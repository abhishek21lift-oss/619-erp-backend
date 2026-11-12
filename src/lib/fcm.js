// src/lib/fcm.js
// Firebase Cloud Messaging HTTP v1, one message at a time.
//
// There is no Firebase Admin SDK here on purpose: `google-auth-library` is
// already a dependency (Google identity), and v1 accepts a service-account
// JWT directly. One less tree of transitive dependencies in the backend.
//
// Configuration, in order of preference:
//   FIREBASE_SERVICE_ACCOUNT       the service-account JSON itself
//   FIREBASE_SERVICE_ACCOUNT_PATH  a path to that JSON
//   FIREBASE_PROJECT_ID            optional override; defaults to project_id
//
// Nothing is read at require time: a deployment without push must still boot,
// and a misconfigured key must fail loudly on the first send rather than in a
// top-level import. The credential never leaves this process — no frontend,
// APK, log line or notification_log row carries it.

const fs = require('fs');
const logger = require('./logger');
const { providerSignal } = require('./providerTimeout');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const SEND_URL = (projectId) => `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

let cached;
let warned = false;

function loadConfig() {
  if (cached !== undefined) return cached;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!raw && !path) return (cached = null);

  let account;
  try {
    account = raw ? JSON.parse(raw) : JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`FCM service account is not readable JSON: ${err.message}`, { cause: err });
  }
  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error('FCM service account is missing project_id, client_email or private_key');
  }

  const { JWT } = require('google-auth-library');
  const jwt = new JWT({
    email: account.client_email,
    key: account.private_key,
    scopes: [SCOPE],
  });
  cached = { jwt, projectId: process.env.FIREBASE_PROJECT_ID || account.project_id };
  return cached;
}

/** True when a service account is present. A malformed one logs once and is false. */
function isConfigured() {
  try {
    return Boolean(loadConfig());
  } catch (err) {
    if (!warned) {
      warned = true;
      logger.error({ err: err.message }, 'fcm misconfigured');
    }
    return false;
  }
}

function accessToken(config) {
  // JWT caches the token and refreshes it shortly before expiry.
  return config.jwt.getAccessToken().then((res) => res.token);
}

/**
 * Map an FCM error to the action the caller should take.
 *
 * Only errors that mean THIS TOKEN is dead revoke it. INVALID_ARGUMENT is
 * usually a malformed message, not a bad token, so it is only treated as a
 * dead token when FCM says so explicitly — revoking a live device over a
 * payload bug would silently unsubscribe a user.
 */
function classify(status, body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const fcmError = details.find((d) => String(d['@type'] || '').includes('FcmError'));
  const code = fcmError?.errorCode || body?.error?.status || `HTTP_${status}`;
  const message = String(body?.error?.message || '');

  const tokenDead = code === 'UNREGISTERED'
    || code === 'SENDER_ID_MISMATCH'
    || (code === 'INVALID_ARGUMENT' && /registration token/i.test(message));

  return {
    ok: false,
    code,
    invalidToken: tokenDead,
    retryable: !tokenDead && (status === 429 || status >= 500),
  };
}

/**
 * Send one user-visible message to one device.
 *
 * Returns { ok, providerId } or { ok:false, code, invalidToken, retryable }.
 * It never throws for a provider response; a network failure is returned as a
 * retryable failure so the BullMQ job can back off. Throws only when push is
 * not configured — the adapter checks isConfigured() first.
 */
async function sendMessage({ token, title, body, data = {}, channelId = 'default' }) {
  const config = loadConfig();
  if (!config) throw new Error('FCM is not configured');

  const access = await accessToken(config);
  const payload = {
    message: {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: {
          channel_id: channelId,
          sound: 'default',
          default_vibrate_timings: true,
        },
      },
    },
  };

  let res;
  try {
    res = await fetch(SEND_URL(config.projectId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: providerSignal(),
    });
  } catch (err) {
    return { ok: false, code: 'NETWORK', retryable: true, message: err.message };
  }

  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // A gateway/proxy error page is not JSON.
  }

  if (res.ok) return { ok: true, providerId: parsed?.name || null };
  return classify(res.status, parsed);
}

module.exports = { isConfigured, sendMessage, classify };

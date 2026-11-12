// src/modules/notifications/push.service.js
// The push transport: resolve this recipient's live devices, send one FCM v1
// message per device, revoke tokens FCM says are dead, and remember which
// devices already accepted a given BullMQ job.
//
// One job, many devices. A retry must not re-alert the devices that succeeded
// on the first attempt — FCM v1 has no idempotency key, so the ledger
// `push_deliveries` carries it. The key is the BullMQ job id; inline sends
// (no Redis) have no retry and therefore no ledger row.

const crypto = require('crypto');
const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const fcm = require('../../lib/fcm');
const pushGate = require('../../lib/pushGate');
const devices = require('../devices/devices.service');

const MAX_ERROR_CHARS = 200;
const DEFAULT_RETENTION_DAYS = 30;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * An internal absolute path, or null. Push is allowed to open a screen; it is
 * not allowed to open an arbitrary URL. `//host` and `/\host` are rejected.
 */
function safeLink(link) {
  if (typeof link !== 'string') return null;
  if (link.length > 512) return null;
  if (!link.startsWith('/') || link.startsWith('//')) return null;
  if (link.includes('\\') || /\p{Cc}/u.test(link)) return null;
  return link;
}

const DEFAULT_LINK = { studio: '/engagement/notifications', member: '/member/notifications' };

/**
 * Keep each shell inside its own half of the site. A member device never opens
 * a `/pt-os/...` trainer screen, and a studio device never opens `/member/...`.
 * An unusable or cross-plane link falls back to that shell's notification page.
 */
function linkForApp(link, app) {
  const fallback = DEFAULT_LINK[app] || DEFAULT_LINK.studio;
  const safe = safeLink(link);
  if (!safe) return fallback;
  const memberLink = safe === '/member' || safe.startsWith('/member/');
  if (app === 'member') return memberLink ? safe : fallback;
  return memberLink ? DEFAULT_LINK.studio : safe;
}

async function alreadySent(dedupeKey, hashes) {
  if (!dedupeKey || !hashes.length) return new Set();
  const { rows } = await pool.query(
    `SELECT token_hash FROM push_deliveries
      WHERE dedupe_key = $1 AND token_hash = ANY($2::text[])`,
    [dedupeKey, hashes]
  );
  return new Set(rows.map((r) => r.token_hash));
}

async function recordSent(dedupeKey, hashes) {
  if (!dedupeKey || !hashes.length) return;
  await pool.query(
    `INSERT INTO push_deliveries (dedupe_key, token_hash)
     SELECT $1, unnest($2::text[])
     ON CONFLICT DO NOTHING`,
    [dedupeKey, hashes]
  );
}

function retentionDays() {
  const days = parseInt(process.env.PUSH_DELIVERY_RETENTION_DAYS, 10);
  if (!Number.isFinite(days) || days < 1) return DEFAULT_RETENTION_DAYS;
  return Math.min(days, 365);
}

/**
 * Delete dedupe rows older than the retention window.
 *
 * `push_deliveries` is retry state, not the delivery audit: `notification_log`
 * already records every attempt (channel, template, status, provider id, error,
 * sent_at) and is deliberately not touched here. Losing an old ledger row only
 * means a very old BullMQ job could be retried without its dedupe hint, which
 * cannot happen because queue jobs complete or fail long before the window.
 */
async function pruneDeliveries({ days = retentionDays() } = {}) {
  const window = Math.max(1, Math.min(365, parseInt(days, 10) || DEFAULT_RETENTION_DAYS));
  const { rowCount } = await pool.query(
    `DELETE FROM push_deliveries
      WHERE created_at < NOW() - make_interval(days => $1)`,
    [window]
  );
  return { deleted: rowCount, days: window };
}

/**
 * Deliver one user-facing push.
 *
 * @param {object} args
 * @param {object} args.recipient - { user_id, organization_id } from a resolver
 * @param {string} args.type      - template key
 * @param {string} args.title
 * @param {string} args.body
 * @param {string} [args.link]    - internal path for tap routing
 * @param {string} [args.dedupeKey] - BullMQ job id; absent for inline sends
 */
async function sendPush({ recipient, type, title, body, link, dedupeKey }) {
  // The gate is checked here, not only at enqueue time: a job queued while a
  // tenant was enabled must not send after the switch is turned off.
  if (!pushGate.isEnabledFor(recipient?.organization_id)) {
    return { status: 'disabled', error: 'push_disabled' };
  }

  if (!fcm.isConfigured()) {
    logger.warn({ type }, 'push not_configured (set FIREBASE_SERVICE_ACCOUNT)');
    return { status: 'not_configured', error: 'fcm_not_configured' };
  }

  // Fail closed: a recipient with no user row or no tenant has no devices.
  if (!recipient?.user_id || !recipient?.organization_id) {
    return { status: 'failed', error: 'recipient_not_scoped' };
  }

  const tokens = await devices.activeTokens({
    userId: recipient.user_id,
    organizationId: recipient.organization_id,
  });
  if (!tokens.length) return { status: 'skipped', error: 'no_device' };

  const hashes = tokens.map((t) => hashToken(t.token));
  const done = await alreadySent(dedupeKey, hashes);
  const pending = tokens.filter((_, i) => !done.has(hashes[i]));
  if (!pending.length) return { status: 'sent', provider_id: null, deduped: true };

  let accepted = 0;
  const dead = [];
  const failures = [];
  let providerId = null;

  for (const device of pending) {
    // The list above is a snapshot taken before the loop; a shared device can
    // be re-registered to another account while this job runs. Do not send
    // this account's message to a token that no longer belongs to it.
    const stillOwned = await devices.ownsToken({
      userId: recipient.user_id,
      organizationId: recipient.organization_id,
      token: device.token,
    });
    if (!stillOwned) continue;

    const data = { type, link: linkForApp(link, device.app), app: device.app };
    let result;
    try {
      result = await fcm.sendMessage({
        token: device.token,
        title,
        body,
        data,
      });
    } catch (err) {
      // A thrown error here is configuration/transport, not a dead token.
      result = { ok: false, code: 'TRANSPORT', retryable: true, message: err.message };
    }

    if (result.ok) {
      accepted += 1;
      providerId = providerId || result.providerId;
      // Record each device as it accepts, not once at the end: a crash or a
      // ledger failure between two devices must not make a retry re-alert the
      // devices that already received this job.
      await recordSent(dedupeKey, [hashToken(device.token)]);
      continue;
    }
    if (result.invalidToken) {
      dead.push(device.token);
      continue;
    }
    failures.push(result);
  }

  if (dead.length) await devices.revokeDead(dead, 'fcm_invalid');

  if (!failures.length) {
    return {
      status: 'sent',
      provider_id: providerId,
      sent: accepted,
      revoked: dead.length,
    };
  }

  // Anything retryable is retried by BullMQ; the next attempt skips `accepted`
  // through the ledger. A permanent failure is reported, not retried.
  const retryable = failures.some((f) => f.retryable);
  const codes = [...new Set(failures.map((f) => f.code || 'fcm_error'))].join(',');
  return {
    status: accepted ? 'partial' : 'failed',
    error: codes.slice(0, MAX_ERROR_CHARS),
    retryable,
    sent: accepted,
    revoked: dead.length,
  };
}

module.exports = { sendPush, safeLink, linkForApp, hashToken, pruneDeliveries, retentionDays };

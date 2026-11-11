'use strict';
// Native Android device credentials — fingerprint / strong-face sign-in for the
// WebView shell.
//
// The phone generates an EC P-256 key in the Android Keystore that requires a
// strong biometric for every use, and keeps the private half unexportable. This
// route stores only the public half, in the existing user_webauthn_credentials
// table, under credential_id = native:<deviceId>. No migration: the table and
// webauthn_challenges are reused as-is.
//
// Registration happens once, while signed in. Login proves possession of the
// key against a fresh server challenge and mints the same cookie session as the
// password and passkey doors — no token is ever handed to the shell.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { AUD_TENANT } = require('../middleware/platformAuth');
const { makeStore } = require('../lib/rateLimitStore');
const logger = require('../lib/logger');
const loginEvents = require('../lib/loginEvents');
const { normalisePortal, portalProblem, resolveLoginPortal } = require('../lib/authPortal');
const {
  signAccessToken, setAccessCookie, issueRefreshToken, sessionUserPayload,
} = require('../lib/authSession');

const router = express.Router();

const GENERIC_LOGIN_ERROR = 'Sign-in failed. Use your password.';

const loginLimiter = rateLimit({
  store: makeStore('device-auth'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes.' },
});

const DEVICE_ID_RE = /^[0-9a-f]{32}$/;
const CHALLENGE_RE = /^[0-9a-f]{64}$/;
// DER ECDSA signatures are 70-72 bytes in practice; the bounds leave room for
// long-form length encodings without accepting arbitrary payloads.
const MIN_SIG_BYTES = 60;
const MAX_SIG_BYTES = 100;
// An EC P-256 SPKI DER key is 91 bytes; the bounds absorb other encodings while
// still rejecting a garbage blob before it reaches createPublicKey.
const MIN_KEY_BYTES = 50;
const MAX_KEY_BYTES = 200;

const LOGIN_MESSAGE_PREFIX = 'MPS-DEVICE-LOGIN-V1\n';
const REGISTER_MESSAGE_PREFIX = 'MPS-DEVICE-REGISTER-V1\n';

function registerMessage(challenge) {
  return REGISTER_MESSAGE_PREFIX + challenge;
}

function loginMessage(challenge) {
  return LOGIN_MESSAGE_PREFIX + challenge;
}

function verifySignature(publicKeyB64, message, signatureB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      'sha256',
      Buffer.from(message, 'utf8'),
      key,
      Buffer.from(signatureB64, 'base64')
    );
  } catch {
    return false;
  }
}

async function saveChallenge(challenge, userId, type) {
  await pool.query(
    `INSERT INTO webauthn_challenges (challenge, user_id, type, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
    [challenge, userId, type]
  );
}

/**
 * Consume a challenge exactly once.
 *
 * The row must be bound to the same user and type that issued it: a device
 * challenge is only ever consumed by the device ceremony.
 */
async function consumeChallenge(challenge, type, userId) {
  const { rows } = await pool.query(
    `DELETE FROM webauthn_challenges
      WHERE challenge = $1 AND type = $2 AND user_id = $3 AND expires_at > NOW()
      RETURNING user_id`,
    [challenge, type, userId]
  );
  return rows.length > 0;
}

function decodeB64(value, min, max) {
  if (typeof value !== 'string' || !value) return null;
  const buf = Buffer.from(value, 'base64');
  if (buf.length < min || buf.length > max) return null;
  return buf;
}

async function logEvent(req, action, detail, actor) {
  const user = actor || req.user;
  try {
    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1, $2, $3, 'webauthn', $4, $5, $6, $7)`,
      [user?.id || null, user?.name || null, action,
       detail?.entity_id || null, detail || {},
       req.ip || null, req.get('user-agent') || null]
    );
  } catch (err) {
    logger.warn({ err: err.message, action }, 'device activity log failed');
  }
}

// The device tables require a tenant: platform operators have no organization,
// so registering one would write a row no studio can see or revoke.
function tenantOnly(req, res, next) {
  const user = req.user;
  if (!user || user.role === 'super_admin' || !user.organization_id) {
    return res.status(403).json({ error: 'This account cannot use device sign-in.' });
  }
  next();
}

// POST /register/options — a fresh challenge for the enrollment signature.
router.post('/register/options', auth, tenantOnly, async (req, res, next) => {
  try {
    const challenge = crypto.randomBytes(32).toString('hex');
    // The same challenge type the passkey enrolment uses: production's
    // webauthn_challenges carries a CHECK that predates the device ceremony,
    // and the values already proven live are 'registration' and
    // 'authentication'. The signed messages differ, so a challenge from one
    // ceremony cannot be replayed into the other.
    await saveChallenge(challenge, req.user.id, 'registration');
    res.json({ challenge });
  } catch (err) {
    next(err);
  }
});

// POST /register/verify — store the public key once the phone has signed the
// registration challenge with it.
router.post('/register/verify', auth, tenantOnly, async (req, res, next) => {
  try {
    const { challenge, deviceId, publicKey, signature } = req.body || {};
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) {
      return res.status(400).json({ error: 'challenge is invalid' });
    }
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      return res.status(400).json({ error: 'deviceId is invalid' });
    }
    const keyBytes = decodeB64(publicKey, MIN_KEY_BYTES, MAX_KEY_BYTES);
    if (!keyBytes) return res.status(400).json({ error: 'publicKey is invalid' });
    if (!decodeB64(signature, MIN_SIG_BYTES, MAX_SIG_BYTES)) {
      return res.status(400).json({ error: 'signature is invalid' });
    }
    const label = String(req.body?.label || 'Android device').trim().slice(0, 60) || 'Android device';

    const consumed = await consumeChallenge(challenge, 'registration', req.user.id);
    if (!consumed) {
      return res.status(401).json({ error: 'Registration expired. Try again.' });
    }

    if (!verifySignature(publicKey, registerMessage(challenge), signature)) {
      return res.status(401).json({ error: 'Could not enable fingerprint sign-in. Try again.' });
    }

    let inserted;
    try {
      inserted = await pool.query(
        `INSERT INTO user_webauthn_credentials
           (user_id, organization_id, credential_id, public_key, device_name, device_type,
            transports, is_active)
         VALUES ($1, $2, 'native:' || $3, $4, $5, 'android_native', '{}', true)
         RETURNING id`,
        [req.user.id, req.user.organization_id, deviceId, publicKey, label]
      );
    } catch (err) {
      if (err && err.code === '23505') {
        return res.status(409).json({ error: 'This phone is already registered.' });
      }
      throw err;
    }

    await logEvent(req, 'device_credential_registered', {
      entity_id: inserted.rows[0]?.id || null,
      user_id: req.user.id,
      device_id: deviceId,
      device_name: label,
    });

    res.json({ success: true, deviceId });
  } catch (err) {
    next(err);
  }
});

// POST /login/options — a fresh challenge. The device id is the only input:
// the credential selects the account, exactly as the spec requires.
router.post('/login/options', loginLimiter, async (req, res, next) => {
  try {
    const deviceId = req.body?.deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      return res.status(400).json({ error: 'deviceId is invalid' });
    }

    // Look up the row even when it is revoked: a valid signature over the
    // stored challenge is what earns the revoked answer. The user join still
    // keeps disabled accounts on the generic failure.
    const { rows } = await pool.query(
      `SELECT c.user_id
         FROM user_webauthn_credentials c
         JOIN users u ON u.id = c.user_id AND u.is_active = true AND u.deleted_at IS NULL
        WHERE c.credential_id = $1`,
      ['native:' + deviceId]
    );

    const challenge = crypto.randomBytes(32).toString('hex');
    // Only a known credential gets a stored challenge: production's
    // webauthn_challenges rejects an anonymous row (a CHECK that predates the
    // device ceremony), and an unknown device id must look the same as a
    // revoked one anyway — both answer the generic 401 at /login/verify
    // unless the key actually verifies.
    if (rows.length) await saveChallenge(challenge, rows[0].user_id, 'authentication');
    res.json({ challenge });
  } catch (err) {
    next(err);
  }
});

// POST /login/verify — prove possession of the Keystore key and mint the same
// cookie session as the password and passkey doors.
router.post('/login/verify', loginLimiter, async (req, res, next) => {
  try {
    const { challenge, deviceId, signature } = req.body || {};
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)
        || typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)
        || !decodeB64(signature, MIN_SIG_BYTES, MAX_SIG_BYTES)) {
      return res.status(400).json({ error: 'Sign-in request is invalid.' });
    }

    // Deliberately no deleted_at / is_active filter on the credential: a
    // revoked row must still reach the signature check, so the revoked answer
    // is only given to someone who actually holds the key.
    const { rows } = await pool.query(
      `SELECT c.public_key, c.is_active, c.deleted_at, c.user_id,
              u.id, u.name, u.email, u.role, u.trainer_id, u.pt_client_id, u.token_version,
              u.organization_id, o.name AS organization_name, o.logo_url AS organization_logo_url,
              o.is_founder, o.founder_number, up.avatar_url
         FROM user_webauthn_credentials c
         JOIN users u ON u.id = c.user_id AND u.is_active = true AND u.deleted_at IS NULL
         LEFT JOIN organizations o ON o.id = u.organization_id
         LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE c.credential_id = $1`,
      ['native:' + deviceId]
    );
    if (!rows.length) return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    const cred = rows[0];

    const consumed = await consumeChallenge(challenge, 'authentication', cred.user_id);
    if (!consumed) return res.status(401).json({ error: GENERIC_LOGIN_ERROR });

    if (!verifySignature(cred.public_key, loginMessage(challenge), signature)) {
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }

    if (!cred.is_active || cred.deleted_at) {
      return res.status(401).json({
        error: {
          code: 'DEVICE_CREDENTIAL_REVOKED',
          message: 'Fingerprint sign-in was turned off for this phone.',
        },
      });
    }

    // The passkey settings page reads this to answer "when was this phone last
    // used"; without it a working credential reads "Never used".
    await pool.query(
      `UPDATE user_webauthn_credentials
          SET last_used_at = NOW(), updated_at = NOW()
        WHERE credential_id = $1`,
      ['native:' + deviceId]
    );

    const portal = normalisePortal(req.body.portal);
    const problem = portalProblem(cred, portal);
    if (problem) {
      return res.status(problem.status).json({
        error: { code: problem.code, portal: problem.portal, message: problem.message },
      });
    }
    const sessionPortal = resolveLoginPortal(cred, portal);

    const token = signAccessToken(cred.id, cred.token_version ?? 0, AUD_TENANT);
    setAccessCookie(res, sessionPortal, token, { mirrorLegacy: true });
    try {
      await issueRefreshToken(res, cred.id, AUD_TENANT, sessionPortal, { mirrorLegacy: true });
    } catch (rfErr) {
      logger.warn({ err: rfErr.message }, 'device refresh_token issue failed (non-critical)');
    }

    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [cred.id]).catch(() => {});
    // shortcut: login_events.method stays 'passkey' because its CHECK constraint
    // accepts only password|google|passkey|refresh, and a device login is a
    // password-equivalent sign-in; activity_log's device_biometric_login action
    // carries the distinction. Upgrade when a migration adds a 'device' method.
    loginEvents.record(req, {
      outcome: loginEvents.OUTCOMES.SUCCESS, method: 'passkey', email: cred.email,
      userId: cred.id, orgId: cred.organization_id,
    });
    await logEvent(req, 'device_biometric_login', {
      entity_id: cred.id,
      device_id: deviceId,
    }, cred);

    res.json({ user: sessionUserPayload(cred) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

'use strict';
const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const logger = require('../lib/logger');

const router = express.Router();

const rateLimit = require('express-rate-limit');
const authnLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many authentication attempts' } });

const RP_ID   = process.env.RP_ID   || 'localhost';
const RP_NAME = process.env.RP_NAME || '619 Fitness';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;
const isProd = process.env.NODE_ENV === 'production';

function setTokenCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// Lazy-load @simplewebauthn/server so missing package fails at call-time, not startup
let _wauthn = null;
function wauthn() {
  if (!_wauthn) _wauthn = require('@simplewebauthn/server');
  return _wauthn;
}

function pickPayload(body, key) {
  if (body && body[key] && typeof body[key] === 'object') return body[key];
  return body || {};
}

async function findUserByMemberId(memberId) {
  if (!memberId) return null;
  const { rows } = await pool.query(
    `SELECT id, name, email, role, trainer_id, member_id, token_version
       FROM users
      WHERE member_id = $1 AND is_active = true
      ORDER BY updated_at DESC
      LIMIT 1`,
    [memberId]
  );
  return rows[0] || null;
}

async function findUserByEmail(email) {
  if (!email) return null;
  const { rows } = await pool.query(
    `SELECT id, name, email, role, trainer_id, member_id, token_version
       FROM users
      WHERE LOWER(email) = LOWER($1) AND is_active = true
      ORDER BY updated_at DESC
      LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

function memberIdFromRequest(req, fallback) {
  return req.user?.member_id || fallback || null;
}

function issueActionToken(user) {
  return jwt.sign(
    { id: user.id, purpose: 'webauthn_action' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

async function logWebauthnEvent(req, action, detail) {
  try {
    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1, $2, $3, 'webauthn', $4, $5, $6, $7)`,
      [
        req.user?.id || null,
        req.user?.name || null,
        action,
        detail?.entity_id || null,
        detail || {},
        req.ip || null,
        req.get('user-agent') || null,
      ]
    );
  } catch (err) {
    logger.warn({ err: err.message, action }, 'Failed to write webauthn activity log');
  }
}

// ── Helpers ───────────────────────────────────────────────────────
async function saveChallenge(challenge, memberId, type, sessionId) {
  await pool.query(
    `INSERT INTO webauthn_challenges (challenge, member_id, type, session_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes')
     ON CONFLICT (challenge) DO NOTHING`,
    [challenge, memberId || null, type, sessionId || null]
  );
}

async function consumeChallenge(challenge, type) {
  const r = await pool.query(
    `DELETE FROM webauthn_challenges
     WHERE challenge = $1 AND type = $2 AND expires_at > NOW()
     RETURNING member_id`,
    [challenge, type]
  );
  return r.rows[0] || null;
}

// Clean up expired challenges periodically
setInterval(async () => {
  try { await pool.query("DELETE FROM webauthn_challenges WHERE expires_at < NOW()"); } catch {}
}, 60_000).unref();

// ── Registration ──────────────────────────────────────────────────
// GET /api/webauthn/member-search?q=name  — search members across all tables
router.get('/member-search', auth, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ members: [] });
    const like = `%${q}%`;
    const { rows: regular } = await pool.query(
      `SELECT id, name, email, 'member' AS source FROM clients
       WHERE (name ILIKE $1 OR email ILIKE $1 OR client_id ILIKE $1) AND status != 'deleted'
       ORDER BY name LIMIT 10`, [like]
    );
    const { rows: pt } = await pool.query(
      `SELECT id, name, email, 'pt_client' AS source FROM pt_clients
       WHERE (name ILIKE $1 OR email ILIKE $1 OR unique_id ILIKE $1) AND deleted_at IS NULL
       ORDER BY name LIMIT 10`, [like]
    );
    res.json({ members: [...regular, ...pt].slice(0, 15) });
  } catch (err) { next(err); }
});

// GET /api/webauthn/register/begin?member_id=xxx
router.get('/register/begin', auth, async (req, res, next) => {
  try {
    const requestedMemberId = req.query.member_id || req.query.memberId || null;
    const member_id = memberIdFromRequest(req, requestedMemberId);
    if (!member_id) return res.status(400).json({ error: 'member_id is required' });

    // Search both regular clients and PT clients
    let memberRow = null;
    const { rows: r1 } = await pool.query('SELECT id, name, email FROM clients WHERE id = $1', [member_id]);
    if (r1.length) { memberRow = r1[0]; }
    else {
      const { rows: r2 } = await pool.query('SELECT id, name, email FROM pt_clients WHERE id = $1 AND deleted_at IS NULL', [member_id]);
      if (r2.length) memberRow = r2[0];
    }
    if (!memberRow) return res.status(404).json({ error: 'Member not found' });
    const member = memberRow;

    const existing = await pool.query(
      'SELECT credential_id FROM webauthn_credentials WHERE member_id = $1',
      [member_id]
    );

    const { generateRegistrationOptions } = wauthn();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(member.id, 'utf8'),
      userName: member.email || member.name,
      userDisplayName: member.name,
      attestationType: 'none',
      excludeCredentials: existing.rows.map(r => ({
        id: Buffer.from(r.credential_id, 'base64url'),
        type: 'public-key',
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    await saveChallenge(options.challenge, member_id, 'registration', req.sessionID || null);
    res.json(options);
  } catch (err) {
    next(err);
  }
});

// POST /api/webauthn/register/complete
router.post('/register/complete', auth, async (req, res, next) => {
  try {
    const registration = pickPayload(req.body, 'registration');
    const memberId = memberIdFromRequest(req, req.body?.memberId || req.body?.member_id);
    const deviceName = req.body?.deviceName || req.body?.device_name || 'Passkey';
    const credentialId = registration?.id || req.body?.credentialId;
    const rawId = registration?.rawId || req.body?.rawId;
    const transports = registration?.response?.transports || req.body?.transports || [];
    const deviceType = req.body?.deviceType || req.body?.device_type || 'unknown';
    const attestationObject = registration?.response?.attestationObject || req.body?.attestationObject;
    const clientDataJSON = registration?.response?.clientDataJSON || req.body?.clientDataJSON;

    if (!memberId || !credentialId) return res.status(400).json({ error: 'memberId and credentialId are required' });

    const challenge = await pool.query(
      `SELECT challenge, member_id FROM webauthn_challenges
       WHERE member_id = $1 AND type = 'registration' AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [memberId]
    );
    if (!challenge.rows.length) return res.status(400).json({ error: 'No valid challenge found. Please restart registration.' });

    const { verifyRegistrationResponse } = wauthn();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: { id: credentialId, rawId, type: 'public-key', response: { attestationObject, clientDataJSON }, clientExtensionResults: {} },
        expectedChallenge: challenge.rows[0].challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });
    } catch {
      return res.status(400).json({ error: 'Credential verification failed' });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }

    await consumeChallenge(challenge.rows[0].challenge, 'registration');

    const { credentialPublicKey, credentialID, counter } = verification.registrationInfo;
    const publicKeyB64 = Buffer.from(credentialPublicKey).toString('base64url');
    const credIdB64    = Buffer.from(credentialID).toString('base64url');

    const cred = await pool.query(
      `INSERT INTO webauthn_credentials
         (member_id, credential_id, public_key, counter, device_name, device_type, transports)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (credential_id) DO UPDATE SET last_used_at = NOW()
       RETURNING id`,
      [memberId, credIdB64, publicKeyB64, counter,
       deviceName || 'Passkey', deviceType || 'unknown',
       Array.isArray(transports) ? transports : null]
    );

    await logWebauthnEvent(req, 'webauthn_registered', {
      entity_id: cred.rows[0].id,
      member_id: memberId,
      credential_id: credIdB64,
      device_name: deviceName || 'Passkey',
    });

    res.json({ success: true, credential: { id: cred.rows[0].id } });
  } catch (err) {
    next(err);
  }
});

// ── Authentication ────────────────────────────────────────────────
// GET /api/webauthn/authenticate/begin?member_id=xxx
router.get('/authenticate/begin', authnLimiter, async (req, res, next) => {
  try {
    const email = String(req.query.email || req.body?.email || '').trim();
    const requestedMemberId = req.query.member_id || req.query.memberId || req.body?.memberId || req.body?.member_id || null;
    let member_id = memberIdFromRequest(req, requestedMemberId);

    if (!member_id && email) {
      const user = await findUserByEmail(email);
      member_id = user?.member_id || null;
    }

    let allowCredentials = [];
    if (member_id) {
      const creds = await pool.query(
        'SELECT credential_id, transports FROM webauthn_credentials WHERE member_id = $1',
        [member_id]
      );
      allowCredentials = creds.rows.map(r => ({
        id: Buffer.from(r.credential_id, 'base64url'),
        type: 'public-key',
        transports: r.transports || [],
      }));
    }

    const { generateAuthenticationOptions } = wauthn();
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: 'preferred',
    });

    await saveChallenge(options.challenge, member_id || null, 'authentication', req.sessionID || null);
    res.json(options);
  } catch (err) {
    next(err);
  }
});

// POST /api/webauthn/authenticate/complete
router.post('/authenticate/complete', authnLimiter, async (req, res, next) => {
  try {
    const authentication = pickPayload(req.body, 'authentication');
    const credentialId = authentication?.id || req.body?.credentialId || req.body?.credential_id;
    const rawId = authentication?.rawId || req.body?.rawId;
    const authenticatorData = authentication?.response?.authenticatorData || req.body?.authenticatorData;
    const signature = authentication?.response?.signature || req.body?.signature;
    const clientDataJSON = authentication?.response?.clientDataJSON || req.body?.clientDataJSON;
    const userHandle = authentication?.response?.userHandle || req.body?.userHandle;
    if (!credentialId) return res.status(400).json({ error: 'credentialId is required' });

    const credRow = await pool.query(
      'SELECT credential_id, public_key, counter, member_id FROM webauthn_credentials WHERE credential_id = $1',
      [credentialId]
    );
    if (!credRow.rows.length) return res.status(404).json({ error: 'Credential not found' });
    const cred = credRow.rows[0];

    const challengeRow = await pool.query(
      `SELECT challenge FROM webauthn_challenges
       WHERE type = 'authentication'
         AND expires_at > NOW()
         AND ($1::text IS NULL OR member_id = $1)
       ORDER BY created_at DESC LIMIT 1`,
      [cred.member_id]
    );
    if (!challengeRow.rows.length) return res.status(400).json({ error: 'No valid challenge. Please restart authentication.' });

    const { verifyAuthenticationResponse } = wauthn();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: { id: credentialId, rawId, type: 'public-key', response: { authenticatorData, signature, clientDataJSON, userHandle }, clientExtensionResults: {} },
        expectedChallenge: challengeRow.rows[0].challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        authenticator: {
          credentialID: Buffer.from(cred.credential_id, 'base64url'),
          credentialPublicKey: Buffer.from(cred.public_key, 'base64url'),
          counter: Number(cred.counter),
        },
      });
    } catch {
      return res.status(400).json({ error: 'Authentication verification failed' });
    }

    if (!verification.verified) return res.status(401).json({ error: 'Not verified' });

    await consumeChallenge(challengeRow.rows[0].challenge, 'authentication');
    await pool.query(
      'UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE credential_id = $2',
      [verification.authenticationInfo.newCounter, credentialId]
    );

    let m = null;
    const { rows: mr1 } = await pool.query('SELECT id, name FROM clients WHERE id = $1', [cred.member_id]);
    if (mr1.length) m = mr1[0];
    else {
      const { rows: mr2 } = await pool.query('SELECT id, name FROM pt_clients WHERE id = $1', [cred.member_id]);
      if (mr2.length) m = mr2[0];
    }
    const user = await findUserByMemberId(cred.member_id);
    if (!user) return res.status(404).json({ error: 'No user account is linked to this passkey' });

    const token = jwt.sign(
      { id: user.id, token_version: user.token_version ?? 0 },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    setTokenCookie(res, token);

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]).catch(() => {});
    await logWebauthnEvent(req, 'webauthn_login_success', {
      entity_id: cred.member_id,
      credential_id: credentialId,
      member_id: cred.member_id,
    });

    res.json({
      success: true,
      memberId: m?.id,
      memberName: m?.name,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        trainer_id: user.trainer_id,
        member_id: user.member_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Credential management ─────────────────────────────────────────
// GET /api/webauthn/credentials?member_id=xxx
router.get('/credentials', auth, async (req, res, next) => {
  try {
    const member_id = memberIdFromRequest(req, req.query.member_id || req.query.memberId || null);
    if (!member_id) return res.status(400).json({ error: 'member_id is required' });
    const result = await pool.query(
      `SELECT id, device_name, device_type, created_at, last_used_at
       FROM webauthn_credentials WHERE member_id = $1 ORDER BY created_at DESC`,
      [member_id]
    );
    res.json({ credentials: result.rows });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/webauthn/credentials/:id
router.delete('/credentials/:id', auth, async (req, res, next) => {
  try {
    const existing = await pool.query(
      'SELECT id, member_id FROM webauthn_credentials WHERE id = $1',
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Credential not found' });
    const member_id = memberIdFromRequest(req, null);
    if (req.user?.role !== 'admin' && member_id !== existing.rows[0].member_id) {
      return res.status(403).json({ error: 'Not authorized to remove this credential' });
    }
    const result = await pool.query(
      'DELETE FROM webauthn_credentials WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

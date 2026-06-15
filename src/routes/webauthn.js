'use strict';
const express = require('express');
const crypto  = require('crypto');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');

const router = express.Router();

const RP_ID   = process.env.RP_ID   || 'localhost';
const RP_NAME = process.env.RP_NAME || '619 Fitness';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;

// Lazy-load @simplewebauthn/server so missing package fails at call-time, not startup
let _wauthn = null;
function wauthn() {
  if (!_wauthn) _wauthn = require('@simplewebauthn/server');
  return _wauthn;
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
}, 60_000);

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
    const { member_id } = req.query;
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
    const { memberId, deviceName, credentialId, rawId, transports, deviceType, attestationObject, clientDataJSON } = req.body;
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
       transports ? `{${transports.join(',')}}` : null]
    );

    res.json({ success: true, credential: { id: cred.rows[0].id } });
  } catch (err) {
    next(err);
  }
});

// ── Authentication ────────────────────────────────────────────────
// GET /api/webauthn/authenticate/begin?member_id=xxx
router.get('/authenticate/begin', async (req, res, next) => {
  try {
    const { member_id } = req.query;

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
router.post('/authenticate/complete', async (req, res, next) => {
  try {
    const { credentialId, rawId, authenticatorData, signature, clientDataJSON, userHandle } = req.body;
    if (!credentialId) return res.status(400).json({ error: 'credentialId is required' });

    const credRow = await pool.query(
      'SELECT * FROM webauthn_credentials WHERE credential_id = $1',
      [credentialId]
    );
    if (!credRow.rows.length) return res.status(404).json({ error: 'Credential not found' });
    const cred = credRow.rows[0];

    const challengeRow = await pool.query(
      `SELECT challenge FROM webauthn_challenges
       WHERE type = 'authentication' AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`
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
    res.json({ success: true, memberId: m?.id, memberName: m?.name });
  } catch (err) {
    next(err);
  }
});

// ── Credential management ─────────────────────────────────────────
// GET /api/webauthn/credentials?member_id=xxx
router.get('/credentials', auth, async (req, res, next) => {
  try {
    const { member_id } = req.query;
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
    const result = await pool.query(
      'DELETE FROM webauthn_credentials WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Credential not found' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

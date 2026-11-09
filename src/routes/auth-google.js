// src/routes/auth-google.js
//
// Continue with Google for studio accounts.
//
// Identity is the Google subject (`sub`), never the email: a Google account
// can change its address, and an email address can be reassigned. Email is
// only a first-link hint. An existing password account is never merged into a
// Google identity by matching email — POST /api/auth/google-link requires the
// account password as well as a valid Google token.
//
// Both endpoints issue the same session as POST /api/auth/login: a 15-minute
// tenant access cookie, a rotating 7-day refresh token, and the same user
// payload. The Command Center is refused outright because Google cannot carry
// the super admin's second factor.

'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const logger = require('../lib/logger');
const loginEvents = require('../lib/loginEvents');
const { verifyGoogleCredential } = require('../lib/googleIdentity');
const { normalisePortal, portalProblem, resolveLoginPortal } = require('../lib/authPortal');
const {
  setAccessCookie, signAccessToken, issueRefreshToken,
  bodyTokensAllowed, sessionUserPayload,
} = require('../lib/authSession');
const { AUD_TENANT } = require('../middleware/platformAuth');

// One query for both endpoints. `google_sub` wins over email; email is only
// the first-link hint. Inactive and deleted rows are returned deliberately so
// the caller gets an honest ACCOUNT_DISABLED rather than a fake "no account".
const USER_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.password, u.token_version, u.trainer_id,
         u.member_id, u.pt_client_id, u.is_active, u.deleted_at, u.google_sub,
         u.organization_id, o.name AS organization_name,
         o.logo_url AS organization_logo_url, o.is_founder, o.founder_number,
         up.avatar_url
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    LEFT JOIN user_profiles up ON up.user_id = u.id
   WHERE u.google_sub = $1 OR LOWER(u.email) = LOWER($2)
   ORDER BY (u.google_sub = $1) DESC
   LIMIT 1`;

async function findUser(sub, email) {
  const { rows } = await pool.query(USER_SELECT, [sub, email]);
  return rows[0] || null;
}

async function verifiedPayload(req, res) {
  try {
    return await verifyGoogleCredential(req.body && req.body.credential);
  } catch (err) {
    if (err.code === 'GOOGLE_NOT_CONFIGURED') {
      logger.error('GOOGLE_CLIENT_ID is not configured');
      res.status(500).json({ error: 'Google login is not configured on this server' });
    } else {
      res.status(401).json({
        error: { code: 'GOOGLE_INVALID_CREDENTIAL', message: 'Invalid Google credential' },
      });
    }
    return null;
  }
}

function deny(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

async function issueSession(req, res, user) {
  const portal = resolveLoginPortal(user, normalisePortal(req.body.portal));
  const token = signAccessToken(user.id, user.token_version, AUD_TENANT);
  setAccessCookie(res, portal, token, { mirrorLegacy: true });
  let refreshToken;
  try {
    refreshToken = await issueRefreshToken(res, user.id, AUD_TENANT, portal, { mirrorLegacy: true });
  } catch (err) {
    logger.warn({ err: err.message }, 'refresh_token issue failed (non-critical, table may not exist yet)');
  }
  res.json({
    user: sessionUserPayload(user),
    ...(bodyTokensAllowed(req) ? { token, refresh_token: refreshToken } : {}),
  });
}

function recordSuccess(req, payload, user) {
  pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
    .catch((err) => logger.warn({ err: err.message }, 'last_login write failed (non-critical)'));
  loginEvents.record(req, {
    outcome: loginEvents.OUTCOMES.SUCCESS, method: 'google',
    email: payload.email, userId: user.id, orgId: user.organization_id,
  });
}

async function commonChecks(req, res, payload) {
  if (payload.sub && req.body.portal === 'platform') {
    deny(res, 403, 'GOOGLE_ACCOUNT_NOT_SUPPORTED',
      'Google sign-in is for studio accounts. Use password login with your authenticator code.');
    return { stop: true };
  }
  const user = await findUser(payload.sub, payload.email);
  if (!user) {
    loginEvents.record(req, {
      outcome: loginEvents.OUTCOMES.UNKNOWN_USER, method: 'google', email: payload.email,
    });
    deny(res, 404, 'GOOGLE_NO_ACCOUNT',
      'No account found for this Google email. Start a free studio to continue.',
      { email: payload.email });
    return { stop: true };
  }
  if (!user.is_active || user.deleted_at) {
    loginEvents.record(req, {
      outcome: loginEvents.OUTCOMES.INACTIVE, method: 'google',
      email: payload.email, userId: user.id, orgId: user.organization_id,
    });
    deny(res, 403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact your studio.');
    return { stop: true };
  }
  if (user.role === 'super_admin') {
    deny(res, 403, 'GOOGLE_ACCOUNT_NOT_SUPPORTED',
      'Google sign-in is for studio accounts. Use password login with your authenticator code.');
    return { stop: true };
  }
  return { stop: false, user };
}

function portalResponse(req, res, user, payload) {
  const portal = normalisePortal(req.body.portal);
  const problem = portalProblem(user, portal);
  if (!problem) return false;

  if (problem.code === 'WRONG_PORTAL') {
    loginEvents.record(req, {
      outcome: loginEvents.OUTCOMES.WRONG_PORTAL, method: 'google',
      email: payload.email, userId: user.id, orgId: user.organization_id,
    });
  }
  res.status(problem.status).json({
    error: {
      code: problem.code,
      ...(problem.portal ? { portal: problem.portal } : {}),
      message: problem.message,
    },
  });
  return true;
}

// POST /api/auth/google-login
router.post('/google-login', async (req, res) => {
  try {
    const payload = await verifiedPayload(req, res);
    if (!payload) return;

    const common = await commonChecks(req, res, payload);
    if (common.stop) return;
    const { user } = common;

    if (user.google_sub && user.google_sub !== payload.sub) {
      return deny(res, 409, 'GOOGLE_ALREADY_LINKED',
        'This Google account is already linked to another user.');
    }
    if (!user.google_sub) {
      return deny(res, 409, 'GOOGLE_LINK_REQUIRED',
        'This account already uses a password. Enter it to link Google.',
        { email: payload.email });
    }

    if (portalResponse(req, res, user, payload)) return;

    recordSuccess(req, payload, user);
    return await issueSession(req, res, user);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unexpected Google login error');
    return res.status(500).json({ error: 'Unexpected server error. Please try again.' });
  }
});

// POST /api/auth/google-link
//
// The only path that writes a Google identity onto an existing account. It
// requires a valid Google ID token for the account's email AND that account's
// password. There is no email-only merge, and no session is issued before
// both proofs succeed.
router.post('/google-link', async (req, res) => {
  try {
    const payload = await verifiedPayload(req, res);
    if (!payload) return;

    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = await findUser(null, payload.email);

    if (!user) {
      loginEvents.record(req, {
        outcome: loginEvents.OUTCOMES.UNKNOWN_USER, method: 'google', email: payload.email,
      });
      return deny(res, 404, 'GOOGLE_NO_ACCOUNT',
        'No account found for this Google email. Start a free studio to continue.',
        { email: payload.email });
    }
    if (!user.is_active || user.deleted_at) {
      loginEvents.record(req, {
        outcome: loginEvents.OUTCOMES.INACTIVE, method: 'google',
        email: payload.email, userId: user.id, orgId: user.organization_id,
      });
      return deny(res, 403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact your studio.');
    }
    if (user.role === 'super_admin') {
      return deny(res, 403, 'GOOGLE_ACCOUNT_NOT_SUPPORTED',
        'Google sign-in is for studio accounts. Use password login with your authenticator code.');
    }
    if (user.google_sub && user.google_sub !== payload.sub) {
      return deny(res, 409, 'GOOGLE_ALREADY_LINKED',
        'This Google account is already linked to another user.');
    }
    if (!user.password) {
      return deny(res, 403, 'GOOGLE_LINK_UNAVAILABLE',
        'This account cannot link Google. Contact your studio.');
    }

    let valid = false;
    try {
      valid = await bcrypt.compare(password, user.password);
    } catch (err) {
      logger.error({ err: err.message }, 'bcrypt error');
      return res.status(500).json({ error: 'Authentication error. Please try again.' });
    }
    if (!valid) {
      loginEvents.record(req, {
        outcome: loginEvents.OUTCOMES.BAD_PASSWORD, method: 'google',
        email: payload.email, userId: user.id, orgId: user.organization_id,
      });
      return deny(res, 401, 'GOOGLE_LINK_INVALID_PASSWORD', 'That password is incorrect.');
    }

    if (portalResponse(req, res, user, payload)) return;

    try {
      const result = await pool.query(
        `UPDATE users
            SET google_sub = $2, google_linked_at = NOW()
          WHERE id = $1 AND (google_sub IS NULL OR google_sub = $2)`,
        [user.id, payload.sub]
      );
      if (result.rowCount !== 1) {
        return deny(res, 409, 'GOOGLE_ALREADY_LINKED',
          'This Google account is already linked to another user.');
      }
    } catch (err) {
      if (err && err.code === '23505') {
        return deny(res, 409, 'GOOGLE_ALREADY_LINKED',
          'This Google account is already linked to another user.');
      }
      throw err;
    }

    recordSuccess(req, payload, user);
    return await issueSession(req, res, user);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unexpected Google link error');
    return res.status(500).json({ error: 'Unexpected server error. Please try again.' });
  }
});

module.exports = router;

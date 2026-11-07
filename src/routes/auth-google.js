// src/routes/auth-google.js
// Google OAuth — verifies a Google ID token and issues the same JWT cookie as regular login.
// The user must already have an account (created by admin); we never auto-provision from Google.
const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const pool   = require('../db/pool');
const logger = require('../lib/logger');
const loginEvents = require('../lib/loginEvents');
const { AUD_TENANT } = require('../middleware/platformAuth');

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

// POST /api/auth/google-login
router.post('/google-login', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      logger.error('GOOGLE_CLIENT_ID is not configured');
      return res.status(500).json({ error: 'Google login is not configured on this server' });
    }

    // Verify the Google ID token using google-auth-library
    let payload;
    try {
      const { OAuth2Client } = require('google-auth-library');
      const client = new OAuth2Client(clientId);
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } catch (verifyErr) {
      logger.warn({ err: verifyErr.message }, 'Google token verification failed');
      return res.status(401).json({ error: 'Invalid Google credential' });
    }

    if (!payload || !payload.email_verified) {
      return res.status(401).json({ error: 'Google account email is not verified' });
    }

    const email = payload.email;

    // Find an existing, active user by email — never auto-create
    let user;
    try {
      const { rows } = await pool.query(
        // Same session shape as POST /login. The client adopts this object as
        // the signed-in user without fetching /api/auth/me, so a partial user
        // made the shell fall back to "PT Studio" and a generic mark.
        `SELECT u.id, u.name, u.email, u.role, u.token_version, u.trainer_id,
                u.member_id, u.pt_client_id, u.is_active, u.organization_id,
                o.name AS organization_name, o.logo_url AS organization_logo_url,
                o.is_founder, o.founder_number, up.avatar_url
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
           LEFT JOIN user_profiles up ON up.user_id = u.id
          WHERE LOWER(u.email) = LOWER($1) AND u.is_active = true AND u.deleted_at IS NULL`,
        [email]
      );
      user = rows[0];
    } catch (dbErr) {
      logger.error({ err: dbErr.message }, 'Google login DB error');
      return res.status(500).json({ error: 'Database error. Please try again.' });
    }

    if (!user) {
      loginEvents.record(req, {
        outcome: loginEvents.OUTCOMES.UNKNOWN_USER, method: 'google', email,
      });
      return res.status(401).json({
        error: 'No active account found for this Google email. Contact your administrator.',
      });
    }

    // Update last login (non-critical)
    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
      .catch(err => logger.warn({ err: err.message }, 'last_login update failed (non-critical)'));

    loginEvents.record(req, {
      outcome: loginEvents.OUTCOMES.SUCCESS, method: 'google', email,
      userId: user.id, orgId: user.organization_id,
    });

    // Sign JWT — identical shape to the regular login cookie
    let token;
    try {
      // Tenant audience: this is the studio door. An operator who signs in
      // with Google gets a session that runs the studio app and cannot drive
      // the control plane — the Command Center has its own door, and that is
      // the only thing that mints a platform session. See
      // middleware/platformAuth.js.
      token = jwt.sign(
        { id: user.id, token_version: user.token_version, aud: AUD_TENANT },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
    } catch (jwtErr) {
      logger.error({ err: jwtErr.message }, 'JWT sign error');
      return res.status(500).json({ error: 'Token generation failed. Contact administrator.' });
    }

    setTokenCookie(res, token);

    res.json({
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        trainer_id: user.trainer_id,
        pt_client_id:  user.pt_client_id,
        organization_id:       user.organization_id,
        organization_name:     user.organization_name,
        organization_logo_url: user.organization_logo_url,
        is_founder:            Boolean(user.is_founder),
        founder_number:        user.founder_number ?? null,
        avatar_url:            user.avatar_url ?? null,
      },
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unexpected Google login error');
    res.status(500).json({ error: 'Unexpected server error. Please try again.' });
  }
});

module.exports = router;

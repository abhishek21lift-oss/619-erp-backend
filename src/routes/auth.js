// src/routes/auth.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const { authenticator } = require('otplib');
const pool   = require('../db/pool');
const logger = require('../lib/logger');
const { auth, adminOnly, invalidateUserCache } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { authSchemas } = require('../lib/validation');
const { sendPasswordReset } = require('../lib/email');

const isProd = process.env.NODE_ENV === 'production';

const ACCESS_TOKEN_TTL_MS  = 15 * 60 * 1000;          // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function setTokenCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: ACCESS_TOKEN_TTL_MS,
    path: '/',
  });
}

function setRefreshCookie(res, rawToken) {
  res.cookie('refresh_token', rawToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: REFRESH_TOKEN_TTL_MS,
    path: '/api/auth',
  });
}

async function issueRefreshToken(res, userId) {
  const rawToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );
  setRefreshCookie(res, rawToken);
  // Returned (not just cookied) so mobile/native clients — which don't share
  // a browser cookie jar — can store it themselves and send it back via
  // Authorization header / request body instead of a cookie.
  return rawToken;
}

async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1', [tokenHash])
    .catch(() => {});
}

// POST /api/auth/login
router.post('/login', validate(authSchemas.login), async (req, res) => {
  try {
    const { email, password } = req.body;

    // ── Fetch user from DB ─────────────────────────────
    let rows;
    try {
      const result = await pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.password, u.token_version,
                u.trainer_id, u.member_id, u.is_active,
                u.organization_id, o.name AS organization_name, o.logo_url AS organization_logo_url
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
          WHERE LOWER(u.email) = LOWER($1) AND u.is_active = true`,
        [email]
      );
      rows = result.rows;
    } catch (dbErr) {
      logger.error({ err: dbErr.message }, 'Login DB error');
      return res.status(500).json({ error: 'Database connection error. Please try again.' });
    }

    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    // ── Verify password ────────────────────────────────
    let valid = false;
    try {
      valid = await bcrypt.compare(password, user.password);
    } catch (bcryptErr) {
      logger.error({ err: bcryptErr.message }, 'bcrypt error');
      return res.status(500).json({ error: 'Authentication error. Please try again.' });
    }

    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    // ── 2FA enforcement for platform super admins ──────
    // A super_admin operates the whole platform, so their account MUST be
    // second-factor protected. If they have TOTP enabled, a valid 6-digit code
    // is required here. If they have not enrolled yet, login is allowed (so
    // they can reach Settings to set it up) but flagged mfaSetupRequired — the
    // super-admin API itself is blocked until 2FA is on (requireSuperAdmin).
    let mfaSetupRequired = false;
    if (user.role === 'super_admin') {
      let mfaEnabled = false;
      let mfaSecret = null;
      try {
        const { rows: mrows } = await pool.query(
          'SELECT mfa_enabled, mfa_secret FROM user_profiles WHERE user_id = $1', [user.id]
        );
        mfaEnabled = !!(mrows[0] && mrows[0].mfa_enabled);
        mfaSecret = mrows[0] && mrows[0].mfa_secret;
      } catch (mfaErr) {
        // user_profiles may not exist pre-migration — treat as not enrolled.
        logger.warn({ err: mfaErr.message }, 'super_admin mfa lookup failed');
      }
      if (mfaEnabled) {
        const code = String(req.body.mfa_code || '').trim();
        if (!code) return res.status(401).json({ error: 'MFA code required', mfaRequired: true });
        if (!/^\d{6}$/.test(code) || !authenticator.check(code, mfaSecret, { window: 1 })) {
          return res.status(401).json({ error: 'Invalid MFA code', mfaRequired: true });
        }
      } else {
        mfaSetupRequired = true;
      }
    }

    // ── Update last login (non-critical, don't block on failure) ──
    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
      .catch(function(err) { logger.warn({ err: err.message }, 'last_login update failed (non-critical)'); });

    // ── Sign JWT ───────────────────────────────────────
    let token;
    try {
      token = jwt.sign(
        { id: user.id, token_version: user.token_version },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
      );
    } catch (jwtErr) {
      logger.error({ err: jwtErr.message }, 'JWT sign error');
      return res.status(500).json({ error: 'Token generation failed. Contact administrator.' });
    }

    setTokenCookie(res, token);
    let refreshToken;
    try {
      refreshToken = await issueRefreshToken(res, user.id);
    } catch (rfErr) {
      logger.warn({ err: rfErr.message }, 'refresh_token issue failed (non-critical, table may not exist yet)');
    }

    // Web keeps using the httpOnly cookies set above and can ignore these
    // fields entirely. Mobile/native clients have no browser cookie jar, so
    // they read the tokens here, store them in secure on-device storage,
    // and send them back via `Authorization: Bearer <token>` (already
    // supported by the auth middleware) and a `refresh_token` body field.
    res.json({
      user: {
        id:                user.id,
        name:              user.name,
        email:             user.email,
        role:              user.role,
        trainer_id:        user.trainer_id,
        member_id:         user.member_id,
        organization_id:       user.organization_id,
        organization_name:     user.organization_name,
        organization_logo_url: user.organization_logo_url,
        mfaSetupRequired,
      },
      token,
      refresh_token: refreshToken,
    });

  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unexpected login error');
    res.status(500).json({ error: 'Unexpected server error. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', async function(req, res) {
  // Mobile clients have no refresh_token cookie to read — accept it from
  // the body as a fallback so they can revoke their session too.
  await revokeRefreshToken(req.cookies?.refresh_token || req.body?.refresh_token);
  res.clearCookie('token', { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/' });
  res.clearCookie('refresh_token', { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/api/auth' });
  res.json({ message: 'Logged out' });
});

// POST /api/auth/refresh — exchange a valid refresh token for a new access token (token rotation)
router.post('/refresh', async (req, res) => {
  const rawToken = req.cookies?.refresh_token || req.body?.refresh_token;
  const isMobile = !req.cookies?.refresh_token;
  if (!rawToken) return res.status(401).json({ error: 'No refresh token' });

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  try {
    const { rows } = await pool.query(
      `SELECT rt.user_id, u.token_version, u.is_active, u.deleted_at
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
          AND rt.expires_at > NOW()
          AND rt.revoked_at IS NULL`,
      [tokenHash]
    );

    if (!rows[0] || !rows[0].is_active || rows[0].deleted_at) {
      res.clearCookie('refresh_token', { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/api/auth' });
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const { user_id, token_version } = rows[0];

    // Rotate: revoke old token, issue new ones
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1', [tokenHash]);

    const newAccessToken = jwt.sign(
      { id: user_id, token_version },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );
    setTokenCookie(res, newAccessToken);
    const newRefreshToken = await issueRefreshToken(res, user_id);

    res.json(isMobile ? { ok: true, token: newAccessToken, refresh_token: newRefreshToken } : { ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'Token refresh error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    const { rows } = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (rows.length) {
      await pool.query(
        // M-07: 15-minute window — was 1 hour, which gave too large an interception window
      'UPDATE users SET password_reset_token = $1, password_reset_expires = NOW() + INTERVAL \'15 minutes\' WHERE id = $2',
        [hashedToken, rows[0].id]
      );
      // FIX: await + .catch so email failures are logged instead of silently swallowed
      sendPasswordReset(email, rawToken)
        .catch(function(err) { logger.warn({ err: err.message }, 'Password reset email failed (non-critical)'); });
    }

    // Always return success — don't reveal if email exists
    res.json({ message: 'If the email exists, a reset link has been sent.' });
  } catch (err) {
    logger.error({ err: err.message }, 'Forgot password error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const { rows } = await pool.query(
      'SELECT id FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW()',
      [hashedToken]
    );

    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hashed = await bcrypt.hash(password, 12);
    await pool.query(
      'UPDATE users SET password = $1, token_version = token_version + 1, password_reset_token = NULL, password_reset_expires = NULL, updated_at = NOW() WHERE id = $2',
      [hashed, rows[0].id]
    );
    invalidateUserCache(rows[0].id);

    res.json({ message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) {
    logger.error({ err: err.message }, 'Reset password error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// PUT /api/auth/change-password
// Also accepts POST for backwards compatibility with older frontend builds
async function changePasswordHandler(req, res) {
  try {
    // Accept both new and legacy field names so a stale frontend still works
    const currentPassword = (
      req.body.currentPassword ?? req.body.current ?? req.body.oldPassword ?? ''
    ).trim();
    const newPassword = (
      req.body.newPassword ?? req.body.newPw ?? req.body.password ?? ''
    ).trim();

    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both current and new password are required' });
    // L-03: standardise to 8 chars minimum across all password flows
    if (typeof newPassword !== 'string' || newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const { rows } = await pool.query(
      'SELECT password FROM users WHERE id = $1', [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password = $1, token_version = token_version + 1, updated_at = NOW() WHERE id = $2',
      [hashed, req.user.id]
    );
    invalidateUserCache(req.user.id);
    const { rows: updated } = await pool.query(
      'SELECT token_version FROM users WHERE id = $1', [req.user.id]
    );
    const newToken = jwt.sign(
      { id: req.user.id, token_version: updated[0].token_version },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );
    setTokenCookie(res, newToken);
    await revokeRefreshToken(req.cookies?.refresh_token);
    try { await issueRefreshToken(res, req.user.id); } catch { /* non-critical */ }
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    logger.error({ err: err.message }, 'Change password error');
    res.status(500).json({ error: 'Server error' });
  }
}
router.put('/change-password', auth, validate(authSchemas.changePassword), changePasswordHandler);
router.post('/change-password', auth, validate(authSchemas.changePassword), changePasswordHandler);

// POST /api/auth/create-user  (admin only)
// Also accepts /users for compatibility with older frontend builds
const ALLOWED_ROLES = ['admin', 'manager', 'trainer', 'reception', 'member'];

async function createUserHandler(req, res) {
  try {
    const { name, email, password, role = 'trainer', trainer_id, member_id } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!ALLOWED_ROLES.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${ALLOWED_ROLES.join(', ')}` });

    // If a trainer_id is supplied, make sure it actually exists. Otherwise
    // we'd happily create an orphaned link that breaks the dashboard later.
    if (trainer_id) {
      const { rows: t } = await pool.query('SELECT 1 FROM trainers WHERE id = $1', [trainer_id]);
      if (!t.length) return res.status(400).json({ error: 'trainer_id does not match an existing trainer' });
    }

    const { rows: exists } = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]
    );
    if (exists.length) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO users (id, name, email, password, role, trainer_id, member_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, name.trim(), email.toLowerCase().trim(), hashed, role, trainer_id || null, member_id || null]
    );
    res.status(201).json({ message: 'User created', user: { id, name, email: email.toLowerCase(), role } });
  } catch (err) {
    logger.error({ err: err.message }, 'Create user error');
    res.status(500).json({ error: 'Server error' });
  }
}
router.post('/create-user', auth, adminOnly, validate(authSchemas.createUser), createUserHandler);
// Compatibility alias — the frontend at one point posted here
router.post('/users', auth, adminOnly, validate(authSchemas.createUser), createUserHandler);

// GET /api/auth/users  (admin only)
router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { rows } = await pool.query(
      'SELECT id, name, email, role, trainer_id, is_active, last_login, created_at FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/users/:id (admin only) — update name, email, role, status
router.put('/users/:id', auth, adminOnly, async (req, res) => {
  if (req.params.id === req.user.id && req.body.role && req.body.role !== req.user.role)
    return res.status(400).json({ error: 'Cannot change your own role' });
  try {
    const allowed = ['name', 'email', 'role'];
    const updates = [];
    const vals = [];
    let idx = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${idx++}`);
        vals.push(req.body[key]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} AND deleted_at IS NULL RETURNING id, name, email, role`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    invalidateUserCache(req.params.id);
    res.json({ message: 'Updated', user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/users/:id/toggle  (admin only)
router.put('/users/:id/toggle', auth, adminOnly, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot disable yourself' });
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_active = NOT is_active, token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING id, is_active',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    invalidateUserCache(req.params.id);
    res.json({ message: 'Updated', is_active: rows[0].is_active });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/auth/users/:id (admin only)
// FIX: soft delete — sets deleted_at and bumps token_version so existing tokens are immediately revoked.
// Hard delete left a dangling reference risk and bypassed the deleted_at guard in auth middleware.
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  try {
    const { rows } = await pool.query(
      `UPDATE users
          SET deleted_at = NOW(),
              is_active = false,
              token_version = token_version + 1,
              updated_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found or already deleted' });
    invalidateUserCache(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

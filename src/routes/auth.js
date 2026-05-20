// src/routes/auth.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const logger = require('../lib/logger');
const { auth, adminOnly, invalidateUserCache } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { authSchemas } = require('../lib/validation');

// POST /api/auth/login
router.post('/login', validate(authSchemas.login), async (req, res) => {
  try {
    const { email, password } = req.body;

    // ── Fetch user from DB ─────────────────────────────
    let rows;
    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true',
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

    // ── Update last login (non-critical, don't block on failure) ──
    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
      .catch(function(err) { logger.warn({ err: err.message }, 'last_login update failed (non-critical)'); });

    // ── Sign JWT ───────────────────────────────────────
    let token;
    try {
      token = jwt.sign(
        { id: user.id },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
    } catch (jwtErr) {
      logger.error({ err: jwtErr.message }, 'JWT sign error');
      return res.status(500).json({ error: 'Token generation failed. Contact administrator.' });
    }

    res.json({
      token,
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        trainer_id: user.trainer_id,
        member_id:  user.member_id,
      },
    });

  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unexpected login error');
    res.status(500).json({ error: 'Unexpected server error. Please try again.' });
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
    const currentPassword =
      req.body.currentPassword ?? req.body.current ?? req.body.oldPassword;
    const newPassword =
      req.body.newPassword ?? req.body.newPw ?? req.body.password;

    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both current and new password are required' });
    if (typeof newPassword !== 'string' || newPassword.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const { rows } = await pool.query(
      'SELECT password FROM users WHERE id = $1', [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
      [hashed, req.user.id]
    );
    invalidateUserCache(req.user.id);
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
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
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

    const hashed = await bcrypt.hash(password, 10);
    const id = uuid();
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
    const { rows } = await pool.query(
      'SELECT id, name, email, role, trainer_id, is_active, last_login, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/users/:id/toggle  (admin only)
router.put('/users/:id/toggle', auth, adminOnly, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot disable yourself' });
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING id, is_active',
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
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    invalidateUserCache(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

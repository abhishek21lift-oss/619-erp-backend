'use strict';
// Super Admin platform API (multi-tenant SaaS — Phase 2).
//
// The hidden admin portal that only platform operators (role='super_admin')
// can reach. Mounted with `auth` + `requireSuperAdmin` applied at the mount
// point, so every handler here runs as an authenticated super admin.
//
// Manages tenants (organizations) and their login accounts:
//   GET    /organizations                 list all tenants + usage counts
//   POST   /organizations                 create org + owner trainer + admin login (atomic)
//   GET    /organizations/:id             one tenant + its users
//   PATCH  /organizations/:id             rename / suspend / reactivate
//   PATCH  /users/:id                     activate / deactivate a single account
//   POST   /users/:id/reset-password      set a new password + kill existing sessions
//
// SECURITY: platform-level only. Tenant admins (role='admin') never reach here.
// Every mutation is written to activity_log for audit.

const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { invalidateUserCache } = require('../../middleware/auth');

// ── Helpers ────────────────────────────────────────────────────────────────
function slugify(name) {
  return String(name || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'org';
}

async function uniqueSlug(base) {
  let slug = base;
  for (let i = 0; i < 5; i++) {
    const { rows } = await pool.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
    if (!rows.length) return slug;
    slug = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function audit(req, action, entityType, entityId, data) {
  try {
    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, new_data, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.user?.id || null, req.user?.name || null, action, entityType,
       entityId || null, data || {}, req.ip || null, req.get('user-agent') || null]
    );
  } catch (err) {
    logger.warn({ err: err.message, action }, 'super-admin audit log write failed');
  }
}

// ── GET /organizations ───────────────────────────────────────────────────────
router.get('/organizations', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.slug, o.status, o.created_at,
             (SELECT count(*) FROM users u    WHERE u.organization_id = o.id AND u.deleted_at IS NULL)    AS user_count,
             (SELECT count(*) FROM trainers t WHERE t.organization_id = o.id AND t.deleted_at IS NULL)     AS trainer_count,
             (SELECT count(*) FROM pt_clients c
                 JOIN trainers t ON t.id = c.trainer_id
                WHERE t.organization_id = o.id AND c.deleted_at IS NULL)                                   AS client_count
        FROM organizations o
       ORDER BY o.created_at DESC`);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /organizations/:id ────────────────────────────────────────────────────
router.get('/organizations/:id', async (req, res, next) => {
  try {
    const { rows: orgs } = await pool.query('SELECT * FROM organizations WHERE id = $1', [req.params.id]);
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    const { rows: users } = await pool.query(
      `SELECT id, name, email, role, trainer_id, is_active, last_login, created_at
         FROM users WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [req.params.id]
    );
    res.json({ data: { ...orgs[0], users } });
  } catch (err) { next(err); }
});

// ── POST /organizations ───────────────────────────────────────────────────────
// Creates a tenant workspace in one transaction: the organization, its owner
// trainer record, and the trainer's login (role='admin' — full control of
// their own isolated workspace; the platform god is role='super_admin').
router.post('/organizations', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgName = String(req.body.name || '').trim();
    const trainerName = String(req.body.trainer_name || orgName).trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!orgName) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Organization name is required' } });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A valid login email is required' } });
    if (password.length < 8) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Password must be at least 8 characters' } });

    const { rows: dupe } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (dupe.length) return res.status(409).json({ error: { code: 'CONFLICT', message: 'That login email is already in use' } });

    const slug = await uniqueSlug(slugify(orgName));
    const hashed = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();

    await client.query('BEGIN');
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, slug, status) VALUES ($1,$2,'active') RETURNING *`,
      [orgName, slug]
    );
    const org = orgRows[0];
    const { rows: trainerRows } = await client.query(
      `INSERT INTO trainers (name, email, organization_id) VALUES ($1,$2,$3) RETURNING id`,
      [trainerName, email, org.id]
    );
    const trainerId = trainerRows[0].id;
    await client.query(
      `INSERT INTO users (id, name, email, password, role, trainer_id, organization_id, is_active)
       VALUES ($1,$2,$3,$4,'admin',$5,$6,true)`,
      [userId, trainerName, email, hashed, trainerId, org.id]
    );
    await client.query('COMMIT');

    await audit(req, 'org_created', 'organization', org.id, { name: orgName, slug, owner_email: email });
    res.status(201).json({ data: { organization: org, owner: { id: userId, name: trainerName, email, role: 'admin', trainer_id: trainerId } } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── PATCH /organizations/:id ──────────────────────────────────────────────────
// Rename and/or change status. Suspending an org deactivates all its logins
// and revokes their sessions; reactivating restores them.
router.patch('/organizations/:id', async (req, res, next) => {
  try {
    const { name, status } = req.body;
    if (status && !['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: "status must be 'active' or 'suspended'" } });
    }

    const sets = [];
    const params = [req.params.id];
    if (name !== undefined)   { params.push(String(name).trim()); sets.push(`name = $${params.length}`); }
    if (status !== undefined) { params.push(status);              sets.push(`status = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Nothing to update' } });
    sets.push('updated_at = now()');

    const { rows } = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    if (status === 'suspended') {
      await pool.query(
        `UPDATE users SET is_active = false, token_version = token_version + 1 WHERE organization_id = $1`,
        [req.params.id]
      );
      invalidateUserCache();
    } else if (status === 'active') {
      await pool.query(
        `UPDATE users SET is_active = true, token_version = token_version + 1 WHERE organization_id = $1`,
        [req.params.id]
      );
      invalidateUserCache();
    }

    await audit(req, 'org_updated', 'organization', req.params.id, { name, status });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /users/:id ──────────────────────────────────────────────────────────
// Activate / deactivate a single login. Deactivating revokes existing sessions.
router.patch('/users/:id', async (req, res, next) => {
  try {
    if (typeof req.body.is_active !== 'boolean') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'is_active (boolean) is required' } });
    }
    const { rows } = await pool.query(
      `UPDATE users SET is_active = $2, token_version = token_version + 1, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, name, email, role, organization_id, is_active`,
      [req.params.id, req.body.is_active]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    invalidateUserCache(req.params.id);
    await audit(req, req.body.is_active ? 'user_activated' : 'user_deactivated', 'user', req.params.id, {});
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /users/:id/reset-password ────────────────────────────────────────────
// Sets a new password and revokes all existing sessions for that account.
router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 8) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Password must be at least 8 characters' } });
    }
    const hashed = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `UPDATE users SET password = $2, token_version = token_version + 1, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, email`,
      [req.params.id, hashed]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    invalidateUserCache(req.params.id);
    await audit(req, 'user_password_reset', 'user', req.params.id, {});
    res.json({ data: { id: rows[0].id, message: 'Password reset. Existing sessions revoked.' } });
  } catch (err) { next(err); }
});

module.exports = router;

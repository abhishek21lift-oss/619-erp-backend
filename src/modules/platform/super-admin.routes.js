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
const jwt = require('jsonwebtoken');
const multer = require('multer');
const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { saveFile } = require('../../lib/fileStorage');
const { invalidateUserCache } = require('../../middleware/auth');

// Roles a tenant login may hold (never 'super_admin' — that is platform-only and
// cannot be created, edited, or impersonated through this tenant-facing portal).
const TENANT_ROLES = ['admin', 'manager', 'trainer', 'member'];
// How long a read-only impersonation session stays valid before the operator
// must re-enter the studio. Short by design — impersonation is a spot check.
const IMPERSONATION_TTL = process.env.IMPERSONATION_TTL || '30m';

// ── Logo upload (per-studio branding) ───────────────────────────────────────
// memoryStorage + magic-byte sniff (MIME header alone can be spoofed), same
// pattern as the PAR-Q/consent document uploads.
const LOGO_MAX_BYTES = parseInt(process.env.ORG_LOGO_MAX_BYTES, 10) || 2 * 1024 * 1024; // 2MB
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype || '')) {
      return cb(new Error('Only PNG, JPG, or WEBP images are allowed'));
    }
    cb(null, true);
  },
});
const LOGO_SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg',  magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  ext: 'png',  magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" (WEBP container)
];
function detectLogoType(buf) {
  for (const sig of LOGO_SIGNATURES) {
    if (sig.magic.every((b, i) => buf[i] === b)) return sig;
  }
  return null;
}

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
// Edit a tenant login: name, email, role, and/or activate/deactivate. Changing
// role or is_active bumps token_version so the account re-authenticates with its
// new powers (and a deactivation immediately revokes existing sessions).
// Platform (super_admin) accounts cannot be edited through this portal.
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (existing[0].role === 'super_admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Platform accounts cannot be edited here' } });
    }

    const { name, email, role, is_active } = req.body;
    const sets = [];
    const params = [req.params.id];
    let securityChange = false;

    if (name !== undefined) {
      const v = String(name).trim();
      if (!v) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Name cannot be empty' } });
      params.push(v); sets.push(`name = $${params.length}`);
    }
    if (email !== undefined) {
      const v = String(email).trim().toLowerCase();
      if (!EMAIL_RE.test(v)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A valid email is required' } });
      const { rows: dupe } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2', [v, req.params.id]);
      if (dupe.length) return res.status(409).json({ error: { code: 'CONFLICT', message: 'That email is already in use' } });
      params.push(v); sets.push(`email = $${params.length}`);
    }
    if (role !== undefined) {
      if (!TENANT_ROLES.includes(role)) return res.status(400).json({ error: { code: 'VALIDATION', message: `role must be one of: ${TENANT_ROLES.join(', ')}` } });
      params.push(role); sets.push(`role = $${params.length}`); securityChange = true;
    }
    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') return res.status(400).json({ error: { code: 'VALIDATION', message: 'is_active must be a boolean' } });
      params.push(is_active); sets.push(`is_active = $${params.length}`); securityChange = true;
    }
    if (!sets.length) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Nothing to update' } });
    if (securityChange) sets.push('token_version = token_version + 1');
    sets.push('updated_at = now()');

    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')}
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, name, email, role, organization_id, is_active`,
      params
    );
    invalidateUserCache(req.params.id);
    const action = is_active === false ? 'user_deactivated' : is_active === true ? 'user_activated' : 'user_updated';
    await audit(req, action, 'user', req.params.id, { name, email, role, is_active });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /organizations/:id/users ─────────────────────────────────────────────
// Add another login account to a studio (beyond the owner created with the org).
router.post('/organizations/:id/users', async (req, res, next) => {
  try {
    const { rows: orgs } = await pool.query('SELECT id FROM organizations WHERE id = $1', [req.params.id]);
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = req.body.role || 'admin';

    if (!name) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Name is required' } });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: { code: 'VALIDATION', message: 'A valid email is required' } });
    if (password.length < 8) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Password must be at least 8 characters' } });
    if (!TENANT_ROLES.includes(role)) return res.status(400).json({ error: { code: 'VALIDATION', message: `role must be one of: ${TENANT_ROLES.join(', ')}` } });

    const { rows: dupe } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (dupe.length) return res.status(409).json({ error: { code: 'CONFLICT', message: 'That email is already in use' } });

    const hashed = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       RETURNING id, name, email, role, organization_id, is_active, created_at`,
      [userId, name, email, hashed, role, req.params.id]
    );
    await audit(req, 'user_created', 'user', userId, { email, role, organization_id: req.params.id });
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /users/:id ─────────────────────────────────────────────────────────
// Soft-delete a tenant login and revoke its sessions. Guards: cannot delete the
// platform account, yourself, or a studio's last remaining active admin.
router.delete('/users/:id', async (req, res, next) => {
  try {
    if (req.params.id === req.user?.id) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'You cannot delete your own account' } });
    }
    const { rows: existing } = await pool.query(
      `SELECT id, role, organization_id FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    const target = existing[0];
    if (target.role === 'super_admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Platform accounts cannot be deleted here' } });
    }
    if (target.role === 'admin' && target.organization_id) {
      const { rows: [{ count }] } = await pool.query(
        `SELECT count(*)::int AS count FROM users
          WHERE organization_id = $1 AND role = 'admin' AND is_active = true AND deleted_at IS NULL AND id <> $2`,
        [target.organization_id, req.params.id]
      );
      if (count === 0) {
        return res.status(409).json({ error: { code: 'LAST_ADMIN', message: "Cannot delete a studio's last active admin. Add another admin first." } });
      }
    }
    await pool.query(
      `UPDATE users SET deleted_at = now(), is_active = false, token_version = token_version + 1, updated_at = now()
        WHERE id = $1`,
      [req.params.id]
    );
    invalidateUserCache(req.params.id);
    await audit(req, 'user_deleted', 'user', req.params.id, { role: target.role, organization_id: target.organization_id });
    res.json({ data: { id: req.params.id, message: 'Account removed and sessions revoked.' } });
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

// POST /organizations/:id/logo — upload/replace a studio's logo image.
router.post('/organizations/:id/logo', logoUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Logo file is required' } });
    const detected = detectLogoType(req.file.buffer);
    if (!detected) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'File is not a valid PNG, JPG, or WEBP image' } });
    }
    const { rows: orgRows } = await pool.query('SELECT id FROM organizations WHERE id = $1', [req.params.id]);
    if (!orgRows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    const filename = `${req.params.id}-${Date.now()}.${detected.ext}`;
    const url = await saveFile('org-logos', filename, req.file.buffer, detected.mime);
    const { rows } = await pool.query(
      'UPDATE organizations SET logo_url = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [req.params.id, url]
    );
    await audit(req, 'org_logo_updated', 'organization', req.params.id, { logo_url: url });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /overview ─────────────────────────────────────────────────────────────
// Cross-studio command-centre dashboard: one row of KPIs per studio plus rolled-
// up platform totals. Revenue is collected cash (SUM paid_amount); outstanding is
// balances still owed. Sessions counted for the current calendar month.
router.get('/overview', async (req, res, next) => {
  try {
    const { rows: studios } = await pool.query(`
      SELECT o.id, o.name, o.slug, o.status, o.logo_url, o.created_at,
        (SELECT count(*) FROM users u
           WHERE u.organization_id = o.id AND u.deleted_at IS NULL AND u.role = 'admin')::int              AS admin_count,
        (SELECT max(u.last_login) FROM users u
           WHERE u.organization_id = o.id AND u.deleted_at IS NULL)                                        AS last_login,
        (SELECT count(*) FROM pt_clients c
           WHERE c.organization_id = o.id AND c.deleted_at IS NULL)::int                                   AS total_clients,
        (SELECT count(*) FROM pt_clients c
           WHERE c.organization_id = o.id AND c.deleted_at IS NULL AND c.status = 'active')::int           AS active_clients,
        (SELECT COALESCE(SUM(c.paid_amount), 0) FROM pt_clients c
           WHERE c.organization_id = o.id AND c.deleted_at IS NULL)                                        AS revenue,
        (SELECT COALESCE(SUM(c.balance_amount), 0) FROM pt_clients c
           WHERE c.organization_id = o.id AND c.deleted_at IS NULL)                                        AS outstanding,
        (SELECT count(*) FROM pt_sessions s
           WHERE s.organization_id = o.id AND s.session_date >= date_trunc('month', CURRENT_DATE))::int    AS sessions_this_month
      FROM organizations o
      ORDER BY o.created_at DESC`);

    const totals = studios.reduce((t, s) => ({
      studios: t.studios + 1,
      active_studios: t.active_studios + (s.status === 'active' ? 1 : 0),
      suspended_studios: t.suspended_studios + (s.status === 'suspended' ? 1 : 0),
      total_clients: t.total_clients + Number(s.total_clients || 0),
      active_clients: t.active_clients + Number(s.active_clients || 0),
      revenue: t.revenue + Number(s.revenue || 0),
      outstanding: t.outstanding + Number(s.outstanding || 0),
      sessions_this_month: t.sessions_this_month + Number(s.sessions_this_month || 0),
    }), {
      studios: 0, active_studios: 0, suspended_studios: 0, total_clients: 0,
      active_clients: 0, revenue: 0, outstanding: 0, sessions_this_month: 0,
    });

    res.json({ data: { totals, studios } });
  } catch (err) { next(err); }
});

// ── GET /activity ─────────────────────────────────────────────────────────────
// Platform-wide audit feed. Filter by studio (org_id), user, or action. The
// activity_log has no org column, so studio is resolved through the acting user.
router.get('/activity', async (req, res, next) => {
  try {
    const orgId  = req.query.org_id  || null;
    const userId = req.query.user_id || null;
    const action = req.query.action  || null;
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows } = await pool.query(`
      SELECT a.id, a.user_id, a.user_name, a.action, a.entity_type, a.entity_id,
             a.new_data, a.ip_address, a.created_at,
             u.organization_id, o.name AS organization_name
        FROM activity_log a
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN organizations o ON o.id = u.organization_id
       WHERE ($1::uuid IS NULL OR u.organization_id = $1::uuid)
         AND ($2::uuid IS NULL OR a.user_id = $2::uuid)
         AND ($3::text IS NULL OR a.action = $3)
       ORDER BY a.created_at DESC
       LIMIT $4 OFFSET $5`,
      [orgId, userId, action, limit, offset]
    );
    res.json({ data: rows, paging: { limit, offset, count: rows.length } });
  } catch (err) { next(err); }
});

// ── POST /organizations/:id/impersonate ───────────────────────────────────────
// Mint a short-lived, READ-ONLY access token for a studio's admin so the operator
// can enter the workspace and see exactly what that admin sees. The token carries
// an `imp` claim; the auth middleware loads the target admin as req.user (so the
// whole app renders as them) and rejects every write while `imp.ro` is set. The
// operator's own super-admin session is untouched — the client sends this token
// via Authorization header and simply drops it to exit. No refresh token issued.
router.post('/organizations/:id/impersonate', async (req, res, next) => {
  try {
    const { rows: orgs } = await pool.query(
      'SELECT id, name, slug, logo_url, status FROM organizations WHERE id = $1', [req.params.id]
    );
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    const org = orgs[0];

    // Target: an explicit user in this org, else the studio's primary admin.
    let target;
    if (req.body.user_id) {
      const { rows } = await pool.query(
        `SELECT id, name, email, role, token_version, is_active FROM users
          WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [req.body.user_id, org.id]
      );
      target = rows[0];
    } else {
      const { rows } = await pool.query(
        `SELECT id, name, email, role, token_version, is_active FROM users
          WHERE organization_id = $1 AND role = 'admin' AND deleted_at IS NULL
          ORDER BY is_active DESC, created_at ASC LIMIT 1`,
        [org.id]
      );
      target = rows[0];
    }

    if (!target) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No admin account to impersonate in this studio' } });
    if (target.role === 'super_admin') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot impersonate a platform account' } });
    if (!target.is_active) return res.status(409).json({ error: { code: 'INACTIVE', message: 'That account is deactivated' } });

    // Mode: read-only by default (safe). 'full' allows writes as the admin — every
    // audited write during that window is stamped with who really acted
    // (_impersonated_by) by the shared activity logger.
    const readonly = req.body.mode !== 'full';

    const token = jwt.sign(
      {
        id: target.id,
        token_version: target.token_version,
        imp: { by: req.user.id, byName: req.user.name || 'Super Admin', ro: readonly, org: org.id },
      },
      process.env.JWT_SECRET,
      { expiresIn: IMPERSONATION_TTL }
    );

    await audit(req, 'user_impersonated', 'user', target.id, { organization_id: org.id, readonly, mode: readonly ? 'read_only' : 'full' });
    res.json({
      data: {
        token,
        readonly,
        admin: { id: target.id, name: target.name, email: target.email, role: target.role },
        organization: { id: org.id, name: org.name, slug: org.slug, logo_url: org.logo_url },
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;

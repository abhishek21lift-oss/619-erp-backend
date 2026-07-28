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
const subscription = require('../../lib/subscription');
const { TRIAL_DAYS } = subscription;

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
    // New studios get a 7-day free trial with all premium features unlocked.
    // organizations.status stays 'active' (that column is the super-admin hard
    // on/off switch); subscription_status drives the billing lifecycle.
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, slug, status, subscription_status, trial_ends_at)
       VALUES ($1,$2,'active','trial', now() + ($3 || ' days')::interval)
       RETURNING *`,
      [orgName, slug, String(TRIAL_DAYS)]
    );
    const org = orgRows[0];
    await client.query(
      `INSERT INTO subscription_events (organization_id, event, data, actor_id, actor_name)
       VALUES ($1,'trial_started',$2,$3,$4)`,
      [org.id, JSON.stringify({ days: TRIAL_DAYS }), req.user?.id || null, req.user?.name || null]
    );
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
         AND ($2::text IS NULL OR a.user_id = $2::text)
         AND ($3::text IS NULL OR a.action = $3)
       ORDER BY a.created_at DESC
       LIMIT $4 OFFSET $5`,
      [orgId, userId, action, limit, offset]
    );
    res.json({ data: rows, paging: { limit, offset, count: rows.length } });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN MANAGEMENT — operator actions on a studio's login accounts
//
//  These sit beside the existing reset-password / activate-deactivate
//  handlers above. All four are platform-only and every one is audited.
// ═══════════════════════════════════════════════════════════════════════════

// Loads a tenant user, refusing to touch a super_admin. The tenant portal must
// never be able to act on a platform operator's own account — same guard the
// existing user handlers apply.
async function loadTenantUser(id) {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, organization_id FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]
  );
  const u = rows[0];
  if (!u) return { error: 'NOT_FOUND' };
  if (!TENANT_ROLES.includes(u.role)) return { error: 'FORBIDDEN' };
  return { user: u };
}

// ── POST /users/:id/force-logout ─────────────────────────────────────────────
// Revokes every live session for one account by bumping token_version, which
// the auth middleware compares against the claim in each JWT. Deliberately
// does not touch the password: "sign this person out everywhere" and "lock
// them out" are different operator intents and conflating them is how support
// accidentally locks a paying admin out of their own studio.
router.post('/users/:id/force-logout', async (req, res, next) => {
  try {
    const { user, error } = await loadTenantUser(req.params.id);
    if (error === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (error === 'FORBIDDEN') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot act on a platform account' } });

    const { rows } = await pool.query(
      `UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1
       RETURNING id, token_version`, [req.params.id]
    );
    invalidateUserCache();
    await audit(req, 'user_force_logout', 'user', req.params.id,
      { email: user.email, organization_id: user.organization_id, token_version: rows[0].token_version });
    res.json({ data: { id: rows[0].id, message: 'All sessions revoked' } });
  } catch (err) { next(err); }
});

// ── POST /users/:id/reset-mfa ────────────────────────────────────────────────
// Clears the enrolled authenticator so a locked-out admin can re-enrol. This is
// a support action with real weight — it removes a security factor — so it is
// audited with the previous state, and sessions are revoked alongside it: an
// existing session would otherwise outlive the factor that authorised it.
router.post('/users/:id/reset-mfa', async (req, res, next) => {
  try {
    const { user, error } = await loadTenantUser(req.params.id);
    if (error === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (error === 'FORBIDDEN') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot act on a platform account' } });

    const { rows: before } = await pool.query(
      'SELECT mfa_enabled FROM user_profiles WHERE user_id = $1', [req.params.id]
    );
    const wasEnabled = !!(before[0] && before[0].mfa_enabled);

    await pool.query(
      `UPDATE user_profiles SET mfa_enabled = FALSE, mfa_secret = NULL WHERE user_id = $1`, [req.params.id]
    );
    await pool.query(
      `UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1`, [req.params.id]
    );
    invalidateUserCache();

    await audit(req, 'user_mfa_reset', 'user', req.params.id,
      { email: user.email, organization_id: user.organization_id, was_enabled: wasEnabled });
    res.json({ data: { id: req.params.id, was_enabled: wasEnabled, message: 'Two-factor reset; sessions revoked' } });
  } catch (err) { next(err); }
});

// ── POST /organizations/:id/subscription/bonus-days ──────────────────────────
// Extends the current period (or the trial, when still on one) by N days.
// Separate from PATCH .../expiry, which sets an absolute date: goodwill is
// expressed as "give them another 14 days", and making the operator compute
// the target date by hand is how off-by-one credits happen. The delta is what
// gets audited, so the reason for the new date stays legible later.
const BONUS_DAYS_MAX = 365;

router.post('/organizations/:id/subscription/bonus-days', async (req, res, next) => {
  try {
    const days = parseInt(req.body.days, 10);
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > BONUS_DAYS_MAX) {
      return res.status(400).json({
        error: { code: 'VALIDATION', message: `days must be a non-zero integer within ±${BONUS_DAYS_MAX}` },
      });
    }

    const { rows: orgRows } = await pool.query(
      `SELECT id, name, subscription_status, trial_ends_at, current_period_end
         FROM organizations WHERE id = $1`, [req.params.id]
    );
    const org = orgRows[0];
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    // Extend whichever clock the studio is actually on. A trialling studio has
    // no period end to move, and moving the wrong one silently does nothing.
    const onTrial = org.subscription_status === 'trial' || org.subscription_status === 'trial_expired';
    const field = onTrial ? 'trial_ends_at' : 'current_period_end';
    const current = onTrial ? org.trial_ends_at : org.current_period_end;

    // Extending from today (not from a date already in the past) is what an
    // operator means by "give them 14 more days" on an expired account.
    const base = current && new Date(current) > new Date() ? new Date(current) : new Date();
    const next = new Date(base.getTime() + days * 86400000);

    await pool.query(`UPDATE organizations SET ${field} = $2 WHERE id = $1`, [req.params.id, next.toISOString()]);
    invalidateUserCache();

    await audit(req, 'subscription_bonus_days', 'organization', req.params.id, {
      days, field, from: current, to: next.toISOString(), reason: req.body.reason || null,
    });
    res.json({ data: { id: req.params.id, field, previous: current, [field]: next.toISOString(), days } });
  } catch (err) { next(err); }
});

// ── GET / PUT /organizations/:id/notes ───────────────────────────────────────
// Operator-only scratchpad. Never surfaced on any tenant-facing endpoint — the
// studio's own admins must not see what the platform wrote about them.
router.get('/organizations/:id/notes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT internal_notes, internal_notes_updated_at, internal_notes_updated_by
         FROM organizations WHERE id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

const NOTES_MAX = 20000;

router.put('/organizations/:id/notes', async (req, res, next) => {
  try {
    const notes = typeof req.body.notes === 'string' ? req.body.notes : '';
    if (notes.length > NOTES_MAX) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `notes must be ${NOTES_MAX} characters or fewer` } });
    }

    const { rows: before } = await pool.query('SELECT internal_notes FROM organizations WHERE id = $1', [req.params.id]);
    if (!before[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });

    const { rows } = await pool.query(
      `UPDATE organizations
          SET internal_notes = $2, internal_notes_updated_at = NOW(), internal_notes_updated_by = $3
        WHERE id = $1
        RETURNING internal_notes, internal_notes_updated_at, internal_notes_updated_by`,
      [req.params.id, notes || null, req.user?.name || req.user?.id || null]
    );

    // Length only, not content: the note is operator commentary about a
    // customer and copying it wholesale into a second table is needless
    // duplication of something that may name individuals.
    await audit(req, 'org_notes_updated', 'organization', req.params.id, {
      previous_length: (before[0].internal_notes || '').length,
      new_length: notes.length,
    });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  AUDIT CENTRE
//
//  /activity above is the dashboard's recent-events feed: newest 50, three
//  optional filters, no total. The Audit Centre is the investigative view —
//  "what did this operator change on that studio last Tuesday, and what was
//  the value before?" — so it adds a time window, entity filter, free-text
//  search, a real total for pagination, and old_data alongside new_data.
//  Kept as separate routes rather than growing /activity, so the dashboard
//  feed stays cheap (no COUNT) and its contract is unchanged.
// ═══════════════════════════════════════════════════════════════════════════

// Builds the shared WHERE clause + params for both the list and the export, so
// a CSV can never disagree with the table it was exported from.
function buildAuditFilter(query) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (query.org_id)      add('u.organization_id = $?::uuid', query.org_id);
  if (query.user_id)     add('a.user_id = $?', query.user_id);
  if (query.action)      add('a.action = $?', query.action);
  if (query.entity_type) add('a.entity_type = $?', query.entity_type);
  if (query.from)        add('a.created_at >= $?::timestamptz', query.from);
  // `to` is treated as an inclusive day: the UI sends a date, and an operator
  // asking for activity "to the 5th" means through the end of the 5th.
  if (query.to)          add('a.created_at < ($?::date + INTERVAL \'1 day\')', query.to);
  if (query.q) {
    params.push(`%${query.q}%`);
    const i = params.length;
    where.push(`(a.user_name ILIKE $${i} OR a.action ILIKE $${i} OR a.entity_id ILIKE $${i} OR o.name ILIKE $${i})`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const AUDIT_SELECT = `
  SELECT a.id, a.user_id, a.user_name, a.action, a.entity_type, a.entity_id,
         a.old_data, a.new_data, a.ip_address, a.user_agent, a.created_at,
         u.organization_id, o.name AS organization_name
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN organizations o ON o.id = u.organization_id`;

// ── GET /audit ───────────────────────────────────────────────────────────────
router.get('/audit', async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { clause, params } = buildAuditFilter(req.query);

    // One round trip for the page and one for the total. The count is needed
    // for pagination; running it in parallel keeps the added latency off the
    // critical path rather than doubling it.
    const [rowsRes, countRes] = await Promise.all([
      pool.query(`${AUDIT_SELECT} ${clause} ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS total FROM activity_log a
                    LEFT JOIN users u ON u.id = a.user_id
                    LEFT JOIN organizations o ON o.id = u.organization_id ${clause}`, params),
    ]);

    res.json({
      data: rowsRes.rows,
      paging: { limit, offset, total: countRes.rows[0].total, count: rowsRes.rows.length },
    });
  } catch (err) { next(err); }
});

// ── GET /audit/filters ───────────────────────────────────────────────────────
// Distinct actions and entity types actually present, so the filter dropdowns
// offer what exists rather than a hardcoded list that drifts from reality.
router.get('/audit/filters', async (req, res, next) => {
  try {
    const [actions, entities] = await Promise.all([
      pool.query(`SELECT DISTINCT action AS v FROM activity_log WHERE action IS NOT NULL AND action <> '' ORDER BY 1`),
      pool.query(`SELECT DISTINCT entity_type AS v FROM activity_log WHERE entity_type IS NOT NULL AND entity_type <> '' ORDER BY 1`),
    ]);
    res.json({ actions: actions.rows.map(r => r.v), entity_types: entities.rows.map(r => r.v) });
  } catch (err) { next(err); }
});

// ── GET /audit/export ────────────────────────────────────────────────────────
// CSV of the *same* filtered set, capped so one click cannot stream an
// unbounded table into memory. Honours the identical filter builder as the
// list route, so the export always matches what the operator is looking at.
const AUDIT_EXPORT_MAX = 10000;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Escape per RFC 4180. The leading-character guard defuses spreadsheet
  // formula injection: a logged value beginning =, +, - or @ would otherwise
  // execute when the CSV is opened in Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

router.get('/audit/export', async (req, res, next) => {
  try {
    const { clause, params } = buildAuditFilter(req.query);
    const { rows } = await pool.query(
      `${AUDIT_SELECT} ${clause} ORDER BY a.created_at DESC LIMIT $${params.length + 1}`,
      [...params, AUDIT_EXPORT_MAX]
    );

    const header = ['Timestamp', 'Actor', 'Actor ID', 'Studio', 'Action', 'Entity Type',
                    'Entity ID', 'Previous Value', 'New Value', 'IP', 'User Agent'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.created_at ? new Date(r.created_at).toISOString() : '',
        r.user_name, r.user_id, r.organization_name, r.action, r.entity_type,
        r.entity_id, r.old_data, r.new_data, r.ip_address, r.user_agent,
      ].map(csvCell).join(','));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`);
    // Exporting the audit trail is itself an auditable act.
    await audit(req, 'audit_exported', 'audit_log', null, { rows: rows.length, filters: req.query });
    // BOM so Excel opens UTF-8 names correctly instead of mojibake.
    res.send('﻿' + lines.join('\n'));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SYSTEM HEALTH
//
//  Live introspection, deliberately with no table of its own: anything
//  persisted here would be a second copy of the truth that can go stale.
//  Everything below is measured at request time.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/system-health', async (req, res, next) => {
  try {
    const started = Date.now();
    let db = { status: 'down', latency_ms: null, error: null };
    let migrations = { applied: null, latest: null, applied_at: null };
    let dbSize = null;

    try {
      const t0 = Date.now();
      await pool.query('SELECT 1');
      db = { status: 'up', latency_ms: Date.now() - t0, error: null };

      const [mig, size] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS applied,
                           (SELECT filename   FROM _migrations ORDER BY id DESC LIMIT 1) AS latest,
                           (SELECT applied_at FROM _migrations ORDER BY id DESC LIMIT 1) AS applied_at
                      FROM _migrations`),
        pool.query(`SELECT pg_database_size(current_database())::bigint AS bytes`),
      ]);
      migrations = mig.rows[0];
      dbSize = Number(size.rows[0].bytes);
    } catch (err) {
      db = { status: 'down', latency_ms: null, error: err.message };
    }

    // Error volume over the last 24h, read from the audit trail rather than
    // log files — log files are not queryable from here and rotate away.
    let errors24h = null;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM activity_log
          WHERE created_at > NOW() - INTERVAL '24 hours' AND action ILIKE '%fail%'`);
      errors24h = rows[0].n;
    } catch { /* non-fatal: health must still render if this query fails */ }

    const mem = process.memoryUsage();
    res.json({
      checked_at: new Date().toISOString(),
      check_duration_ms: Date.now() - started,
      database: {
        ...db,
        size_bytes: dbSize,
        pool: { total: pool.totalCount ?? null, idle: pool.idleCount ?? null, waiting: pool.waitingCount ?? null },
      },
      migrations,
      process: {
        uptime_seconds: Math.round(process.uptime()),
        node_version: process.version,
        app_version: process.env.npm_package_version || null,
        environment: process.env.NODE_ENV || 'development',
        memory: {
          rss_bytes: mem.rss,
          heap_used_bytes: mem.heapUsed,
          heap_total_bytes: mem.heapTotal,
        },
      },
      errors_24h: errors24h,
    });
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

// ══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION / BILLING MANAGEMENT (platform operator)
// ══════════════════════════════════════════════════════════════════════════════

// GET /subscriptions — every studio's billing state + platform KPIs.
router.get('/subscriptions', async (req, res, next) => {
  try {
    const { rows: studios } = await pool.query(`
      SELECT o.id, o.name, o.slug, o.logo_url, o.status, o.subscription_status,
             o.trial_ends_at, o.current_period_start, o.current_period_end,
             o.plan_code, o.client_limit, o.is_founder, o.founder_number, o.locked_price_inr,
             o.created_at, p.name AS plan_name,
             (SELECT count(*) FROM pt_clients c WHERE c.organization_id = o.id AND c.deleted_at IS NULL)::int AS client_count,
             req.created_at AS requested_at, req.plan_code AS requested_plan_code,
             req.direction AS requested_direction, rp.name AS requested_plan_name
        FROM organizations o
        LEFT JOIN subscription_plans p ON p.code = o.plan_code
        -- Latest pending ask, whether it's a first activation or a plan
        -- change on an already-active studio — both go through the same
        -- operator queue (routes/subscription.js), so both must surface here.
        LEFT JOIN LATERAL (
          SELECT e.created_at, e.data->>'plan_code' AS plan_code, e.data->>'direction' AS direction
            FROM subscription_events e
           WHERE e.organization_id = o.id
             AND e.event IN ('activation_requested', 'change_requested')
             AND e.created_at > COALESCE(o.current_period_start, 'epoch'::timestamptz)
           ORDER BY e.created_at DESC LIMIT 1
        ) req ON true
        LEFT JOIN subscription_plans rp ON rp.code = req.plan_code
       ORDER BY o.created_at DESC`);

    const withState = studios.map((s) => {
      const access = subscription.computeAccess({
        status: s.status, subscription_status: s.subscription_status,
        trial_ends_at: s.trial_ends_at, current_period_end: s.current_period_end,
      });
      return { ...s, effective_state: access.state, allowed: access.allowed,
        trial_days_left: access.trialDaysLeft ?? null, period_days_left: access.periodDaysLeft ?? null,
        renewal_due: access.renewalDue ?? false };
    });

    const { rows: [rev] } = await pool.query(`
      SELECT COALESCE(SUM(amount_inr) FILTER (WHERE status='paid'), 0)::int AS total_revenue,
             COALESCE(SUM(amount_inr) FILTER (WHERE status='paid' AND created_at >= date_trunc('month', now())), 0)::int AS revenue_this_month,
             count(*) FILTER (WHERE status='paid')::int AS payment_count
        FROM subscription_payments`);
    const slots = await subscription.founderSlotsRemaining();

    const kpis = {
      studios: withState.length,
      trial: withState.filter((s) => s.effective_state === 'trial').length,
      active: withState.filter((s) => s.effective_state === 'active').length,
      frozen: withState.filter((s) => ['frozen', 'trial_expired', 'expired', 'cancelled'].includes(s.effective_state)).length,
      founders: withState.filter((s) => s.is_founder).length,
      total_revenue: rev.total_revenue,
      revenue_this_month: rev.revenue_this_month,
      founder_slots_remaining: slots,
    };
    res.json({ data: { studios: withState, kpis } });
  } catch (err) { next(err); }
});

// ── Coupons ───────────────────────────────────────────────────────────────────
// times_redeemed is derived from the redemption ledger rather than kept as a
// counter on the coupon, so it cannot drift out of step with reality.
router.get('/coupons', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
             (SELECT count(*) FROM subscription_coupon_redemptions r WHERE r.coupon_id = c.id)::int AS times_redeemed,
             (SELECT COALESCE(SUM(r.discount_inr), 0) FROM subscription_coupon_redemptions r WHERE r.coupon_id = c.id)::int AS total_discount_inr
        FROM subscription_coupons c
       ORDER BY c.created_at DESC`);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// GET /coupons/:id/redemptions — who used it, when, and for how much.
router.get('/coupons/:id/redemptions', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, o.name AS organization_name
        FROM subscription_coupon_redemptions r
        LEFT JOIN organizations o ON o.id = r.organization_id
       WHERE r.coupon_id = $1
       ORDER BY r.redeemed_at DESC`, [req.params.id]);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/coupons', async (req, res, next) => {
  try {
    const {
      code, description, discount_type, discount_value, max_discount_inr,
      min_amount_inr, applies_to_plans, max_redemptions, max_per_org,
      valid_from, valid_until,
    } = req.body;

    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'code is required' } });
    }
    if (!['percent', 'fixed'].includes(discount_type)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: "discount_type must be 'percent' or 'fixed'" } });
    }
    const value = Number(discount_value);
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'discount_value must be greater than 0' } });
    }
    if (discount_type === 'percent' && value > 100) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A percentage discount cannot exceed 100' } });
    }

    const { rows } = await pool.query(`
      INSERT INTO subscription_coupons
        (code, description, discount_type, discount_value, max_discount_inr, min_amount_inr,
         applies_to_plans, max_redemptions, max_per_org, valid_from, valid_until,
         created_by, created_by_name)
      VALUES (upper(trim($1)),$2,$3,$4,$5,$6,$7,$8,COALESCE($9,1),$10,$11,$12,$13)
      RETURNING *`,
      [code, description || null, discount_type, value,
       max_discount_inr != null ? Number(max_discount_inr) : null,
       min_amount_inr != null ? Number(min_amount_inr) : null,
       Array.isArray(applies_to_plans) && applies_to_plans.length ? applies_to_plans : null,
       max_redemptions != null ? Number(max_redemptions) : null,
       max_per_org != null ? Number(max_per_org) : null,
       valid_from || null, valid_until || null,
       req.user.id, req.user.name || null]
    );
    await audit(req, 'coupon_created', 'coupon', rows[0].id, { code: rows[0].code });
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A coupon with that code already exists' } });
    }
    next(err);
  }
});

// PATCH /coupons/:id — edit terms or deactivate. Past redemptions are never
// rewritten: the ledger records what was actually granted at the time.
router.patch('/coupons/:id', async (req, res, next) => {
  try {
    const allowed = ['description', 'is_active', 'max_redemptions', 'max_per_org', 'valid_from', 'valid_until', 'min_amount_inr', 'max_discount_inr'];
    const sets = [];
    const params = [req.params.id];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Nothing to update' } });
    sets.push('updated_at = now()');

    const { rows } = await pool.query(
      `UPDATE subscription_coupons SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Coupon not found' } });
    await audit(req, 'coupon_updated', 'coupon', req.params.id, req.body);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /coupons/:id — only while unused. Once redeemed a coupon is part of the
// billing record, so it is deactivated instead of deleted.
router.delete('/coupons/:id', async (req, res, next) => {
  try {
    const { rows: [used] } = await pool.query(
      'SELECT count(*)::int AS n FROM subscription_coupon_redemptions WHERE coupon_id = $1', [req.params.id]
    );
    if (used.n > 0) {
      return res.status(409).json({
        error: {
          code: 'COUPON_IN_USE',
          message: `This coupon has been redeemed ${used.n} time${used.n === 1 ? '' : 's'} and is part of the billing record. Deactivate it instead.`,
        },
      });
    }
    const { rowCount } = await pool.query('DELETE FROM subscription_coupons WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Coupon not found' } });
    await audit(req, 'coupon_deleted', 'coupon', req.params.id, {});
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
});

// GET /subscription-metrics — SaaS health for the command centre.
//
// MRR is a RUN-RATE, not cash collected: each active subscription's recurring
// price normalised to one month. It deliberately ignores proration credits and
// one-off adjustments, which move cash but not the underlying run-rate. A
// founder's locked price is their recurring price, so locked_price_inr wins
// over the list price where present. Grandfathered studios (no plan) contribute
// nothing, which is correct — they pay nothing.
router.get('/subscription-metrics', async (req, res, next) => {
  try {
    const [mrrRow, planMix, states, conversion, founders, revenueTrend, growth] = await Promise.all([
      // Run-rate across everything currently entitled to service.
      pool.query(`
        SELECT
          COALESCE(SUM(COALESCE(o.locked_price_inr, p.price_inr)::numeric
                       / NULLIF(p.duration_months, 0)), 0)::int AS mrr_inr,
          count(*)::int AS paying_studios,
          COALESCE(AVG(COALESCE(o.locked_price_inr, p.price_inr)::numeric
                       / NULLIF(p.duration_months, 0)), 0)::int AS arpu_inr
          FROM organizations o
          JOIN subscription_plans p ON p.code = o.plan_code
         WHERE o.subscription_status = 'active'
           AND o.status <> 'suspended'
           AND (o.current_period_end IS NULL OR o.current_period_end > now())`),

      // Distribution of paying studios across the catalogue.
      pool.query(`
        SELECT p.code, p.name, p.price_inr, p.duration_months,
               count(o.id)::int AS studios,
               COALESCE(SUM(COALESCE(o.locked_price_inr, p.price_inr)::numeric
                            / NULLIF(p.duration_months, 0)), 0)::int AS mrr_inr
          FROM subscription_plans p
          LEFT JOIN organizations o
                 ON o.plan_code = p.code
                AND o.subscription_status = 'active'
                AND o.status <> 'suspended'
                AND (o.current_period_end IS NULL OR o.current_period_end > now())
         GROUP BY p.code, p.name, p.price_inr, p.duration_months, p.sort_order
         ORDER BY p.sort_order NULLS LAST, p.price_inr`),

      // Lifecycle spread. Timestamp-aware so a lapsed row that the worker has
      // not swept yet is still reported as expired.
      pool.query(`
        SELECT
          count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
          count(*) FILTER (WHERE status <> 'suspended' AND subscription_status = 'trial'
                             AND (trial_ends_at IS NULL OR trial_ends_at > now()))::int AS on_trial,
          count(*) FILTER (WHERE status <> 'suspended' AND subscription_status = 'trial'
                             AND trial_ends_at IS NOT NULL AND trial_ends_at <= now())::int AS trial_lapsed,
          count(*) FILTER (WHERE status <> 'suspended' AND subscription_status = 'active'
                             AND (current_period_end IS NULL OR current_period_end > now()))::int AS active,
          count(*) FILTER (WHERE status <> 'suspended' AND subscription_status = 'active'
                             AND current_period_end IS NOT NULL AND current_period_end <= now())::int AS lapsed,
          count(*) FILTER (WHERE subscription_status = 'frozen')::int AS frozen,
          count(*) FILTER (WHERE subscription_status = 'expired')::int AS expired,
          count(*) FILTER (WHERE subscription_status = 'cancelled')::int AS cancelled,
          count(*)::int AS total
          FROM organizations`),

      // Trial → paid conversion, scoped to studios that actually ran a trial.
      // Grandfathered studios never had one and would otherwise skew this.
      pool.query(`
        WITH trials AS (
          SELECT DISTINCT organization_id, min(created_at) AS started_at
            FROM subscription_events WHERE event = 'trial_started'
           GROUP BY organization_id
        ), converted AS (
          SELECT DISTINCT t.organization_id
            FROM trials t
            JOIN subscription_events e
              ON e.organization_id = t.organization_id
             AND e.event = 'activated'
             AND e.created_at >= t.started_at
        )
        SELECT (SELECT count(*) FROM trials)::int    AS trials_started,
               (SELECT count(*) FROM converted)::int AS trials_converted`),

      pool.query(`
        SELECT count(*)::int AS granted,
               COALESCE(SUM(locked_price_inr), 0)::int AS locked_value_inr,
               MAX(founder_number)::int AS highest_number
          FROM founder_members`),

      // Cash actually collected, last 12 months.
      pool.query(`
        SELECT to_char(date_trunc('month', created_at), 'Mon YYYY') AS label,
               date_trunc('month', created_at)::date AS month,
               COALESCE(SUM(amount_inr) FILTER (WHERE status = 'paid'), 0)::int AS revenue_inr,
               count(*) FILTER (WHERE status = 'paid')::int AS payments,
               COALESCE(SUM(amount_inr) FILTER (WHERE status = 'refunded'), 0)::int AS refunded_inr
          FROM subscription_payments
         WHERE created_at >= date_trunc('month', now()) - interval '11 months'
         GROUP BY 1, 2 ORDER BY 2`),

      // New paying studios per month — first activation only, so renewals do
      // not inflate it.
      pool.query(`
        WITH first_activation AS (
          SELECT organization_id, min(created_at) AS activated_at
            FROM subscription_events WHERE event = 'activated'
           GROUP BY organization_id
        )
        SELECT to_char(date_trunc('month', activated_at), 'Mon YYYY') AS label,
               date_trunc('month', activated_at)::date AS month,
               count(*)::int AS new_studios
          FROM first_activation
         WHERE activated_at >= date_trunc('month', now()) - interval '11 months'
         GROUP BY 1, 2 ORDER BY 2`),
    ]);

    const mrr = mrrRow.rows[0] || { mrr_inr: 0, paying_studios: 0, arpu_inr: 0 };
    const conv = conversion.rows[0] || { trials_started: 0, trials_converted: 0 };
    const f = founders.rows[0] || { granted: 0, locked_value_inr: 0, highest_number: null };
    const slotsRemaining = await subscription.founderSlotsRemaining();

    res.json({
      data: {
        mrr_inr: mrr.mrr_inr,
        arr_inr: mrr.mrr_inr * 12,
        arpu_inr: mrr.arpu_inr,
        paying_studios: mrr.paying_studios,
        states: states.rows[0],
        plan_distribution: planMix.rows,
        trial_conversion: {
          started: conv.trials_started,
          converted: conv.trials_converted,
          rate_pct: conv.trials_started > 0
            ? Math.round((conv.trials_converted / conv.trials_started) * 1000) / 10
            : null,
        },
        founders: {
          granted: f.granted,
          limit: subscription.FOUNDER_LIMIT,
          slots_remaining: slotsRemaining,
          locked_value_inr: f.locked_value_inr,
          highest_number: f.highest_number,
        },
        revenue_trend: revenueTrend.rows,
        growth: growth.rows,
      },
    });
  } catch (err) { next(err); }
});

// GET /organizations/:id/subscription — one studio's billing detail + history.
router.get('/organizations/:id/subscription', async (req, res, next) => {
  try {
    const { rows: orgs } = await pool.query(`
      SELECT o.*, p.name AS plan_name, p.duration_months, p.price_inr
        FROM organizations o LEFT JOIN subscription_plans p ON p.code = o.plan_code
       WHERE o.id = $1`, [req.params.id]);
    if (!orgs.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });
    const o = orgs[0];
    const access = subscription.computeAccess({
      status: o.status, subscription_status: o.subscription_status,
      trial_ends_at: o.trial_ends_at, current_period_end: o.current_period_end,
    });
    const [{ rows: payments }, { rows: invoices }, { rows: events }] = await Promise.all([
      pool.query(`SELECT id, plan_code, amount_inr, method, reference, status, period_start, period_end, recorded_by_name, refunded_at, notes, created_at
                    FROM subscription_payments WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.id]),
      pool.query(`SELECT id, invoice_number, plan_code, amount_inr, period_start, period_end, status, issued_at
                    FROM subscription_invoices WHERE organization_id=$1 ORDER BY issued_at DESC LIMIT 100`, [req.params.id]),
      pool.query(`SELECT id, event, data, actor_name, created_at
                    FROM subscription_events WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.params.id]),
    ]);
    res.json({ data: {
      organization: {
        id: o.id, name: o.name, slug: o.slug, status: o.status,
        subscription_status: o.subscription_status, effective_state: access.state, allowed: access.allowed,
        trial_ends_at: o.trial_ends_at, current_period_start: o.current_period_start, current_period_end: o.current_period_end,
        plan_code: o.plan_code, plan_name: o.plan_name, client_limit: o.client_limit,
        is_founder: o.is_founder, founder_number: o.founder_number, locked_price_inr: o.locked_price_inr,
        trial_days_left: access.trialDaysLeft ?? null, period_days_left: access.periodDaysLeft ?? null,
      },
      payments, invoices, events,
    } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/activate — record a payment + activate/renew.
router.post('/organizations/:id/subscription/activate', async (req, res, next) => {
  try {
    const { plan_code, amount_inr, method, reference, notes, period_months, coupon_code } = req.body;
    if (!plan_code) return res.status(400).json({ error: { code: 'VALIDATION', message: 'plan_code is required' } });
    const result = await subscription.activate(req.params.id, plan_code, {
      amount_inr: amount_inr != null ? Number(amount_inr) : undefined,
      method, reference, notes,
      periodMonths: period_months != null ? Number(period_months) : undefined,
      // Redeemed under a row lock inside the activation transaction.
      couponCode: coupon_code || undefined,
      actor: { id: req.user.id, name: req.user.name },
    });
    invalidateUserCache();
    await audit(req, 'subscription_activated', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: 'ACTIVATION_FAILED', message: err.message } });
    next(err);
  }
});

// GET /organizations/:id/subscription/change-quote?plan_code=  — price a plan
// change for a studio before executing it (proration credit, amount due,
// effective date, over-limit warning). Read-only.
router.get('/organizations/:id/subscription/change-quote', async (req, res, next) => {
  try {
    const planCode = req.query.plan_code;
    if (!planCode) return res.status(400).json({ error: { code: 'VALIDATION', message: 'plan_code is required' } });
    const quote = await subscription.quotePlanChange(req.params.id, String(planCode));
    res.json({ data: quote });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'QUOTE_FAILED', message: err.message } });
    next(err);
  }
});

// POST /organizations/:id/subscription/change — execute an immediate, prorated
// upgrade (or same-plan renewal) once payment is confirmed. The unused value of
// the current period is credited, the studio is charged the difference, and the
// billing period restarts from now. Downgrades are rejected here by design —
// they must be scheduled so the studio keeps the time it already paid for.
router.post('/organizations/:id/subscription/change', async (req, res, next) => {
  try {
    const { plan_code, amount_inr, method, reference, notes } = req.body;
    if (!plan_code) return res.status(400).json({ error: { code: 'VALIDATION', message: 'plan_code is required' } });
    const result = await subscription.changePlan(req.params.id, plan_code, {
      amount_inr: amount_inr != null ? Number(amount_inr) : undefined,
      method, reference, notes,
      actor: { id: req.user.id, name: req.user.name },
    });
    invalidateUserCache();
    await audit(req, 'subscription_plan_changed', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'CHANGE_FAILED', message: err.message } });
    next(err);
  }
});

// POST /organizations/:id/subscription/schedule-downgrade — queue a downgrade
// for the end of the current period. Nothing changes now.
router.post('/organizations/:id/subscription/schedule-downgrade', async (req, res, next) => {
  try {
    const { plan_code } = req.body;
    if (!plan_code) return res.status(400).json({ error: { code: 'VALIDATION', message: 'plan_code is required' } });
    const result = await subscription.scheduleDowngrade(req.params.id, plan_code, { id: req.user.id, name: req.user.name });
    await audit(req, 'subscription_downgrade_scheduled', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'SCHEDULE_FAILED', message: err.message } });
    next(err);
  }
});

// DELETE /organizations/:id/subscription/scheduled-change — drop a pending downgrade.
router.delete('/organizations/:id/subscription/scheduled-change', async (req, res, next) => {
  try {
    const result = await subscription.cancelScheduledChange(req.params.id, { id: req.user.id, name: req.user.name });
    await audit(req, 'subscription_scheduled_change_cancelled', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/freeze
router.post('/organizations/:id/subscription/freeze', async (req, res, next) => {
  try {
    await subscription.freeze(req.params.id, { id: req.user.id, name: req.user.name }, req.body?.reason);
    invalidateUserCache();
    await audit(req, 'subscription_frozen', 'organization', req.params.id, {});
    res.json({ data: { id: req.params.id, subscription_status: 'frozen' } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/reactivate — comp un-freeze (no payment).
router.post('/organizations/:id/subscription/reactivate', async (req, res, next) => {
  try {
    await subscription.reactivate(req.params.id, { id: req.user.id, name: req.user.name });
    invalidateUserCache();
    await audit(req, 'subscription_reactivated', 'organization', req.params.id, {});
    res.json({ data: { id: req.params.id, subscription_status: 'active' } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/cancel
router.post('/organizations/:id/subscription/cancel', async (req, res, next) => {
  try {
    await subscription.cancelSubscription(req.params.id, { id: req.user.id, name: req.user.name });
    invalidateUserCache();
    await audit(req, 'subscription_cancelled', 'organization', req.params.id, {});
    res.json({ data: { id: req.params.id, subscription_status: 'cancelled' } });
  } catch (err) { next(err); }
});

// PATCH /organizations/:id/subscription/expiry — override trial / period end.
router.patch('/organizations/:id/subscription/expiry', async (req, res, next) => {
  try {
    const { trial_ends_at, current_period_end } = req.body;
    await subscription.changeExpiry(req.params.id, {
      trialEndsAt: trial_ends_at !== undefined ? (trial_ends_at || null) : undefined,
      periodEnd: current_period_end !== undefined ? (current_period_end || null) : undefined,
    }, { id: req.user.id, name: req.user.name });
    invalidateUserCache();
    await audit(req, 'subscription_expiry_changed', 'organization', req.params.id, { trial_ends_at, current_period_end });
    res.json({ data: { id: req.params.id } });
  } catch (err) { next(err); }
});

// POST /organizations/:id/subscription/founder — manually grant founder status.
router.post('/organizations/:id/subscription/founder', async (req, res, next) => {
  try {
    const result = await subscription.grantFounder(req.params.id, { id: req.user.id, name: req.user.name });
    invalidateUserCache();
    await audit(req, 'founder_granted', 'organization', req.params.id, result);
    res.json({ data: result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: 'FOUNDER_FAILED', message: err.message } });
    next(err);
  }
});

// POST /subscription-payments/:id/refund
router.post('/subscription-payments/:id/refund', async (req, res, next) => {
  try {
    const pay = await subscription.refundPayment(req.params.id, { id: req.user.id, name: req.user.name });
    await audit(req, 'subscription_refunded', 'organization', pay.organization_id, { payment_id: req.params.id });
    res.json({ data: { id: req.params.id, status: 'refunded' } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: 'REFUND_FAILED', message: err.message } });
    next(err);
  }
});


// ════════════════════════════════════════════════════════════════════════════
//  SUBSCRIPTION SELF-CHECKOUT — the operator's verification queue
// ════════════════════════════════════════════════════════════════════════════
//
// Studios pay the platform over UPI and submit the bank reference. This is
// where the operator matches that reference against the platform bank account
// and turns it into an active subscription. Approval delegates to
// subscription.activate(), so founder pricing, coupon redemption, invoices and
// period stacking all behave exactly as they do for a manually recorded
// payment — there is no second activation path.

const checkout = require('../../lib/subscriptionCheckout');

function checkoutActor(req) {
  return { id: req.user.id, name: req.user.name || null, role: req.user.role };
}

function sendCheckoutError(res, err, next) {
  if (err && err.name === 'PaymentError') {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err && err.status) {
    return res.status(err.status).json({ error: { code: 'CHECKOUT_FAILED', message: err.message } });
  }
  return next(err);
}

// GET /platform-payment-settings — the platform's own payee details.
router.get('/platform-payment-settings', async (req, res, next) => {
  try {
    const data = await checkout.getPlatformSettings();
    res.json({ data, configured: Boolean(data), enabled: Boolean(data?.is_enabled) });
  } catch (err) { next(err); }
});

// PUT /platform-payment-settings
router.put('/platform-payment-settings', async (req, res, next) => {
  try {
    const body = req.body || {};
    const saved = await checkout.savePlatformSettings({
      upi_id: String(body.upi_id || '').trim(),
      merchant_name: String(body.merchant_name || '').trim(),
      instructions: body.instructions ? String(body.instructions).trim().slice(0, 500) : null,
      is_enabled: body.is_enabled === true || body.is_enabled === 'true',
      request_ttl_minutes: Number(body.request_ttl_minutes) || 60,
    }, req.user.id);
    await audit(req, 'platform_payment_settings_updated', 'platform', null, {
      upi_id: saved.upi_id, is_enabled: saved.is_enabled,
    });
    res.json({ data: saved });
  } catch (err) { sendCheckoutError(res, err, next); }
});

// GET /subscription-requests — the queue plus its counters.
router.get('/subscription-requests', async (req, res, next) => {
  try {
    const status = ['AWAITING_VERIFICATION', 'AWAITING_PAYMENT', 'APPROVED', 'ALL']
      .includes(req.query.status) ? req.query.status : 'AWAITING_VERIFICATION';
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const conds = [];
    const params = [];
    if (status !== 'ALL') { params.push(status); conds.push(`r.status = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      conds.push(`(o.name ILIKE $${params.length} OR r.request_no ILIKE $${params.length} OR r.utr ILIKE $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const listParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT ${checkout.REQUEST_COLUMNS},
              o.name AS organization_name, o.slug AS organization_slug,
              o.subscription_status, o.current_period_end,
              p.name AS plan_name, p.duration_months
         FROM subscription_payment_requests r
         JOIN organizations o ON o.id = r.organization_id
         LEFT JOIN subscription_plans p ON p.code = r.plan_code
         ${where}
        ORDER BY r.submitted_at ASC NULLS LAST, r.created_at ASC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM subscription_payment_requests r
         JOIN organizations o ON o.id = r.organization_id ${where}`,
      params
    );

    // Counters come from SQL, so "collected" is the real total rather than the
    // total of whatever happens to be on this page.
    const { rows: stats } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='AWAITING_VERIFICATION')::int              AS awaiting_count,
         COALESCE(SUM(amount_inr) FILTER (WHERE status='AWAITING_VERIFICATION'),0)::int AS awaiting_amount_inr,
         COUNT(*) FILTER (WHERE status='AWAITING_PAYMENT')::int                   AS unpaid_count,
         COUNT(*) FILTER (WHERE status='APPROVED' AND reviewed_at::date = CURRENT_DATE)::int AS approved_today,
         COALESCE(SUM(amount_inr) FILTER (WHERE status='APPROVED' AND reviewed_at::date = CURRENT_DATE),0)::int AS approved_today_amount_inr,
         COALESCE(SUM(amount_inr) FILTER (WHERE status='APPROVED'),0)::int        AS collected_inr
       FROM subscription_payment_requests`
    );

    res.json({
      data: rows, total: countRows[0].total, stats: stats[0],
      reject_reasons: checkout.REJECT_REASONS,
    });
  } catch (err) { next(err); }
});

// POST /subscription-requests/:id/approve — verify and activate.
router.post('/subscription-requests/:id/approve', async (req, res, next) => {
  try {
    const result = await checkout.approve({ requestId: req.params.id, actor: checkoutActor(req) });
    await audit(req, 'subscription_checkout_approved', 'organization',
      result.request.organization_id, {
        request_no: result.request.request_no, utr: result.request.utr,
        amount_inr: result.request.amount_inr, plan_code: result.request.plan_code,
      });

    // Tell the studio's admins their subscription is live.
    try {
      const { rows: admins } = await pool.query(
        `SELECT id FROM users WHERE organization_id=$1 AND role='admin' AND is_active=true`,
        [result.request.organization_id]
      );
      for (const a of admins) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, link)
           VALUES ($1,'subscription','Payment approved',$2,'/subscription')`,
          [a.id, `Your ${result.request.plan_code} subscription is active.`]
        );
      }
    } catch { /* best-effort */ }

    res.json({ data: result });
  } catch (err) { sendCheckoutError(res, err, next); }
});

// POST /subscription-requests/:id/reject
router.post('/subscription-requests/:id/reject', async (req, res, next) => {
  try {
    const result = await checkout.reject({
      requestId: req.params.id,
      reason: req.body?.reason,
      note: req.body?.note ? String(req.body.note).trim().slice(0, 500) : null,
      actor: checkoutActor(req),
    });
    await audit(req, 'subscription_checkout_rejected', 'organization',
      result.request.organization_id, { reason: result.reason, note: result.note });

    try {
      const { rows: admins } = await pool.query(
        `SELECT id FROM users WHERE organization_id=$1 AND role='admin' AND is_active=true`,
        [result.request.organization_id]
      );
      for (const a of admins) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, link)
           VALUES ($1,'subscription','Payment could not be verified',$2,'/subscription')`,
          [a.id, `${checkout.REJECT_REASONS[result.reason]}${result.note ? ` — ${result.note}` : ''} You can submit a corrected reference.`]
        );
      }
    } catch { /* best-effort */ }

    res.json({ data: result });
  } catch (err) { sendCheckoutError(res, err, next); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BILLING CENTRE
//
//  The platform's side of the money: what it invoiced, to whom, with what tax,
//  and the seller identity that appears on the document.
//
//  Read-and-export only. Nothing here issues, voids or refunds an invoice —
//  those already happen inside lib/subscription.js as a consequence of a
//  payment, which is the only place they can stay consistent with the payment
//  ledger. A Billing Centre that could mint an invoice on its own would be a
//  second source of truth for revenue.
// ═══════════════════════════════════════════════════════════════════════════

const platformBilling = require('../../lib/platformBilling');
const { generateSubscriptionInvoicePdf } = require('../../lib/subscriptionInvoicePdf');

const INVOICE_EXPORT_MAX = 10000;
const INVOICE_PAGE_MAX = 200;

// Editable settings, whitelisted. A blind Object.keys() loop over req.body
// would let a caller write id, updated_at or a column added later.
const BILLING_SETTING_FIELDS = [
  'legal_name', 'address_line1', 'address_line2', 'city', 'state', 'state_code',
  'postal_code', 'country', 'gstin', 'pan', 'email', 'phone',
  'gst_percent', 'prices_include_gst', 'invoice_prefix', 'invoice_notes',
];
const BILLING_PROFILE_FIELDS = [
  'billing_name', 'billing_email', 'billing_gstin', 'billing_address_line1',
  'billing_address_line2', 'billing_city', 'billing_state', 'billing_state_code',
  'billing_postal_code',
];

const INVOICE_SELECT = `
  SELECT i.id, i.invoice_number, i.organization_id, i.payment_id, i.plan_code,
         i.amount_inr, i.taxable_value_inr, i.gst_percent,
         i.cgst_inr, i.sgst_inr, i.igst_inr,
         i.period_start, i.period_end, i.status, i.issued_at,
         i.buyer_snapshot,
         o.name AS organization_name, o.slug AS organization_slug,
         o.billing_gstin, pl.name AS plan_name,
         p.method AS payment_method, p.reference AS payment_reference
    FROM subscription_invoices i
    LEFT JOIN organizations      o  ON o.id   = i.organization_id
    LEFT JOIN subscription_plans pl ON pl.code = i.plan_code
    LEFT JOIN subscription_payments p ON p.id  = i.payment_id`;

// Shared by the list, the totals and the export so all three can never
// describe different sets — the bug where an export quietly ignores the
// filters the operator is looking at.
function buildInvoiceFilter(query) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (query.org_id) add('i.organization_id = $?::uuid', query.org_id);
  if (query.status) add('i.status = $?', query.status);
  if (query.plan_code) add('i.plan_code = $?', query.plan_code);
  if (query.from) add('i.issued_at >= $?::timestamptz', query.from);
  // Inclusive of the whole end day: an operator picking "to 31 March" means
  // through the 31st, not up to midnight at its start.
  if (query.to) add("i.issued_at < ($?::date + INTERVAL '1 day')", query.to);
  if (query.q) {
    params.push(`%${query.q}%`);
    const i = `$${params.length}`;
    where.push(`(i.invoice_number ILIKE ${i} OR o.name ILIKE ${i} OR p.reference ILIKE ${i})`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// ── GET /billing/settings ────────────────────────────────────────────────────
router.get('/billing/settings', async (req, res, next) => {
  try {
    res.json({ data: await platformBilling.loadSettings() });
  } catch (err) { next(err); }
});

// ── PUT /billing/settings ────────────────────────────────────────────────────
// Changing the rate affects invoices issued FROM NOW ON only; historical ones
// carry their own snapshot and are untouched. That is the whole point of the
// snapshot, and it is stated in the audit entry so the change is legible later.
router.put('/billing/settings', async (req, res, next) => {
  try {
    const patch = {};
    for (const f of BILLING_SETTING_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) patch[f] = req.body[f];
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }
    if (patch.gst_percent != null) {
      const n = Number(patch.gst_percent);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'gst_percent must be between 0 and 100' } });
      }
      patch.gst_percent = n;
    }
    if (patch.prices_include_gst != null) patch.prices_include_gst = Boolean(patch.prices_include_gst);
    if (patch.invoice_prefix != null) {
      // The prefix becomes part of a UNIQUE invoice_number; punctuation in it
      // would produce numbers that are awkward to quote and search for.
      const p = String(patch.invoice_prefix).trim().toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(p)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'invoice_prefix must be 1–10 letters or digits' } });
      }
      patch.invoice_prefix = p;
    }
    for (const f of ['gstin', 'pan', 'state_code']) {
      if (patch[f] != null) patch[f] = String(patch[f]).trim().toUpperCase() || null;
    }

    const before = await platformBilling.loadSettings();

    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    const { rows } = await pool.query(
      `UPDATE platform_billing_settings
          SET ${sets.join(', ')}, updated_at = now(), updated_by = $${cols.length + 1}
        WHERE id = TRUE
        RETURNING *`,
      [...cols.map((c) => patch[c]), req.user?.name || null]
    );

    const changed = {};
    for (const c of cols) if (String(before[c] ?? '') !== String(patch[c] ?? '')) changed[c] = { from: before[c] ?? null, to: patch[c] ?? null };
    await audit(req, 'billing_settings_updated', 'platform_billing', null, {
      changed,
      note: 'Applies to invoices issued from now on; existing invoices keep their snapshot.',
    });

    res.json({ data: { ...platformBilling.DEFAULTS, ...(rows[0] || {}) } });
  } catch (err) { next(err); }
});

// ── GET /billing/invoices ────────────────────────────────────────────────────
// Rows for the current page PLUS totals over the whole filtered set, because
// "revenue in this range" must not change when the operator turns the page.
router.get('/billing/invoices', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, INVOICE_PAGE_MAX);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { clause, params } = buildInvoiceFilter(req.query);

    const [list, totals] = await Promise.all([
      pool.query(
        `${INVOICE_SELECT} ${clause} ORDER BY i.issued_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT count(*)::int AS count,
                COALESCE(SUM(i.amount_inr) FILTER (WHERE i.status = 'paid'), 0)::numeric      AS gross_inr,
                COALESCE(SUM(i.taxable_value_inr) FILTER (WHERE i.status = 'paid'), 0)::numeric AS taxable_inr,
                COALESCE(SUM(COALESCE(i.cgst_inr,0) + COALESCE(i.sgst_inr,0) + COALESCE(i.igst_inr,0))
                         FILTER (WHERE i.status = 'paid'), 0)::numeric                        AS tax_inr,
                COALESCE(SUM(i.amount_inr) FILTER (WHERE i.status = 'refunded'), 0)::numeric  AS refunded_inr,
                count(*) FILTER (WHERE i.taxable_value_inr IS NULL)::int                      AS untaxed_count
           FROM subscription_invoices i
           LEFT JOIN organizations o ON o.id = i.organization_id
           LEFT JOIN subscription_payments p ON p.id = i.payment_id
           ${clause}`,
        params
      ),
    ]);

    const t = totals.rows[0];
    res.json({
      data: list.rows,
      totals: {
        count: t.count,
        gross_inr: Number(t.gross_inr),
        taxable_inr: Number(t.taxable_inr),
        tax_inr: Number(t.tax_inr),
        refunded_inr: Number(t.refunded_inr),
        // Surfaced rather than hidden: these are pre-migration-122 invoices
        // with no tax snapshot, so the tax total under-reports by their share.
        untaxed_count: t.untaxed_count,
      },
      page: { limit, offset, has_more: offset + list.rows.length < t.count },
    });
  } catch (err) { next(err); }
});

// ── GET /billing/invoices/export ─────────────────────────────────────────────
// CSV, opened in Excel by double-click. Not .xlsx: a real workbook would add a
// binary writer dependency to gain formatting nobody asked for, while CSV is
// what an accountant's software imports anyway.
router.get('/billing/invoices/export', async (req, res, next) => {
  try {
    const { clause, params } = buildInvoiceFilter(req.query);
    const { rows } = await pool.query(
      `${INVOICE_SELECT} ${clause} ORDER BY i.issued_at DESC LIMIT $${params.length + 1}`,
      [...params, INVOICE_EXPORT_MAX]
    );

    const header = ['Invoice No', 'Issue Date', 'Studio', 'Studio GSTIN', 'Plan',
      'Period Start', 'Period End', 'Taxable Value', 'GST %', 'CGST', 'SGST', 'IGST',
      'Total', 'Status', 'Payment Method', 'Payment Reference'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.invoice_number,
        r.issued_at ? new Date(r.issued_at).toISOString().slice(0, 10) : '',
        r.organization_name,
        r.buyer_snapshot?.gstin || r.billing_gstin,
        r.plan_name || r.plan_code,
        r.period_start ? new Date(r.period_start).toISOString().slice(0, 10) : '',
        r.period_end ? new Date(r.period_end).toISOString().slice(0, 10) : '',
        // Passed through as null so csvCell emits a truly empty cell. A 0 here
        // would be summed by the spreadsheet and quietly understate the
        // taxable base for rows that simply have no snapshot.
        r.taxable_value_inr, r.gst_percent,
        r.cgst_inr, r.sgst_inr, r.igst_inr,
        r.amount_inr, r.status, r.payment_method, r.payment_reference,
      ].map(csvCell).join(','));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="invoices-${stamp}.csv"`);
    await audit(req, 'billing_exported', 'subscription_invoice', null,
      { rows: rows.length, filters: req.query });
    // BOM so Excel reads it as UTF-8 rather than mojibake.
    res.send('﻿' + lines.join('\n'));
  } catch (err) { next(err); }
});

// ── GET /billing/invoices/:id/pdf ────────────────────────────────────────────
router.get('/billing/invoices/:id/pdf', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, o.name AS organization_name, o.billing_name, o.billing_gstin,
              o.billing_email, o.billing_address_line1, o.billing_address_line2,
              o.billing_city, o.billing_state, o.billing_postal_code,
              pl.name AS plan_name
         FROM subscription_invoices i
         LEFT JOIN organizations o       ON o.id   = i.organization_id
         LEFT JOIN subscription_plans pl ON pl.code = i.plan_code
        WHERE i.id = $1`,
      [req.params.id]
    );
    const invoice = rows[0];
    if (!invoice) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found' } });

    const [payment, settings] = await Promise.all([
      invoice.payment_id
        ? pool.query('SELECT * FROM subscription_payments WHERE id = $1', [invoice.payment_id])
          .then((r) => r.rows[0] || null)
        : Promise.resolve(null),
      platformBilling.loadSettings(),
    ]);

    const pdf = await generateSubscriptionInvoicePdf({
      invoice,
      payment,
      organization: {
        id: invoice.organization_id, name: invoice.organization_name,
        billing_name: invoice.billing_name, billing_gstin: invoice.billing_gstin,
        billing_email: invoice.billing_email,
        billing_address_line1: invoice.billing_address_line1,
        billing_address_line2: invoice.billing_address_line2,
        billing_city: invoice.billing_city, billing_state: invoice.billing_state,
        billing_postal_code: invoice.billing_postal_code,
      },
      settings,
      planName: invoice.plan_name,
    });

    res.setHeader('Content-Type', 'application/pdf');
    // inline: an operator almost always wants to look at it before sending it
    // on, and the browser's viewer still offers Save.
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

// ── GET|PUT /organizations/:id/billing-profile ───────────────────────────────
// The studio's registered identity, used on invoices issued from now on.
// Editing it does NOT retro-fit existing invoices: those carry their own buyer
// snapshot, and silently re-addressing an issued tax invoice would break the
// document's evidentiary value.
router.get('/organizations/:id/billing-profile', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, ${BILLING_PROFILE_FIELDS.join(', ')} FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.put('/organizations/:id/billing-profile', async (req, res, next) => {
  try {
    const patch = {};
    for (const f of BILLING_PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) {
        const v = req.body[f];
        patch[f] = v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 300);
      }
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }
    for (const f of ['billing_gstin', 'billing_state_code']) {
      if (patch[f]) patch[f] = patch[f].toUpperCase();
    }

    const { rows: existing } = await pool.query(
      `SELECT id, ${BILLING_PROFILE_FIELDS.join(', ')} FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    if (!existing[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });

    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`);
    const { rows } = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1
        RETURNING id, name, ${BILLING_PROFILE_FIELDS.join(', ')}`,
      [req.params.id, ...cols.map((c) => patch[c])]
    );

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'billing_profile_updated','organization',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.id,
       existing[0], patch, req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  FEATURE MANAGER
//
//  The control plane for what the product can do: a catalogue of capabilities,
//  which plans include them, and per-studio overrides.
//
//  Enforcement is deliberately NOT wired to any existing route — see the note
//  on requireFeature() in lib/features.js. This module builds and audits the
//  switches; turning one against a live studio is an operator's decision, and
//  every one of those decisions is recorded here.
// ═══════════════════════════════════════════════════════════════════════════

const features = require('../../lib/features');

const OVERRIDE_REASON_MAX = 500;

/** A studio's plan is needed to resolve plan-gated features. */
async function loadOrgForFeatures(id) {
  const { rows } = await pool.query('SELECT id, name, plan_code FROM organizations WHERE id = $1', [id]);
  return rows[0] || null;
}

// ── GET /features ────────────────────────────────────────────────────────────
// The catalogue, the plan matrix, and how many studios override each feature.
// The override count is what tells an operator that flipping a global switch is
// about to collide with deliberate per-studio decisions.
router.get('/features', async (req, res, next) => {
  try {
    const [cat, plans, matrix] = await Promise.all([
      pool.query(`
        SELECT f.*,
               (SELECT count(*) FROM organization_features o
                 WHERE o.feature_key = f.key
                   AND (o.expires_at IS NULL OR o.expires_at > now()))::int AS override_count,
               (SELECT count(*) FROM organization_features o
                 WHERE o.feature_key = f.key AND o.enabled = FALSE
                   AND (o.expires_at IS NULL OR o.expires_at > now()))::int AS disabled_count
          FROM platform_features f
         ORDER BY f.sort_order, f.key`),
      pool.query('SELECT code, name, sort_order FROM subscription_plans ORDER BY sort_order, code'),
      pool.query('SELECT plan_code, feature_key, enabled FROM plan_features'),
    ]);

    // Shaped as plan → feature → boolean, which is how the UI draws the grid.
    const plan_matrix = {};
    for (const p of plans.rows) plan_matrix[p.code] = {};
    for (const r of matrix.rows) {
      if (!plan_matrix[r.plan_code]) plan_matrix[r.plan_code] = {};
      plan_matrix[r.plan_code][r.feature_key] = r.enabled;
    }

    res.json({ data: { features: cat.rows, plans: plans.rows, plan_matrix } });
  } catch (err) { next(err); }
});

// ── PATCH /features/:key ─────────────────────────────────────────────────────
// The three platform-level switches. is_core is not among them: it is a
// property of the product, not a setting, and the schema rejects a core
// feature that is off anyway.
router.patch('/features/:key', async (req, res, next) => {
  try {
    const { rows: [before] } = await pool.query('SELECT * FROM platform_features WHERE key = $1', [req.params.key]);
    if (!before) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown feature' } });
    if (before.is_core) {
      return res.status(400).json({ error: { code: 'CORE_FEATURE', message: `${before.name} is core to the product and cannot be changed.` } });
    }

    const patch = {};
    for (const f of ['global_enabled', 'default_enabled', 'is_plan_gated']) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) patch[f] = Boolean(req.body[f]);
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'No fields to update' } });
    }

    const cols = Object.keys(patch);
    const { rows } = await pool.query(
      `UPDATE platform_features SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE key = $1 RETURNING *`,
      [req.params.key, ...cols.map((c) => patch[c])]
    );

    // How many studios this actually reaches, recorded at the moment of the
    // change: "turned off the AI Suite" means something different against 3
    // studios than against 300, and the count is not recoverable later.
    const { rows: [reach] } = await pool.query(
      `SELECT count(*)::int AS studios FROM organizations WHERE status <> 'deleted'`
    );

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'feature_updated','platform_feature',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.key,
       { global_enabled: before.global_enabled, default_enabled: before.default_enabled, is_plan_gated: before.is_plan_gated },
       { ...patch, studios_affected: reach.studios },
       req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── PUT /features/:key/plans ─────────────────────────────────────────────────
// Which plans include this feature. Body: { plans: { starter: false, ... } }.
router.put('/features/:key/plans', async (req, res, next) => {
  try {
    const { rows: [feature] } = await pool.query('SELECT * FROM platform_features WHERE key = $1', [req.params.key]);
    if (!feature) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown feature' } });
    if (feature.is_core) {
      return res.status(400).json({ error: { code: 'CORE_FEATURE', message: `${feature.name} is core to the product and is included in every plan.` } });
    }

    const wanted = req.body?.plans;
    if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'plans must be an object of { plan_code: boolean }' } });
    }

    const { rows: validPlans } = await pool.query('SELECT code FROM subscription_plans');
    const valid = new Set(validPlans.map((p) => p.code));
    const unknown = Object.keys(wanted).filter((c) => !valid.has(c));
    if (unknown.length) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Unknown plan(s): ${unknown.join(', ')}` } });
    }

    const { rows: before } = await pool.query(
      'SELECT plan_code, enabled FROM plan_features WHERE feature_key = $1', [req.params.key]
    );

    for (const [code, enabled] of Object.entries(wanted)) {
      await pool.query(
        `INSERT INTO plan_features (plan_code, feature_key, enabled)
         VALUES ($1,$2,$3)
         ON CONFLICT (plan_code, feature_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [code, req.params.key, Boolean(enabled)]
      );
    }

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'feature_plans_updated','platform_feature',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.key,
       Object.fromEntries(before.map((r) => [r.plan_code, r.enabled])), wanted,
       req.ip || null, req.get('user-agent') || null]
    );

    const { rows } = await pool.query(
      'SELECT plan_code, feature_key, enabled FROM plan_features WHERE feature_key = $1', [req.params.key]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ── GET /organizations/:id/features ──────────────────────────────────────────
// One studio's resolved state, with the reason for each — the view an operator
// needs when a studio reports that something has vanished.
router.get('/organizations/:id/features', async (req, res, next) => {
  try {
    const org = await loadOrgForFeatures(req.params.id);
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });
    res.json({ data: await features.resolveForOrg(org.id, org.plan_code) });
  } catch (err) { next(err); }
});

// ── PUT /organizations/:id/features/:key ─────────────────────────────────────
// Set an override. A reason is required: an unexplained flag on one studio is
// indistinguishable from a mistake six months later, and the operator who set
// it will not be the one reading it.
router.put('/organizations/:id/features/:key', async (req, res, next) => {
  try {
    const org = await loadOrgForFeatures(req.params.id);
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });

    const { rows: [feature] } = await pool.query('SELECT * FROM platform_features WHERE key = $1', [req.params.key]);
    if (!feature) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown feature' } });
    if (feature.is_core) {
      return res.status(400).json({ error: { code: 'CORE_FEATURE', message: `${feature.name} is core to the product and cannot be switched off.` } });
    }

    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'enabled must be true or false' } });
    }
    const reason = String(req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'A reason is required for a per-studio override.' } });
    }
    if (reason.length > OVERRIDE_REASON_MAX) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: `Reason must be ${OVERRIDE_REASON_MAX} characters or fewer.` } });
    }

    let expiresAt = null;
    if (req.body.expires_at) {
      const d = new Date(req.body.expires_at);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'expires_at is not a valid date' } });
      }
      if (d.getTime() <= Date.now()) {
        // An override that is already expired does nothing, so accepting it
        // would silently produce a no-op the operator believes worked.
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'expires_at must be in the future' } });
      }
      expiresAt = d.toISOString();
    }

    const { rows: [before] } = await pool.query(
      'SELECT enabled, reason, expires_at FROM organization_features WHERE organization_id = $1 AND feature_key = $2',
      [org.id, req.params.key]
    );

    const { rows } = await pool.query(
      `INSERT INTO organization_features
         (organization_id, feature_key, enabled, reason, expires_at, set_by, set_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, feature_key) DO UPDATE
         SET enabled = EXCLUDED.enabled, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at,
             set_by = EXCLUDED.set_by, set_by_name = EXCLUDED.set_by_name, updated_at = now()
       RETURNING *`,
      [org.id, req.params.key, req.body.enabled, reason, expiresAt,
       req.user?.id || null, req.user?.name || null]
    );

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'feature_override_set','organization',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, org.id,
       before || null,
       { feature: req.params.key, enabled: req.body.enabled, reason, expires_at: expiresAt, studio: org.name },
       req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /organizations/:id/features/:key ──────────────────────────────────
// Clear the override so the studio falls back to its plan / the default.
router.delete('/organizations/:id/features/:key', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM organization_features WHERE organization_id = $1 AND feature_key = $2 RETURNING *',
      [req.params.id, req.params.key]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No override set' } });

    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_name, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,'feature_override_cleared','organization',$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.user?.name || null, req.params.id,
       { enabled: rows[0].enabled, reason: rows[0].reason, expires_at: rows[0].expires_at },
       { feature: req.params.key },
       req.ip || null, req.get('user-agent') || null]
    );

    res.json({ data: { cleared: true, feature: req.params.key } });
  } catch (err) { next(err); }
});

// ── GET /features/:key/overrides ─────────────────────────────────────────────
// Every studio that deviates from the default for one feature — the answer to
// "who is this switch actually going to affect".
router.get('/features/:key/overrides', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, org.name AS organization_name, org.slug AS organization_slug, org.plan_code
         FROM organization_features o
         JOIN organizations org ON org.id = o.organization_id
        WHERE o.feature_key = $1
        ORDER BY o.updated_at DESC`,
      [req.params.key]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

module.exports = router;

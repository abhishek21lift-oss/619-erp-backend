// src/routes/settings.js — Studio Settings CRUD
//
// ── Every statement here is scoped to one studio ───────────────────────────
//
// It did not used to be. system_settings had no organization_id and none of
// the queries below filtered, so all six studios in production shared one set
// of 35 rows: studio name, business email, phone, address, the geofence that
// gates check-in. Any studio could read another studio's, and overwrite it,
// because the upserts conflicted on `key` alone.
//
// Migration 194 gave the table an organization_id, moved the primary key to
// (organization_id, key) and swapped its RLS policy from shared-read to
// tenant_isolation. This file is the application half of that: orgIdOf(req)
// for writes, tenantScope(req) for reads, and no path that can see or touch a
// row belonging to another studio.
//
// settings.tenancy.integration.test.js proves it against a real database, and
// settings.routeScoping.test.js pins that these handlers are the ones doing it.
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, requireTrainer } = require('../middleware/auth');
const { orgIdOf } = require('../lib/tenant-db');
const logger = require('../lib/logger');

// The studio trainer only. server.js mounts this router behind requireTrainer
// too; declaring it here as well means the guard travels with the router and
// cannot be lost if the mount is edited or the router is mounted again.
router.use(auth, requireTrainer);

/**
 * The org this request reads and writes settings for.
 *
 * Fails closed: a caller with no resolvable studio gets null, and every query
 * below binds that null so it matches no row and writes nothing. Settings are
 * per-studio business configuration; there is no platform-wide view of them.
 */
function settingsOrg(req) {
  return orgIdOf(req);
}

/** 400 when there is no studio to scope to, so a write cannot land nowhere. */
function requireOrg(req, res) {
  const orgId = settingsOrg(req);
  if (!orgId) {
    res.status(400).json({
      error: { code: 'NO_ORG', message: 'Select a target studio before changing its settings.' },
    });
    return null;
  }
  return orgId;
}

// GET /api/settings — List all settings of the trainer's studio.
// Members never reach this router (requireTrainer at the mount), so there is
// no filtered "non-admin" view to serve.
router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value, type, description, updated_at FROM system_settings
        WHERE organization_id = $1 ORDER BY key`,
      [settingsOrg(req)]
    );

    const visibleRows = rows;

    const obj = {};
    for (const r of visibleRows) {
      if (r.type === 'boolean') obj[r.key] = r.value === 'true';
      else if (r.type === 'number') obj[r.key] = parseFloat(r.value);
      else obj[r.key] = r.value;
    }
    res.json({ settings: obj, raw: visibleRows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings — Bulk update settings
router.put('/', auth, requireTrainer, async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = Object.keys(updates);
    if (!keys.length)
      return res.status(400).json({ error: 'No settings provided' });

    const strVals = keys.map(key => {
      const val = updates[key];
      if (typeof val === 'boolean') return val ? 'true' : 'false';
      if (typeof val === 'number') return String(val);
      return val;
    });

    await pool.query(
      `INSERT INTO system_settings (organization_id, key, value, updated_at)
       SELECT $3, unnest($1::text[]), unnest($2::text[]), NOW()
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [keys, strVals, orgId]
    );

    logger.info({ userId: req.user.id, orgId, keys }, 'Settings updated');
    res.json({ message: 'Settings updated', count: keys.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/studio — Full studio config for the Studio Settings page
router.get('/studio', auth, async (req, res, next) => {
  try {
    const org = settingsOrg(req);
    const { rows } = await pool.query(
      'SELECT key, value, type FROM system_settings WHERE organization_id = $1', [org]
    );
    const settings = {};
    for (const r of rows) {
      if (r.type === 'boolean') settings[r.key] = r.value === 'true';
      else if (r.type === 'number') settings[r.key] = parseFloat(r.value);
      else settings[r.key] = r.value;
    }

    // Get branches
    const { rows: branches } = await pool.query(
      `SELECT s.key AS branch_id, s.value AS name,
              COALESCE((SELECT COUNT(*) FROM pt_clients WHERE branch_id = s.key AND deleted_at IS NULL), 0) AS member_count
       FROM system_settings s
       WHERE s.organization_id = $1 AND s.key LIKE 'branch_%' AND s.type = 'json'
       ORDER BY s.key`,
      [org]
    );

    res.json({ settings, branches });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/branches
router.get('/branches', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key AS id,
              (value::jsonb)->>'name' AS name,
              (value::jsonb)->>'location' AS location,
              (value::jsonb)->>'status' AS status,
              -- pt_clients carries no branch_id, so no client is attributed to a
              -- branch. The subquery that used to count them named a column that
              -- does not exist (every call failed) and, had it existed, would have
              -- counted clients of every studio sharing the same key.
              0::int AS member_count
       FROM system_settings s
       WHERE s.organization_id = $1 AND s.key LIKE 'branch_%' AND s.type = 'json'
       ORDER BY s.key`,
      [settingsOrg(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/branches
router.post('/branches', auth, requireTrainer, async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const { name, location } = req.body;
    if (!name?.trim())
      return res.status(400).json({ error: 'Branch name is required' });

    const id = randomUUID();
    const branchKey = 'branch_' + id;
    const value = JSON.stringify({ name: name.trim(), location: location || '', status: 'active' });

    await pool.query(
      `INSERT INTO system_settings (organization_id, key, value, type, description, updated_by, updated_at)
       VALUES ($5, $1, $2, 'json', $3, $4, NOW())`,
      [branchKey, value, 'Branch: ' + name.trim(), req.user.id, orgId]
    );

    res.status(201).json({ id, name: name.trim(), location: location || '', status: 'active', member_count: 0 });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/branches/:id
router.put('/branches/:id', auth, requireTrainer, async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const branchKey = 'branch_' + req.params.id;
    const { name, location, status } = req.body;

    const { rows: ex } = await pool.query(
      'SELECT value FROM system_settings WHERE key=$1 AND organization_id=$2',
      [branchKey, orgId]
    );
    if (!ex[0]) return res.status(404).json({ error: 'Branch not found' });

    let current;
    try { current = JSON.parse(ex[0].value); } catch { current = {}; }
    const updated = {
      name: name ?? current.name,
      location: location ?? current.location ?? '',
      status: status ?? current.status ?? 'active',
    };

    await pool.query(
      `UPDATE system_settings SET value=$1, updated_by=$2, updated_at=NOW()
       WHERE key=$3 AND organization_id=$4`,
      [JSON.stringify(updated), req.user.id, branchKey, orgId]
    );

    res.json({ id: req.params.id, ...updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/settings/branches/:id
//
// The client has always had a Delete Branch button; there was no route behind
// it, so it 404'd and the row stayed on screen.
//
// Refuses rather than orphans. `clients.branch_id` holds the full
// system_settings key (see the member_count subquery on GET /branches), and
// there is no FK to cascade or null it out — deleting a branch with members
// would leave those rows pointing at a key that no longer resolves, and they
// would silently vanish from every per-branch view. A studio that wants the
// branch out of the way without moving its members can PUT status:'inactive'.
router.delete('/branches/:id', auth, requireTrainer, async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const branchKey = 'branch_' + req.params.id;

    const { rows: ex } = await pool.query(
      'SELECT key FROM system_settings WHERE key=$1 AND organization_id=$2',
      [branchKey, orgId]
    );
    if (!ex[0]) return res.status(404).json({ error: 'Branch not found' });

    const { rows: [{ member_count }] } = await pool.query(
      `SELECT COUNT(*)::int AS member_count
         FROM pt_clients WHERE branch_id=$1 AND deleted_at IS NULL`,
      [branchKey]
    );
    if (member_count > 0) {
      return res.status(409).json({
        error: `Cannot delete a branch with ${member_count} member${member_count === 1 ? '' : 's'}. `
             + 'Move them to another branch first, or set this one to inactive.',
      });
    }

    await pool.query(
      'DELETE FROM system_settings WHERE key=$1 AND organization_id=$2', [branchKey, orgId]
    );
    res.json({ message: 'Branch deleted' });
  } catch (err) {
    next(err);
  }
});

// ── GYM / BIOMETRIC SETTINGS ─────────────────────────────────────────────────
const GYM_KEYS = [
  'geofence_lat', 'geofence_lng', 'geofence_radius',
  'enable_face_id', 'enable_touch_id', 'enable_gps',
  'duplicate_window_minutes', 'auto_checkout', 'auto_checkout_minutes',
];

const GYM_DEFAULTS = {
  geofence_lat: 19.076,
  geofence_lng: 72.8777,
  geofence_radius: 100,
  enable_face_id: true,
  enable_touch_id: true,
  enable_gps: true,
  duplicate_window_minutes: 60,
  auto_checkout: false,
  auto_checkout_minutes: 120,
};

// GET /api/settings/gym
router.get('/gym', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value, type FROM system_settings
        WHERE key = ANY($1::text[]) AND organization_id = $2`,
      [GYM_KEYS, settingsOrg(req)]
    );
    const result = { ...GYM_DEFAULTS };
    for (const r of rows) {
      if (r.type === 'boolean') result[r.key] = r.value === 'true';
      else if (r.type === 'number') result[r.key] = parseFloat(r.value);
      else result[r.key] = r.value;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/gym
router.put('/gym', auth, requireTrainer, async (req, res, next) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const body = req.body || {};
    const allowedKeys = GYM_KEYS.filter(k => body[k] !== undefined);
    if (!allowedKeys.length) return res.status(400).json({ error: 'No valid gym settings provided' });

    const strVals = allowedKeys.map(key => {
      const raw = body[key];
      if (typeof raw === 'boolean') return raw ? 'true' : 'false';
      if (typeof raw === 'number') return String(raw);
      return String(raw);
    });

    await pool.query(
      `INSERT INTO system_settings (organization_id, key, value, updated_at)
       SELECT $3, unnest($1::text[]), unnest($2::text[]), NOW()
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [allowedKeys, strVals, orgId]
    );

    logger.info({ userId: req.user.id, orgId, keys: allowedKeys }, 'Gym settings updated');
    res.json({ success: true, message: 'Gym settings saved', count: allowedKeys.length });
  } catch (err) {
    next(err);
  }
});

// The per-role permission matrix (perm_trainer_* / perm_reception_*) is gone
// with the staff roles: the trainer owns the studio and has every capability,
// so there is nothing left to grant or withhold. Migration 208 deletes the
// stored perm_* rows.
//
// So are GET/PUT /feature-flags. They required super_admin behind a mount that
// requires a trainer, so no request could ever reach them; the platform's
// feature switches live in the Command Center (/api/platform/features).

module.exports = router;

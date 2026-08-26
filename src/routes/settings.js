// src/routes/settings.js — Studio Settings CRUD
//
// ── Every query here carries an organization_id predicate ───────────────────
//
// `system_settings` and `feature_flags` received their tenant column in
// migration 180. Before it they had none, so none of the fourteen queries in
// this file was scoped — not because a filter was forgotten, but because there
// was nothing to filter on. The write routes are gated on `adminOnly`, which
// is the ordinary Studio Owner role granted to every self-serve trial signup,
// so any trial account could overwrite every studio's gym identity, permission
// matrix and feature flags, or delete another studio's branch.
//
// Two rules hold for everything below, and both are load-bearing:
//
//   READS  go through orgWhere(req, params), which appends nothing for a
//          platform super admin operating platform-wide. That is deliberate —
//          the operator console reads across studios — and safe, because
//          tenant users can never reach that branch (see lib/tenant-db.js:
//          the org comes from the JWT-loaded user row, and only the x-org-id
//          header can retarget it, only for a super_admin).
//
//   WRITES go through requireOrg(), which REFUSES when no organisation
//          resolved. orgWhere()'s empty-string return is correct for a read
//          and catastrophic for a write: an UPDATE with no predicate rewrites
//          every studio's row, and an INSERT with a NULL organization_id
//          recreates exactly the platform-global row migration 180 removed.
//          A super admin who wants to edit a studio's settings selects it in
//          the org switcher, which sends x-org-id.
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { orgWhere, orgIdOf } = require('../lib/tenant-db');
const logger = require('../lib/logger');

/**
 * The organisation this request writes to, or null if it has none.
 *
 * Returns null rather than throwing so each handler can answer with its own
 * shape; every caller below turns null into a 400. The message names the org
 * switcher because the only caller who can legitimately hit this is a platform
 * operator who has not selected a studio — a tenant user always resolves.
 */
function requireOrg(req, res) {
  const orgId = orgIdOf(req);
  if (!orgId) {
    res.status(400).json({
      error: {
        code: 'NO_TARGET_ORG',
        message: 'Select a studio before changing its settings.',
      },
    });
    return null;
  }
  return orgId;
}

// GET /api/settings — List all settings
// ISSUE-028: Non-admin users receive a filtered view that excludes
// internal_, geo_, biometric_, and feature_ prefixed keys.
router.get('/', auth, async (req, res, next) => {
  try {
    const params = [];
    const { rows } = await pool.query(
      `SELECT key, value, type, description, updated_at
         FROM system_settings
        WHERE 1=1${orgWhere(req, params)}
        ORDER BY key`,
      params
    );

    const isAdminLevel = ['admin', 'super_admin'].includes(req.user.role);
    const RESTRICTED_PREFIXES = ['internal_', 'geo_', 'biometric_', 'feature_'];
    const visibleRows = isAdminLevel
      ? rows
      : rows.filter(r => !RESTRICTED_PREFIXES.some(prefix => r.key.startsWith(prefix)));

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
router.put('/', auth, adminOnly, async (req, res, next) => {
  try {
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

    const orgId = requireOrg(req, res);
    if (!orgId) return;

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, organization_id)
       SELECT unnest($1::text[]), unnest($2::text[]), NOW(), $3
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [keys, strVals, orgId]
    );

    logger.info({ userId: req.user.id, keys }, 'Settings updated');
    res.json({ message: 'Settings updated', count: keys.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/studio — Full studio config for the Studio Settings page
router.get('/studio', auth, async (req, res, next) => {
  try {
    const params = [];
    const { rows } = await pool.query(
      `SELECT key, value, type FROM system_settings WHERE 1=1${orgWhere(req, params)}`,
      params
    );
    const settings = {};
    for (const r of rows) {
      if (r.type === 'boolean') settings[r.key] = r.value === 'true';
      else if (r.type === 'number') settings[r.key] = parseFloat(r.value);
      else settings[r.key] = r.value;
    }

    // Get branches.
    //
    // The member_count subquery is scoped too, and separately: it counts
    // pt_clients, not system_settings, so the outer filter does not reach it.
    // Unscoped it aggregated every studio's clients that happened to share a
    // branch key, which is a second cross-tenant read hiding inside the first.
    const bParams = [];
    const bOrg = orgWhere(req, bParams, 's.organization_id');
    const cOrg = orgWhere(req, bParams, 'c.organization_id');
    const { rows: branches } = await pool.query(
      `SELECT s.key AS branch_id, s.value AS name,
              COALESCE((SELECT COUNT(*) FROM pt_clients c
                         WHERE c.branch_id = s.key AND c.deleted_at IS NULL${cOrg}), 0) AS member_count
       FROM system_settings s
       WHERE s.key LIKE 'branch_%' AND s.type = 'json'${bOrg}
       ORDER BY s.key`,
      bParams
    );

    res.json({ settings, branches });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/branches
router.get('/branches', auth, async (req, res, next) => {
  try {
    // Both the branch rows and the client count they carry are scoped —
    // see the identical pair in GET /studio above.
    const params = [];
    const sOrg = orgWhere(req, params, 's.organization_id');
    const cOrg = orgWhere(req, params, 'c.organization_id');
    const { rows } = await pool.query(
      `SELECT key AS id,
              (value::jsonb)->>'name' AS name,
              (value::jsonb)->>'location' AS location,
              (value::jsonb)->>'status' AS status,
              COALESCE((SELECT COUNT(*) FROM pt_clients c
                         WHERE c.branch_id = s.key AND c.deleted_at IS NULL${cOrg}), 0)::int AS member_count
       FROM system_settings s
       WHERE s.key LIKE 'branch_%' AND s.type = 'json'${sOrg}
       ORDER BY s.key`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/branches
router.post('/branches', auth, adminOnly, async (req, res, next) => {
  try {
    const { name, location } = req.body;
    if (!name?.trim())
      return res.status(400).json({ error: 'Branch name is required' });

    const orgId = requireOrg(req, res);
    if (!orgId) return;

    const id = randomUUID();
    const branchKey = 'branch_' + id;
    const value = JSON.stringify({ name: name.trim(), location: location || '', status: 'active' });

    await pool.query(
      `INSERT INTO system_settings (key, value, type, description, updated_by, updated_at, organization_id)
       VALUES ($1, $2, 'json', $3, $4, NOW(), $5)`,
      [branchKey, value, 'Branch: ' + name.trim(), req.user.id, orgId]
    );

    res.status(201).json({ id, name: name.trim(), location: location || '', status: 'active', member_count: 0 });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/branches/:id
router.put('/branches/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const branchKey = 'branch_' + req.params.id;
    const { name, location, status } = req.body;

    const orgId = requireOrg(req, res);
    if (!orgId) return;

    // Scoped read before the write, so another studio's branch is a 404 rather
    // than a silent overwrite. The UPDATE below repeats the predicate — this
    // lookup narrows the response, the predicate is what bounds the write.
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
router.delete('/branches/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const branchKey = 'branch_' + req.params.id;

    const orgId = requireOrg(req, res);
    if (!orgId) return;

    const { rows: ex } = await pool.query(
      'SELECT key FROM system_settings WHERE key=$1 AND organization_id=$2',
      [branchKey, orgId]
    );
    if (!ex[0]) return res.status(404).json({ error: 'Branch not found' });

    // Scoped as well, and it matters in the refusing direction: an unscoped
    // count could see another studio's clients on a shared branch key and
    // block a delete this studio is entitled to make.
    const { rows: [{ member_count }] } = await pool.query(
      `SELECT COUNT(*)::int AS member_count
         FROM pt_clients WHERE branch_id=$1 AND deleted_at IS NULL AND organization_id=$2`,
      [branchKey, orgId]
    );
    if (member_count > 0) {
      return res.status(409).json({
        error: `Cannot delete a branch with ${member_count} member${member_count === 1 ? '' : 's'}. `
             + 'Move them to another branch first, or set this one to inactive.',
      });
    }

    await pool.query(
      'DELETE FROM system_settings WHERE key=$1 AND organization_id=$2',
      [branchKey, orgId]
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
    const params = [GYM_KEYS];
    const { rows } = await pool.query(
      `SELECT key, value, type FROM system_settings
        WHERE key = ANY($1::text[])${orgWhere(req, params)}`,
      params
    );
    // A studio with no rows yet falls back to these, which is what makes the
    // per-studio split safe for an organisation created after migration 180:
    // absent means default, not blank.
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
router.put('/gym', auth, adminOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const allowedKeys = GYM_KEYS.filter(k => body[k] !== undefined);
    if (!allowedKeys.length) return res.status(400).json({ error: 'No valid gym settings provided' });

    const strVals = allowedKeys.map(key => {
      const raw = body[key];
      if (typeof raw === 'boolean') return raw ? 'true' : 'false';
      if (typeof raw === 'number') return String(raw);
      return String(raw);
    });

    const orgId = requireOrg(req, res);
    if (!orgId) return;

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, organization_id)
       SELECT unnest($1::text[]), unnest($2::text[]), NOW(), $3
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

// ── ROLE PERMISSIONS ─────────────────────────────────────────────────────────

const PERM_KEYS = [
  'perm_trainer_pt_module', 'perm_trainer_finance', 'perm_trainer_reports',
  'perm_trainer_insights', 'perm_trainer_staff_view', 'perm_trainer_settings',
  'perm_trainer_all_pt_clients', 'perm_trainer_commissions', 'perm_trainer_record_payment',
  'perm_reception_pt_module', 'perm_reception_finance', 'perm_reception_reports',
  'perm_reception_insights', 'perm_reception_settings', 'perm_reception_staff_view',
  'perm_reception_record_payment',
];

const PERM_DEFAULTS = {
  perm_trainer_pt_module: true,
  perm_trainer_finance: false,
  perm_trainer_reports: false,
  perm_trainer_insights: false,
  perm_trainer_staff_view: true,
  perm_trainer_settings: false,
  perm_trainer_all_pt_clients: false,
  perm_trainer_commissions: true,
  perm_trainer_record_payment: false,
  perm_reception_pt_module: false,
  perm_reception_finance: false,
  perm_reception_reports: false,
  perm_reception_insights: false,
  perm_reception_settings: false,
  perm_reception_staff_view: true,
  perm_reception_record_payment: true,
};

// GET /api/settings/permissions
router.get('/permissions', auth, async (req, res, next) => {
  try {
    const params = [PERM_KEYS];
    const { rows } = await pool.query(
      `SELECT key, value FROM system_settings
        WHERE key = ANY($1::text[])${orgWhere(req, params)}`,
      params
    );
    const perms = { ...PERM_DEFAULTS };
    for (const r of rows) {
      perms[r.key] = r.value === 'true';
    }
    res.json({ permissions: perms, role: req.user.role });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/permissions
router.put('/permissions', auth, adminOnly, async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = PERM_KEYS.filter(k => updates[k] !== undefined);
    if (keys.length) {
      const orgId = requireOrg(req, res);
      if (!orgId) return;

      const strVals = keys.map(k => updates[k] ? 'true' : 'false');
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at, organization_id)
         SELECT unnest($1::text[]), unnest($2::text[]), NOW(), $3
         ON CONFLICT (organization_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [keys, strVals, orgId]
      );
    }
    res.json({ message: 'Permissions updated' });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/feature-flags
router.get('/feature-flags', auth, async (req, res, next) => {
  try {
    const params = [];
    const { rows } = await pool.query(
      `SELECT key, value, description FROM feature_flags
        WHERE 1=1${orgWhere(req, params)}
        ORDER BY key`,
      params
    );
    // No defaults map here, unlike GYM_DEFAULTS and PERM_DEFAULTS above: the
    // flag set is defined by the rows themselves, not by a constant in this
    // file, so there is nothing to fall back to. A studio with no rows gets an
    // empty object, which is what an empty table returned before as well.
    const flags = {};
    for (const r of rows) flags[r.key] = r.value;
    res.json({ flags, raw: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/feature-flags
router.put('/feature-flags', auth, adminOnly, async (req, res, next) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = Object.keys(updates);
    if (!keys.length) return res.json({ message: 'Feature flags updated', updated: 0, requested: 0 });

    // One statement, atomic by construction — the same shape PUT /permissions
    // above uses for the same class of bulk key/value write.
    //
    // This was a `for` loop issuing one UPDATE per key with no transaction
    // around it. A failure partway through (dropped connection, constraint
    // error on flag 3 of 5) left flags 1-2 committed, 4-5 never attempted, and
    // returned a single 500 that read as "nothing happened" — so the operator's
    // next move was to retry a write that had already half-applied. Feature
    // flags gate real functionality, so a half-applied set is a half-configured
    // product, not a cosmetic problem.
    const orgId = requireOrg(req, res);
    if (!orgId) return;

    // Still an UPDATE rather than an upsert, deliberately. Inserting on absence
    // would make a mistyped key create a flag row instead of being reported by
    // the `updated` count below, and the flag set is defined by the rows rather
    // than by an allow-list in this file, so there is nothing to validate a key
    // against. See settings.featureFlags.atomic.test.js, which pins both the
    // single-statement shape and the skip-unknown-keys behaviour.
    //
    // Known consequence: an organisation created AFTER migration 180 has no
    // flag rows of its own — 180 fans out to the studios that existed when it
    // ran — so every write reports `updated: 0` until something seeds them.
    // That is a provisioning gap, not a scoping one; seeding belongs with
    // organisation creation (super-admin/organizations.js, registrations.js)
    // and is deliberately not bundled into a tenant-isolation fix.
    const vals = keys.map((k) => Boolean(updates[k]));
    const { rowCount } = await pool.query(
      `UPDATE feature_flags AS f
          SET value = v.value, updated_at = NOW()
         FROM unnest($1::text[], $2::boolean[]) AS v(key, value)
        WHERE f.key = v.key AND f.organization_id = $3`,
      [keys, vals, orgId]
    );

    // Report what actually changed. Unknown keys match no row and are skipped
    // silently — true of the loop too — so returning the count lets a caller
    // notice a typo instead of reading "updated" and believing it.
    res.json({ message: 'Feature flags updated', updated: rowCount, requested: keys.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

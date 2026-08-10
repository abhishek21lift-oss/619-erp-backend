// src/routes/settings.js — Studio Settings CRUD
//
// ── AUD-001 (P0) ────────────────────────────────────────────────────────────
//
// Every handler in this file used to read and write `system_settings` and
// `feature_flags` with no organization predicate, because neither table had an
// organization column. Six live studios shared one row set: one studio's name,
// its owner's email and mobile, its street location, the GPS coordinates of its
// check-in geofence, and the sixteen role-permission toggles. Any admin could
// read all of it and, via a bulk PUT that accepted arbitrary keys, overwrite it
// for everyone.
//
// Migration 159 adds `organization_id` and re-keys both tables on
// `(organization_id, key)`. This file is the other half: every read is scoped,
// every write is scoped and stamped, and the bulk PUT now goes through an
// explicit allow-list (lib/settingsSchema.js) instead of trusting Object.keys.
//
// Settings are inherently per-studio, so there is no meaningful platform-wide
// view of them: a super admin operating with no target organization is asked to
// pick one rather than being served six studios' settings merged into one
// object. Same shape as routes/aiKnowledge.js.
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');
const { validateSettingsBody } = require('../lib/settingsSchema');
const { SETTING_DEFAULTS, FEATURE_FLAG_DEFAULTS } = require('../lib/settingsDefaults');
const logger = require('../lib/logger');

/**
 * The organization whose settings this request may touch, or null.
 *
 * A tenant user always gets their own — `tenantScope` reads it from the
 * session, never from the request, so it cannot be steered by a body or a
 * query parameter. A super admin gets whichever org they have targeted with
 * `x-org-id`, and null if they have targeted none.
 */
function settingsOrg(req, res) {
  const scope = tenantScope(req);
  if (!scope.orgId) {
    res.status(400).json({
      error: {
        code: 'NO_ORG',
        message: scope.isSuperAdmin
          ? 'Select a studio (x-org-id) before reading or changing its settings.'
          : 'This account is not attached to a studio.',
      },
    });
    return null;
  }
  return scope.orgId;
}

/** Parse a stored row back into its JS value, per the recorded type. */
function parseValue(row) {
  if (row.type === 'boolean') return row.value === 'true';
  if (row.type === 'number') return parseFloat(row.value);
  return row.value;
}

/** Upsert validated entries for one organization, in a single statement. */
async function writeSettings(orgId, entries, userId) {
  return pool.query(
    `INSERT INTO system_settings (organization_id, key, value, type, updated_by, updated_at)
     SELECT $1, k, v, t, $5, NOW()
       FROM unnest($2::text[], $3::text[], $4::text[]) AS s(k, v, t)
     ON CONFLICT (organization_id, key)
     DO UPDATE SET value = EXCLUDED.value,
                   type = EXCLUDED.type,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
    [
      orgId,
      entries.map((e) => e.key),
      entries.map((e) => e.value),
      entries.map((e) => e.type),
      userId || null,
    ]
  );
}

// GET /api/settings — List all settings for the caller's studio
// ISSUE-028: Non-admin users receive a filtered view that excludes
// internal_, geo_, biometric_, and feature_ prefixed keys.
router.get('/', auth, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    const { rows } = await pool.query(
      `SELECT key, value, type, description, updated_at
         FROM system_settings
        WHERE organization_id = $1
        ORDER BY key`,
      [orgId]
    );

    const isAdminLevel = ['admin', 'super_admin'].includes(req.user.role);
    const RESTRICTED_PREFIXES = ['internal_', 'geo_', 'biometric_', 'feature_'];
    const visibleRows = isAdminLevel
      ? rows
      : rows.filter(r => !RESTRICTED_PREFIXES.some(prefix => r.key.startsWith(prefix)));

    const obj = {};
    for (const r of visibleRows) obj[r.key] = parseValue(r);
    res.json({ settings: obj, raw: visibleRows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings — Bulk update settings
//
// The body is checked against the settings catalogue before anything is
// written. An unknown key, a number outside its range, a string past its
// length, a boolean that is not one — any of those rejects the WHOLE request
// with a 400 naming what was wrong. Partial application is deliberately not an
// option: a half-saved settings screen is indistinguishable, to the person
// looking at it, from a saved one.
router.put('/', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    const parsed = validateSettingsBody(req.body);
    if (!parsed.ok) return res.status(parsed.status).json(parsed.error);

    await writeSettings(orgId, parsed.entries, req.user.id);

    logger.info(
      { userId: req.user.id, orgId, keys: parsed.entries.map((e) => e.key) },
      'Settings updated'
    );
    res.json({ message: 'Settings updated', count: parsed.entries.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/studio — Full studio config for the Studio Settings page
router.get('/studio', auth, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    const { rows } = await pool.query(
      'SELECT key, value, type FROM system_settings WHERE organization_id = $1',
      [orgId]
    );
    const settings = {};
    for (const r of rows) settings[r.key] = parseValue(r);

    const { rows: branches } = await pool.query(
      `SELECT s.key AS branch_id, s.value AS name,
              COALESCE((SELECT COUNT(*) FROM clients
                         WHERE branch_id = s.key AND deleted_at IS NULL), 0) AS member_count
         FROM system_settings s
        WHERE s.organization_id = $1
          AND s.key LIKE 'branch_%' AND s.type = 'json'
        ORDER BY s.key`,
      [orgId]
    );

    res.json({ settings, branches });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/branches
router.get('/branches', auth, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    // NOTE: member_count still counts the legacy `clients` table, which is
    // empty — so it always reads 0. That is AUD-006/Phase 4 territory (the
    // live client table is pt_clients) and is deliberately left alone here:
    // this change is about tenant isolation, and repointing it would alter
    // what the screen displays in the same deploy.
    const { rows } = await pool.query(
      `SELECT key AS id,
              (value::jsonb)->>'name' AS name,
              (value::jsonb)->>'location' AS location,
              (value::jsonb)->>'status' AS status,
              COALESCE((SELECT COUNT(*) FROM clients
                         WHERE branch_id = s.key AND deleted_at IS NULL), 0)::int AS member_count
         FROM system_settings s
        WHERE s.organization_id = $1
          AND s.key LIKE 'branch_%' AND s.type = 'json'
        ORDER BY s.key`,
      [orgId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/branches
router.post('/branches', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    const { name, location } = req.body;
    if (!name?.trim())
      return res.status(400).json({ error: 'Branch name is required' });
    if (name.trim().length > 120)
      return res.status(400).json({ error: 'Branch name must be at most 120 characters' });

    const id = randomUUID();
    const branchKey = 'branch_' + id;
    const value = JSON.stringify({
      name: name.trim(),
      location: (location || '').toString().slice(0, 200),
      status: 'active',
    });

    await pool.query(
      `INSERT INTO system_settings
         (organization_id, key, value, type, description, updated_by, updated_at)
       VALUES ($1, $2, $3, 'json', $4, $5, NOW())`,
      [orgId, branchKey, value, 'Branch: ' + name.trim(), req.user.id]
    );

    res.status(201).json({
      id, name: name.trim(), location: location || '', status: 'active', member_count: 0,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/branches/:id
router.put('/branches/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    const branchKey = 'branch_' + req.params.id;
    const { name, location, status } = req.body;

    const { rows: ex } = await pool.query(
      'SELECT value FROM system_settings WHERE organization_id = $1 AND key = $2',
      [orgId, branchKey]
    );
    // 404 rather than 403 for a branch owned by another studio: the response
    // must not confirm that the id exists somewhere else on the platform.
    if (!ex[0]) return res.status(404).json({ error: 'Branch not found' });

    let current;
    try { current = JSON.parse(ex[0].value); } catch { current = {}; }
    const updated = {
      name: (name ?? current.name ?? '').toString().slice(0, 120),
      location: (location ?? current.location ?? '').toString().slice(0, 200),
      status: ['active', 'inactive'].includes(status) ? status : (current.status ?? 'active'),
    };
    if (!updated.name.trim()) return res.status(400).json({ error: 'Branch name is required' });

    await pool.query(
      `UPDATE system_settings SET value = $1, updated_by = $2, updated_at = NOW()
        WHERE organization_id = $3 AND key = $4`,
      [JSON.stringify(updated), req.user.id, orgId, branchKey]
    );

    res.json({ id: req.params.id, ...updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/settings/branches/:id
//
// Refuses rather than orphans. `clients.branch_id` holds the full
// system_settings key, and there is no FK to cascade or null it out — deleting
// a branch with members would leave those rows pointing at a key that no longer
// resolves. A studio that wants the branch out of the way without moving its
// members can PUT status:'inactive'.
router.delete('/branches/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    const branchKey = 'branch_' + req.params.id;

    const { rows: ex } = await pool.query(
      'SELECT key FROM system_settings WHERE organization_id = $1 AND key = $2',
      [orgId, branchKey]
    );
    if (!ex[0]) return res.status(404).json({ error: 'Branch not found' });

    const { rows: [{ member_count }] } = await pool.query(
      `SELECT COUNT(*)::int AS member_count
         FROM clients WHERE branch_id = $1 AND deleted_at IS NULL`,
      [branchKey]
    );
    if (member_count > 0) {
      return res.status(409).json({
        error: `Cannot delete a branch with ${member_count} member${member_count === 1 ? '' : 's'}. `
             + 'Move them to another branch first, or set this one to inactive.',
      });
    }

    await pool.query(
      'DELETE FROM system_settings WHERE organization_id = $1 AND key = $2',
      [orgId, branchKey]
    );
    res.json({ message: 'Branch deleted' });
  } catch (err) {
    next(err);
  }
});

// ── GYM / BIOMETRIC SETTINGS ─────────────────────────────────────────────────
//
// The slice of the catalogue the check-in screen owns. Derived from
// lib/settingsDefaults rather than re-listed, so a key cannot exist here with
// one default and there with another.
const GYM_KEYS = [
  'geofence_lat', 'geofence_lng', 'geofence_radius',
  'enable_face_id', 'enable_touch_id', 'enable_gps',
  'duplicate_window_minutes', 'auto_checkout', 'auto_checkout_minutes',
];

const PERM_KEYS = SETTING_DEFAULTS
  .filter((d) => d.key.startsWith('perm_'))
  .map((d) => d.key);

/** Catalogue defaults for a slice of keys, as parsed JS values. */
function defaultsFor(keys) {
  const out = {};
  for (const key of keys) {
    const d = SETTING_DEFAULTS.find((x) => x.key === key);
    if (!d) continue;
    out[key] = d.type === 'boolean' ? d.value === 'true'
      : d.type === 'number' ? parseFloat(d.value)
        : d.value;
  }
  return out;
}

/** Read a slice of the caller's settings, falling back to catalogue defaults. */
async function readSlice(orgId, keys) {
  const { rows } = await pool.query(
    `SELECT key, value, type FROM system_settings
      WHERE organization_id = $1 AND key = ANY($2::text[])`,
    [orgId, keys]
  );
  const result = defaultsFor(keys);
  for (const r of rows) result[r.key] = parseValue(r);
  return result;
}

// GET /api/settings/gym
router.get('/gym', auth, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;
    res.json(await readSlice(orgId, GYM_KEYS));
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/gym
router.put('/gym', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    // Only the gym slice is settable here. The whole body is validated, NOT a
    // pre-filtered subset: filtering first would silently discard a key that
    // does not belong here and still answer 200, so the caller would be told
    // their change was saved when it was thrown away. Rejecting by name is the
    // whole point of having an allow-list.
    const body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) {
      return res.status(400).json({ error: 'No valid gym settings provided' });
    }

    const parsed = validateSettingsBody(body, { allowKeys: GYM_KEYS });
    if (!parsed.ok) return res.status(parsed.status).json(parsed.error);

    await writeSettings(orgId, parsed.entries, req.user.id);

    logger.info(
      { userId: req.user.id, orgId, keys: parsed.entries.map((e) => e.key) },
      'Gym settings updated'
    );
    res.json({ success: true, message: 'Gym settings saved', count: parsed.entries.length });
  } catch (err) {
    next(err);
  }
});

// ── ROLE PERMISSIONS ─────────────────────────────────────────────────────────
//
// NOTE, and it matters: these toggles are consumed by the browser only —
// lib/permissions-context.tsx in the frontend is their sole reader. No backend
// route checks one. Scoping them per studio (this change) stops one studio's
// admin configuring another studio's trainers; it does NOT make them
// enforceable. That is AUD-007, Phase 3.
router.get('/permissions', auth, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;
    const permissions = await readSlice(orgId, PERM_KEYS);
    res.json({ permissions, role: req.user.role });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/permissions
router.put('/permissions', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    // Same reasoning as PUT /gym above: validate the body as given, so a key
    // that does not belong here is refused by name rather than dropped.
    const body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) {
      return res.status(400).json({ error: 'No valid permissions provided' });
    }

    const parsed = validateSettingsBody(body, { allowKeys: PERM_KEYS });
    if (!parsed.ok) return res.status(parsed.status).json(parsed.error);

    await writeSettings(orgId, parsed.entries, req.user.id);

    logger.info(
      { userId: req.user.id, orgId, keys: parsed.entries.map((e) => e.key) },
      'Role permissions updated'
    );
    res.json({ message: 'Permissions updated', count: parsed.entries.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/feature-flags
router.get('/feature-flags', auth, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    const { rows } = await pool.query(
      `SELECT key, value, description FROM feature_flags
        WHERE organization_id = $1 ORDER BY key`,
      [orgId]
    );
    const flags = {};
    for (const d of FEATURE_FLAG_DEFAULTS) flags[d.key] = d.value;
    for (const r of rows) flags[r.key] = r.value;
    res.json({ flags, raw: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/feature-flags
//
// One statement, atomic by construction. This was a `for` loop issuing one
// UPDATE per key with no transaction around it; a failure partway through left
// some flags committed and the rest never attempted, and returned a single 500
// that read as "nothing happened".
router.put('/feature-flags', auth, adminOnly, async (req, res, next) => {
  try {
    const orgId = settingsOrg(req, res);
    if (!orgId) return;

    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates))
      return res.status(400).json({ error: 'Body must be a key-value object' });

    const keys = Object.keys(updates);
    if (!keys.length) return res.json({ message: 'Feature flags updated', updated: 0, requested: 0 });

    // Deliberately NOT allow-listed, unlike PUT /api/settings above.
    //
    // The arbitrary-key problem in AUD-001 was that system_settings INSERTed
    // whatever it was given, so an unknown key became a new row. This is an
    // UPDATE joined against existing rows: an unknown key matches nothing and
    // writes nothing, so it cannot pollute the table or set anything. The
    // `updated` vs `requested` counts below are how a caller notices a typo —
    // a documented contract with its own test
    // (settings.featureFlags.atomic.test.js), and rejecting unknown keys here
    // would break it for no security gain.
    const { rowCount } = await pool.query(
      `UPDATE feature_flags AS f
          SET value = v.value, updated_at = NOW()
         FROM unnest($1::text[], $2::boolean[]) AS v(key, value)
        WHERE f.key = v.key AND f.organization_id = $3`,
      [keys, keys.map((k) => Boolean(updates[k])), orgId]
    );

    res.json({ message: 'Feature flags updated', updated: rowCount, requested: keys.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

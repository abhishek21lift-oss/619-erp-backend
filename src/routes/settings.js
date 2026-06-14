// src/routes/settings.js — Studio Settings CRUD
const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const logger = require('../lib/logger');

// GET /api/settings — List all settings
router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, value, type, description, updated_at FROM system_settings ORDER BY key'
    );
    const obj = {};
    for (const r of rows) {
      if (r.type === 'boolean') obj[r.key] = r.value === 'true';
      else if (r.type === 'number') obj[r.key] = parseFloat(r.value);
      else obj[r.key] = r.value;
    }
    res.json({ settings: obj, raw: rows });
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

    for (const key of keys) {
      const val = updates[key];
      let strVal;
      if (typeof val === 'boolean') strVal = val ? 'true' : 'false';
      else if (typeof val === 'number') strVal = String(val);
      else strVal = val;

      await pool.query(
        `INSERT INTO system_settings (key, value, type, updated_by, updated_at)
         VALUES ($1, $2,
           CASE
             WHEN $2 IN ('true','false') THEN 'boolean'
             WHEN $2 ~ '^\\d+(\\.\\d+)?$' THEN 'number'
             ELSE 'string'
           END,
           $3, NOW())
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           type = EXCLUDED.type,
           updated_by = $3,
           updated_at = NOW()`,
        [key, strVal, req.user.id]
      );
    }

    logger.info({ userId: req.user.id, keys }, 'Settings updated');
    res.json({ message: 'Settings updated', count: keys.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/studio — Full studio config for the Studio Settings page
router.get('/studio', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT key, value, type FROM system_settings');
    const settings = {};
    for (const r of rows) {
      if (r.type === 'boolean') settings[r.key] = r.value === 'true';
      else if (r.type === 'number') settings[r.key] = parseFloat(r.value);
      else settings[r.key] = r.value;
    }

    // Get branches
    const { rows: branches } = await pool.query(
      `SELECT s.key AS branch_id, s.value AS name,
              COALESCE((SELECT COUNT(*) FROM clients WHERE branch_id = s.key AND deleted_at IS NULL), 0) AS member_count
       FROM system_settings s
       WHERE s.key LIKE 'branch_%' AND s.type = 'json'
       ORDER BY s.key`
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
      `SELECT key AS id, value->>'name' AS name, value->>'location' AS location,
              value->>'status' AS status,
              COALESCE((SELECT COUNT(*) FROM clients WHERE branch_id = s.key AND deleted_at IS NULL), 0)::int AS member_count
       FROM system_settings s
       WHERE s.key LIKE 'branch_%' AND s.type = 'json'
       ORDER BY s.key`
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

    const id = randomUUID();
    const branchKey = 'branch_' + id;
    const value = JSON.stringify({ name: name.trim(), location: location || '', status: 'active' });

    await pool.query(
      `INSERT INTO system_settings (key, value, type, description, updated_by, updated_at)
       VALUES ($1, $2, 'json', $3, $4, NOW())`,
      [branchKey, value, 'Branch: ' + name.trim(), req.user.id]
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

    const { rows: ex } = await pool.query(
      'SELECT value FROM system_settings WHERE key=$1', [branchKey]
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
       WHERE key=$3`,
      [JSON.stringify(updated), req.user.id, branchKey]
    );

    res.json({ id: req.params.id, ...updated });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/branding — Load branding settings
router.get('/branding', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value, type FROM system_settings
       WHERE key IN ('primary_color','accent_color','theme_mode','typeface','button_style','radius_style')
       ORDER BY key`
    );
    const obj = {};
    for (const r of rows) {
      obj[r.key] = r.value;
    }
    res.json(obj);
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/branding — Save branding settings
router.put('/branding', auth, adminOnly, async (req, res, next) => {
  try {
    const allowed = ['primary_color','accent_color','theme_mode','typeface','button_style','radius_style'];
    const updates = req.body;
    if (!updates || typeof updates !== 'object')
      return res.status(400).json({ error: 'Body must be a key-value object' });

    for (const key of allowed) {
      if (updates[key] === undefined) continue;
      const val = String(updates[key]);
      await pool.query(
        `INSERT INTO system_settings (key, value, type, updated_by, updated_at)
         VALUES ($1, $2, 'string', $3, NOW())
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           updated_by = $3,
           updated_at = NOW()`,
        [key, val, req.user.id]
      );
    }

    logger.info({ userId: req.user.id }, 'Branding settings updated');
    res.json({ message: 'Branding settings updated' });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/branding/upload-logo — Upload brand asset
const path = require('path');
const fs = require('fs');
router.post('/branding/upload-logo', auth, adminOnly, async (req, res, next) => {
  try {
    const { image, key } = req.body;
    if (!image || !key)
      return res.status(400).json({ error: 'image (base64) and key are required' });

    const matches = image.match(/^data:image\/(jpeg|png|webp|gif);base64,(.+)$/);
    if (!matches)
      return res.status(400).json({ error: 'Invalid base64 image format. Allowed types: jpeg, png, webp, gif' });

    const ext = matches[1];
    const data = Buffer.from(matches[2], 'base64');
    const uploadsDir = path.join(__dirname, '..', '..', 'uploads', 'branding');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const filename = `${key}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, filename), data);

    const url = `/uploads/branding/${filename}`;
    res.json({ message: 'Uploaded', url });
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
      `SELECT key, value, type FROM system_settings WHERE key = ANY($1::text[])`,
      [GYM_KEYS]
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
router.put('/gym', auth, adminOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const allowedKeys = GYM_KEYS.filter(k => body[k] !== undefined);
    if (!allowedKeys.length) return res.status(400).json({ error: 'No valid gym settings provided' });

    for (const key of allowedKeys) {
      const raw = body[key];
      let strVal, type;
      if (typeof raw === 'boolean') { strVal = raw ? 'true' : 'false'; type = 'boolean'; }
      else if (typeof raw === 'number') { strVal = String(raw); type = 'number'; }
      else { strVal = String(raw); type = 'string'; }

      await pool.query(
        `INSERT INTO system_settings (key, value, type, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, type=$3, updated_by=$4, updated_at=NOW()`,
        [key, strVal, type, req.user.id]
      );
    }

    logger.info({ userId: req.user.id, keys: allowedKeys }, 'Gym settings updated');
    res.json({ success: true, message: 'Gym settings saved', count: allowedKeys.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/feature-flags
router.get('/feature-flags', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT key, value, description FROM feature_flags ORDER BY key');
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

    for (const [key, val] of Object.entries(updates)) {
      await pool.query(
        `UPDATE feature_flags SET value=$1, updated_at=NOW() WHERE key=$2`,
        [Boolean(val), key]
      );
    }
    res.json({ message: 'Feature flags updated' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
// otplib v13 removed the `authenticator` singleton that v12 exported and
// replaced it with these functions. Verification now returns a RESULT OBJECT
// ({ valid, delta, ... }), not a boolean — reading it as a boolean would make
// every code appear valid, so the `.valid` property is checked explicitly.
// `epochTolerance` is in SECONDS; 30 is one TOTP step either side, matching
// what v12's `{ window: 1 }` meant.
const { generateSecret, verifySync } = require('otplib');
const pool = require('../db/pool');
const { auth, invalidateUserCache } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { saveFile } = require('../lib/fileStorage');
const credentials = require('../lib/credentials');
const profileFields = require('../lib/profileFields');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || '')) {
      return cb(new Error('Only PNG, JPG, WEBP, or GIF images are allowed'));
    }
    cb(null, true);
  },
});

const defaultNotifications = {
  email_logins: true,
  email_payments: true,
  email_reports: true,
  email_marketing: false,
  push_logins: true,
  push_tasks: true,
  push_mentions: true,
  whatsapp_alerts: false,
  frequency: 'instant',
};

const defaultPreferences = {
  theme: 'system',
  language: 'en',
  timezone: 'Asia/Calcutta',
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '12h',
  compactMode: false,
};

let schemaReady;

function jsonOrDefault(value, fallback) {
  if (!value) return { ...fallback };
  if (typeof value === 'object') return { ...fallback, ...value };
  try {
    return { ...fallback, ...JSON.parse(value) };
  } catch {
    return { ...fallback };
  }
}

function clientInfo(req) {
  const ua = String(req.headers['user-agent'] || '');
  const browser = /Chrome/i.test(ua) ? 'Chrome'
    : /Firefox/i.test(ua) ? 'Firefox'
    : /Safari/i.test(ua) ? 'Safari'
    : /Edge/i.test(ua) ? 'Edge'
    : 'Browser';
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Mac OS|Macintosh/i.test(ua) ? 'macOS'
    : /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';
  const type = /Mobile|Android|iPhone/i.test(ua) ? 'mobile' : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
  return { browser, os, type, ip: req.ip || '' };
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT,
        location TEXT,
        bio TEXT,
        avatar_url TEXT,
        notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
        preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
        mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        mfa_secret TEXT,
        job_title TEXT,
        experience_since DATE,
        specialisations JSONB NOT NULL DEFAULT '[]'::jsonb,
        certifications JSONB NOT NULL DEFAULT '[]'::jsonb,
        cover_url TEXT,
        designation TEXT,
        philosophy TEXT,
        training_style TEXT,
        current_gym TEXT,
        languages JSONB NOT NULL DEFAULT '[]'::jsonb,
        coaching_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
        previous_gyms JSONB NOT NULL DEFAULT '[]'::jsonb,
        education JSONB NOT NULL DEFAULT '[]'::jsonb,
        achievements JSONB NOT NULL DEFAULT '[]'::jsonb,
        working_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  await schemaReady;
}

async function profileFor(userId) {
  await ensureSchema();
  await pool.query('INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.created_at, u.last_login,
            p.phone, p.location, p.bio, p.avatar_url,
            p.notification_preferences, p.preferences, p.mfa_enabled,
            p.job_title, p.experience_since, p.specialisations, p.certifications,
            p.cover_url, p.designation, p.philosophy, p.training_style, p.current_gym,
            p.languages, p.coaching_modes, p.previous_gyms, p.education,
            p.achievements, p.working_hours
       FROM users u
  LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  return rows[0];
}

/** A JSONB column that should hold a list, defended at the boundary. */
function arr(v) { return Array.isArray(v) ? v : []; }

function shapeProfile(row) {
  const since = row.experience_since
    ? new Date(row.experience_since).toISOString().slice(0, 10) : null;
  return {
    id: row.id,
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    role: row.role || '',
    location: row.location || '',
    bio: row.bio || '',
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login,
    mfaEnabled: Boolean(row.mfa_enabled),
    jobTitle: row.job_title || '',
    // Normalise ONCE and derive from that. node-postgres hands a DATE column
    // back as a Date object, not a 'YYYY-MM-DD' string, and passing the raw
    // value to yearsOfExperience() made it reject its own stored date and
    // report null years for everyone.
    experienceSince: since,
    // A date in, a duration out. See lib/credentials.js — storing "8 years"
    // is wrong twelve months later and nobody comes back to correct it.
    yearsExperience: credentials.yearsOfExperience(since),
    specialisations: Array.isArray(row.specialisations) ? row.specialisations : [],
    // Each certificate arrives with its expiry status already decided. The
    // browser's clock is not evidence of whether someone is currently
    // qualified to take a session.
    certifications: credentials.presentCertifications(row.certifications),
    credentialSummary: credentials.credentialSummary(row.certifications),

    // ── Migration 133 fields ────────────────────────────────────────────────
    coverUrl: row.cover_url || null,
    designation: row.designation || '',
    philosophy: row.philosophy || '',
    trainingStyle: row.training_style || '',
    currentGym: row.current_gym || '',
    languages: arr(row.languages),
    coachingModes: arr(row.coaching_modes),
    previousGyms: arr(row.previous_gyms),
    education: arr(row.education),
    achievements: arr(row.achievements),
    workingHours: (row.working_hours && typeof row.working_hours === 'object'
      && !Array.isArray(row.working_hours)) ? row.working_hours : {},
    // Derived, so the UI never has to add up a week of split shifts itself
    // and then disagree with the next screen that tries.
    weeklyMinutes: profileFields.weeklyMinutes(row.working_hours),
  };
}

router.use(auth);

router.get('/me', async (req, res, next) => {
  try {
    const row = await profileFor(req.user.id);
    res.json(shapeProfile(row));
  } catch (err) {
    next(err);
  }
});

/**
 * Every column on user_profiles that PUT /me may write, as data.
 *
 * ── Why a table and not eighteen if-blocks ───────────────────────────────────
 *
 * The rule "a field the client did not send is left alone" has to hold for
 * every field, and the version of this written as one guard per field did not:
 * phone, location and bio were built into the SET list unconditionally, so a
 * PUT that omitted them wrote '' over whatever was there. Nobody noticed
 * because the only client always sent all three — until this page grew tabs
 * that legitimately do not render them.
 *
 * Expressed this way the rule lives in exactly one line of the loop below, so
 * a nineteenth field cannot forget it.
 *
 * `parse` returns { value } or { error }, matching lib/credentials.js.
 * `json` marks a column that must be stringified before it is bound.
 */
const ok = (value) => ({ value });

const PROFILE_FIELDS = [
  { body: 'phone',            col: 'phone',            parse: (v) => ok(credentials.cleanText(v, 40)) },
  { body: 'location',         col: 'location',         parse: (v) => ok(credentials.cleanText(v, 160)) },
  { body: 'bio',              col: 'bio',              parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.freeText)) },
  { body: 'job_title',        col: 'job_title',        parse: (v) => ok(credentials.cleanText(v, credentials.LIMITS.job_title)) },
  { body: 'designation',      col: 'designation',      parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.designation)) },
  { body: 'philosophy',       col: 'philosophy',       parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.philosophy)) },
  { body: 'training_style',   col: 'training_style',   parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.trainingStyle)) },
  { body: 'current_gym',      col: 'current_gym',      parse: (v) => ok(credentials.cleanText(v, profileFields.LIMITS.gymName)) },
  {
    body: 'experience_since',
    col: 'experience_since',
    parse: (v) => {
      const d = credentials.cleanDate(v);
      return d === undefined ? { error: 'Invalid experience start date' } : ok(d);
    },
  },
  { body: 'specialisations',  col: 'specialisations',  parse: credentials.validateSpecialisations,  json: true },
  { body: 'certifications',   col: 'certifications',   parse: credentials.validateCertifications,   json: true },
  { body: 'languages',        col: 'languages',        parse: profileFields.validateLanguages,      json: true },
  { body: 'coaching_modes',   col: 'coaching_modes',   parse: profileFields.validateCoachingModes,  json: true },
  { body: 'previous_gyms',    col: 'previous_gyms',    parse: profileFields.validatePreviousGyms,   json: true },
  { body: 'education',        col: 'education',        parse: profileFields.validateEducation,      json: true },
  { body: 'achievements',     col: 'achievements',     parse: profileFields.validateAchievements,   json: true },
  { body: 'working_hours',    col: 'working_hours',    parse: profileFields.validateWorkingHours,   json: true },
];

router.put('/me', async (req, res, next) => {
  try {
    await ensureSchema();
    // name and email stay outside the table: they live on `users`, they are
    // required rather than optional, and email carries a uniqueness check.
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 AND deleted_at IS NULL',
      [email, req.user.id]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    // Validate everything BEFORE writing anything, so a bad certification
    // cannot leave the name and email already updated.
    const writes = [];
    for (const f of PROFILE_FIELDS) {
      if (req.body[f.body] === undefined) continue;   // ← the whole contract, once
      const r = f.parse(req.body[f.body]);
      if (r.error) return res.status(400).json({ error: r.error });
      writes.push([f.col, f.json ? JSON.stringify(r.value) : r.value]);
    }

    await pool.query('UPDATE users SET name = $1, email = $2, updated_at = NOW() WHERE id = $3', [name, email, req.user.id]);

    // Guarantee the row, then UPDATE only the columns this request carried.
    //
    // The obvious shape — one INSERT ... ON CONFLICT with COALESCE on each
    // value — cannot express the difference between "the client omitted this
    // field" and "the client cleared it", because both arrive as NULL and
    // COALESCE keeps the old value for each. That would make an experience
    // date, once set, impossible to erase.
    await pool.query('INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user.id]);

    if (writes.length) {
      const params = [req.user.id];
      const sets = writes.map(([col, value]) => { params.push(value); return `${col} = $${params.length}`; });
      sets.push('updated_at = NOW()');
      await pool.query(`UPDATE user_profiles SET ${sets.join(', ')} WHERE user_id = $1`, params);
    }

    invalidateUserCache(req.user.id);
    await logActivity(req, 'profile.update', 'user', req.user.id, { name, email });
    const row = await profileFor(req.user.id);
    res.json(shapeProfile(row));
  } catch (err) {
    next(err);
  }
});

// M-06: magic byte signatures to verify actual file type, not just MIME header
const IMAGE_SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg',  magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  ext: 'png',  magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif',  ext: 'gif',  magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46], offset4: [0x57, 0x45, 0x42, 0x50] },
];

function detectImageType(buf) {
  for (const sig of IMAGE_SIGNATURES) {
    const header = sig.magic.every((b, i) => buf[i] === b);
    if (!header) continue;
    if (sig.offset4 && !sig.offset4.every((b, i) => buf[8 + i] === b)) continue;
    return sig;
  }
  return null;
}

router.post('/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Avatar file is required' });
    await ensureSchema();

    // M-06: verify magic bytes — MIME header alone can be spoofed
    const detected = detectImageType(req.file.buffer);
    if (!detected) {
      return res.status(400).json({ error: 'File content does not match an allowed image type (PNG, JPG, WEBP, GIF)' });
    }
    const filename = `${req.user.id}-${Date.now()}.${detected.ext}`;
    const avatarUrl = await saveFile('profile', filename, req.file.buffer, detected.mime,
      { organizationId: req.user.organization_id, uploadedBy: req.user.id });

    await pool.query(
      `INSERT INTO user_profiles (user_id, avatar_url, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET avatar_url = EXCLUDED.avatar_url, updated_at = NOW()`,
      [req.user.id, avatarUrl]
    );
    await logActivity(req, 'profile.avatar.update', 'user', req.user.id);
    res.json({ avatarUrl });
  } catch (err) {
    next(err);
  }
});

router.put('/password', async (req, res, next) => {
  try {
    const currentPassword = String(req.body.currentPassword || req.body.current || '');
    const newPassword = String(req.body.newPassword || req.body.password || '');
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password = $1, token_version = token_version + 1, updated_at = NOW() WHERE id = $2',
      [hashed, req.user.id]
    );
    invalidateUserCache(req.user.id);
    await logActivity(req, 'profile.password.update', 'user', req.user.id);
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
});

router.post('/mfa/setup', async (req, res, next) => {
  try {
    await ensureSchema();
    const secret = generateSecret();
    await pool.query(
      `INSERT INTO user_profiles (user_id, mfa_secret, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET mfa_secret = EXCLUDED.mfa_secret, updated_at = NOW()`,
      [req.user.id, secret]
    );
    res.json({
      secret,
      qrUrl: `otpauth://totp/619-ERP:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=619-ERP`,
    });
  } catch (err) {
    next(err);
  }
});

// A 6-digit TOTP code is a 1M-value space; throttle harder than the general
// per-user API limit so it can't be brute-forced from a single account.
const mfaVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many MFA verification attempts. Please wait 15 minutes.' },
});

router.post('/mfa/verify', mfaVerifyLimiter, async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Valid MFA code is required' });
    await ensureSchema();
    const { rows } = await pool.query('SELECT mfa_secret FROM user_profiles WHERE user_id = $1', [req.user.id]);
    const storedSecret = rows[0] && rows[0].mfa_secret;
    if (!storedSecret) return res.status(400).json({ error: 'MFA setup required before verification' });
    const valid = verifySync({
      secret: storedSecret, token: code, strategy: 'totp', epochTolerance: 30,
    }).valid;
    if (!valid) return res.status(400).json({ error: 'Invalid MFA code' });
    await pool.query(
      `UPDATE user_profiles
          SET mfa_enabled = TRUE, updated_at = NOW()
        WHERE user_id = $1`,
      [req.user.id]
    );
    const recoveryCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());
    await logActivity(req, 'profile.mfa.enable', 'user', req.user.id);
    res.json({ recoveryCodes });
  } catch (err) {
    next(err);
  }
});

router.delete('/mfa', async (req, res, next) => {
  try {
    await ensureSchema();
    await pool.query('UPDATE user_profiles SET mfa_enabled = FALSE, mfa_secret = NULL, updated_at = NOW() WHERE user_id = $1', [req.user.id]);
    await logActivity(req, 'profile.mfa.disable', 'user', req.user.id);
    res.json({ message: 'MFA disabled' });
  } catch (err) {
    next(err);
  }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const row = await profileFor(req.user.id);
    res.json(jsonOrDefault(row.notification_preferences, defaultNotifications));
  } catch (err) {
    next(err);
  }
});

router.put('/notifications', async (req, res, next) => {
  try {
    await ensureSchema();
    const preferences = jsonOrDefault(req.body, defaultNotifications);
    await pool.query(
      `INSERT INTO user_profiles (user_id, notification_preferences, updated_at)
       VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET notification_preferences = EXCLUDED.notification_preferences, updated_at = NOW()`,
      [req.user.id, JSON.stringify(preferences)]
    );
    res.json(preferences);
  } catch (err) {
    next(err);
  }
});

router.get('/preferences', async (req, res, next) => {
  try {
    const row = await profileFor(req.user.id);
    res.json(jsonOrDefault(row.preferences, defaultPreferences));
  } catch (err) {
    next(err);
  }
});

router.put('/preferences', async (req, res, next) => {
  try {
    await ensureSchema();
    const preferences = jsonOrDefault(req.body, defaultPreferences);
    await pool.query(
      `INSERT INTO user_profiles (user_id, preferences, updated_at)
       VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET preferences = EXCLUDED.preferences, updated_at = NOW()`,
      [req.user.id, JSON.stringify(preferences)]
    );
    res.json(preferences);
  } catch (err) {
    next(err);
  }
});

router.get('/devices', (req, res) => {
  const info = clientInfo(req);
  res.json([{
    id: 'current',
    name: `${info.browser} on ${info.os}`,
    type: info.type,
    browser: info.browser,
    os: info.os,
    ip: info.ip,
    location: 'Current network',
    lastSeen: new Date().toISOString(),
    isCurrent: true,
  }]);
});

router.delete('/devices/:id', (req, res) => {
  if (req.params.id === 'current') return res.status(400).json({ error: 'Cannot revoke the current device here' });
  res.json({ message: 'Device revoked' });
});

router.get('/sessions', (req, res) => {
  const info = clientInfo(req);
  res.json([{
    id: 'current',
    ip: info.ip,
    location: 'Current network',
    device: `${info.type} device`,
    browser: info.browser,
    createdAt: req.user.last_login || new Date().toISOString(),
    lastActive: new Date().toISOString(),
    isCurrent: true,
  }]);
});

router.delete('/sessions/:id', (req, res) => {
  if (req.params.id === 'current') return res.status(400).json({ error: 'Cannot revoke the current session here' });
  res.json({ message: 'Session revoked' });
});

router.post('/sessions/revoke-all', async (req, res, next) => {
  try {
    await pool.query('UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1', [req.user.id]);
    invalidateUserCache(req.user.id);
    await logActivity(req, 'profile.sessions.revoke_all', 'user', req.user.id);
    res.clearCookie('token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });
    res.json({ message: 'All sessions revoked' });
  } catch (err) {
    next(err);
  }
});

router.get('/activity', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const category = String(req.query.category || '').trim();
    const params = [req.user.id];
    const conds = ['user_id = $1'];
    if (category && category !== 'all') {
      params.push(`${category}.%`);
      conds.push(`action LIKE $${params.length}`);
    }
    const where = conds.join(' AND ');
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM activity_log WHERE ${where}`, params);
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, action, entity_type, ip_address, created_at
         FROM activity_log
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = count.rows[0]?.total || 0;
    res.json({
      events: rows.map((row) => ({
        id: row.id,
        type: row.action,
        description: row.action.replace(/\./g, ' '),
        ip: row.ip_address || '',
        location: 'Current network',
        createdAt: row.created_at,
        category: row.action.split('.')[0] || 'system',
      })),
      hasMore: offset + rows.length < total,
      total,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

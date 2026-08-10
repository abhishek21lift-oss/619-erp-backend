'use strict';
// The studio settings catalogue — AUD-001.
//
// ONE list, three consumers, so they cannot disagree:
//
//   1. lib/settingsSchema.js  builds the PUT /api/settings allow-list from it.
//      A key that is not here cannot be written, at all.
//   2. seedOrganizationSettings() below gives a NEW studio a complete set at
//      the moment its organization row is created.
//   3. __tests__/security/settings.defaults.drift.test.js checks it against
//      the frozen copy inside migration 159, which is what every studio that
//      existed before that migration was seeded from.
//
// ── Why (2) exists ──────────────────────────────────────────────────────────
//
// Migration 159 seeds every organization that exists when it runs. Migrations
// run once. Without a seed at creation time, studio number seven — the first
// one to sign up after the deploy — opens Settings to a blank screen, a
// check-in geofence at 0,0 and no role permissions. The migration cannot help
// it; only this can.
//
// ── Why the migration keeps its own copy ────────────────────────────────────
//
// A migration must describe what it did on the day it ran. If it imported this
// file it would silently change meaning every time somebody edited a constant,
// and re-running it against a restored backup would produce a different
// database. The duplication is deliberate; the drift test is what makes it
// safe.

/**
 * Every setting a studio has, with the value a new studio starts from.
 *
 * `type` is the storage type recorded in system_settings.type, and drives both
 * how routes/settings.js parses the value back out and how settingsSchema.js
 * validates an incoming one.
 *
 * Constraint fields are advisory to the schema builder:
 *   maxLength  strings
 *   min / max  numbers
 *   enum       strings restricted to a fixed set
 */
const SETTING_DEFAULTS = [
  // ── Identity and branding ────────────────────────────────────────────────
  // studio_name and gym_name are seeded from the organization's own name at
  // creation time (see seedOrganizationSettings), so a new studio never opens
  // Settings showing a placeholder or, worse, somebody else's studio.
  { key: 'studio_name',  value: '',          type: 'string', maxLength: 120, description: 'Studio name shown across the app' },
  { key: 'gym_name',     value: '',          type: 'string', maxLength: 120, description: 'Legacy alias of studio_name' },
  { key: 'gym_address',  value: '',          type: 'string', maxLength: 500, description: 'Street address' },
  { key: 'gym_phone',    value: '',          type: 'string', maxLength: 32,  description: 'Public contact number' },
  { key: 'location',     value: '',          type: 'string', maxLength: 200, description: 'Locality shown on invoices' },
  { key: 'email',        value: '',          type: 'string', maxLength: 255, description: 'Contact email' },
  { key: 'phone',        value: '',          type: 'string', maxLength: 32,  description: 'Contact mobile' },
  { key: 'name',         value: '',          type: 'string', maxLength: 120, description: 'Owner name' },

  // ── Locale and finance ───────────────────────────────────────────────────
  { key: 'timezone',         value: 'UTC+05:30', type: 'string', maxLength: 64, description: 'Studio timezone' },
  { key: 'currency',         value: 'INR',       type: 'string', maxLength: 8,  description: 'Billing currency' },
  { key: 'gst',              value: '0',         type: 'number', min: 0, max: 1e9,  description: 'GST amount' },
  { key: 'gst_rate',         value: '0',         type: 'number', min: 0, max: 100,  description: 'GST percentage' },
  { key: 'invoice_prefix',   value: '0',         type: 'number', min: 0, max: 1e9,  description: 'Invoice number prefix' },
  { key: 'payment_terms',    value: '0',         type: 'number', min: 0, max: 365,  description: 'Payment terms in days' },
  { key: 'expiry_warn_days', value: '30',        type: 'number', min: 0, max: 365,  description: 'Warn this many days before a membership expires' },
  { key: 'retention_period', value: '',          type: 'string', maxLength: 64, description: 'Data retention period' },

  // ── Check-in ─────────────────────────────────────────────────────────────
  // Ranges are real units, not guesses: latitude and longitude have hard
  // bounds, and a geofence radius is metres. Before this, PUT /api/settings
  // accepted any value for any key — a radius of 40,000,000 would have made
  // the geofence the planet.
  { key: 'geofence_lat',    value: '19.076',  type: 'number', min: -90,  max: 90,    description: 'Check-in geofence latitude' },
  { key: 'geofence_lng',    value: '72.8777', type: 'number', min: -180, max: 180,   description: 'Check-in geofence longitude' },
  { key: 'geofence_radius', value: '100',     type: 'number', min: 1,    max: 50000, description: 'Check-in geofence radius in metres' },
  { key: 'enable_face_id',           value: 'true',  type: 'boolean', description: 'Allow Face ID check-in' },
  { key: 'enable_touch_id',          value: 'true',  type: 'boolean', description: 'Allow Touch ID check-in' },
  { key: 'enable_gps',               value: 'true',  type: 'boolean', description: 'Require GPS on check-in' },
  { key: 'duplicate_window_minutes', value: '60',    type: 'number', min: 0, max: 1440, description: 'Ignore repeat check-ins within this window' },
  { key: 'auto_checkout',            value: 'false', type: 'boolean', description: 'Check members out automatically' },
  { key: 'auto_checkout_minutes',    value: '120',   type: 'number', min: 1, max: 1440, description: 'Minutes before an automatic check-out' },
  // 'face' remains accepted because production still holds it, and a value the
  // database already contains must not become unwritable — that would make the
  // Settings screen impossible to save. Check-in is QR-only in the app today.
  { key: 'check_in_method',      value: 'qr',   type: 'string', enum: ['qr', 'face', 'manual'], description: 'Check-in method' },
  { key: 'face_match_threshold', value: '0.50', type: 'number', min: 0, max: 1, description: 'Face match confidence threshold' },
  { key: 'geo_fencing',          value: 'true', type: 'boolean', description: 'Enforce the check-in geofence' },

  // ── Notifications and product toggles ────────────────────────────────────
  { key: 'email_notifications', value: 'true', type: 'boolean', description: 'Send email notifications' },
  { key: 'sms_notifications',   value: 'true', type: 'boolean', description: 'Send SMS notifications' },
  { key: 'push_notifications',  value: 'true', type: 'boolean', description: 'Send push notifications' },
  { key: 'smart_reminders',     value: 'true', type: 'boolean', description: 'Send smart reminders' },
  { key: 'auto_renewals',       value: 'true', type: 'boolean', description: 'Offer automatic renewals' },
  { key: 'auto_backup',         value: 'true', type: 'boolean', description: 'Automatic backups' },
  { key: 'ai_insights',         value: 'true', type: 'boolean', description: 'Show AI insights' },

  // ── Role permissions ─────────────────────────────────────────────────────
  // Per-organization from now on. NOTE these are still enforced only in the
  // browser (AUD-007) — making them per-studio is the prerequisite for
  // enforcing them server-side in Phase 3, not the enforcement itself.
  { key: 'perm_trainer_pt_module',        value: 'true',  type: 'boolean', description: 'Trainer: PT module' },
  { key: 'perm_trainer_finance',          value: 'false', type: 'boolean', description: 'Trainer: finance' },
  { key: 'perm_trainer_reports',          value: 'false', type: 'boolean', description: 'Trainer: reports' },
  { key: 'perm_trainer_insights',         value: 'false', type: 'boolean', description: 'Trainer: insights' },
  { key: 'perm_trainer_staff_view',       value: 'true',  type: 'boolean', description: 'Trainer: view staff' },
  { key: 'perm_trainer_settings',         value: 'false', type: 'boolean', description: 'Trainer: settings' },
  { key: 'perm_trainer_all_pt_clients',   value: 'false', type: 'boolean', description: 'Trainer: all PT clients' },
  { key: 'perm_trainer_commissions',      value: 'true',  type: 'boolean', description: 'Trainer: commissions' },
  { key: 'perm_trainer_record_payment',   value: 'false', type: 'boolean', description: 'Trainer: record payment' },
  { key: 'perm_reception_pt_module',      value: 'false', type: 'boolean', description: 'Reception: PT module' },
  { key: 'perm_reception_finance',        value: 'false', type: 'boolean', description: 'Reception: finance' },
  { key: 'perm_reception_reports',        value: 'false', type: 'boolean', description: 'Reception: reports' },
  { key: 'perm_reception_insights',       value: 'false', type: 'boolean', description: 'Reception: insights' },
  { key: 'perm_reception_settings',       value: 'false', type: 'boolean', description: 'Reception: settings' },
  { key: 'perm_reception_staff_view',     value: 'true',  type: 'boolean', description: 'Reception: view staff' },
  { key: 'perm_reception_record_payment', value: 'true',  type: 'boolean', description: 'Reception: record payment' },
];

/**
 * Feature flags a studio starts with.
 *
 * face_checkin and voice_feedback default to FALSE where the pre-tenancy rows
 * had TRUE: both gate the face check-in system, which was removed from the app
 * (see the note above the '/api/biometric-attend' mount in server.js). A flag
 * that is on for a feature that no longer exists is a lie in the UI.
 */
const FEATURE_FLAG_DEFAULTS = [
  { key: 'auto_expire',        value: true,  description: 'Auto-expire memberships past end date' },
  { key: 'birthday_reminders', value: true,  description: 'Send birthday notifications' },
  { key: 'face_checkin',       value: false, description: 'Face recognition check-in (feature removed from the app)' },
  { key: 'voice_feedback',     value: false, description: 'Voice feedback on check-in (feature removed from the app)' },
];

/** Keys a studio may write, as a Set — the allow-list settingsSchema builds on. */
const SETTING_KEYS = SETTING_DEFAULTS.map((d) => d.key);
const SETTING_KEY_SET = new Set(SETTING_KEYS);

/** The definition for one key, or undefined if it is not a real setting. */
function settingDef(key) {
  return SETTING_DEFAULTS.find((d) => d.key === key);
}

/** A branch is stored as `branch_<uuid>` with type 'json' (routes/settings.js). */
const BRANCH_KEY_RE = /^branch_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Give one organization a complete set of settings and feature flags.
 *
 * `db` is a pg client or pool — pass the CLIENT when calling inside a
 * transaction, so a studio is never committed without its settings.
 *
 * ON CONFLICT DO NOTHING throughout, so this is safe to call on an
 * organization that already has some or all of them: it fills gaps and never
 * overwrites a value a studio has set.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} db
 * @param {string} organizationId
 * @param {{ studioName?: string }} [opts] studio name to seed into
 *        studio_name / gym_name instead of the empty default.
 * @returns {Promise<{ settings: number, flags: number }>} rows actually inserted
 */
async function seedOrganizationSettings(db, organizationId, opts = {}) {
  if (!organizationId) throw new Error('seedOrganizationSettings: organizationId is required');

  const name = typeof opts.studioName === 'string' ? opts.studioName.trim() : '';
  const NAME_KEYS = new Set(['studio_name', 'gym_name']);

  const keys = [];
  const values = [];
  const types = [];
  const descriptions = [];
  for (const d of SETTING_DEFAULTS) {
    keys.push(d.key);
    values.push(NAME_KEYS.has(d.key) && name ? name : d.value);
    types.push(d.type);
    descriptions.push(d.description);
  }

  // One statement rather than a loop: a partially-seeded studio is exactly the
  // failure this function exists to prevent, and a loop can be interrupted.
  const settingsRes = await db.query(
    `INSERT INTO system_settings (organization_id, key, value, type, description, updated_at)
     SELECT $1, k, v, t, d, NOW()
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS s(k, v, t, d)
     ON CONFLICT (organization_id, key) DO NOTHING`,
    [organizationId, keys, values, types, descriptions]
  );

  const flagsRes = await db.query(
    `INSERT INTO feature_flags (organization_id, key, value, description, updated_at)
     SELECT $1, k, v, d, NOW()
       FROM unnest($2::text[], $3::boolean[], $4::text[]) AS f(k, v, d)
     ON CONFLICT (organization_id, key) DO NOTHING`,
    [
      organizationId,
      FEATURE_FLAG_DEFAULTS.map((d) => d.key),
      FEATURE_FLAG_DEFAULTS.map((d) => d.value),
      FEATURE_FLAG_DEFAULTS.map((d) => d.description),
    ]
  );

  return { settings: settingsRes.rowCount, flags: flagsRes.rowCount };
}

module.exports = {
  SETTING_DEFAULTS,
  FEATURE_FLAG_DEFAULTS,
  SETTING_KEYS,
  SETTING_KEY_SET,
  BRANCH_KEY_RE,
  settingDef,
  seedOrganizationSettings,
};

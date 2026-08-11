// The settings catalogue exists twice, on purpose. This stops the two copies
// drifting apart.
//
//   lib/settingsDefaults.js          what a studio created TODAY is seeded with
//   migrations/159_settings_tenant_scope.sql   what every studio that existed
//                                    before that migration was seeded with
//
// A migration must describe what it did on the day it ran: if 159 imported the
// JavaScript it would silently change meaning whenever somebody edited a
// constant, and re-running it against a restored backup would build a
// different database. So the duplication is deliberate — and this test is the
// thing that makes it safe, in the same spirit as the SHARED_TABLES cross-check
// between migration 157 and migrations.orgNotNull.test.js.
//
// If this fails you have added a setting to one and not the other. The fix is
// never to edit the migration: add a NEW migration that seeds the new key for
// existing organizations, and update the catalogue. Editing an applied
// migration changes history without changing any database that already ran it.

'use strict';

const fs = require('fs');
const path = require('path');
const {
  SETTING_DEFAULTS,
  FEATURE_FLAG_DEFAULTS,
  SETTING_KEYS,
} = require('../../lib/settingsDefaults');

const MIGRATION = path.join(__dirname, '..', '..', 'db', 'migrations', '159_settings_tenant_scope.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');

/** The settings VALUES block: ('key', 'value', 'type', 'description'). */
function migrationSettingRows() {
  const block = sql.slice(
    sql.indexOf('INSERT INTO system_settings (organization_id, key, value, type, description, updated_at)'),
    sql.indexOf(') AS d(key, value, type, description)')
  );
  const rows = [];
  const re = /\(\s*'([a-z0-9_]+)'\s*,\s*'([^']*)'\s*,\s*'(string|number|boolean)'\s*,/gi;
  let m;
  while ((m = re.exec(block)) !== null) rows.push({ key: m[1], value: m[2], type: m[3] });
  return rows;
}

/** The feature-flag VALUES block: ('key', TRUE|FALSE, 'description'). */
function migrationFlagRows() {
  const block = sql.slice(
    sql.indexOf('INSERT INTO feature_flags (organization_id, key, value, description, updated_at)'),
    sql.indexOf(') AS d(key, value, description)')
  );
  const rows = [];
  const re = /\(\s*'([a-z0-9_]+)'\s*,\s*(TRUE|FALSE)\s*,/gi;
  let m;
  while ((m = re.exec(block)) !== null) rows.push({ key: m[1], value: m[2] === 'TRUE' });
  return rows;
}

describe('the settings catalogue and migration 159 agree', () => {
  const migrationRows = migrationSettingRows();

  test('the migration was parsed (guards against this test silently passing on nothing)', () => {
    expect(migrationRows.length).toBeGreaterThan(40);
    expect(migrationFlagRows().length).toBe(4);
  });

  test('the same setting keys, in both', () => {
    expect([...migrationRows.map((r) => r.key)].sort())
      .toEqual([...SETTING_KEYS].sort());
  });

  test('the same default value and type for every setting', () => {
    for (const row of migrationRows) {
      const def = SETTING_DEFAULTS.find((d) => d.key === row.key);
      expect(def).toBeDefined();
      expect({ key: row.key, value: row.value, type: row.type })
        .toEqual({ key: def.key, value: def.value, type: def.type });
    }
  });

  test('the same feature flags, with the same defaults', () => {
    const mig = migrationFlagRows().sort((a, b) => a.key.localeCompare(b.key));
    const cat = FEATURE_FLAG_DEFAULTS
      .map((d) => ({ key: d.key, value: d.value }))
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(mig).toEqual(cat);
  });

  // ── The flag seed must PREFER the pre-migration value ─────────────────────
  //
  // Before 159, `feature_flags` was one global table read by all six studios,
  // and production holds face_checkin=true and voice_feedback=true while the
  // catalogue defaults for both are FALSE. Seeding the catalogue value would
  // switch a live setting off for every studio on deploy day.
  //
  // The migration therefore seeds COALESCE(quarantined value, catalogue value).
  // These assertions pin that down: the previous version of this migration read
  // `SELECT o.id, d.key, d.value, ...` and would fail every one of them.
  test('the flag seed prefers the quarantined production value over the default', () => {
    const block = sql.slice(
      sql.indexOf('INSERT INTO feature_flags (organization_id, key, value, description, updated_at)'),
      sql.indexOf('-- 7. Indexes')
    );
    expect(block).toMatch(/COALESCE\(\s*q\.value\s*,\s*d\.value\s*\)/i);
    expect(block).toMatch(/COALESCE\(\s*q\.description\s*,\s*d\.description\s*\)/i);
    expect(block).toMatch(/LEFT\s+JOIN\s+feature_flags_unattributed\s+q\s+ON\s+q\.key\s*=\s*d\.key/i);
    // The bare-default form must be gone, or the COALESCE above is decorative.
    expect(block).not.toMatch(/SELECT\s+o\.id\s*,\s*d\.key\s*,\s*d\.value\s*,/i);
  });

  test('the seed still skips a studio that already has the key, so re-running is a no-op', () => {
    const block = sql.slice(
      sql.indexOf('INSERT INTO feature_flags (organization_id, key, value, description, updated_at)'),
      sql.indexOf('-- 7. Indexes')
    );
    expect(block).toMatch(/WHERE\s+NOT\s+EXISTS/i);
    expect(block).toMatch(/f\.organization_id\s*=\s*o\.id\s+AND\s+f\.key\s*=\s*d\.key/i);
  });

  test('the originals are still quarantined verbatim, not consumed by the seed', () => {
    // Preserving the VALUE must not have turned into moving the ROW: the
    // quarantine insert has to still copy value and description across.
    expect(sql).toMatch(
      /INSERT INTO feature_flags_unattributed \(key, value, description, updated_at, reason\)/
    );
    expect(sql).toMatch(/SELECT m\.key, m\.value, m\.description, m\.updated_at,/);
  });
});

describe('the catalogue itself is coherent', () => {
  test('no duplicate keys', () => {
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
  });

  test('every entry declares a type the storage layer understands', () => {
    for (const d of SETTING_DEFAULTS) {
      expect(['string', 'number', 'boolean']).toContain(d.type);
    }
  });

  test('every default value round-trips through its own declared type', () => {
    // A default that its own validator would reject is a studio that cannot
    // save its Settings screen without first changing a field it never touched.
    const { validateSetting } = require('../../lib/settingsSchema');
    for (const d of SETTING_DEFAULTS) {
      const raw = d.type === 'boolean' ? d.value === 'true'
        : d.type === 'number' ? parseFloat(d.value)
          : d.value;
      const r = validateSetting(d.key, raw);
      expect({ key: d.key, ok: r.ok }).toEqual({ key: d.key, ok: true });
    }
  });

  test('every numeric default sits inside its own declared range', () => {
    for (const d of SETTING_DEFAULTS.filter((x) => x.type === 'number')) {
      const n = parseFloat(d.value);
      if (d.min !== undefined) expect({ key: d.key, ok: n >= d.min }).toEqual({ key: d.key, ok: true });
      if (d.max !== undefined) expect({ key: d.key, ok: n <= d.max }).toEqual({ key: d.key, ok: true });
    }
  });

  test('the keys production already holds are all writable', () => {
    // Read off the live database during the Phase 1 audit. A key that exists in
    // production but is not in the catalogue would be readable and unwritable:
    // the Settings screen would show it and refuse to save it.
    const PRODUCTION_KEYS = [
      'ai_insights', 'auto_backup', 'auto_checkout', 'auto_checkout_minutes',
      'auto_renewals', 'check_in_method', 'currency', 'duplicate_window_minutes',
      'email', 'email_notifications', 'enable_face_id', 'enable_gps',
      'enable_touch_id', 'expiry_warn_days', 'face_match_threshold', 'geo_fencing',
      'geofence_lat', 'geofence_lng', 'geofence_radius', 'gst', 'gst_rate',
      'gym_address', 'gym_name', 'gym_phone', 'invoice_prefix', 'location',
      'name', 'payment_terms', 'phone', 'push_notifications', 'retention_period',
      'smart_reminders', 'sms_notifications', 'studio_name', 'timezone',
    ];
    const missing = PRODUCTION_KEYS.filter((k) => !SETTING_KEYS.includes(k));
    expect(missing).toEqual([]);
  });

  test('check_in_method still accepts the value production holds', () => {
    // Production stores 'face' from the removed face check-in system. The app
    // is QR-only now, but a value already in the database must stay writable or
    // the screen cannot be saved.
    const { validateSetting } = require('../../lib/settingsSchema');
    expect(validateSetting('check_in_method', 'face').ok).toBe(true);
    expect(validateSetting('check_in_method', 'qr').ok).toBe(true);
    expect(validateSetting('check_in_method', 'telepathy').ok).toBe(false);
  });
});

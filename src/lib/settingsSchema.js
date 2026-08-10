'use strict';
// The PUT /api/settings allow-list — AUD-001, second half.
//
// ── What this replaces ──────────────────────────────────────────────────────
//
// `PUT /api/settings` took `req.body`, read `Object.keys(updates)`, and upserted
// every one of them into system_settings. Any key, any value, any length. A
// studio admin could write `database_url`, `role`, `internal_flags` or ten
// thousand rows of junk, and — before the tenant column landed — every other
// studio would then read them.
//
// Nothing downstream re-validated: routes/settings.js parses a value purely
// from the stored `type` column, so a number key holding "banana" comes back as
// NaN, and a boolean key holding "no" comes back as false because the parse is
// `value === 'true'`. The write path was the only place this could be caught,
// and it caught nothing.
//
// ── The shape of the rule ───────────────────────────────────────────────────
//
// A key is writable only if it appears in SETTING_DEFAULTS (lib/settingsDefaults)
// or is a branch key. There is no escape hatch and no prefix wildcard: adding a
// setting means adding it to the catalogue, which also gives it a default, a
// type and a description for free.
//
// Rejection is explicit and names the offending key. A silent drop would be
// worse than a 400 — the operator sees "saved", the value is not saved, and
// nothing anywhere says why.

const { z } = require('zod');
const {
  SETTING_DEFAULTS,
  SETTING_KEY_SET,
  BRANCH_KEY_RE,
  settingDef,
} = require('./settingsDefaults');

/**
 * Keys that must NEVER be settable, listed by name even though the allow-list
 * already excludes them.
 *
 * The allow-list is what enforces this; the point of naming them is that a
 * future edit which widens the allow-list — a prefix match, a "custom_" escape
 * hatch, a merge of two catalogues — trips a test that says exactly why these
 * are different, rather than silently re-opening a privilege-escalation path.
 */
const FORBIDDEN_KEYS = [
  'organization_id', 'organizationId', 'org_id',
  'role', 'roles', 'permissions',
  'database_url', 'DATABASE_URL',
  'jwt_secret', 'JWT_SECRET',
  'internal_flags', 'is_super_admin', 'super_admin',
];

/** Coerce the incoming JS value to the string form system_settings stores. */
function serialize(value, type) {
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') return String(value);
  return String(value);
}

/**
 * Validate one key/value pair against the catalogue.
 * @returns {{ ok: true, value: string, type: string }
 *         | { ok: false, key: string, message: string }}
 */
function validateSetting(key, raw) {
  if (BRANCH_KEY_RE.test(key)) {
    // Branches are JSON blobs written by the branch endpoints, not by the bulk
    // settings PUT. Validate the shape rather than trusting it.
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return { ok: false, key, message: 'branch value must be valid JSON' };
    }
    const shape = z.object({
      name: z.string().min(1).max(120),
      location: z.string().max(200).optional().default(''),
      status: z.enum(['active', 'inactive']).optional().default('active'),
    });
    const r = shape.safeParse(parsed);
    if (!r.success) {
      return { ok: false, key, message: r.error.issues[0]?.message || 'invalid branch' };
    }
    return { ok: true, value: JSON.stringify(r.data), type: 'json' };
  }

  const def = settingDef(key);
  if (!def) {
    return {
      ok: false,
      key,
      message: FORBIDDEN_KEYS.includes(key)
        ? 'this key is not a studio setting and can never be set here'
        : 'unknown setting',
    };
  }

  if (def.type === 'boolean') {
    // Accept the real booleans and the two string forms the frontend has
    // historically sent; refuse anything else rather than coercing it to false.
    if (typeof raw === 'boolean') return { ok: true, value: serialize(raw, 'boolean'), type: 'boolean' };
    if (raw === 'true' || raw === 'false') return { ok: true, value: raw, type: 'boolean' };
    return { ok: false, key, message: 'must be true or false' };
  }

  if (def.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) return { ok: false, key, message: 'must be a number' };
    if (def.min !== undefined && n < def.min) {
      return { ok: false, key, message: `must be at least ${def.min}` };
    }
    if (def.max !== undefined && n > def.max) {
      return { ok: false, key, message: `must be at most ${def.max}` };
    }
    return { ok: true, value: serialize(n, 'number'), type: 'number' };
  }

  // string
  if (raw === null || raw === undefined) return { ok: true, value: '', type: 'string' };
  if (typeof raw === 'object') return { ok: false, key, message: 'must be text' };
  const s = String(raw).trim();
  if (def.maxLength !== undefined && s.length > def.maxLength) {
    return { ok: false, key, message: `must be at most ${def.maxLength} characters` };
  }
  if (def.enum && s !== '' && !def.enum.includes(s)) {
    return { ok: false, key, message: `must be one of: ${def.enum.join(', ')}` };
  }
  if (key === 'email' && s !== '' && !z.string().email().safeParse(s).success) {
    return { ok: false, key, message: 'must be a valid email address' };
  }
  return { ok: true, value: s, type: 'string' };
}

/**
 * Validate a whole `PUT /api/settings` body.
 *
 * Rejects the entire request if any key is bad, rather than applying the good
 * ones — a half-applied settings save is the failure mode the feature-flags
 * loop in this same router was already fixed for once.
 *
 * @param {unknown} body
 * @param {{ allowKeys?: string[] }} [opts] restrict to a subset (the /gym and
 *        /permissions endpoints, which own a slice of the catalogue).
 * @returns {{ ok: true, entries: Array<{key:string,value:string,type:string}> }
 *         | { ok: false, status: number, error: object }}
 */
function validateSettingsBody(body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: { error: 'Body must be a key-value object' } };
  }

  const keys = Object.keys(body);
  if (!keys.length) {
    return { ok: false, status: 400, error: { error: 'No settings provided' } };
  }
  // A bulk write is a settings save, not a data import. The catalogue is ~51
  // keys; anything far past that is a mistake or an attempt to fill the table.
  if (keys.length > 200) {
    return { ok: false, status: 400, error: { error: 'Too many settings in one request' } };
  }

  const allow = opts.allowKeys ? new Set(opts.allowKeys) : null;
  const entries = [];
  const rejected = [];

  for (const key of keys) {
    if (allow && !allow.has(key)) {
      rejected.push({ key, message: 'not settable on this endpoint' });
      continue;
    }
    const r = validateSetting(key, body[key]);
    if (r.ok) entries.push({ key, value: r.value, type: r.type });
    else rejected.push({ key: r.key, message: r.message });
  }

  if (rejected.length) {
    return {
      ok: false,
      status: 400,
      error: {
        error: {
          code: 'INVALID_SETTING',
          message: `Rejected ${rejected.length} setting${rejected.length === 1 ? '' : 's'}: `
            + rejected.map((r) => `${r.key} (${r.message})`).join('; '),
          rejected,
        },
      },
    };
  }

  return { ok: true, entries };
}

module.exports = {
  FORBIDDEN_KEYS,
  validateSetting,
  validateSettingsBody,
  // re-exported so routes/settings.js has one import
  SETTING_DEFAULTS,
  SETTING_KEY_SET,
};

// The matrix has one definition of what each toggle means, and one set of
// defaults, across both repositories.
//
// Two copies of a default is two answers to "may this trainer open Finance",
// and the answers only have to differ once. Before this file there were three
// copies — routes/settings.js, the frontend's permissions-context.tsx, and
// nothing on the server enforcing either — and the enforcement layer is exactly
// where a drift would stop being cosmetic.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PERM_KEYS, PERM_DEFAULTS, ENFORCEABLE, permKey, can } = require('../lib/permissions');

const BACKEND = path.join(__dirname, '..');
const FRONTEND = path.join(__dirname, '..', '..', '..', '619-erp-frontend', 'src');
const frontendAvailable = fs.existsSync(FRONTEND);

describe('the backend has one copy of the matrix', () => {
  it('routes/settings.js imports the keys rather than declaring them', () => {
    const src = fs.readFileSync(path.join(BACKEND, 'routes', 'settings.js'), 'utf8');
    expect(src).toMatch(/require\('\.\.\/lib\/permissions'\)/);
    // A local re-declaration is the drift this file exists to prevent.
    expect(src).not.toMatch(/const PERM_KEYS\s*=\s*\[/);
    expect(src).not.toMatch(/const PERM_DEFAULTS\s*=\s*\{/);
  });

  it('every key has a default, and every default is a key', () => {
    expect(Object.keys(PERM_DEFAULTS).sort()).toEqual([...PERM_KEYS].sort());
  });

  it('every enforceable feature has a trainer key, and a missing one denies', () => {
    // Trainer is offered all six. Reception is offered five — there is no
    // perm_reception_commissions, because commissions are not a front-desk
    // concern — and the absence has to read as DENY rather than as "no rule,
    // allow", which is the fail-closed half of can().
    for (const feature of ENFORCEABLE) {
      expect(PERM_KEYS).toContain(permKey('trainer', feature));
    }

    const missingForReception = ENFORCEABLE
      .filter((f) => !PERM_KEYS.includes(permKey('reception', f)));
    expect(missingForReception).toEqual(['commissions']);
    for (const feature of missingForReception) {
      expect(can('reception', feature, {})).toBe(false);
    }
  });
});

describe('an unknown key or role is denied, never waved through', () => {
  it('a feature with no key for the role denies', () => {
    // `commissions` has no perm_reception_* key — reception is not offered the
    // toggle. The gate must refuse rather than default to allowed.
    expect(permKey('reception', 'commissions')).toBe('perm_reception_commissions');
    expect(can('reception', 'commissions', {})).toBe(false);
  });

  it('a role outside the matrix and outside the unconstrained list denies', () => {
    expect(can('staff', 'finance', {})).toBe(false);
    expect(can('nonsense', 'finance', {})).toBe(false);
  });

  it('a malformed stored value is not truthy-coerced into a grant', () => {
    // loadMatrix() stores `value === 'true'`, so anything else is already
    // false by the time it arrives — this pins that the comparison is strict.
    expect(can('trainer', 'finance', { perm_trainer_finance: 'true' })).toBe(false);
    expect(can('trainer', 'finance', { perm_trainer_finance: 1 })).toBe(false);
    expect(can('trainer', 'finance', { perm_trainer_finance: true })).toBe(true);
  });
});

// The frontend lives in a sibling checkout, and CI checks out only this repo.
//
// ── Why the reads are inside each test and not up here ──────────────────────
//
// They were in the describe callback body, guarded by `describe.skip`. That
// does not work: skip suppresses the TESTS, not the callback, which Jest still
// executes while collecting the file. So on CI — backend-only — readFileSync
// threw during collection and the whole suite failed to run, with 2658 other
// tests passing around it.
//
// Reading lazily inside each `it` means the guard actually guards. The earlier
// version of this comment also claimed CI has both checkouts, which is what led
// me to write it that way; it does not.
const readFrontend = (...p) => fs.readFileSync(path.join(FRONTEND, ...p), 'utf8');
const describeCrossRepo = frontendAvailable ? describe : describe.skip;

describeCrossRepo('backend and frontend agree', () => {
  it('the shipped defaults are identical', () => {
    const ctx = readFrontend('lib', 'permissions-context.tsx');
    const block = ctx.slice(ctx.indexOf('const DEFAULTS'), ctx.indexOf('};', ctx.indexOf('const DEFAULTS')));
    const frontDefaults = {};
    for (const [, k, v] of block.matchAll(/(perm_[a-z_]+):\s*(true|false)/g)) {
      frontDefaults[k] = v === 'true';
    }
    // Only compare keys the frontend actually ships — it omits two the backend
    // round-trips, and a missing key there is a separate question from a
    // differing value.
    for (const [k, v] of Object.entries(frontDefaults)) {
      expect({ [k]: PERM_DEFAULTS[k] }).toEqual({ [k]: v });
    }
    expect(Object.keys(frontDefaults).length).toBeGreaterThan(10);
  });

  it('every feature the sidebar gates on is one the server enforces', () => {
    // The direction that matters. A link hidden by a rule the server does not
    // apply is the original bug; the reverse (server stricter than the menu) is
    // merely confusing.
    const sidebar = readFrontend('components', 'sidebar', 'Sidebar.tsx');
    const used = [...sidebar.matchAll(/can\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const feature of new Set(used)) {
      expect(ENFORCEABLE).toContain(feature);
    }
  });
});

// Rate limits are shared across replicas, and degrade rather than fail.
//
// Audit finding H-4. Every limiter used express-rate-limit's default store —
// an in-process Map. Correct for exactly one api container, quietly wrong for
// two: each replica keeps its own counters, so "30 login attempts per 15
// minutes" becomes 30 x N for an attacker who gets round-robined. The control
// does not break loudly when the service scales out, it silently weakens.
//
// Redis was already a hard dependency (five BullMQ queues), so this is a second
// consumer of existing infrastructure, not new infrastructure.
//
// Two properties have to hold together, and they pull in opposite directions:
// the store must be SHARED when Redis is available, and the app must still work
// when it is not — redis.js is explicit that Redis is optional. So this file
// tests both the wiring and the degradation.

'use strict';

const fs = require('fs');
const path = require('path');

const mockRedisState = { configured: true };
jest.mock('../lib/redis', () => ({
  isConfigured: () => mockRedisState.configured,
  // The store takes the FAIL-FAST client, not the shared BullMQ one. The
  // shared client queues commands during an outage instead of rejecting them,
  // so `passOnStoreError` never fired and every limited route hung — see
  // __tests__/redis.failFast.test.js.
  getFailFastClient: () => ({
    // rate-limit-redis loads its Lua script on init and expects a SHA string
    // back; everything else in its protocol is numeric. Returning 1 for both
    // makes the store throw "unexpected reply from redis client" at construction.
    call: jest.fn(async (cmd) => (String(cmd).toUpperCase() === 'SCRIPT' ? 'a'.repeat(40) : 1)),
  }),
  getConnection: () => { throw new Error('the rate limiter must not use the shared BullMQ connection'); },
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => mockLog);

const { makeStore } = require('../lib/rateLimitStore');

beforeEach(() => {
  mockRedisState.configured = true;
  Object.values(mockLog).forEach((f) => f.mockClear());
});

describe('makeStore', () => {
  it('returns a Redis-backed store when Redis is configured', () => {
    const store = makeStore('login');

    expect(store).toBeDefined();
    // rate-limit-redis stores expose the express-rate-limit Store interface.
    expect(typeof store.increment).toBe('function');
  });

  it('falls back to the in-memory store when Redis is not configured', () => {
    // undefined is meaningful here: express-rate-limit reads it as "no store
    // given" and uses its own default, which is exactly the previous
    // behaviour. Local dev and single-container deploys are unaffected.
    mockRedisState.configured = false;

    expect(makeStore('login')).toBeUndefined();
  });

  it('says so, once, when limits are only per-process', () => {
    // The "warned already" flag is module-level and deliberately survives for
    // the life of the process — eleven identical warnings at boot would be
    // noise. So this needs a fresh copy of the module to observe the first one.
    mockRedisState.configured = false;

    jest.isolateModules(() => {
      const fresh = require('../lib/rateLimitStore');
      fresh.makeStore('a');
      fresh.makeStore('b');
      fresh.makeStore('c');
    });

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn.mock.calls[0][0]).toMatch(/per-process/i);
  });

  it('refuses a missing prefix rather than letting limiters share a counter', () => {
    // Two limiters on one prefix share one budget: a burst of searches would
    // consume the login allowance. Failing loudly at boot beats debugging that.
    expect(() => makeStore()).toThrow(/unique string prefix/i);
    expect(() => makeStore('')).toThrow(/unique string prefix/i);
  });

  it('namespaces keys per limiter', () => {
    const a = makeStore('login');
    const b = makeStore('search');

    expect(a.prefix).toBe('rl:login:');
    expect(b.prefix).toBe('rl:search:');
    expect(a.prefix).not.toBe(b.prefix);
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────
//
// Source-level, because the risk is a limiter being ADDED later without a
// store — which no unit test of the existing ones would notice.

// ── Discovered, not listed ─────────────────────────────────────────────────
//
// This was a hand-maintained array of seven paths, and the blind spot is the
// same one the tenant-table scanner had: a limiter in a file nobody added to
// the list is not merely unchecked, it is invisible — the suite stays green
// and the count assertion below is the only thing that notices, by going DOWN.
// That is exactly what happened when the credential limiters moved into
// middleware/authRateLimit.js: three new limiters appeared, the total fell,
// and the failure pointed at the vacuity guard rather than at the new file.
//
// So the list is derived by walking src/ for files that actually construct a
// limiter. A new one is covered the moment it is written, wherever it lives.
const ROOT = path.join(__dirname, '..', '..');

/**
 * Source with comments removed.
 *
 * Every scan below has to read CODE. middleware/authRateLimit.js opens by
 * quoting the limiter it replaces — `store: makeStore('login')` and all — to
 * explain the lockout, and a raw scan counted that quotation as a live limiter
 * missing its passOnStoreError. The failure was in the comment, not the code.
 *
 * It cuts the other way too, which is the dangerous direction: a file whose
 * only mention of `makeStore` is inside a comment would satisfy a raw scan
 * while wiring nothing at all.
 */
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const FILES = (() => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(rel);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      if (/rateLimit\(\{/.test(read(rel))) found.push(rel);
    }
  };
  walk('src');
  return found.sort();
})();

describe('every limiter in the codebase uses the shared store', () => {
  it('finds the limiters, so this cannot pass vacuously', () => {
    const total = FILES.reduce((n, f) => n + (read(f).match(/rateLimit\(\{/g) || []).length, 0);
    // Twelve today: nine route/server limiters plus the three credential ones
    // in middleware/authRateLimit.js. A floor, not an equality — adding a
    // limiter should not fail this, removing every one of them should.
    expect(FILES.length).toBeGreaterThanOrEqual(7);
    expect(total).toBeGreaterThanOrEqual(12);
  });

  it.each(FILES)('%s wires store + passOnStoreError on each limiter', (file) => {
    const src = read(file);
    const limiters = (src.match(/rateLimit\(\{/g) || []).length;
    const stores = (src.match(/store: makeStore\('/g) || []).length;
    const passOn = (src.match(/passOnStoreError: true/g) || []).length;

    // A new limiter added without a store silently reintroduces the finding
    // for that endpoint only — the hardest kind to notice.
    expect(stores).toBe(limiters);
    expect(passOn).toBe(limiters);
  });

  it('gives every limiter a DISTINCT prefix', () => {
    // Hyphens included: the credential limiters are `login-id`, `login-ip` and
    // `refresh-device`, and a letters-only pattern silently matched none of
    // them — a prefix-collision test that cannot see a prefix proves nothing
    // about it. The three are also the ones where a collision did real damage:
    // login and refresh sharing the `login` prefix shared a counter, which is
    // how automatic token renewals locked a studio out of signing in.
    const prefixes = FILES.flatMap((f) => [...read(f).matchAll(/makeStore\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));

    expect(prefixes.length).toBeGreaterThanOrEqual(12);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('pairs the store with passOnStoreError so a Redis blip degrades, not 500s', () => {
    // Without passOnStoreError, a store error propagates and express-rate-limit
    // answers 500 — turning a Redis hiccup into a full API outage, which is
    // strictly worse than the per-process counters this replaces.
    for (const f of FILES) {
      const src = read(f);
      for (const m of src.matchAll(/rateLimit\(\{([\s\S]{0,200}?)\}\)/g)) {
        if (/store: makeStore/.test(m[1])) {
          expect(m[1]).toMatch(/passOnStoreError: true/);
        }
      }
    }
  });
});

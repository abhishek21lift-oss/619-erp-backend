'use strict';

/**
 * Which tier each intent starts on.
 *
 * Two ways this table has already gone wrong, both silent:
 *
 *   1. An intent that is MISSING falls through to `primary`. That is the right
 *      default and the wrong way to discover that a feature was never routed.
 *      `ops` and `fitness_testing` were being passed by live routes and were
 *      not in the table at all.
 *
 *   2. An intent parked on the `fallback` tier starts on `openrouter/auto` —
 *      a different model per request. `summary` sat there, so the Client
 *      Assistant's widest answers ("summarise this client", "brief me") were
 *      the only ones in that panel served by an unpredictable model, while
 *      every narrow lookup beside them got a fixed one.
 *
 * The routing table is data, so these are cheap to pin.
 */

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const fs = require('fs');
const path = require('path');

const { resolveModel, INTENT_ROUTES } = require('../lib/ai/models');
const settings = require('../lib/ai/settings');

afterAll(() => settings.stop());

describe('intent tier routing', () => {
  it('answers a client summary with the same fixed model as every other panel answer', () => {
    // The regression: this was 'fallback' → openrouter/auto.
    expect(resolveModel('summary')).toMatchObject({ tier: 'primary' });
    expect(resolveModel('analysis')).toMatchObject({ tier: 'primary' });
    expect(resolveModel('lookup')).toMatchObject({ tier: 'primary' });
  });

  it('never sends a money question to openrouter/auto', () => {
    for (const intent of ['finance', 'payment', 'invoice', 'dues', 'subscription']) {
      expect(INTENT_ROUTES[intent]).toBeDefined();
      expect(INTENT_ROUTES[intent]).not.toBe('fallback');
    }
  });

  it('keeps no developer intents — a PT studio app has no coding surface', () => {
    for (const intent of ['code', 'debug', 'sql', 'audit', 'technical', 'architecture', 'refactor', 'database']) {
      expect(INTENT_ROUTES[intent]).toBeUndefined();
    }
  });

  // The structural guard. A literal `intent: 'x'` at a call site IS a routing
  // request, so an x the table does not know about is a feature quietly
  // running on the default tier.
  it('routes every intent a call site names', () => {
    const root = path.join(__dirname, '..');
    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    })(root);

    const named = new Set();
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bintent:\s*'([a-z_]+)'/g)) named.add(m[1]);
    }

    expect(named.size).toBeGreaterThan(0);
    for (const intent of named) {
      expect(INTENT_ROUTES).toHaveProperty(intent);
    }
  });
});

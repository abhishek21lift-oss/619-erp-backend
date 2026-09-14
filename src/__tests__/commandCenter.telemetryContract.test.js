'use strict';
// The payload a card promises, and whether the collector still sends it.
//
// ── The failure this catches ───────────────────────────────────────────────
//
// `data` is `unknown` on the wire, and the console reads it with a runtime
// path walker: pick(d, 'memory.heap_used_ratio'). A path that no longer exists
// returns undefined, renders as an em-dash, and is indistinguishable from a
// metric that is legitimately absent.
//
// So renaming a field during a refactor did not break a build, fail a test, or
// raise anything. It blanked a number on an operations console — the one place
// where a blank must mean "we could not measure this" and nothing else.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const { CONTRACT, violations, auditSnapshot } = require('../modules/command-center/telemetry-contract');

describe('violations() holds a graded card to its shape', () => {
  it('passes a card that carries every promised key', () => {
    expect(violations({
      name: 'queues', status: 'healthy',
      data: { summary: {}, queues: [], totals: { waiting: 0, active: 0, failed: 0 }, problems: [] },
    })).toEqual([]);
  });

  it('names the key that went missing', () => {
    const missing = violations({
      name: 'queues', status: 'healthy',
      data: { summary: {}, queues: [], problems: [] },
    });
    expect(missing).toEqual(['queues.totals']);
  });

  it('catches a rename INSIDE a nested object', () => {
    // The renamed-field case exactly: `waiting` becomes `waiting_count` and
    // every "Waiting" number on the console silently becomes a dash.
    const missing = violations({
      name: 'queues', status: 'healthy',
      data: { summary: {}, queues: [], problems: [], totals: { waiting_count: 0, active: 0, failed: 0 } },
    });
    expect(missing).toEqual(['queues.totals.waiting']);
  });

  it('lets a collector ADD fields freely', () => {
    // `required` is a floor, not a whitelist — otherwise this file becomes a
    // second place to edit on every change, and then it stops being edited.
    expect(violations({
      name: 'queues', status: 'healthy',
      data: {
        summary: {}, queues: [], problems: [], totals: { waiting: 0, active: 0, failed: 0 },
        something_new: true,
      },
    })).toEqual([]);
  });

  it('does NOT hold an unavailable or degraded card to a shape', () => {
    // The whole point of those states is that the measurement did not happen.
    for (const status of ['unavailable', 'degraded', 'timeout']) {
      expect(violations({ name: 'queues', status, data: null })).toEqual([]);
    }
  });

  it('DOES object to a graded card with no payload at all', () => {
    const missing = violations({ name: 'database', status: 'critical', data: null });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/carries no data/);
  });

  it('ignores a nested parent that is legitimately null', () => {
    // http nulls latency_ms when the ring is empty; that is a real reading of
    // "no requests yet", not a broken payload.
    expect(violations({
      name: 'http', status: 'healthy',
      data: { window_ms: 1, samples: 0, latency_ms: null, status: null, slowest_endpoints: [] },
    })).toEqual([]);
  });

  it('says nothing about a card it has no contract for', () => {
    expect(violations({ name: 'something_new', status: 'healthy', data: {} })).toEqual([]);
  });
});

describe('the real collectors still honour the contract', () => {
  // runtime and http need no doubles: they read this process. Running them for
  // real is the strongest version of this check available without a database.
  it.each(['runtime', 'http'])('%s', async (name) => {
    const collector = require(`../modules/command-center/collectors/${name}.collector`);
    const raw = await collector.collect({ signal: new AbortController().signal });
    const card = raw && typeof raw === 'object' && 'status' in raw
      ? { ...raw, name: collector.NAME }
      : { name: collector.NAME, status: 'healthy', data: raw };
    expect(violations(card)).toEqual([]);
  });
});

describe('the contract covers what the registry registers', () => {
  it('has an entry for every collector the build registers', () => {
    const registry = require('../modules/command-center/registry');
    const index = require('../modules/command-center/index');
    registry.clear();
    index.reset();
    index.registerCollectors();
    for (const name of registry.names()) {
      expect(Object.keys(CONTRACT)).toContain(name);
    }
    registry.clear();
  });

  it('declares each card scope consistently with the registry', () => {
    const registry = require('../modules/command-center/registry');
    const index = require('../modules/command-center/index');
    registry.clear();
    index.reset();
    index.registerCollectors();
    for (const name of registry.names()) {
      expect(CONTRACT[name].scope).toBe(registry.get(name).scope);
    }
    registry.clear();
  });
});

describe('auditSnapshot reports across a whole snapshot', () => {
  it('collects violations from every card', () => {
    const problems = auditSnapshot({
      cards: {
        queues: { name: 'queues', status: 'healthy', data: { summary: {}, queues: [], problems: [] } },
        database: { name: 'database', status: 'healthy', data: {} },
      },
    });
    expect(problems.length).toBeGreaterThan(1);
    expect(problems.some((p) => p.startsWith('queues.'))).toBe(true);
    expect(problems.some((p) => p.startsWith('database.'))).toBe(true);
  });

  it('is empty for a snapshot with no cards', () => {
    expect(auditSnapshot({ cards: {} })).toEqual([]);
    expect(auditSnapshot(null)).toEqual([]);
  });
});

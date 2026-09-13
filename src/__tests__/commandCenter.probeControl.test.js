'use strict';
// Probe control: coalescing, cancellation, bounded concurrency.
//
// ── What was wrong ─────────────────────────────────────────────────────────
//
// runCollector raced the collector against a timeout and returned whichever
// won. The loser was not cancelled — it was ABANDONED. Nothing stopped it,
// nothing awaited it, and nothing stopped the next tick starting another one
// on top of it. On a 1s WebSocket tick against a database that had gone slow,
// that is one new probe per second, forever, from the tool whose job is to
// keep the database alive.
//
// Beside it, snapshot.collect fanned out with Promise.all, so a fresh sweep
// opened every probe in the same instant, and N operators pressing Refresh
// opened N sweeps.
//
// Both are now bounded by the same small mechanism, and these tests are what
// stop either coming back.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

const registry = require('../modules/command-center/registry');
const snapshot = require('../modules/command-center/snapshot.service');

const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  registry.clear();
  snapshot.invalidate();
});

describe('concurrent callers share one probe', () => {
  it('runs the collector ONCE for callers that arrive together', async () => {
    let starts = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    registry.register('slow', async () => { starts += 1; await gate; return { ok: true }; }, { timeoutMs: 5000 });

    const a = registry.runCollector(registry.get('slow'));
    const b = registry.runCollector(registry.get('slow'));
    const c = registry.runCollector(registry.get('slow'));
    await tick();

    expect(starts).toBe(1);
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    // Same settled object, not merely equal — proof they awaited one promise.
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
    expect(ra.status).toBe('healthy');
  });

  it('a later caller, after the probe settled, gets a NEW probe', async () => {
    // Coalescing must not turn into caching. The TTL cache is a separate
    // decision made in snapshot.service; the registry always re-probes.
    let starts = 0;
    registry.register('quick', async () => { starts += 1; return { ok: true }; });
    await registry.runCollector(registry.get('quick'));
    await registry.runCollector(registry.get('quick'));
    expect(starts).toBe(2);
  });

  it('an eight-operator Refresh storm costs one probe per card', async () => {
    let starts = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    registry.register('db', async () => { starts += 1; await gate; return { rows: 1 }; }, { timeoutMs: 5000 });

    const storm = Array.from({ length: 8 }, () => snapshot.collect({ fresh: true }));
    await tick();
    expect(starts).toBe(1);
    release();
    await Promise.all(storm);
  });
});

describe('an abandoned probe is never multiplied', () => {
  it('leaves exactly one probe outstanding however many ticks pass', async () => {
    let starts = 0;
    // Never resolves: the database has gone away and the query is hanging.
    registry.register('hung', async () => { starts += 1; return new Promise(() => {}); }, { timeoutMs: 5 });

    const first = await registry.runCollector(registry.get('hung'));
    expect(first.status).toBe('timeout');
    expect(starts).toBe(1);
    // The probe is STILL running — it never resolved — so the next tick must
    // join it rather than open a second hanging query.
    expect(registry.inflightCount()).toBe(1);

    for (let i = 0; i < 5; i += 1) {
      const r = await registry.runCollector(registry.get('hung'));
      expect(r.status).toBe('timeout');
    }
    expect(starts).toBe(1);
  });

  it('does not leave an unhandled rejection behind when it finally fails', async () => {
    const unhandled = [];
    const onUnhandled = (r) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      let boom;
      registry.register('late', async () => {
        await new Promise((r) => { boom = r; });
        throw new Error('the connection died, 200ms after we gave up');
      }, { timeoutMs: 5 });

      const out = await registry.runCollector(registry.get('late'));
      expect(out.status).toBe('timeout');
      boom();                       // the abandoned branch now rejects
      await tick(); await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('clears the slot once the probe settles, so the card can recover', async () => {
    let release;
    registry.register('recovers', async () => {
      await new Promise((r) => { release = r; });
      return { ok: true };
    }, { timeoutMs: 5 });

    await registry.runCollector(registry.get('recovers'));
    expect(registry.inflightCount()).toBe(1);
    release();
    await tick(); await tick();
    expect(registry.inflightCount()).toBe(0);
  });
});

describe('cancellation is offered, not merely claimed', () => {
  it('hands the collector an AbortSignal', async () => {
    let seen = null;
    registry.register('sig', async (arg) => { seen = arg; return { ok: true }; });
    await registry.runCollector(registry.get('sig'));
    expect(seen && seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal.aborted).toBe(false);
  });

  it('aborts that signal when the deadline passes', async () => {
    let captured;
    registry.register('abortable', async ({ signal }) => {
      captured = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }, { timeoutMs: 10 });

    const out = await registry.runCollector(registry.get('abortable'));
    expect(out.status).toBe('timeout');
    expect(captured.aborted).toBe(true);
  });
});

describe('a sweep is bounded, not a thundering herd', () => {
  it('never opens more probes at once than the limit', async () => {
    const LIMIT = snapshot.MAX_CONCURRENT_PROBES;
    const TOTAL = LIMIT + 5;
    let open = 0;
    let peak = 0;
    for (let i = 0; i < TOTAL; i += 1) {
      registry.register(`c${i}`, async () => {
        open += 1;
        peak = Math.max(peak, open);
        // Long enough that every probe overlaps the others if nothing bounds
        // them — with Promise.all this reaches TOTAL immediately.
        await new Promise((r) => setTimeout(r, 15));
        open -= 1;
        return { i };
      }, { timeoutMs: 5000 });
    }

    const snap = await snapshot.collect({ fresh: true });

    expect(peak).toBeLessThanOrEqual(LIMIT);
    // Cannot pass because nothing ran, and cannot pass by running them one at
    // a time either — the bound has to be a bound, not a queue of one.
    expect(peak).toBe(LIMIT);
    expect(Object.keys(snap.cards)).toHaveLength(TOTAL);
  });

  it('still returns every requested card, in order', async () => {
    for (let i = 0; i < 9; i += 1) {
      registry.register(`k${i}`, async () => ({ i }));
    }
    const snap = await snapshot.collect();
    expect(Object.keys(snap.cards).sort()).toEqual(
      Array.from({ length: 9 }, (_, i) => `k${i}`).sort(),
    );
  });
});

describe('a cached card says how stale it is', () => {
  it('carries age_ms beside the cached flag', async () => {
    registry.register('ttl', async () => ({ v: 1 }), { ttlMs: 10_000 });
    await snapshot.collect();
    await new Promise((r) => setTimeout(r, 15));
    const second = await snapshot.collect();
    expect(second.cards.ttl.cached).toBe(true);
    expect(second.cards.ttl.age_ms).toBeGreaterThanOrEqual(10);
  });
});

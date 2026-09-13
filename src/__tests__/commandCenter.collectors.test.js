// Command Center — Phase 1 collectors.
//
// Two things are being pinned here, and neither is "does it return numbers".
//
// 1. UNAVAILABLE IS NOT CRITICAL. Redis being unconfigured is a supported
//    state: docker-compose.yml's header explains that without REDIS_URL the
//    queues degrade to inline sends by design. A console that paints that red
//    trains its operators to ignore red.
//
// 2. THE THRESHOLDS MEAN SOMETHING. Each collector grades its own numbers, and
//    a grading bug is invisible in production until the night it fails to warn.
//    Redis at 256mb with maxmemory-policy noeviction does not degrade
//    gracefully — it starts refusing writes — so the memory grade in particular
//    has to fire early.
'use strict';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { STATUS } = require('../modules/command-center/registry');

// ── Redis ────────────────────────────────────────────────────────────────────
describe('redis collector', () => {
  const load = () => require('../modules/command-center/collectors/redis.collector');

  beforeEach(() => { jest.resetModules(); });

  test('unconfigured Redis is UNAVAILABLE, not CRITICAL', async () => {
    jest.doMock('../lib/redis', () => ({ isConfigured: () => false }));
    const card = await load().collect();

    expect(card.status).toBe(STATUS.UNAVAILABLE);
    expect(card.reason).toMatch(/not set/i);
  });

  test('a healthy ping with room to spare is healthy', async () => {
    jest.doMock('../lib/redis', () => ({
      isConfigured: () => true, isReady: () => true, ping: async () => 'PONG',
      getClient: () => ({ info: async () => 'used_memory:1000\r\nmaxmemory:100000\r\nconnected_clients:3\r\n' }),
    }));
    const card = await load().collect();

    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.clients.connected).toBe(3);
    expect(card.data.memory.used_ratio).toBeCloseTo(0.01);
  });

  test('memory near maxmemory is CRITICAL and says why noeviction matters', async () => {
    jest.doMock('../lib/redis', () => ({
      isConfigured: () => true, isReady: () => true, ping: async () => 'PONG',
      getClient: () => ({ info: async () => 'used_memory:95000\r\nmaxmemory:100000\r\nmaxmemory_policy:noeviction\r\n' }),
    }));
    const card = await load().collect();

    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/enqueues will start failing/i);
  });

  test('maxmemory 0 means unlimited — no ratio, no false alarm', async () => {
    // Dividing by 0 here would produce Infinity and a permanently red card.
    jest.doMock('../lib/redis', () => ({
      isConfigured: () => true, isReady: () => true, ping: async () => 'PONG',
      getClient: () => ({ info: async () => 'used_memory:99999999\r\nmaxmemory:0\r\n' }),
    }));
    const card = await load().collect();

    expect(card.data.memory.used_ratio).toBeNull();
    expect(card.status).toBe(STATUS.HEALTHY);
  });

  test('a restricted INFO still leaves a useful card', async () => {
    // Managed Redis often refuses INFO. Latency alone is worth rendering.
    jest.doMock('../lib/redis', () => ({
      isConfigured: () => true, isReady: () => true, ping: async () => 'PONG',
      getClient: () => ({ info: async () => { throw new Error('NOPERM'); } }),
    }));
    const card = await load().collect();

    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.connected).toBe(true);
    expect(card.data.memory.used_bytes).toBeNull();
  });

  test('a failed ping propagates so the harness grades it critical', async () => {
    jest.doMock('../lib/redis', () => ({
      isConfigured: () => true, ping: async () => { throw new Error('ECONNREFUSED'); },
    }));
    await expect(load().collect()).rejects.toThrow(/ECONNREFUSED/);
  });

  test('parseInfo ignores comments and blank lines', () => {
    const { parseInfo } = load();
    expect(parseInfo('# Memory\r\nused_memory:12\r\n\r\nbad-line\r\n')).toEqual({ used_memory: '12' });
  });
});

// ── Queues ───────────────────────────────────────────────────────────────────
describe('queue collector', () => {
  const load = () => require('../modules/command-center/collectors/queue.collector');

  beforeEach(() => { jest.resetModules(); });

  function withQueues(stats) {
    jest.doMock('../lib/redis', () => ({ isConfigured: () => true, isReady: () => true }));
    jest.doMock('../lib/queueHealth', () => ({
      collectQueueStats: async () => stats,
      summarize: () => ({ status: 'ok' }),
    }));
  }

  test('no Redis means UNAVAILABLE, and EXPECTED — a deployment choice', async () => {
    jest.doMock('../lib/redis', () => ({ isConfigured: () => false, isReady: () => false }));
    const card = await load().collect();

    expect(card.status).toBe(STATUS.UNAVAILABLE);
    // `expected` is what keeps a box that deliberately runs without Redis from
    // reading amber forever. See registry.rollup().
    expect(card.expected).toBe(true);
    expect(card.reason).toMatch(/inline/i);
  });

  test('no Redis still says what it COSTS, per queue', async () => {
    // The folklore is "Redis is optional, producers fall back to inline". That
    // is wrong in the way that matters: renewals do not fall back at all.
    jest.doMock('../lib/redis', () => ({ isConfigured: () => false, isReady: () => false }));
    const card = await load().collect();

    const modes = Object.fromEntries(
      card.data.degradation.queues.map((q) => [q.queue, q.mode]),
    );
    expect(modes.email).toBe('inline');
    expect(modes.whatsapp).toBe('deferred');
    expect(modes['membership-renewals']).toBe('stopped');
    expect(card.reason).toMatch(/membership-renewals/);
  });

  test('Redis configured but UNREACHABLE is DEGRADED, not unavailable', async () => {
    // The real incident, and the case that used to fall through to a probe
    // that would hang. Work is still happening for three of five queues, so
    // this is not an outage — and we know exactly what is going on, which is
    // the opposite of unobservable.
    jest.doMock('../lib/redis', () => ({ isConfigured: () => true, isReady: () => false }));
    const card = await load().collect();

    expect(card.status).toBe(STATUS.DEGRADED);
    expect(card.reason).toMatch(/HAVE STOPPED/);
    expect(card.reason).toMatch(/flush on recovery/);
    expect(card.data.degradation.active).toBe(true);
  });

  test('drained queues are healthy', async () => {
    withQueues({ email: { waiting: 0, active: 0, failed: 0, completed: 100, delayed: 0, paused: false } });
    const card = await load().collect();

    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.totals.waiting).toBe(0);
  });

  test('work waiting with nothing active is flagged as starvation', async () => {
    // The brief's "queue is growing" scenario, and the Guardian's key input.
    withQueues({ email: { waiting: 10, active: 0, failed: 0, completed: 0, delayed: 0, paused: false } });
    const card = await load().collect();

    expect(card.data.queues[0].starved).toBe(true);
    expect(card.reason).toMatch(/no worker draining/i);
  });

  test('a paused queue is not mistaken for starvation', async () => {
    // Pause is rung 1 of the recovery ladder. Waiting jobs are expected there.
    withQueues({ email: { waiting: 10, active: 0, failed: 0, completed: 0, delayed: 0, paused: true } });
    const card = await load().collect();

    expect(card.data.queues[0].starved).toBe(false);
    expect(card.reason).toMatch(/paused/i);
  });

  test('one failed renewal is critical, one failed email is only a warning', async () => {
    // A failed renewal is a card charged with no membership row written.
    withQueues({ 'membership-renewals': { waiting: 0, active: 0, failed: 1, completed: 5, delayed: 0, paused: false } });
    expect((await load().collect()).status).toBe(STATUS.CRITICAL);

    jest.resetModules();
    withQueues({ email: { waiting: 0, active: 0, failed: 1, completed: 5, delayed: 0, paused: false } });
    expect((await load().collect()).status).toBe(STATUS.WARNING);
  });

  test('an unreachable queue is critical and named', async () => {
    withQueues({ ai: null });
    const card = await load().collect();

    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/"ai" unreachable/);
    expect(card.data.queues[0].reachable).toBe(false);
  });
});

// ── Runtime ──────────────────────────────────────────────────────────────────
describe('runtime collector', () => {
  test('reports live process figures', async () => {
    const runtime = require('../modules/command-center/collectors/runtime.collector');
    const card = await runtime.collect();

    expect([STATUS.HEALTHY, STATUS.WARNING, STATUS.CRITICAL]).toContain(card.status);
    expect(card.data.memory.rss_bytes).toBeGreaterThan(0);
    expect(card.data.memory.heap_used_ratio).toBeGreaterThan(0);
    expect(card.data.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(card.data.event_loop_lag_ms).toHaveProperty('p99');
    expect(card.data.node_version).toBe(process.version);
  });

  test('the second sample can compute a CPU share', async () => {
    // cpuUsage is cumulative; a percentage needs two reads and a window.
    const runtime = require('../modules/command-center/collectors/runtime.collector');
    await runtime.collect();
    await new Promise((r) => setTimeout(r, 20));
    const card = await runtime.collect();

    expect(card.data.cpu_percent).not.toBeNull();
    expect(card.data.cpu_percent).toBeGreaterThanOrEqual(0);
  });
});

'use strict';
// Two things an operator needs that the console did not give them.
//
// ── 1. An action you can reconstruct afterwards ────────────────────────────
//
// The audit row for a command recorded the name, the queue, the outcome and
// the duration. What it did not record is what you actually want at 3am: the
// request id that joins this row to the log lines the command produced and to
// the nginx access line; what the platform looked like immediately before and
// after; and, for a destructive command, whether the typed confirmation was
// actually given.
//
// ── 2. Which tiles are telling you about the whole platform ────────────────
//
// `runtime` measures the event-loop lag and heap of ONE Node process, and
// `http` measures ONE process's request ring. The other six describe the
// platform. They render as identical tiles, so a green runtime card behind two
// replicas reads as "the platform is fine" when it means "the container that
// served this request is fine". The scope is now on the card.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockLogActivity = jest.fn(async () => {});
const mockQueue = {
  pause: jest.fn(async () => {}), resume: jest.fn(async () => {}),
  getActiveCount: jest.fn(async () => 0), getWaitingCount: jest.fn(async () => 0),
  getFailedCount: jest.fn(async () => 0), getFailed: jest.fn(async () => []),
  clean: jest.fn(async () => []),
};
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: (...a) => mockLogActivity(...a) }));
jest.mock('../lib/redis', () => ({ isConfigured: () => true, isReady: () => false, ping: async () => 'PONG' }));
jest.mock('../jobs/queue', () => ({
  QUEUE_NAMES: ['email', 'whatsapp', 'ai', 'notifications', 'membership-renewals'],
  getQueue: () => mockQueue,
}));
jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({
    rows: [{ db: 'myptstudio', version: 'PostgreSQL 16.2 on x86' }], rowCount: 1,
  })),
  totalCount: 3, idleCount: 2, waitingCount: 0,
}));

const mockCards = {
  runtime: { name: 'runtime', status: 'healthy' },
  queues: { name: 'queues', status: 'warning' },
};
jest.mock('../modules/command-center/snapshot.service', () => ({
  collect: jest.fn(async () => ({
    status: 'warning', collected_at: '2026-09-13T10:00:00.000Z', cards: mockCards,
  })),
  invalidate: jest.fn(),
}));
jest.mock('../modules/command-center/collectors/queue.collector', () => ({
  ...jest.requireActual('../modules/command-center/collectors/queue.collector'),
  collect: jest.fn(async () => ({
    name: 'queues', status: 'healthy',
    data: { queues: [{ name: 'email', reachable: true, waiting: 0, active: 1, failed: 0 }] },
  })),
}));

const commands = require('../modules/command-center/commands.service');

const req = {
  id: 'req-abc-123',
  user: { id: 'u1', name: 'Ops Person', email: 'ops@myptstudio.com' },
  ip: '10.0.0.1',
  headers: {},
};

const auditFor = (name) => mockLogActivity.mock.calls.find((c) => c[1] === `command_center.${name}`);

beforeEach(async () => {
  mockLogActivity.mockClear();
  await commands._resetCooldowns();
});

describe('every command is auditable end to end', () => {
  it('records the request id that joins the row to the logs', async () => {
    await commands.run('database.test', { req });
    const [, , , , data] = auditFor('database.test');
    expect(data.request_id).toBe('req-abc-123');
  });

  it('hands the request id back to the caller too', async () => {
    // So the console can show it, and an operator can quote it.
    const out = await commands.run('database.test', { req });
    expect(out.request_id).toBe('req-abc-123');
  });

  it('records the actor by id, name and email', async () => {
    await commands.run('database.test', { req });
    const [, , , , data] = auditFor('database.test');
    expect(data.actor).toEqual({ id: 'u1', name: 'Ops Person', email: 'ops@myptstudio.com' });
  });

  it('records pre AND post health for a destructive command', async () => {
    await commands.run('queue.clearFailed', { req, queue: 'email', confirm: 'queue.clearFailed' });
    const [, , , , data] = auditFor('queue.clearFailed');
    expect(data.health_before.status).toBe('warning');
    expect(data.health_before.cards).toEqual({ runtime: 'healthy', queues: 'warning' });
    expect(data.health_after.status).toBe('warning');
  });

  it('reads the AFTER health fresh, never from the cache', async () => {
    const snapshot = require('../modules/command-center/snapshot.service');
    snapshot.collect.mockClear();
    await commands.run('queue.clearFailed', { req, queue: 'email', confirm: 'queue.clearFailed' });
    // A cached post-command reading could predate the command entirely and
    // would be evidence of nothing.
    const freshCalls = snapshot.collect.mock.calls.filter(([o]) => o && o.fresh === true);
    expect(freshCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT probe health for a read-only command', async () => {
    // For `database.test` the reading IS the output; a second one is noise on
    // a database the console exists to protect.
    await commands.run('database.test', { req });
    const [, , , , data] = auditFor('database.test');
    expect(data.health_before).toBeNull();
    expect(data.health_after).toBeNull();
  });

  it('records that the typed confirmation was given', async () => {
    await commands.run('queue.clearFailed', { req, queue: 'email', confirm: 'queue.clearFailed' });
    const [, , , , data] = auditFor('queue.clearFailed');
    expect(data.confirmed).toBe(true);
    expect(data.destructive).toBe(true);
  });

  it('records the failure reason, in words, when a command fails', async () => {
    mockQueue.clean.mockRejectedValueOnce(new Error('WRONGTYPE Operation against a key'));
    await expect(
      commands.run('queue.clearFailed', { req, queue: 'email', confirm: 'queue.clearFailed' }),
    ).rejects.toThrow(/WRONGTYPE/);
    const [, , , , data] = auditFor('queue.clearFailed');
    expect(data.outcome).toBe('error');
    expect(data.error).toMatch(/WRONGTYPE/);
    // The post-command reading is taken even on failure — that is the more
    // interesting one.
    expect(data.health_after).not.toBeNull();
  });

  it('records the verdict the operator was shown, not a second opinion', async () => {
    await commands.run('recovery.run', { req, queue: 'email', confirm: 'recovery.run' });
    const [, , , , data] = auditFor('recovery.run');
    expect(data.verdict.outcome).toBe('was_not_broken');
    expect(data.verdict.summary).toMatch(/already healthy/i);
  });

  it('never lets an audit failure mask the command result', async () => {
    mockLogActivity.mockRejectedValueOnce(new Error('activity_log is full'));
    await expect(commands.run('database.test', { req })).resolves.toMatchObject({ outcome: 'ok' });
  });
});

describe('a card says whose state it describes', () => {
  const registry = require('../modules/command-center/registry');
  const snapshot = jest.requireActual('../modules/command-center/snapshot.service');

  beforeEach(() => { registry.clear(); snapshot.invalidate(); });
  afterAll(() => { registry.clear(); });

  it('stamps the scope onto every card', async () => {
    registry.register('runtime', async () => ({ heap: 1 }), { scope: registry.SCOPE.PROCESS });
    registry.register('database', async () => ({ conns: 1 }));
    const snap = await snapshot.collect();
    expect(snap.cards.runtime.scope).toBe('process');
    // Platform is the default: a collector that does not say is describing the
    // platform, which is the safe way round — a process-local card mislabelled
    // as platform-wide is the claim that overstates.
    expect(snap.cards.database.scope).toBe('platform');
  });

  it('keeps the scope on a card served from the TTL cache', async () => {
    registry.register('http', async () => ({ p95: 12 }), { scope: registry.SCOPE.PROCESS, ttlMs: 10_000 });
    await snapshot.collect();
    const second = await snapshot.collect();
    expect(second.cards.http.cached).toBe(true);
    expect(second.cards.http.scope).toBe('process');
  });

  it('refuses a scope it does not know', () => {
    expect(() => registry.register('bogus', async () => ({}), { scope: 'galaxy' }))
      .toThrow(/unknown scope/i);
  });

  it('the real build marks runtime and http process-local, and nothing else', () => {
    registry.clear();
    const index = require('../modules/command-center/index');
    index.reset();
    index.registerCollectors();
    const byScope = {};
    for (const n of registry.names()) {
      const sc = registry.get(n).scope;
      (byScope[sc] ||= []).push(n);
    }
    expect(byScope.process.sort()).toEqual(['http', 'runtime']);
    expect(byScope.platform.sort())
      .toEqual(['ai', 'database', 'queues', 'redis', 'security', 'smtp']);
  });
});

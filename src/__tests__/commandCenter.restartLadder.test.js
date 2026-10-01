// Command Center — rungs 4 and 5, switched ON.
//
// commandCenter.phase5 and recoveryTruth cover the rungs while they are off
// (503 with the reason) and the URL the client builds. Nothing exercised them
// with a proxy configured, which is the state production is moving to. These
// do, through commands.run(), the same entry point the console uses:
//
//   * a worker restart is "recovered" only when the worker PROVES it came back
//     (fresh connections on every queue, none of the old ones), never on the
//     204 alone;
//   * the API restart is refused until the worker restart has been tried — the
//     last rung is never the first press;
//   * the API restart records its request BEFORE asking Docker, because the
//     process doing it will not survive to record anything after;
//   * typed confirmation, cooldown and the audit row still hold;
//   * nothing a caller sends can choose the container.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.CC_WORKER_VERIFY_TIMEOUT_MS = '300';
process.env.CC_WORKER_VERIFY_POLL_MS = '20';
process.env.CC_API_VERIFY_SETTLE_MS = '1';

const mockQueueNames = ['email', 'whatsapp'];

// ── An in-memory activity_log answering exactly the queries the code runs ───
const mockAudit = [];
function mockRow(action, entityId, data, extra = {}) {
  return {
    action, entity_id: entityId, new_data: data ?? null, created_at: new Date(),
    user_id: 'u1', user_name: 'Operator', ip_address: '10.0.0.1', ...extra,
  };
}
const mockPoolQuery = jest.fn(async (sql, params = []) => {
  if (/INSERT INTO activity_log/.test(sql) && /VALUES \(\$1/.test(sql)) {
    const [userId, userName, action, entityId, json, ip] = params;
    mockAudit.push(mockRow(action, entityId, JSON.parse(json), { user_id: userId, user_name: userName, ip_address: ip }));
    return { rows: [] };
  }
  if (/INSERT INTO activity_log/.test(sql)) {
    const [userId, userName, action, entityId, json, ip] = params;
    if (!mockAudit.some((r) => r.action === action && r.entity_id === entityId)) {
      mockAudit.push(mockRow(action, entityId, JSON.parse(json), { user_id: userId, user_name: userName, ip_address: ip }));
    }
    return { rows: [] };
  }
  if (/FROM activity_log r/.test(sql)) {
    const [req, ver, windowMs] = params;
    return {
      rows: mockAudit
        .filter((r) => r.action === req && Date.now() - r.created_at < windowMs)
        .filter((r) => !mockAudit.some((v) => v.action === ver && v.entity_id === r.entity_id))
        .map((r) => ({ ...r, request_id: r.entity_id })),
    };
  }
  if (/WHERE entity_id = \$1 AND action IN/.test(sql)) {
    const [id, a, b] = params;
    return { rows: mockAudit.filter((r) => r.entity_id === id && (r.action === a || r.action === b)) };
  }
  if (/FROM activity_log\s+WHERE action = \$1 AND created_at > NOW\(\)/.test(sql)) {
    const [action, windowMs] = params;
    return { rows: mockAudit.filter((r) => r.action === action && Date.now() - r.created_at < windowMs) };
  }
  return { rows: [] };
});
const mockLogActivity = jest.fn(async (req, action, _type, entityId, data) => {
  mockAudit.push(mockRow(action, entityId, data));
});

// Worker connections as CLIENT LIST reports them, per queue.
let mockWorkers = {};
const mockGetQueue = jest.fn((name) => ({
  getWorkers: jest.fn(async () => mockWorkers[name] ?? []),
}));
const mockQueueCollect = jest.fn(async () => ({
  status: 'healthy',
  data: { queues: mockQueueNames.map((name) => ({ name, waiting: 0, active: 0, failed: 0 })) },
}));
const mockSnapshotCollect = jest.fn(async () => ({
  status: 'healthy', cards: { database: { status: 'healthy' }, redis: { status: 'healthy' } },
  collected_at: new Date().toISOString(),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/redis', () => ({ isConfigured: () => true, isReady: () => false }));
jest.mock('../jobs/queue', () => ({ QUEUE_NAMES: mockQueueNames, getQueue: mockGetQueue }));
jest.mock('../lib/activityLog', () => ({ logActivity: mockLogActivity }));
jest.mock('../lib/email', () => ({ verifyConnection: jest.fn(), isConfigured: () => true }));
jest.mock('../db/pool', () => ({ query: mockPoolQuery }));
jest.mock('../modules/command-center/snapshot.service', () => ({ invalidate: jest.fn(), collect: mockSnapshotCollect }));
jest.mock('../modules/command-center/collectors/queue.collector', () => ({
  collect: mockQueueCollect, CRITICAL_QUEUES: new Set(), FAILED_CRIT: 10, WAITING_WARN: 100,
}));

const commands = require('../modules/command-center/commands.service');
const verification = require('../modules/command-center/restart-verification');
const docker = require('../modules/command-center/container-recovery');

const req = (id = 'req-1') => ({
  id, user: { id: 'u1', name: 'Operator', email: 'op@x' }, ip: '10.0.0.1', headers: {},
});

let fetchCalls;
function proxyAnswers(status) {
  fetchCalls = [];
  global.fetch = jest.fn(async (url, opts) => {
    fetchCalls.push({ url, method: opts.method });
    // A real restart: the worker comes back with brand-new connections.
    if (status === 204 && /erp-worker/.test(url)) {
      mockWorkers = { email: [{ name: 'bull:email', age: '0' }], whatsapp: [{ name: 'bull:whatsapp', age: '0' }] };
    }
    return { status, text: async () => (status === 204 ? '' : 'no such container') };
  });
}

beforeEach(() => {
  mockAudit.length = 0;
  mockWorkers = {
    email: [{ name: 'bull:email', age: '9000' }],
    whatsapp: [{ name: 'bull:whatsapp', age: '9000' }],
  };
  process.env.DOCKER_PROXY_URL = 'http://docker-socket-proxy:2375';
  process.env.CC_WORKER_CONTAINER = 'erp-worker';
  process.env.CC_API_CONTAINER = 'erp-api';
  commands._resetCooldowns();
  jest.clearAllMocks();
});
afterAll(() => {
  delete process.env.DOCKER_PROXY_URL;
  delete process.env.CC_WORKER_CONTAINER;
  delete process.env.CC_API_CONTAINER;
});

describe('availability', () => {
  test('both rungs list as available once the proxy and both names are configured', () => {
    const byName = Object.fromEntries(commands.list().map((c) => [c.name, c]));
    expect(byName['worker.restart'].unavailable_reason).toBeNull();
    expect(byName['container.restart'].unavailable_reason).toBeNull();
    expect(byName['worker.restart'].destructive).toBe(true);
    expect(byName['container.restart'].destructive).toBe(true);
  });

  test('without the proxy both are unavailable with the reason, and a press is a 503', async () => {
    delete process.env.DOCKER_PROXY_URL;
    const err = await commands.run('worker.restart', { req: req(), confirm: 'worker.restart' }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/DOCKER_PROXY_URL/);
  });

  test.each([
    ['../erp-redis', 'not a valid container name'],
    ['erp-worker/../../erp-redis', 'not a valid container name'],
    ['erp worker', 'not a valid container name'],
    ['erp-worker?force=1', 'not a valid container name'],
    ['erp.worker', 'not a valid container name'],
  ])('a malformed CC_WORKER_CONTAINER (%s) is refused before the proxy', async (bad, reason) => {
    process.env.CC_WORKER_CONTAINER = bad;
    proxyAnswers(204);
    const err = await commands.run('worker.restart', { req: req(), confirm: 'worker.restart' }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(reason);
    expect(fetchCalls).toEqual([]);
  });

  test('worker and API naming the same container disables both', () => {
    process.env.CC_API_CONTAINER = 'erp-worker';
    expect(docker.unavailableReason('worker')).toMatch(/same container/);
    expect(docker.unavailableReason('api')).toMatch(/same container/);
  });

  test('an unknown target key is refused, not looked up', async () => {
    await expect(docker.restart('redis')).rejects.toThrow(/Unknown restart target/);
    expect(docker.unavailableReason('redis')).toMatch(/Unknown restart target/);
  });
});

describe('worker restart (rung 4)', () => {
  test('requires the typed confirmation, and a refusal reaches neither Docker nor the cooldown', async () => {
    proxyAnswers(204);
    const err = await commands.run('worker.restart', { req: req() }).catch((e) => e);
    expect(err.status).toBe(428);
    expect(fetchCalls).toEqual([]);
    // The real press still goes through: the refusal did not burn the cooldown.
    const ok = await commands.run('worker.restart', { req: req(), confirm: 'worker.restart' });
    expect(ok.outcome).toBe('ok');
  });

  test('restarts ONLY the configured worker, proves it, audits it', async () => {
    proxyAnswers(204);
    const out = await commands.run('worker.restart', { req: req(), confirm: 'worker.restart' });

    expect(fetchCalls).toEqual([{
      url: `http://docker-socket-proxy:2375/containers/erp-worker/restart?t=${docker.STOP_TIMEOUT_S}`,
      method: 'POST',
    }]);
    expect(out.output.outcome).toBe('recovered');
    expect(out.output.recovered).toBe(true);
    expect(out.output.verified.workers.ok).toBe(true);

    const audit = mockLogActivity.mock.calls.find((c) => c[1] === 'command_center.worker.restart');
    expect(audit).toBeTruthy();
    expect(audit[4]).toMatchObject({
      outcome: 'ok', destructive: true, confirmed: true,
      verdict: { outcome: 'recovered' },
    });
    expect(audit[4].health_before).toBeTruthy();
    expect(audit[4].health_after).toBeTruthy();
  });

  test('a 204 with the OLD worker still connected is NOT success', async () => {
    fetchCalls = [];
    // Docker says yes, but the same process keeps serving — e.g. the wrong
    // container name, or a restart that never happened.
    global.fetch = jest.fn(async (url, opts) => { fetchCalls.push({ url, method: opts.method }); return { status: 204, text: async () => '' }; });
    const err = await commands.run('worker.restart', { req: req(), confirm: 'worker.restart' }).catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/did not come back cleanly/);
    expect(err.output.outcome).toBe('not_recovered');
    expect(err.output.next_rung.command).toBe('container.restart');
    const audit = mockLogActivity.mock.calls.find((c) => c[1] === 'command_center.worker.restart');
    expect(audit[4]).toMatchObject({ outcome: 'error', verdict: { outcome: 'not_recovered' } });
  });

  test('fresh workers but a starved queue is NOT success', async () => {
    proxyAnswers(204);
    mockQueueCollect.mockResolvedValueOnce({
      data: { queues: [{ name: 'email', waiting: 40, active: 0, starved: true }, { name: 'whatsapp' }] },
    });
    const err = await commands.run('worker.restart', { req: req(), confirm: 'worker.restart' }).catch((e) => e);
    expect(err.output.outcome).toBe('not_recovered');
    expect(err.message).toMatch(/email: 40 waiting/);
  });

  test('a refusal from Docker is reported and audited as an error', async () => {
    proxyAnswers(404);
    const err = await commands.run('worker.restart', { req: req(), confirm: 'worker.restart' }).catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/Docker refused the restart \(404\)/);
    expect(mockLogActivity.mock.calls.some((c) => c[1] === 'command_center.worker.restart' && c[4].outcome === 'error')).toBe(true);
  });

  test('the cooldown holds: a second press inside 60s is a 429 and reaches no Docker', async () => {
    proxyAnswers(204);
    await commands.run('worker.restart', { req: req(), confirm: 'worker.restart' });
    fetchCalls.length = 0;
    const err = await commands.run('worker.restart', { req: req('req-2'), confirm: 'worker.restart' }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.code).toBe('COOLDOWN');
    expect(fetchCalls).toEqual([]);
  });
});

describe('API restart (rung 5) and the ladder', () => {
  test('is refused (409) until the worker has been restarted, before confirmation or cooldown', async () => {
    proxyAnswers(204);
    const err = await commands.run('container.restart', { req: req(), confirm: 'container.restart' }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe('LADDER_ORDER');
    expect(err.message).toMatch(/Restart the worker first/);
    expect(fetchCalls).toEqual([]);
    // No requested row: nothing was attempted.
    expect(mockAudit.filter((r) => r.action === verification.ACTION.apiRequested)).toEqual([]);
  });

  test('after rung 4 it records the request FIRST, then restarts ONLY the API', async () => {
    proxyAnswers(204);
    await commands.run('worker.restart', { req: req('w-1'), confirm: 'worker.restart' });
    fetchCalls.length = 0;

    const order = [];
    const realQuery = mockPoolQuery.getMockImplementation();
    mockPoolQuery.mockImplementation(async (sql, params) => {
      if (/INSERT INTO activity_log/.test(sql)) order.push(params[2]);
      return realQuery(sql, params);
    });
    global.fetch.mockImplementation(async (url, opts) => {
      order.push('docker'); fetchCalls.push({ url, method: opts.method });
      return { status: 204, text: async () => '' };
    });

    const out = await commands.run('container.restart', { req: req('api-1'), confirm: 'container.restart' });
    expect(fetchCalls).toEqual([{
      url: `http://docker-socket-proxy:2375/containers/erp-api/restart?t=${docker.STOP_TIMEOUT_S}`,
      method: 'POST',
    }]);
    expect(order.indexOf(verification.ACTION.apiRequested)).toBeLessThan(order.indexOf('docker'));
    // Delivered is not recovered.
    expect(out.output.outcome).toBe('restart_requested');
    expect(out.output.recovered).toBeNull();
    expect(out.output.verification.request_id).toBe('api-1');
    mockPoolQuery.mockImplementation(realQuery);
  });

  test('the new process verifies the restart on boot and the console can read it', async () => {
    // A request recorded by the previous process, before this one started.
    mockAudit.push(mockRow(verification.ACTION.apiRequested, 'api-9', { process_started_at: '2026-01-01T00:00:00Z' },
      { created_at: new Date(verification.PROCESS_STARTED_AT.getTime() - 2000) }));
    expect((await verification.apiRestartStatus('api-9')).state).toBe('pending');

    const results = await verification.verifyPendingApiRestarts({
      health: async () => ({ status: 'healthy', cards: { database: 'healthy', redis: 'healthy' } }),
      settleMs: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('recovered');

    const status = await verification.apiRestartStatus('api-9');
    expect(status.state).toBe('verified');
    expect(status.outcome).toBe('recovered');
    expect(status.health_after.cards.database).toBe('healthy');
    // Idempotent: a second boot pass writes nothing new.
    await verification.verifyPendingApiRestarts({ health: async () => ({ status: 'healthy', cards: {} }), settleMs: 1 });
    expect(mockAudit.filter((r) => r.action === verification.ACTION.apiVerified)).toHaveLength(1);
  });

  test('a new process whose database is still critical records not_recovered', () => {
    expect(verification.gradeApiHealth({ status: 'critical', cards: { database: 'critical' } }).outcome)
      .toBe('not_recovered');
    expect(verification.gradeApiHealth({ status: 'unknown', cards: {} }).outcome).toBe('unverifiable');
  });

  test('a request newer than this process is not claimed by it', async () => {
    mockAudit.push(mockRow(verification.ACTION.apiRequested, 'api-future', {}, { created_at: new Date() }));
    const results = await verification.verifyPendingApiRestarts({ health: async () => ({ status: 'healthy', cards: {} }), settleMs: 1 });
    expect(results).toEqual([]);
  });

  test('if the request cannot be recorded, the restart is NOT sent', async () => {
    proxyAnswers(204);
    await commands.run('worker.restart', { req: req('w-3'), confirm: 'worker.restart' });
    fetchCalls.length = 0;
    const realQuery = mockPoolQuery.getMockImplementation();
    mockPoolQuery.mockImplementation(async (sql, params) => {
      if (/INSERT INTO activity_log/.test(sql)) throw new Error('database is read-only');
      return realQuery(sql, params);
    });
    const err = await commands.run('container.restart', { req: req('api-3'), confirm: 'container.restart' }).catch((e) => e);
    mockPoolQuery.mockImplementation(realQuery);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/read-only/);
    expect(fetchCalls).toEqual([]);
  });

  test('a Docker refusal closes the request as not_restarted', async () => {
    proxyAnswers(204);
    await commands.run('worker.restart', { req: req('w-2'), confirm: 'worker.restart' });
    proxyAnswers(404);
    const err = await commands.run('container.restart', { req: req('api-2'), confirm: 'container.restart' }).catch((e) => e);
    expect(err.status).toBe(500);
    const status = await verification.apiRestartStatus('api-2');
    expect(status.state).toBe('verified');
    expect(status.outcome).toBe('not_restarted');
  });
});

describe('the caller cannot choose the container', () => {
  test('extra fields naming another container change nothing', async () => {
    proxyAnswers(204);
    await commands.run('worker.restart', {
      req: req(), confirm: 'worker.restart',
      // Not a parameter run() reads — the route passes only queue/confirm/dryRun.
      container: 'erp-redis', target: 'erp-redis', queue: 'erp-redis',
    });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      `http://docker-socket-proxy:2375/containers/erp-worker/restart?t=${docker.STOP_TIMEOUT_S}`,
    ]);
  });
});

describe('gradeWorkerReading', () => {
  test('needs a fresh connection on every queue and none from before the restart', () => {
    expect(verification.gradeWorkerReading({ a: [{ age_s: 2 }], b: [{ age_s: 1 }] }, 3000).ok).toBe(true);
    expect(verification.gradeWorkerReading({ a: [{ age_s: 2 }], b: [] }, 3000)).toMatchObject({ ok: false, missing: ['b'] });
    expect(verification.gradeWorkerReading({ a: [{ age_s: 2 }, { age_s: 500 }] }, 3000)).toMatchObject({ ok: false, stale: ['a'] });
  });
});

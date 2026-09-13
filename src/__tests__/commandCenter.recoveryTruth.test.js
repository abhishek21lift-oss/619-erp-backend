'use strict';
// "Recovered" has to mean recovered.
//
// ── The fake success ───────────────────────────────────────────────────────
//
// One Click Recovery decided whether it had worked like this:
//
//     const recovered = after.status === 'healthy'
//       || (after.queue && after.queue.waiting === 0);
//
// The second arm is the bug, and it is not an edge case — it is the NORMAL
// shape of the failure the button exists for. A worker that has died stops
// draining, so nothing new is picked up; it also stops the queue growing,
// because on this platform work arrives from the API, not from the worker. The
// queue sits at waiting = 0. The button reports success. The worker is still
// dead.
//
// The same arm returns success for a queue with 40 failed jobs, for one that
// is unreachable and therefore reporting nothing, and for one left paused.
//
// It was there because the FIRST arm is too strict in the other direction:
// `card.status` rolls up every queue, so an unrelated sick queue would mark
// this recovery failed. The answer is to grade THIS queue against the
// collector's own thresholds, which is what gradeQueue does.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../jobs/queue', () => ({
  QUEUE_NAMES: ['email', 'whatsapp', 'ai', 'notifications', 'membership-renewals'],
  getQueue: jest.fn(),
}));

const commands = require('../modules/command-center/commands.service');
const { gradeQueue, recoveryVerdict } = commands;

const drainedOk = { drained: true, waited_ms: 10, active: 0 };

describe('gradeQueue refuses to call an unread queue healthy', () => {
  it('returns ok:null — not false, and certainly not true — with no reading', () => {
    const g = gradeQueue(null);
    expect(g.ok).toBeNull();
    expect(g.problems[0]).toMatch(/no reading/);
  });

  it('grades a dead-worker queue with an EMPTY backlog as unhealthy', () => {
    // The exact shape the old check passed: waiting 0, and everything else wrong.
    expect(gradeQueue({ name: 'email', reachable: true, waiting: 0, active: 0, failed: 40 }).ok)
      .toBe(false);
    expect(gradeQueue({ name: 'email', reachable: true, waiting: 0, active: 0, failed: 0, paused: true }).ok)
      .toBe(false);
    expect(gradeQueue({ name: 'email', reachable: false }).ok)
      .toBe(false);
  });

  it('names WHY, so the verdict is arguable rather than asserted', () => {
    const g = gradeQueue({ name: 'email', reachable: true, waiting: 0, active: 0, failed: 40, paused: true });
    expect(g.problems.join(' ')).toMatch(/still paused/);
    expect(g.problems.join(' ')).toMatch(/40 failed/);
  });

  it('uses the collector\'s own thresholds, not a second set', () => {
    const qc = require('../modules/command-center/collectors/queue.collector');
    const atWarn = { name: 'email', reachable: true, waiting: qc.WAITING_WARN, active: 1, failed: 0 };
    const belowWarn = { ...atWarn, waiting: qc.WAITING_WARN - 1 };
    expect(gradeQueue(atWarn).ok).toBe(false);
    expect(gradeQueue(belowWarn).ok).toBe(true);
  });

  it('grades a money queue harder, exactly as the card does', () => {
    const qc = require('../modules/command-center/collectors/queue.collector');
    expect([...qc.CRITICAL_QUEUES]).toContain('membership-renewals');
    const one = { reachable: true, waiting: 0, active: 1, failed: 1 };
    expect(gradeQueue({ ...one, name: 'membership-renewals' }).ok).toBe(false);
    expect(gradeQueue({ ...one, name: 'email' }).ok).toBe(true);
  });

  it('calls a genuinely healthy queue healthy', () => {
    expect(gradeQueue({ name: 'email', reachable: true, waiting: 0, active: 2, failed: 0, paused: false, starved: false }).ok)
      .toBe(true);
  });
});

describe('the verdict distinguishes four outcomes, not two', () => {
  const broken = { ok: false, problems: ['400 jobs waiting'], checked: ['backlog'] };
  const healthy = { ok: true, problems: [], checked: ['reachable', 'paused', 'draining', 'failed', 'backlog'] };
  const unknown = { ok: null, problems: ['no reading'], checked: [] };

  it('recovered: broken before, healthy after', () => {
    expect(recoveryVerdict(broken, healthy, drainedOk).outcome).toBe('recovered');
  });

  it('not_recovered: still failing a named condition', () => {
    const v = recoveryVerdict(broken, broken, drainedOk);
    expect(v.outcome).toBe('not_recovered');
    expect(v.summary).toMatch(/400 jobs waiting/);
  });

  it('was_not_broken: nothing was wrong, so nothing was fixed', () => {
    expect(recoveryVerdict(healthy, healthy, drainedOk).outcome).toBe('was_not_broken');
  });

  it('unverifiable: no post-recovery reading is NOT success', () => {
    const v = recoveryVerdict(broken, unknown, drainedOk);
    expect(v.outcome).toBe('unverifiable');
    expect(v.outcome).not.toBe('recovered');
    expect(v.summary).toMatch(/no evidence|unresolved/i);
  });

  it('not_recovered when the queue grades clean but jobs never finished', () => {
    // The queue is empty because the stuck job is still holding it, not
    // because anything drained. Calling that recovered hides the real fault.
    const v = recoveryVerdict(broken, healthy, { drained: false, waited_ms: 30_000, active: 3 });
    expect(v.outcome).toBe('not_recovered');
    expect(v.summary).toMatch(/still running/);
  });

  it('reports what was actually checked', () => {
    const v = recoveryVerdict(broken, healthy, drainedOk);
    expect(v.checks.post_health_read).toBe(true);
    expect(v.checks.in_flight_work_finished).toBe(true);
    expect(v.checks.conditions_checked).toContain('draining');
  });
});

// ── Rungs 4–5: a restart button that is not a remote shell ─────────────────

describe('container recovery is least-privilege by construction', () => {
  const docker = require('../modules/command-center/container-recovery');
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'command-center', 'container-recovery.js'), 'utf8',
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('can express exactly one Docker verb', () => {
    // Not "we do not call exec" — there is no call to remove. Anything holding
    // the Docker socket is root on the host; `create` and `exec` are arbitrary
    // code execution, so their absence has to be a property, not a habit.
    expect(code).toMatch(/\/containers\/\$\{encodeURIComponent\(id\)\}\/restart/);
    for (const forbidden of ['/exec', '/containers/create', '/images/create', '/attach', 'child_process', 'exec(']) {
      expect(code).not.toContain(forbidden);
    }
    // One and only one fetch.
    expect(code.match(/fetch\(/g)).toHaveLength(1);
  });

  it('takes a target KEY and never a container name', async () => {
    process.env.DOCKER_PROXY_URL = 'http://proxy:2375';
    process.env.CC_WORKER_CONTAINER = 'erp-worker';
    try {
      // Anything that is not one of the two fixed keys is refused before a
      // request exists — so a caller cannot reach a container of their choosing.
      await expect(docker.restart('../../etc')).rejects.toMatchObject({ status: 400 });
      await expect(docker.restart('database')).rejects.toMatchObject({ status: 400 });
      await expect(docker.restart('__proto__')).rejects.toMatchObject({ status: 400 });
      expect(Object.keys(docker.targets()).sort()).toEqual(['api', 'worker']);
    } finally {
      delete process.env.DOCKER_PROXY_URL;
      delete process.env.CC_WORKER_CONTAINER;
    }
  });

  it('is off, and says why, when the proxy is not wired up', async () => {
    delete process.env.DOCKER_PROXY_URL;
    expect(docker.isConfigured()).toBe(false);
    expect(docker.unavailableReason()).toMatch(/DOCKER_PROXY_URL/);
    const out = await docker.restart('worker');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/not wired up/);
  });

  it('refuses per target when only one container is configured', () => {
    process.env.DOCKER_PROXY_URL = 'http://proxy:2375';
    process.env.CC_WORKER_CONTAINER = 'erp-worker';
    delete process.env.CC_API_CONTAINER;
    try {
      expect(docker.unavailableReason('worker')).toBeNull();
      expect(docker.unavailableReason('api')).toMatch(/CC_API_CONTAINER/);
    } finally {
      delete process.env.DOCKER_PROXY_URL;
      delete process.env.CC_WORKER_CONTAINER;
    }
  });

  it('posts the restart, with a stop grace, and nothing else', async () => {
    process.env.DOCKER_PROXY_URL = 'http://proxy:2375/';
    process.env.CC_WORKER_CONTAINER = 'erp-worker';
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url, opts) => {
      calls.push({ url, method: opts.method });
      return { status: 204, text: async () => '' };
    });
    try {
      const out = await docker.restart('worker');
      expect(out.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].url).toBe(`http://proxy:2375/containers/erp-worker/restart?t=${docker.STOP_TIMEOUT_S}`);
    } finally {
      global.fetch = realFetch;
      delete process.env.DOCKER_PROXY_URL;
      delete process.env.CC_WORKER_CONTAINER;
    }
  });

  it('degrades rather than throwing when the proxy refuses', async () => {
    process.env.DOCKER_PROXY_URL = 'http://proxy:2375';
    process.env.CC_API_CONTAINER = 'erp-api';
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ status: 403, text: async () => 'forbidden by proxy' }));
    try {
      const out = await docker.restart('api');
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/403/);
    } finally {
      global.fetch = realFetch;
      delete process.env.DOCKER_PROXY_URL;
      delete process.env.CC_API_CONTAINER;
    }
  });
});

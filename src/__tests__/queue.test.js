'use strict';

/**
 * The queue, and the two properties that make it safe to ship.
 *
 * 1. Nothing in this application constructs a Redis client except one file.
 *    BullMQ needs a separate connection for workers — their blocking commands
 *    would stall a producer sharing the socket — and it duplicates that one
 *    per Worker of its own accord, which is unavoidable. What is avoidable,
 *    and what this guards, is a module deciding to call `new IORedis` itself.
 *
 * 2. No Redis is a supported state. This project had no Redis at all before
 *    BullMQ, Redis is not deployed yet, and the deploy pipeline is currently
 *    failing — so a version of this that required Redis would have taken the
 *    API down the moment it shipped. Every enqueue falls back to running the
 *    work inline, which is exactly what each call site did before.
 *
 * The fallback is not a nicety to be tested loosely: it is the code path that
 * runs in production today, in every test, and in local development.
 */

const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const SRC = path.join(__dirname, '..');

/** Reload the queue modules with a given REDIS_URL. */
function loadWith(redisUrl) {
  jest.resetModules();
  const prev = process.env.REDIS_URL;
  if (redisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = redisUrl;
  const mod = {
    queue: require('../lib/queue'),
    connection: require('../lib/queue/connection'),
  };
  restore.push(() => {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  });
  return mod;
}

const restore = [];
afterEach(() => { while (restore.length) restore.pop()(); jest.resetModules(); });

describe('Redis connections', () => {
  it('are constructed in exactly one file', () => {
    // Grep rather than a runtime assertion: the failure this guards against
    // is a future module quietly doing `new IORedis(...)` of its own, which
    // no amount of exercising the current code would catch.
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/new\s+(IORedis|Redis)\s*\(/.test(src) || /require\(['"]ioredis['"]\)/.test(src)) {
          offenders.push(path.relative(SRC, full));
        }
      }
    })(SRC);
    expect(offenders).toEqual(['lib/queue/connection.js']);
  });

  it('reports itself disabled when REDIS_URL is unset', () => {
    const { connection } = loadWith(undefined);
    expect(connection.isEnabled()).toBe(false);
    expect(connection.producer()).toBeNull();
    expect(connection.worker()).toBeNull();
  });

  it('never defaults to a localhost Redis', () => {
    // A default would make every enqueue retry against a host that is not
    // there, and would hide a missing variable behind a connection error at
    // 3am rather than a log line at boot.
    // Comments stripped first: connection.js explains at length why there is
    // no default, and naming the URL it refuses to use must not trip this.
    const src = fs.readFileSync(path.join(SRC, 'lib/queue/connection.js'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/REDIS_URL\s*\|\|\s*['"]redis/);
    expect(code).not.toMatch(/localhost:6379/);
    // And the real assertion: unset means disabled, whatever the source says.
    expect(loadWith(undefined).connection.isEnabled()).toBe(false);
  });
});

describe('enqueue() without Redis', () => {
  it('runs the work inline and says it did not queue', async () => {
    const { queue } = loadWith(undefined);
    const inline = jest.fn().mockResolvedValue('done');

    const out = await queue.enqueue(queue.QUEUES.EMAIL, 'password_reset', { to: 'a@b.com' }, inline);

    expect(inline).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ queued: false, result: 'done' });
  });

  it('propagates the inline error rather than swallowing it', async () => {
    // The caller's existing .catch() has to keep firing. Swallowing here
    // would turn a visible failure into a silent one — the exact defect this
    // whole feature exists to prevent.
    const { queue } = loadWith(undefined);
    const inline = jest.fn().mockRejectedValue(new Error('smtp down'));

    await expect(queue.enqueue(queue.QUEUES.EMAIL, 'x', {}, inline)).rejects.toThrow('smtp down');
  });

  it('refuses to silently drop a job with no inline fallback', async () => {
    const { queue } = loadWith(undefined);
    await expect(queue.enqueue(queue.QUEUES.AI, 'ingest', { documentId: 1 }))
      .rejects.toThrow(/no inline fallback/i);
  });

  it('reports every queue as disabled rather than throwing', async () => {
    const { queue } = loadWith(undefined);
    for (const name of Object.values(queue.QUEUES)) {
      await expect(queue.counts(name)).resolves.toEqual({ name, enabled: false });
    }
  });

  it('closes cleanly when nothing was ever opened', async () => {
    const { queue } = loadWith(undefined);
    await expect(queue.close()).resolves.toBeUndefined();
  });
});

describe('connection sharing, measured', () => {
  it('documents what BullMQ actually opens', () => {
    // Measured against a real Redis, not assumed: four Queues share one
    // socket; four Workers bring the total to six, because BullMQ duplicates
    // the worker connection once per Worker for its blocking commands. Two
    // workers cannot both sit in BZPOPMIN on one socket, so that duplication
    // is correct and unavoidable — a genuinely shared worker connection would
    // mean the queues consumed one at a time.
    //
    // Pinned as prose in the module rather than as a live count because
    // standing up a Redis in unit tests to assert an integer would be slower
    // and less honest than saying what was measured.
    const src = require('fs').readFileSync(
      require('path').join(SRC, 'lib/queue/connection.js'), 'utf8');
    expect(src).toMatch(/DUPLICATES it once per/);
    expect(src).toMatch(/4 Queues, no workers \.+ 1 connection/);
  });
});

describe('retry policy', () => {
  it('covers all four queues with exponential backoff', () => {
    const { queue } = loadWith(undefined);
    for (const name of Object.values(queue.QUEUES)) {
      const p = queue.JOB_OPTIONS[name];
      expect(p).toBeDefined();
      expect(p.attempts).toBeGreaterThan(1);
      expect(p.backoff.type).toBe('exponential');
      expect(p.backoff.delay).toBeGreaterThan(0);
    }
  });

  it('backs off slower for the expensive queues than the cheap ones', () => {
    // Retrying a PDF embed every 5 seconds is how one bad upload becomes an
    // hour of CPU; retrying an SMTP blip every 60 is how a password reset
    // arrives after the user has given up.
    const { queue } = loadWith(undefined);
    const { EMAIL, AI, RENEWAL } = queue.QUEUES;
    expect(queue.JOB_OPTIONS[AI].backoff.delay)
      .toBeGreaterThan(queue.JOB_OPTIONS[EMAIL].backoff.delay);
    expect(queue.JOB_OPTIONS[RENEWAL].backoff.delay)
      .toBeGreaterThanOrEqual(queue.JOB_OPTIONS[AI].backoff.delay);
  });

  it('bounds retention so Redis cannot grow without limit', () => {
    const { queue } = loadWith(undefined);
    expect(queue.RETENTION.removeOnComplete.count).toBeGreaterThan(0);
    expect(queue.RETENTION.removeOnFail.count).toBeGreaterThan(0);
    // Failed jobs outlive completed ones: a failure nobody can read is the
    // same as no queue at all.
    expect(queue.RETENTION.removeOnFail.age)
      .toBeGreaterThan(queue.RETENTION.removeOnComplete.age);
  });
});

describe('scheduling', () => {
  it('does not fall back to an interval when there is no Redis', async () => {
    // Deliberate: runAutoRenew charges cards. An unsupervised interval doing
    // that on N containers is worse than a missing schedule that shows up in
    // the boot log.
    jest.resetModules();
    delete process.env.REDIS_URL;
    const { scheduleRenewals } = require('../lib/queue/schedule');
    await expect(scheduleRenewals()).resolves.toEqual({
      scheduled: false, reason: 'REDIS_NOT_CONFIGURED',
    });
  });
});

describe('worker bootstrap', () => {
  it('starts nothing without Redis, and stops cleanly', async () => {
    jest.resetModules();
    delete process.env.REDIS_URL;
    const workers = require('../workers/queue');
    expect(workers.startAll()).toEqual([]);
    await expect(workers.stopAll()).resolves.toBeUndefined();
  });

  it('runs AI and renewal one at a time', () => {
    // Embedding is CPU-bound, so parallelism makes all of them slow rather
    // than any of them fast. Renewal charges cards, so serial is easier to
    // reason about than fast.
    jest.resetModules();
    const { CONCURRENCY } = require('../workers/queue');
    const { QUEUES } = require('../lib/queue');
    expect(CONCURRENCY[QUEUES.AI]).toBe(1);
    expect(CONCURRENCY[QUEUES.RENEWAL]).toBe(1);
    expect(CONCURRENCY[QUEUES.EMAIL]).toBeGreaterThan(1);
  });
});

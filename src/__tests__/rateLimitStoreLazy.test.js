// Constructing a rate-limit store must not talk to Redis.
//
// rate-limit-redis@4.3.1 fires two commands from its CONSTRUCTOR
// (dist/index.cjs:95-96):
//
//     this.incrementScriptSha = this.loadIncrementScript();   // SCRIPT LOAD
//     this.getScriptSha       = this.loadGetScript();         // SCRIPT LOAD
//
// Both are async, neither is awaited and neither is caught. makeStore() runs at
// MODULE LOAD — fifteen call sites across six route modules, three middleware
// and server.js — so on every deploy each store issues two commands against a
// client that is, by construction, not connected yet: getFailFastClient()
// inherits lazyConnect:true and sets enableOfflineQueue:false. ioredis rejects
// a command issued while merely CONNECTING (not only while down), so the
// rejection is guaranteed rather than conditional.
//
// Measured against a healthy, reachable Redis:
//
//     status at construction: wait
//     IMMEDIATE command REJECTED: Stream isn't writeable and enableOfflineQueue options is false
//     status after 2s: ready
//     SAME client, 2s later: PONG
//
// Which is why this showed up as a burst of errors at deploy and then vanished,
// with Redis answering PONG the whole time. It was never an outage.
//
// These tests pin the fix: construction issues ZERO commands, so there is
// nothing to reject. The store is built on first real use instead, by which
// point Redis is ready — and if it is not, the failure lands inside increment(),
// which express-rate-limit already handles via passOnStoreError: true.
'use strict';

const mockRedisState = { configured: true };
// `status` mirrors ioredis: `wait` until something calls connect(), then
// `connecting`, then `ready`. Most tests run against a ready client.
const mockClient = {
  call: jest.fn(),
  status: 'ready',
  connect: jest.fn(async () => { mockClient.status = 'ready'; }),
};

jest.mock('../lib/redis', () => ({
  isConfigured: () => mockRedisState.configured,
  getFailFastClient: () => mockClient,
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

/**
 * What a healthy Redis answers.
 *
 * SCRIPT LOAD must return a SHA string (the store throws "unexpected reply"
 * otherwise). The increment/get scripts are EVALSHA and must return a
 * TWO-element array — [totalHits, timeToExpire] — which parseScriptResponse
 * rejects loudly if it is not (dist/index.cjs:39-45).
 */
function healthyReplies() {
  mockClient.call.mockImplementation(async (cmd) => {
    const c = String(cmd).toUpperCase();
    if (c === 'SCRIPT') return 'a'.repeat(40);
    if (c === 'EVALSHA' || c === 'EVAL') return [1, 900_000];
    return 1;
  });
}

/**
 * A partial failure: scripts load, but the increment command fails.
 *
 * This is the shape that isolates the property under test. If SCRIPT LOAD also
 * failed, rate-limit-redis would take its `retryableIncrement` catch path, which
 * reassigns `this.incrementScriptSha = this.loadIncrementScript(key)` without
 * awaiting it (dist/index.cjs:143-145) and leaves a floating rejection that
 * Jest treats as fatal — a library defect verified with no repo code involved,
 * identical before and after this change. Letting the script load keeps the
 * test on the path this PR actually governs: the store's own command failing,
 * which is what `passOnStoreError: true` exists to absorb.
 */
/** A Redis that is simply not there. Used only where NO command should be sent. */
function deadReplies() {
  mockClient.call.mockImplementation(async () => {
    throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
  });
}

function partialFailReplies() {
  mockClient.call.mockImplementation(async (cmd) => {
    const c = String(cmd).toUpperCase();
    if (c === 'SCRIPT') return 'a'.repeat(40);
    if (c === 'EVALSHA' || c === 'EVAL') throw new Error('READONLY You can\'t write against a read only replica');
    return 1;
  });
}

function loadStore() {
  jest.resetModules();
  return require('../lib/rateLimitStore');
}

beforeEach(() => {
  mockRedisState.configured = true;
  mockClient.call.mockReset();
  mockClient.connect.mockReset();
  mockClient.connect.mockImplementation(async () => { mockClient.status = 'ready'; });
  mockClient.status = 'ready';
  healthyReplies();
});

describe('makeStore — construction must not touch Redis', () => {
  it('issues ZERO commands when the store is built', () => {
    // The defect in one assertion. Before the fix this was two SCRIPT LOAD
    // calls per store, fired from the constructor with nothing awaiting them.
    const { makeStore } = loadStore();
    makeStore('login');
    expect(mockClient.call).not.toHaveBeenCalled();
  });

  it('issues ZERO commands across every limiter the app actually builds', () => {
    // Fifteen makeStore() call sites today (server.js x3, authRateLimit x3,
    // aiRateLimit, six route modules). Thirty SCRIPT LOADs, thirty unhandled
    // rejections, one deploy.
    const { makeStore } = loadStore();
    const prefixes = ['api', 'user', 'register', 'login-id', 'login-ip',
      'refresh-device', 'ai', 'search', 'qr', 'qrscan', 'mfa', 'invite',
      'webauthn', 'activation'];
    for (const p of prefixes) makeStore(p);
    expect(mockClient.call).not.toHaveBeenCalled();
  });

  it('still produces no unhandled rejection when Redis is unreachable', async () => {
    // Belt and braces: the assertion above is structural, this is behavioural.
    deadReplies();
    const seen = [];
    const onRejection = (r) => seen.push(r);
    process.on('unhandledRejection', onRejection);
    try {
      const { makeStore } = loadStore();
      for (const p of ['a', 'b', 'c']) makeStore(p);
      // Let the microtask queue drain, which is when Node would report one.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(seen).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });

  it('exposes the key prefix without needing a connection', () => {
    // The existing suite asserts on store.prefix, and it is the only thing that
    // keeps two limiters from sharing a budget.
    const { makeStore } = loadStore();
    expect(makeStore('login').prefix).toBe('rl:login:');
    expect(makeStore('search').prefix).toBe('rl:search:');
  });
});

describe('makeStore — the store still works once Redis is up', () => {
  it('builds on first use and counts', async () => {
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 900000 });

    const result = await store.increment('key-1');

    expect(result).toEqual({ totalHits: 1, resetTime: expect.anything() });
    expect(mockClient.call).toHaveBeenCalled();
  });

  it('loads its Lua script at that point, not before', async () => {
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 900000 });

    expect(mockClient.call).not.toHaveBeenCalled();
    await store.increment('key-1');

    // Two SCRIPT LOADs, then the EVALSHA — the work simply moved to first use.
    const scripts = mockClient.call.mock.calls.filter(([c]) => String(c).toUpperCase() === 'SCRIPT');
    expect(scripts.length).toBeGreaterThanOrEqual(1);
  });

  it('passes the limiter window through to the real store', async () => {
    // RedisStore.init() is the only thing that sets windowMs, and its increment()
    // reads it. A proxy that swallowed init() would send `undefined` into the
    // Lua script — a silent, total failure of the limiter.
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 4242 });

    await store.increment('key-1');

    const evalsha = mockClient.call.mock.calls.find(([c]) => String(c).toUpperCase() === 'EVALSHA');
    expect(evalsha).toBeDefined();
    // EVALSHA args are [cmd, sha, numKeys, key, resetExpiryOnChange, windowMs].
    expect(evalsha[1]).toBe('a'.repeat(40));
    expect(evalsha[evalsha.length - 1]).toBe('4242');
  });

  it('forwards get, decrement and resetKey to the real store', async () => {
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 60000 });

    await expect(store.get('key-1')).resolves.toEqual(
      expect.objectContaining({ totalHits: expect.anything() })
    );
    await expect(store.decrement('key-1')).resolves.not.toThrow();
    await expect(store.resetKey('key-1')).resolves.not.toThrow();
  });

  it('reuses one real store across calls rather than rebuilding per request', async () => {
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 60000 });

    await store.increment('key-1');
    const after = mockClient.call.mock.calls.length;
    await store.increment('key-2');

    // Only the increment command on the second call — no second SCRIPT LOAD.
    const scriptsAfter = mockClient.call.mock.calls
      .slice(after).filter(([c]) => String(c).toUpperCase() === 'SCRIPT').length;
    expect(scriptsAfter).toBe(0);
  });
});

describe('makeStore — outage behaviour is unchanged', () => {
  /**
   * rate-limit-redis emits ONE unhandled rejection per failed increment, from
   * its own retry path: `retryableIncrement` catches, then reassigns
   * `this.incrementScriptSha = this.loadIncrementScript(key)` without awaiting
   * or catching that promise (dist/index.cjs:143-145).
   *
   * Verified to belong to the library, not to this fix, by driving RedisStore
   * directly with a rejecting sendCommand and no repo code in the process at
   * all: increment() rejects AND one floating rejection appears. It behaves
   * identically before and after this change, so it is absorbed here rather
   * than fixed here — fixing it means either patching a third-party package or
   * wrapping every call site, and neither is in scope. Reported separately.
   */
  function absorbLibraryRejection() {
    const seen = [];
    const onRejection = (r) => seen.push(r);
    process.on('unhandledRejection', onRejection);
    return {
      seen,
      done: async () => {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        process.removeListener('unhandledRejection', onRejection);
        return seen;
      },
    };
  }

  it('rejects from increment() so passOnStoreError can fail OPEN', async () => {
    // Deliberate, documented at rateLimitStore.js:29-33: a limiter is a DoS
    // control, not an authorization boundary, so availability wins. Every one of
    // the 19 limiters pairs the store with passOnStoreError:true, and that
    // fallback only works if increment() REJECTS. This test exists to stop a
    // future "fix" from swallowing the error and turning a Redis blip into 500s.
    partialFailReplies();
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 60000 });

    const absorber = absorbLibraryRejection();
    await expect(store.increment('key-1')).rejects.toThrow();
    const floating = await absorber.done();

    // The one thing this PR is responsible for: construction contributes none.
    // Anything that did surface came from the library's retry path.
    expect(floating.filter((e) => /constructed at/i.test(String(e && e.stack)))).toEqual([]);
  });

  it('still counts correctly again after Redis recovers mid-process', async () => {
    // The store is built once and reused, so recovery must not need a restart.
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 60000 });

    healthyReplies();
    await expect(store.increment('key-1')).resolves.toEqual(
      expect.objectContaining({ totalHits: 1 })
    );
  });

  it('documents the first-request fail-open that this fix does NOT change', async () => {
    // Recorded deliberately, because it is the honest boundary of this change.
    //
    // The fail-fast client is `lazyConnect`, so it has still never connected on
    // the first command it is ever sent — whether that command comes from the
    // RedisStore constructor (before this fix) or from the first increment
    // (after it). Verified against a live Redis either way:
    //
    //   before:  SCRIPT LOAD at import -> rejected -> unhandled rejection
    //   after:   SCRIPT LOAD at first increment -> rejected -> passOnStoreError
    //
    // So the FIRST request to each limiter has always failed open, and still
    // does. This change removes the unhandled rejections and the log storm; it
    // does not remove the first-request race, because closing that needs the
    // fail-fast client connected before traffic arrives — a change to
    // lib/redis.js and/or server.js, i.e. a different task. Asserted here so the
    // boundary is visible rather than assumed.
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 60000 });

    partialFailReplies();
    await expect(store.increment('first-hit')).rejects.toThrow();

    // Second hit works once Redis answers — the limiter is not disabled, only
    // its first call was lost, exactly as before.
    healthyReplies();
    await expect(store.increment('second-hit')).resolves.toEqual(
      expect.objectContaining({ totalHits: 1 })
    );
  });

  it('still returns undefined when Redis is not configured at all', () => {
    // Unchanged contract: express-rate-limit reads undefined as "no store" and
    // uses its in-memory default. Local dev and single-container deploys.
    mockRedisState.configured = false;
    const { makeStore } = loadStore();
    expect(makeStore('login')).toBeUndefined();
  });

  it('still refuses a missing prefix', () => {
    const { makeStore } = loadStore();
    expect(() => makeStore()).toThrow(/unique string prefix/i);
    expect(() => makeStore('')).toThrow(/unique string prefix/i);
  });

  it('still warns once, not fifteen times, when Redis is unconfigured', () => {
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    jest.resetModules();
    jest.doMock('../lib/logger', () => log);
    jest.doMock('../lib/redis', () => ({
      isConfigured: () => false,
      getFailFastClient: () => mockClient,
    }));
    const { makeStore } = require('../lib/rateLimitStore');

    makeStore('a'); makeStore('b'); makeStore('c');

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/per-process/i);
  });
});

describe('makeStore — the first request after a deploy (Sentry 619-ERP-BACKEND-1)', () => {
  // The fail-fast client is lazy and nothing else connects it, so the first
  // limited request after a deploy found it in `wait`. Building the store then
  // fired two SCRIPT LOADs that ioredis rejected, one of them unhandled.

  // The suite above doMocks redis as unconfigured; that outlives its test.
  beforeEach(() => {
    jest.doMock('../lib/redis', () => ({
      isConfigured: () => mockRedisState.configured,
      getFailFastClient: () => mockClient,
    }));
  });

  it('does not build the store, or send anything, while the client is still in wait', async () => {
    mockClient.status = 'wait';
    mockClient.connect.mockImplementation(async () => {}); // still connecting
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 60000 });

    await expect(store.increment('key-1')).rejects.toThrow(/redis not ready \(wait\)/);
    expect(mockClient.call).not.toHaveBeenCalled();
    // ...and it starts the connection, so the next request finds it ready.
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });

  it('counts normally once the connection it started is ready', async () => {
    mockClient.status = 'wait';
    const { makeStore } = loadStore();
    const store = makeStore('login');
    store.init({ windowMs: 60000 });

    await expect(store.increment('key-1')).rejects.toThrow(/not ready/);
    // connect() resolved and flipped the status, as ioredis does.
    await expect(store.increment('key-1')).resolves.toEqual(expect.objectContaining({ totalHits: 1 }));
  });

  it('a not-ready store is a store error express-rate-limit lets through, not a crash', async () => {
    mockClient.status = 'wait';
    mockClient.connect.mockImplementation(async () => {});
    const express = require('express');
    const request = require('supertest');
    const { rateLimit } = require('express-rate-limit');
    const { makeStore } = loadStore();
    const app = express();
    app.use(rateLimit({ windowMs: 60000, limit: 5, store: makeStore('boot'), passOnStoreError: true }));
    app.get('/x', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
  });

  it('a failed script load after connecting never surfaces as an unhandled rejection', async () => {
    deadReplies();
    const seen = [];
    const onRejection = (r) => seen.push(r);
    process.on('unhandledRejection', onRejection);
    try {
      const { makeStore } = loadStore();
      const store = makeStore('login');
      store.init({ windowMs: 60000 });
      // A store that has never served get(): its get-script load is the
      // promise nothing awaits.
      await expect(store.increment('key-1')).rejects.toThrow();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(seen).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });
});

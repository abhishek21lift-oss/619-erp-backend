'use strict';
// Three guarantees that a `new Map()` cannot make once a second replica exists.
//
//   cooldowns  the last guard after the typed confirmation on the destructive
//              rungs. Two clicks landing on two instances both passed.
//   tickets    single-use. Minted on A, presented to B, refused — the console
//              simply cannot connect behind a load balancer.
//   streaks    alert damping. Per-instance counters multiply the window by the
//              number of instances, and `streaks.delete()` after a MANUAL
//              resolve cleared only one instance's memory, so another still
//              holding bad:2 re-opened the alert on its next tick.
//
// Every test below runs TWO independent module instances against ONE fake
// Redis, because "works in one process" is exactly the property that was never
// in question.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

/**
 * Enough of ioredis to run the three primitives, with the semantics that
 * matter: SET NX is atomic, the Lua scripts run indivisibly, PX expires.
 */
function fakeRedis() {
  const store = new Map();   // key -> { value, expiresAt }
  const hashes = new Map();  // key -> { field -> number, __exp }
  const now = () => Date.now();
  const live = (rec) => rec && (rec.expiresAt === null || rec.expiresAt > now());

  return {
    failNext: false,
    async set(key, value, ...args) {
      if (this.failNext) { this.failNext = false; throw new Error('redis down'); }
      const px = args.indexOf('PX');
      const ttl = px >= 0 ? Number(args[px + 1]) : null;
      const nx = args.includes('NX');
      const existing = store.get(key);
      if (nx && live(existing)) return null;
      store.set(key, { value, expiresAt: ttl ? now() + ttl : null });
      return 'OK';
    },
    async pttl(key) {
      const rec = store.get(key);
      if (!live(rec)) return -2;
      return rec.expiresAt === null ? -1 : rec.expiresAt - now();
    },
    async del(key) { store.delete(key); hashes.delete(key); return 1; },
    async eval(script, _n, key, ...argv) {
      if (this.failNext) { this.failNext = false; throw new Error('redis down'); }
      if (/GET.*DEL/s.test(script)) {
        const rec = store.get(key);
        store.delete(key);
        return live(rec) ? rec.value : null;
      }
      // The streak script. Read from the SCRIPT, not from the caller's intent:
      // a double that reimplements what the Lua is SUPPOSED to do cannot see
      // the HSET being deleted, and the whole point of the script is that both
      // fields move together.
      const [up, down, ttl] = argv;
      let h = hashes.get(key);
      if (!h || h.__exp <= now()) { h = { bad: 0, good: 0, __exp: 0 }; hashes.set(key, h); }
      if (/HSET[^)]*\bdown\b/.test(script)) h[down] = 0;
      if (/HINCRBY[^)]*\bup\b/.test(script)) h[up] = (h[up] ?? 0) + 1;
      if (/PEXPIRE/.test(script)) h.__exp = now() + Number(ttl);
      return h[up];
    },
    _store: store,
  };
}

let mockShared;
const mockRedisState = { configured: true, ready: true };

jest.mock('../lib/redis', () => ({
  isConfigured: () => mockRedisState.configured,
  isReady: () => mockRedisState.ready,
  getClient: () => mockShared,
}));

/** Two module instances, as two API containers would be. */
function twoInstances() {
  let a; let b;
  jest.isolateModules(() => { a = require('../modules/command-center/coordination'); });
  jest.isolateModules(() => { b = require('../modules/command-center/coordination'); });
  expect(a).not.toBe(b);   // the harness is real, not two names for one module
  return [a, b];
}

beforeEach(() => {
  mockShared = fakeRedis();
  mockRedisState.configured = true;
  mockRedisState.ready = true;
});

describe('cooldowns hold across instances', () => {
  it('a second instance is refused inside the window', async () => {
    const [a, b] = twoInstances();
    expect((await a.claimCooldown('queue.clearFailed', 30_000)).ok).toBe(true);
    const second = await b.claimCooldown('queue.clearFailed', 30_000);
    expect(second.ok).toBe(false);
    expect(second.scope).toBe('shared');
    expect(second.retry_in_ms).toBeGreaterThan(0);
  });

  it('without the shared store BOTH instances run — the bug, pinned', async () => {
    mockRedisState.ready = false;
    const [a, b] = twoInstances();
    expect((await a.claimCooldown('queue.clearFailed', 30_000)).ok).toBe(true);
    // This is what the old Map did on every deployment with more than one
    // replica. Asserted so the difference the shared store makes is visible.
    expect((await b.claimCooldown('queue.clearFailed', 30_000)).ok).toBe(true);
  });

  it('cooldowns are per command', async () => {
    const [a, b] = twoInstances();
    await a.claimCooldown('queue.pause', 30_000);
    expect((await b.claimCooldown('queue.resume', 30_000)).ok).toBe(true);
  });

  it('falls back to local rather than refusing when Redis errors', async () => {
    // An operator must be able to resume a queue while Redis is the thing
    // that is broken. Refusing the recovery button then is the wrong failure.
    const [a] = twoInstances();
    mockShared.failNext = true;
    const out = await a.claimCooldown('queue.resume', 30_000);
    expect(out.ok).toBe(true);
    expect(out.scope).toBe('local');
  });

  it('a zero cooldown never blocks', async () => {
    const [a, b] = twoInstances();
    expect((await a.claimCooldown('health.check', 0)).ok).toBe(true);
    expect((await b.claimCooldown('health.check', 0)).ok).toBe(true);
  });
});

describe('tickets are single-use across instances', () => {
  it('mints on one instance and redeems on the other, exactly once', async () => {
    const [a, b] = twoInstances();
    const t = await a.putTicket({ userId: 'u1', email: 'op@x.com', issuedAt: Date.now() }, 30_000);
    expect(await b.takeTicket(t)).toMatchObject({ userId: 'u1' });
    // The second presentation, on EITHER instance, finds nothing.
    expect(await a.takeTicket(t)).toBeNull();
    expect(await b.takeTicket(t)).toBeNull();
  });

  it('two sockets racing the same ticket: one wins', async () => {
    const [a, b] = twoInstances();
    const t = await a.putTicket({ userId: 'u1', issuedAt: Date.now() }, 30_000);
    const [x, y] = await Promise.all([a.takeTicket(t), b.takeTicket(t)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
  });

  it('never redeems a Redis-minted ticket from local memory', async () => {
    // Single-use is a security property. A ticket whose uniqueness cannot be
    // checked is not a ticket, so this fails closed rather than falling back.
    const [a] = twoInstances();
    const t = await a.putTicket({ userId: 'u1', issuedAt: Date.now() }, 30_000);
    expect(t.startsWith('r.')).toBe(true);
    mockRedisState.ready = false;
    expect(await a.takeTicket(t)).toBeNull();
  });

  it('writes a ticket to exactly ONE store, never both', async () => {
    // This is what makes cross-store replay impossible rather than merely
    // unlikely: there is no second copy to find. Without it, a redemption that
    // fell back to memory could spend the same ticket twice.
    const [a] = twoInstances();
    const t = await a.putTicket({ userId: 'u1', issuedAt: Date.now() }, 30_000);
    expect(t.startsWith('r.')).toBe(true);
    expect(a.localTicketCount()).toBe(0);
    expect(mockShared._store.size).toBe(1);
  });

  it('mints locally, and works, when Redis is absent', async () => {
    mockRedisState.configured = false;
    const [a] = twoInstances();
    const t = await a.putTicket({ userId: 'u1', issuedAt: Date.now() }, 30_000);
    expect(t.startsWith('l.')).toBe(true);
    expect(await a.takeTicket(t)).toMatchObject({ userId: 'u1' });
    expect(await a.takeTicket(t)).toBeNull();
  });

  it('refuses malformed tickets without throwing', async () => {
    const [a] = twoInstances();
    for (const bad of ['', 'nope', 'r.', '.abc', 'x.abc', null, undefined, 42, { t: 1 }]) {
      expect(await a.takeTicket(bad)).toBeNull();
    }
  });

  it('caps the in-memory fallback, evicting the oldest', async () => {
    mockRedisState.configured = false;
    const [a] = twoInstances();
    const first = await a.putTicket({ userId: 'u1', issuedAt: Date.now() }, 60_000);
    for (let i = 0; i <= a.MAX_LOCAL_TICKETS; i += 1) {
      await a.putTicket({ userId: 'u1', issuedAt: Date.now() }, 60_000);
    }
    expect(a.localTicketCount()).toBeLessThanOrEqual(a.MAX_LOCAL_TICKETS);
    expect(await a.takeTicket(first)).toBeNull();
  });
});

describe('damping streaks are mockShared', () => {
  it('two instances contribute to one count', async () => {
    const [a, b] = twoInstances();
    expect(await a.bumpStreak('redis', 'bad', 60_000)).toBe(1);
    expect(await b.bumpStreak('redis', 'bad', 60_000)).toBe(2);
  });

  it('the opposite counter is zeroed in the same step', async () => {
    const [a, b] = twoInstances();
    await a.bumpStreak('redis', 'bad', 60_000);
    await a.bumpStreak('redis', 'bad', 60_000);
    // One good observation must reset `bad` to zero for EVERY instance, or a
    // condition that flickers opens an alert it should not.
    expect(await b.bumpStreak('redis', 'good', 60_000)).toBe(1);
    expect(await b.bumpStreak('redis', 'bad', 60_000)).toBe(1);
  });

  it('a manual resolve clears the streak for every instance', async () => {
    // The worst of the three bugs: an operator closes an alert by hand on
    // instance A, and instance B — still holding bad:2 — re-opens it.
    const [a, b] = twoInstances();
    await a.bumpStreak('redis', 'bad', 60_000);
    await b.bumpStreak('redis', 'bad', 60_000);
    await a.clearStreak('redis');
    expect(await b.bumpStreak('redis', 'bad', 60_000)).toBe(1);
  });

  it('falls back to local counters when Redis errors', async () => {
    const [a] = twoInstances();
    mockShared.failNext = true;
    expect(await a.bumpStreak('redis', 'bad', 60_000)).toBe(1);
  });
});

describe('the namespace stays clear of BullMQ', () => {
  it('prefixes every key it writes', async () => {
    const [a] = twoInstances();
    await a.claimCooldown('queue.pause', 10_000);
    await a.putTicket({ userId: 'u1', issuedAt: Date.now() }, 10_000);
    const keys = [...mockShared._store.keys()];
    expect(keys.length).toBeGreaterThan(0);
    // Redis here is `noeviction` and holds the queue. A key that collided with
    // a BullMQ one would not be a cache miss, it would be a lost job.
    // The literal, deliberately. Asserting `${a.NS}:` would move with the
    // constant, so emptying NS would pass its own test.
    expect(a.NS).toBe('cc');
    for (const k of keys) expect(k.startsWith('cc:')).toBe(true);
  });
});

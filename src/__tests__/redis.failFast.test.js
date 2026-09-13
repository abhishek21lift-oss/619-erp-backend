'use strict';
// A Redis outage must not take the API with it.
//
// ── The hang ───────────────────────────────────────────────────────────────
//
// The shared client is configured for BullMQ, correctly: `maxRetriesPerRequest:
// null`, because a blocking command must never be capped, and ioredis's
// `enableOfflineQueue` left at its default `true`, so a command issued during a
// blip is held and sent on reconnect rather than lost.
//
// For a queue that is right. On a request path the two together are a trap: a
// command issued while Redis is unreachable is QUEUED rather than rejected,
// and with retries uncapped it is never abandoned. It does not fail. It waits.
//
// Measured with Redis stopped and REDIS_URL still set: EVERY rate-limited
// route hung indefinitely — not slow, not a 500, no response at all. The
// limiter's store is paired with `passOnStoreError: true` precisely so a Redis
// fault lets the request through, and that fallback could never fire because
// there was never an error to pass on.
//
// The shape of the failure was the worst available: /api/health answered, being
// unlimited, while every other route was gone. A health check reporting a
// healthy process in front of an unreachable API.
//
// After the fix, with Redis down: login succeeded and the Command Center
// answered in 11-29ms.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('there is a client that refuses to queue', () => {
  const src = code('lib/redis.js');

  it('disables the offline queue on it', () => {
    // The single line that turns an indefinite hang into an error the caller
    // was already written to handle.
    expect(src).toMatch(/enableOfflineQueue:\s*false/);
  });

  it('caps retries and bounds each command', () => {
    expect(src).toMatch(/maxRetriesPerRequest:\s*1/);
    expect(src).toMatch(/commandTimeout:/);
  });

  it('leaves the SHARED client alone, because BullMQ needs it that way', () => {
    // A blocking command must never be capped. Changing the shared client to
    // fix the request path would break the queues instead.
    expect(src).toMatch(/maxRetriesPerRequest:\s*null/);
  });

  it('handles its own error events so an outage cannot kill the process', () => {
    // ioredis emits 'error'; without a listener that is an unhandled event and
    // Node exits — turning a Redis blip into a crash loop.
    expect(src).toMatch(/failFastClient\.on\('error'/);
  });

  it('closes it on shutdown', () => {
    expect(src).toMatch(/if \(failFastClient\)/);
  });
});

describe('every request-path consumer uses it', () => {
  it('the rate limiter does', () => {
    const src = code('lib/rateLimitStore.js');
    expect(src).toMatch(/getFailFastClient\(\)/);
    // The bug, asserted as an absence: the shared connection on this path is
    // what hung every limited route.
    expect(src).not.toMatch(/redis\.getConnection\(\)/);
  });

  it('the Command Center coordination primitives do', () => {
    // Cooldowns, stream tickets and alert streaks are all on a request path
    // and all written to fall back when Redis errors — which requires an error.
    const src = code('modules/command-center/coordination.js');
    expect(src).toMatch(/getFailFastClient\(\)/);
    expect(src).not.toMatch(/redis\.getClient\(\)/);
  });

  it('BullMQ still gets the shared connection', () => {
    // Cannot pass by moving everything onto the fail-fast client: queues need
    // the offline queue and uncapped retries.
    const src = code('jobs/queue.js');
    expect(src).toMatch(/getConnection\(\)/);
    expect(src).not.toMatch(/getFailFastClient/);
  });
});

describe('the fail-fast client rejects rather than waiting', () => {
  it('errors immediately on a command issued while disconnected', async () => {
    jest.resetModules();
    process.env.REDIS_URL = 'redis://127.0.0.1:6399';
    process.env.REDIS_COMMAND_TIMEOUT_MS = '300';
    const redis = require('../lib/redis');
    const client = redis.getFailFastClient();

    // Nothing is listening on 6399 in a unit run. The assertion is that this
    // REJECTS — the old behaviour was to sit in the offline queue forever, so
    // a test like this would time out rather than fail.
    const started = Date.now();
    await expect(client.get('cc:probe')).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(3000);

    client.disconnect();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_COMMAND_TIMEOUT_MS;
  }, 10_000);
});

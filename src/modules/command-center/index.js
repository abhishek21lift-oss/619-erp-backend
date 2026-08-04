// src/modules/command-center/index.js
//
// Registers the Phase 1 collectors and re-exports the pieces the routes use.
//
// Registration happens here, once, rather than inside each collector file, so
// that requiring a collector in a test does not mutate global state — the
// registry throws on a duplicate name, and a self-registering module makes that
// unavoidable the moment two test files import it.
//
// The TTLs are the interesting part. Everything is sampled on a 1s tick for the
// WebSocket, but not everything should be PROBED every second:
//
//   runtime   0ms  — reading process counters is free, and the event-loop
//                    histogram is reset on read, so caching it would silently
//                    widen the window each sample covers.
//   redis     1s   — one PING plus four INFO calls; cheap, but not free against
//                    a 256mb box also carrying the queue.
//   queues    2s   — six BullMQ count calls per collect, each its own round
//                    trip. At 1s this would be the dominant Redis load.
//   database  5s   — pg_stat_activity and pg_stat_statements scan server-wide
//                    state. Polling those every second adds real load to the
//                    thing we are trying to keep healthy.
'use strict';

const registry = require('./registry');
const snapshot = require('./snapshot.service');

const runtime = require('./collectors/runtime.collector');
const redisCollector = require('./collectors/redis.collector');
const queueCollector = require('./collectors/queue.collector');
const databaseCollector = require('./collectors/database.collector');

let registered = false;

/** Idempotent: server.js and the tests may both call this. */
function registerCollectors() {
  if (registered) return;
  registry.register(runtime.NAME, runtime.collect, { timeoutMs: 1000, ttlMs: 0 });
  registry.register(redisCollector.NAME, redisCollector.collect, { timeoutMs: 3000, ttlMs: 1000 });
  registry.register(queueCollector.NAME, queueCollector.collect, { timeoutMs: 5000, ttlMs: 2000 });
  registry.register(databaseCollector.NAME, databaseCollector.collect, { timeoutMs: 5000, ttlMs: 5000 });
  registered = true;
}

function reset() {
  registry.clear();
  snapshot.invalidate();
  registered = false;
}

module.exports = { registerCollectors, reset, registry, snapshot };

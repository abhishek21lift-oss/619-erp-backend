// src/modules/command-center/snapshot.service.js
//
// Collects every registered card in parallel and caches per-collector.
//
// Two properties the rest of the Command Center depends on:
//
//   1. One snapshot call never takes longer than the slowest collector's own
//      timeout. Collectors run concurrently and each carries its own deadline,
//      so a wedged Docker socket costs 3 seconds once, not 3 seconds per card
//      and not the whole request.
//
//   2. It cannot throw. The WebSocket tick and the HTTP endpoint both call
//      this on a timer; a rejection there would kill the stream for every
//      connected operator, at exactly the moment the console matters.
'use strict';

const registry = require('./registry');

/** name -> { at: epochMs, value: result } */
const cache = new Map();

function cached(name, ttlMs) {
  if (!ttlMs) return null;
  const hit = cache.get(name);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age > ttlMs) return null;
  // Marked so the client can tell a fresh probe from a served-from-cache one —
  // an operator watching a latency number needs to know it is 4 seconds old.
  // `age_ms` rather than the bare boolean, because "cached" alone does not
  // distinguish a 200ms-old reading from one that is 29 seconds stale, and the
  // smtp card's TTL is 30 seconds.
  return { ...hit.value, cached: true, age_ms: age };
}

/**
 * How many probes may be outstanding at once.
 *
 * Every collector is already individually cheap; the cost that matters is nine
 * of them arriving together. A fresh sweep opens a pg_stat_statements scan, six
 * BullMQ round trips, five Redis INFO calls and an AI-usage aggregate in the
 * same instant, all pointed at the two dependencies the console exists to
 * protect — and it does that hardest during an incident, when an operator is
 * hammering Refresh on a box that is already struggling.
 *
 * Four is chosen to be smaller than the number of collectors (so the bound is
 * real) and large enough that one slow probe cannot serialise the sweep behind
 * it: the whole collect is still bounded by the slowest collector's own
 * timeout plus at most one queueing round, not by their sum.
 */
const MAX_CONCURRENT_PROBES = Number(process.env.CC_MAX_CONCURRENT_PROBES) || 4;

/**
 * Map with a ceiling on how many run at once. Order of results is preserved.
 *
 * Written here rather than pulled in: this is the only place in the repo that
 * needs it, and a dependency for eleven lines is not a trade worth making on a
 * module that has to keep working when everything else is on fire.
 */
async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

/**
 * Collect the named cards (default: all registered).
 *
 * Concurrent callers do NOT each pay for a sweep: registry.runCollector
 * coalesces per collector, so eight operators refreshing at once share one
 * probe per card. That is deliberately finer-grained than locking the whole
 * snapshot — it also coalesces a `cards=redis` request against a full sweep,
 * and the alert tick against the WebSocket tick, which a snapshot-level lock
 * could not.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.only]   subset of card names
 * @param {boolean}  [opts.fresh]  bypass the TTL cache (the manual Refresh button)
 */
async function collect(opts = {}) {
  const wanted = opts.only?.length ? opts.only : registry.names();
  const started = Date.now();

  const cards = await mapBounded(wanted, MAX_CONCURRENT_PROBES, async (name) => {
    const entry = registry.get(name);
    // Asking for a card that does not exist is a client bug, not a server
    // error: report it as one unavailable card rather than failing the batch.
    if (!entry) return registry.unavailable(name, 'No such collector');

    if (!opts.fresh) {
      const hit = cached(name, entry.ttlMs);
      if (hit) return hit;
    }

    const value = await registry.runCollector(entry);
    if (entry.ttlMs) cache.set(name, { at: Date.now(), value });
    return value;
  });

  const byName = {};
  for (const c of cards) byName[c.name] = c;

  return {
    status: registry.rollup(cards.map((c) => c.status)),
    collected_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    cards: byName,
  };
}

/** Drop cached values so the next collect re-probes. */
function invalidate(name) {
  if (name) cache.delete(name); else cache.clear();
}

module.exports = { collect, invalidate, MAX_CONCURRENT_PROBES, _mapBounded: mapBounded };

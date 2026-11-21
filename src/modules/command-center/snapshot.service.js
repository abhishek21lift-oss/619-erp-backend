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
const contract = require('./telemetry-contract');
const { releaseInfo } = require('../../lib/release');

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
      // Stamped here rather than inside the collector: a collector should not
      // have to know, or be able to misreport, whose state it describes.
      if (hit) return { ...hit, scope: entry.scope };
    }

    const value = await registry.runCollector(entry);
    if (entry.ttlMs) cache.set(name, { at: Date.now(), value });
    return { ...value, scope: entry.scope };
  });

  const byName = {};
  for (const c of cards) byName[c.name] = c;

  return {
    status: registry.rollup(cards),
    // Which build answered. Not a card and not a probe: it is the same for
    // every reading below, and "is the fix deployed?" is asked before any of
    // them. release.js already bakes the sha in at build time.
    release: releaseInfo(),
    // ── How much of the platform was actually measured ────────────────────
    //
    // The single most important field on this payload, and the one that was
    // missing. A status line on its own cannot distinguish "I checked eight
    // things and they are fine" from "I checked two things and they are fine",
    // and those are wildly different claims to put a green dot on.
    observability: observabilityOf(cards),
    // Graded companion to `status`: same evidence, finer resolution. Null when
    // no card could be measured. See healthScore() for the weights.
    health: healthScore(cards),
    degraded_reasons: degradedReasons(cards),
    // ── A card that grades itself healthy but has lost fields ─────────────
    //
    // Present only when something is wrong, so the normal payload is
    // unchanged. A collector whose payload has drifted away from what the
    // console renders is the quietest failure in this system: the card stays
    // green, the numbers render as em-dashes, and an em-dash is
    // indistinguishable from a metric that is legitimately absent. Surfaced
    // here so it reaches an operator rather than only a CI run.
    ...(contractViolations(cards).length
      ? { contract_violations: contractViolations(cards) }
      : {}),
    collected_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    cards: byName,
  };
}

/** Cards claiming a reading whose payload has lost a field the console renders. */
function contractViolations(cards) {
  return cards.flatMap((c) => contract.violations(c));
}

/** How much of the platform this snapshot actually saw. */
function observabilityOf(cards) {
  const unexpected = cards.filter(
    (c) => c.status === registry.STATUS.UNAVAILABLE && !c.expected,
  );
  const expected = cards.filter(
    (c) => c.status === registry.STATUS.UNAVAILABLE && c.expected,
  );
  const timedOut = cards.filter((c) => c.status === registry.STATUS.TIMEOUT);
  const stale = cards.filter((c) => c.cached === true);

  const probed = cards.length - unexpected.length - expected.length - timedOut.length;
  return {
    total: cards.length,
    /** Cards backed by a probe that actually answered this pass or is cached. */
    probed,
    /** Probes that could not run and SHOULD have: we are blind here. */
    unavailable: unexpected.length,
    /** Capabilities this deployment has deliberately not wired up. */
    not_configured: expected.length,
    timed_out: timedOut.length,
    /** Served from the TTL cache rather than freshly probed. */
    stale: stale.length,
    /**
     * The honest headline. 1.0 means every card was measured; anything less
     * means the status above is a statement about part of the platform.
     * `not_configured` is excluded from the denominator — a capability that
     * does not exist here is not something we failed to see.
     */
    coverage: cards.length - expected.length === 0
      ? 1
      : Math.round((probed / (cards.length - expected.length)) * 100) / 100,
  };
}

/** Why the rollup is not green, in words, before anyone opens a card. */
function degradedReasons(cards) {
  const out = [];
  for (const c of cards) {
    if (c.status === registry.STATUS.HEALTHY) continue;
    if (c.status === registry.STATUS.UNAVAILABLE && c.expected) continue;
    out.push({
      card: c.name,
      status: c.status,
      scope: c.scope ?? registry.SCOPE.PLATFORM,
      reason: c.reason ?? null,
    });
  }
  return out;
}

// ── Graded health ───────────────────────────────────────────────────────────
//
// The rollup answers "is anything wrong" with one of six words. A score
// answers a different question — "how much of the platform is healthy, and how
// much of it am I blind to" — and the difference matters when two snapshots
// both say WARNING but one has one slow probe and the other has four.
//
// The points are deliberately coarse and fixed rather than a tuned curve:
// anybody reading the grade can reproduce it in their head from the component
// counts, which is the property that makes a score trustworthy in an incident.
//
// UNAVAILABLE is not zero: the probe could not run, so the platform may be
// perfectly fine. It scores low because blindness is a real operational risk,
// but it stays above CRITICAL, which is evidence of an actual failure.
const HEALTH_POINTS = {
  healthy: 100,
  warning: 70,
  degraded: 55,
  unavailable: 25,
  timeout: 10,
  critical: 0,
};

/**
 * A 0–100 score over the cards that were actually measured.
 *
 * Two rules keep it honest:
 *
 *   1. A capability this deployment deliberately did not configure is excluded
 *      entirely — it is neither health nor a blind spot.
 *   2. PROCESS-scope cards count half. They describe the one API replica that
 *      answered, not the platform, and a green runtime card must not outvote a
 *      red database card.
 *
 * The score is null, never 0, when nothing was measurable: "I saw nothing" and
 * "everything is down" are opposite claims.
 */
function healthScore(cards) {
  const considered = cards.filter(
    (c) => !(c.status === registry.STATUS.UNAVAILABLE && c.expected),
  );
  const components = {
    healthy: 0, warning: 0, degraded: 0, timeout: 0, critical: 0, unavailable: 0,
  };
  let weighted = 0;
  let weight = 0;
  let processWeighted = false;

  for (const c of considered) {
    if (c.status in components) components[c.status] += 1;
    const w = c.scope === registry.SCOPE.PROCESS ? 0.5 : 1;
    if (w !== 1) processWeighted = true;
    weighted += (HEALTH_POINTS[c.status] ?? 0) * w;
    weight += w;
  }

  const measured = considered.length;
  const score = weight > 0 ? Math.round(weighted / weight) : null;
  const worst = considered.reduce((acc, c) => {
    const i = registry.SEVERITY_ORDER.indexOf(c.status);
    return i > registry.SEVERITY_ORDER.indexOf(acc) ? c.status : acc;
  }, registry.STATUS.HEALTHY);

  return {
    score,
    grade: score == null ? 'unknown'
      : score >= 90 ? 'A'
      : score >= 75 ? 'B'
      : score >= 60 ? 'C'
      : score >= 40 ? 'D'
      : 'F',
    worst,
    measured,
    not_configured: cards.length - measured,
    process_weighted: processWeighted,
    components,
  };
}

/** Drop cached values so the next collect re-probes. */
function invalidate(name) {
  if (name) cache.delete(name); else cache.clear();
}

module.exports = {
  collect, invalidate, MAX_CONCURRENT_PROBES,
  observabilityOf, degradedReasons, contractViolations, healthScore, _mapBounded: mapBounded,
};

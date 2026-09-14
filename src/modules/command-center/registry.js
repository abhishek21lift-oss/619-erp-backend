// src/modules/command-center/registry.js
//
// The collector contract, the timeout/severity harness, and the registry every
// other part of the Command Center reads.
//
// Why a registry rather than a service that calls nine things by hand: the
// Command Center has to answer "what is the state of everything" on a timer,
// over a WebSocket, per-card. That means every source needs the same shape
// (so the UI can render an unknown card), the same failure mode (so one dead
// dependency degrades one card), and its own cache TTL (so a 400ms Docker call
// is not made every second just because memory is sampled every second).
//
// The failure mode is the important part and it is copied deliberately from
// lib/queueHealth.js, which already got this right: a probe against something
// unreachable must resolve to an unhealthy VALUE, never reject. A health
// endpoint that 500s because one check timed out is a health endpoint that
// tells you nothing at the exact moment you need it.
'use strict';

const logger = require('../../lib/logger');

/**
 * The card states. One vocabulary, used by the collectors, the rollup, the
 * alert engine and the UI — there is no second scale anywhere.
 *
 * ── Why DEGRADED exists ────────────────────────────────────────────────────
 *
 * Without it, a dependency that is WORKING BUT REDUCED has nowhere honest to
 * sit. Redis down means the queues do not stop — jobs run inline, in the
 * request, synchronously. That is not healthy (latency and failure modes both
 * change), it is not a warning about a threshold, and it is certainly not
 * "unavailable", because work is still being done. Collapsing it into any of
 * those three either overstates the problem or hides it.
 */
const STATUS = {
  HEALTHY: 'healthy',
  /** Working, in a reduced mode that an operator needs to know about. */
  DEGRADED: 'degraded',
  WARNING: 'warning',
  /** The probe ran and did not answer in time. */
  TIMEOUT: 'timeout',
  CRITICAL: 'critical',
  /** The probe could not run at all: no socket mounted, no key configured. */
  UNAVAILABLE: 'unavailable',
};

/**
 * Whose state does a card describe?
 *
 * This is not decoration. `runtime` reports the event-loop lag and heap of ONE
 * Node process; `http` reports the request-timing ring of ONE process. On a
 * deployment with two API replicas, a green runtime card means "the container
 * that happened to serve this request is fine", which is a materially weaker
 * claim than the one the same green dot makes on the database card beside it.
 *
 * An operator reading a wall of identical tiles has no way to know which is
 * which, so the card carries it and the UI can say so.
 *
 * PLATFORM is the default deliberately: a collector that does not declare a
 * scope is treated as describing the platform, and the mistake that direction
 * — a process-local card mislabelled platform-wide — is the one that
 * overstates. It is caught by the test that pins the real build's split rather
 * than by hoping each author remembers.
 */
const SCOPE = {
  /** True of the whole platform: the database, Redis, the queues, the tenants. */
  PLATFORM: 'platform',
  /** True only of the API process that answered this request. */
  PROCESS: 'process',
};

/**
 * Severity, worst last.
 *
 * UNAVAILABLE sits between HEALTHY and DEGRADED rather than at the top, and
 * that placement is the one judgement call in this file.
 *
 * A Docker socket that was never mounted is a gap in OBSERVABILITY, not an
 * outage. Ranking it above WARNING would paint the console red every second on
 * a box where a capability is simply not wired up, and an operator who sees
 * red when nothing is wrong stops seeing red at all. But ranking it below
 * HEALTHY — which is what "leave it out of the rollup" amounts to — is the
 * opposite failure: a snapshot where six of eight probes could not run would
 * report the two that did and call the platform healthy.
 *
 * So it degrades rather than alarms. The top line reads DEGRADED, the
 * `observability` block says exactly how much of the platform was actually
 * measured, and nothing claims health it did not verify.
 */
const SEVERITY_ORDER = [
  STATUS.HEALTHY,
  STATUS.UNAVAILABLE,
  STATUS.DEGRADED,
  STATUS.WARNING,
  STATUS.TIMEOUT,
  STATUS.CRITICAL,
];

/**
 * Roll many card statuses into one.
 *
 * An UNAVAILABLE card lifts the rollup to DEGRADED rather than reporting
 * UNAVAILABLE outright: "the platform is unavailable" is a much stronger claim
 * than "one probe could not run", and it is not the one the evidence supports.
 *
 * @param {Array<string|{status: string, expected?: boolean}>} cards
 *   Statuses, or whole cards. Whole cards let an EXPECTED unavailability — a
 *   capability this deployment has deliberately not wired up — be told from an
 *   unexpected one. See `unavailable()`.
 */
function rollup(cards) {
  let worst = STATUS.HEALTHY;
  for (const c of cards) {
    const status = typeof c === 'string' ? c : c?.status;
    // An expected absence is not a gap in observability: nobody is waiting for
    // a Redis card on a box with no REDIS_URL. It is still SHOWN, and still
    // counted in `observability`, but it does not degrade the rollup — or a
    // deployment that has deliberately not wired something up would read amber
    // forever, which is how a status light stops meaning anything.
    if (status === STATUS.UNAVAILABLE && typeof c === 'object' && c?.expected) continue;
    const rank = SEVERITY_ORDER.indexOf(status);
    if (rank > SEVERITY_ORDER.indexOf(worst)) worst = status;
  }
  // UNAVAILABLE never survives as a rollup: it describes one probe, not the
  // platform. Whatever made it unavailable leaves us partially blind, which is
  // exactly what DEGRADED means.
  return worst === STATUS.UNAVAILABLE ? STATUS.DEGRADED : worst;
}

/**
 * A collector result. Every collector returns this shape, including on failure,
 * so the client never has to special-case a missing card.
 */
function result(name, { status, data = null, latency_ms = null, reason = null }) {
  return {
    name,
    status,
    data,
    latency_ms,
    // Why a card is not green, in words an operator can act on. Null when healthy.
    reason,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Marks a source that cannot be probed here — not an outage.
 *
 * @param {boolean} [expected=false] TRUE when this deployment has deliberately
 *   not wired the capability up (no REDIS_URL, no Docker socket). An expected
 *   absence is reported and counted but does not degrade the platform rollup;
 *   an unexpected one does, because then we are blind to something we should
 *   have been able to see.
 */
function unavailable(name, reason, expected = false) {
  return { ...result(name, { status: STATUS.UNAVAILABLE, reason }), expected: Boolean(expected) };
}

/** Working, in a reduced mode. `detail` names the mode, for the UI to render. */
function degraded(name, reason, data = null) {
  return result(name, { status: STATUS.DEGRADED, reason, data });
}

// ── In-flight probes ────────────────────────────────────────────────────────
//
// name -> { promise, startedAt, controller }  for a probe that has not settled.
//
// This is the mechanism behind two of the properties the console needs, and it
// is worth being explicit that it is ONE mechanism and not two.
//
//   COALESCING. Eight operators pressing Refresh, the alert tick, and
//   `health.check` all want a fresh read at the same second. Without this they
//   get nine concurrent sweeps: nine pg_stat_statements scans, nine sets of six
//   BullMQ round trips, against the database and the 256mb Redis the console
//   exists to protect. With it, whoever asks first starts the probe and
//   everybody else awaits that same promise. A `fresh` caller joins an
//   already-running probe deliberately — a probe that started 40ms ago IS
//   fresh, and starting a second one to prove it defeats the point.
//
//   NO RUNAWAY WORK. A probe that blows its deadline is abandoned by its
//   caller, but the underlying query does not stop existing. Without this map,
//   the next tick one second later starts ANOTHER one on top of it, and a
//   database that has gone slow accumulates a probe per second until it falls
//   over — the observability tool finishing off the thing it was watching.
//   Here a slow collector has exactly one probe outstanding, ever.
const inflight = new Map();

/**
 * Run one collector with its own deadline, coalescing concurrent callers.
 *
 * Never rejects. A collector that throws becomes a CRITICAL card carrying the
 * message; one that hangs becomes TIMEOUT. Both are renderable.
 *
 * ── Cancellation is real where it can be, and honest where it cannot ────────
 *
 * Each probe gets an AbortController whose signal is handed to the collector
 * and aborted on the deadline. A collector doing HTTP or holding a socket can
 * honour it and stop. `pool.query` cannot be cancelled from the client side, so
 * for the database collector the signal is advisory and the real bound is the
 * in-flight map above: the work is abandoned, but it is never multiplied.
 * Saying that plainly matters more than pretending every probe is killable.
 *
 * The timer is unref'd so a pending probe cannot hold the process open — the
 * same trick lib/queueHealth.js uses, and the reason its probes do not wedge
 * the test suite.
 */
function runCollector(entry) {
  const { name } = entry;

  const existing = inflight.get(name);
  // The already-settled TIMEOUT card, handed back immediately. A caller who
  // arrives while a hung probe is outstanding gets the honest answer at once
  // and does NOT open a second query against whatever is hanging.
  if (existing) return existing.outcome;

  const { outcome, work } = startCollector(entry);
  inflight.set(name, { outcome, work, startedAt: Date.now() });

  // ── Cleared when the WORK settles, not when the RACE does ─────────────────
  //
  // These are different moments and the difference is the entire mechanism. A
  // probe that blows its deadline resolves `outcome` after `timeoutMs` while
  // the query behind it is still open. Releasing the slot then would let the
  // next tick start another one a second later — the exact pile-up this map
  // exists to prevent. The slot is held until the underlying work actually
  // finishes, however long that takes, and only then may the card be re-probed.
  //
  // This also happens to be what keeps an abandoned probe from becoming an
  // unhandled rejection: the query that finally fails two minutes after the
  // card already said TIMEOUT settles a promise nobody is awaiting. Both
  // Promise.race inside startCollector and this `clear` attach a rejection
  // handler to it, so a late failure is consumed rather than reaching
  // process.on('unhandledRejection') — which on this process logs
  // `{"reason":{}}` and tells an operator nothing.
  const clear = () => { if (inflight.get(name)?.work === work) inflight.delete(name); };
  work.then(clear, clear);

  return outcome;
}

/**
 * @returns {{ outcome: Promise<object>, work: Promise<object> }}
 *   `outcome` settles at the deadline or when the collector answers, whichever
 *   is first; `work` settles only when the collector itself is done.
 */
function startCollector(entry) {
  const { name, collect, timeoutMs } = entry;
  const started = Date.now();
  const controller = new AbortController();

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        // Abort BEFORE resolving, so a collector that honours the signal is
        // already unwinding by the time the caller is handed a TIMEOUT card.
        try { controller.abort(new Error(`Probe exceeded ${timeoutMs}ms`)); } catch { /* older runtimes */ }
        resolve(result(name, {
          status: STATUS.TIMEOUT,
          latency_ms: Date.now() - started,
          reason: `Probe exceeded ${timeoutMs}ms`,
        }));
      },
      timeoutMs,
    );
    if (typeof timer.unref === 'function') timer.unref();
  });

  const work = (async () => {
    try {
      const value = await collect({ signal: controller.signal });
      // A collector may return a finished result (to set its own status and
      // reason) or just its data, in which case it is healthy by default.
      const out = value && typeof value === 'object' && 'status' in value
        ? { ...value, name }
        : result(name, { status: STATUS.HEALTHY, data: value });
      return { ...out, latency_ms: Date.now() - started, checked_at: new Date().toISOString() };
    } catch (err) {
      logger.warn({ err: err.message, collector: name }, 'command-center collector failed');
      return result(name, {
        status: STATUS.CRITICAL,
        latency_ms: Date.now() - started,
        reason: err.message,
      });
    }
  })();

  const outcome = Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  return { outcome, work };
}

/** How many probes are outstanding right now. Diagnostics and tests. */
function inflightCount() { return inflight.size; }

// ── Registry ────────────────────────────────────────────────────────────────

const registry = new Map();

/**
 * @param {string} name        card id, stable — the client diffs on it
 * @param {Function} collect   async () => data | result
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=3000]
 * @param {number} [opts.ttlMs=0]  serve a cached value for this long. Sampling
 *   memory every second is free; asking Docker to list containers every second
 *   is not, and neither is a Postgres stats query.
 * @param {'platform'|'process'} [opts.scope='platform'] whose state this
 *   describes. See SCOPE above.
 */
function register(name, collect, opts = {}) {
  if (registry.has(name)) throw new Error(`Collector already registered: ${name}`);
  if (typeof collect !== 'function') throw new Error(`Collector ${name} must be a function`);
  if (opts.scope && !Object.values(SCOPE).includes(opts.scope)) {
    throw new Error(`Collector ${name} has an unknown scope: ${opts.scope}`);
  }
  registry.set(name, {
    name,
    collect,
    timeoutMs: opts.timeoutMs ?? 3000,
    ttlMs: opts.ttlMs ?? 0,
    scope: opts.scope ?? SCOPE.PLATFORM,
  });
}

function get(name) { return registry.get(name) || null; }
function names() { return [...registry.keys()]; }
function clear() { registry.clear(); inflight.clear(); }

module.exports = {
  STATUS, SCOPE, SEVERITY_ORDER, rollup,
  result, unavailable, degraded, runCollector,
  register, get, names, clear,
  inflightCount,
};

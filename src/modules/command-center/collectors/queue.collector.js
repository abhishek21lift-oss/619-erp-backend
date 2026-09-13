// src/modules/command-center/collectors/queue.collector.js
//
// BullMQ state, delegated entirely to lib/queueHealth.js.
//
// This file adds no Redis client and no Queue instance of its own — it calls
// collectQueueStats(), which already opens each queue through jobs/queue.js's
// registry and races every probe against a 2s timeout. Duplicating that here
// would mean a second set of BullMQ clients against a 256mb noeviction Redis,
// which is the specific thing §18 warns about.
//
// What this file DOES add is judgement. queueHealth reports counts; an operator
// needs to know which counts are a problem. The two that matter:
//
//   * waiting climbing while active stays flat  → workers are not draining.
//     This is the brief's "Redis latency increased because the worker queue is
//     growing" scenario, and it is the input the Guardian correlates on.
//   * failed climbing at all → jobs are being lost. For membership-renewals
//     that is a card charged with no membership row written, so it is graded
//     harder than the other queues.
'use strict';

const { STATUS, result, unavailable, degraded } = require('../registry');
const redis = require('../../../lib/redis');
const { QUEUE_NAMES } = require('../../../jobs/queue');

const NAME = 'queues';

const WAITING_WARN = Number(process.env.CC_QUEUE_WAITING_WARN) || 50;
const WAITING_CRIT = Number(process.env.CC_QUEUE_WAITING_CRIT) || 250;
const FAILED_WARN = Number(process.env.CC_QUEUE_FAILED_WARN) || 1;
const FAILED_CRIT = Number(process.env.CC_QUEUE_FAILED_CRIT) || 25;

/** Losing one of these silently costs money or trust, so grade them harder. */
const CRITICAL_QUEUES = new Set(['membership-renewals']);

async function collect() {
  const degradation = require('../redis-degradation');

  // ── Three Redis states, three different cards ────────────────────────────
  //
  // These used to be one: `!isConfigured()` returned UNAVAILABLE and anything
  // else fell through to a probe that would hang or throw. That collapsed the
  // two cases an operator most needs told apart.
  //
  //   not configured  a deployment choice. EXPECTED, so it does not degrade
  //                   the platform rollup — but it is still shown, with what
  //                   it costs, because "no Redis" means renewals never run.
  //   configured but  the real incident. The queues are not merely unreadable;
  //   unreachable     each one has a DEFINED fallback and they are not the
  //                   same fallback. DEGRADED, naming the mode per queue.
  //   up              probe normally.
  if (!redis.isConfigured()) {
    const d = degradation.describe('not_configured');
    return {
      ...unavailable(NAME, d.headline, true),
      data: { degradation: d },
    };
  }

  if (!redis.isReady()) {
    // Not CRITICAL: work is still happening for three of the five queues, and
    // calling that an outage overstates it. Not UNAVAILABLE either: we know
    // exactly what is going on, which is the opposite of unobservable.
    const d = degradation.describe('down');
    return degraded(NAME, d.headline, { degradation: d });
  }

  const { collectQueueStats, summarize } = require('../../../lib/queueHealth');
  const stats = await collectQueueStats();
  const summary = summarize(stats);

  const queues = [];
  const problems = [];

  // ── collectQueueStats returns an ARRAY ────────────────────────────────────
  //
  // It maps over QUEUE_NAMES and filters, so each element carries its own
  // `.name`; there is no key to read. This used to be `Object.entries(stats)`,
  // which on an array yields ["0", obj], ["1", obj] … — so every queue was
  // named after its index.
  //
  // That was not cosmetic. Three things broke silently:
  //
  //   * The card listed queues called 0,1,2,3,4,5 and the problem strings read
  //     `0: 12 jobs waiting`, naming nothing an operator could act on.
  //   * CRITICAL_QUEUES.has(name) became has("0"), which is never true — so
  //     membership-renewals has never once been graded harder than any other
  //     queue, and the "one failed renewal is critical" rule had never fired.
  //   * recovery.run looks its queue up by name and never found it, so its
  //     verification had nothing to read.
  //
  // Found by driving the real endpoint against a real Redis; the unit tests
  // could not see it because their double passed an object keyed by name,
  // which is the shape the collector WANTED rather than the one it gets.
  for (const s of Array.isArray(stats) ? stats : Object.values(stats || {})) {
    // queueHealth returns null for a queue it could not reach.
    if (!s) continue;
    const name = s.name;
    if (!name) continue;

    const waiting = s.waiting ?? 0;
    const failed = s.failed ?? 0;
    const active = s.active ?? 0;
    const isCritical = CRITICAL_QUEUES.has(name);

    queues.push({
      name,
      reachable: true,
      waiting,
      active,
      delayed: s.delayed ?? 0,
      completed: s.completed ?? 0,
      failed,
      paused: Boolean(s.paused),
      // The signal the Guardian reads: work queued with nothing working it.
      starved: waiting > 0 && active === 0 && !s.paused,
    });

    if (waiting >= WAITING_CRIT) {
      problems.push({ severity: STATUS.CRITICAL, text: `${name}: ${waiting} jobs waiting` });
    } else if (waiting >= WAITING_WARN) {
      problems.push({ severity: STATUS.WARNING, text: `${name}: ${waiting} jobs waiting` });
    }

    // On a money queue a single failure is already worth a red card.
    const failCrit = isCritical ? 1 : FAILED_CRIT;
    if (failed >= failCrit) {
      problems.push({ severity: STATUS.CRITICAL, text: `${name}: ${failed} failed job(s)` });
    } else if (failed >= FAILED_WARN) {
      problems.push({ severity: STATUS.WARNING, text: `${name}: ${failed} failed job(s)` });
    }

    if (waiting > 0 && active === 0 && !s.paused) {
      problems.push({ severity: STATUS.WARNING, text: `${name}: ${waiting} waiting but nothing active — no worker draining` });
    }
    if (s.paused) {
      problems.push({ severity: STATUS.WARNING, text: `${name}: paused` });
    }
  }

  // ── A queue that vanished is not a queue that is fine ────────────────────
  //
  // collectQueueStats() does `.filter(Boolean)`, so a queue it could not reach
  // is ABSENT from the result rather than present-and-null. Left alone, that
  // is the quietest failure available: the card renders five healthy queues
  // instead of six and nothing anywhere says the sixth could not be read.
  //
  // The old code had a `if (!s)` branch for this, which could never fire —
  // the filter upstream had already removed them. Comparing against the
  // declared set is what actually detects it.
  const seen = new Set(queues.map((q) => q.name));
  for (const name of QUEUE_NAMES) {
    if (seen.has(name)) continue;
    queues.push({ name, reachable: false });
    problems.push({ severity: STATUS.CRITICAL, text: `Queue "${name}" unreachable` });
  }

  const worst = problems.some((p) => p.severity === STATUS.CRITICAL)
    ? STATUS.CRITICAL
    : problems.length ? STATUS.WARNING : STATUS.HEALTHY;

  return result(NAME, {
    status: worst,
    reason: problems.length ? problems.map((p) => p.text).join('; ') : null,
    data: {
      summary,
      queues,
      totals: queues.reduce((acc, q) => ({
        waiting: acc.waiting + (q.waiting || 0),
        active: acc.active + (q.active || 0),
        failed: acc.failed + (q.failed || 0),
      }), { waiting: 0, active: 0, failed: 0 }),
      problems,
    },
  });
}

module.exports = { NAME, collect, WAITING_WARN, WAITING_CRIT, FAILED_WARN, FAILED_CRIT, CRITICAL_QUEUES };

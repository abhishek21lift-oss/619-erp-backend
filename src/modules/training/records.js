// Personal records: deciding what counts as one, and what beat what.
//
// ── Why this is a module and not three booleans ────────────────────────────
//
// The old system set is_pr_weight / is_pr_reps / is_pr_volume on a set row at
// write time. Three questions, answered once, permanently — a set that WAS a
// PR still reads as one years after it was beaten, and a treadmill run could
// not be a record at all because cardio has no set row.
//
// Here a record is a candidate produced from a performance, compared against
// whatever the client's current record is, and either accepted or discarded.
// The comparison is the whole job, and it is not always "bigger wins": a 5 km
// time and a rowing pace are records when the number goes DOWN.
//
// Pure functions. The caller fetches current records and persists the winners;
// nothing here touches a database, so every rule below is testable directly.
'use strict';

const u = require('./units');

const RECORD_TYPES = [
  'MAX_WEIGHT', 'MAX_REPS', 'BEST_VOLUME', 'BEST_1RM_ESTIMATE',
  'BEST_DISTANCE', 'BEST_TIME', 'BEST_PACE', 'BEST_SPEED', 'MOST_CALORIES',
];

/**
 * Which direction is better.
 *
 * The two inverted ones are the reason this table exists rather than a
 * `>` scattered through the code: a faster 5 km is a SMALLER number, and a
 * PR engine that assumes bigger-is-better silently records the client's
 * worst run as their best.
 */
const LOWER_IS_BETTER = new Set(['BEST_TIME', 'BEST_PACE']);

function isImprovement(recordType, candidate, current) {
  const c = Number(candidate);
  if (!Number.isFinite(c)) return false;
  if (current == null) return true;              // no record yet — anything is one
  const existing = Number(current);
  if (!Number.isFinite(existing)) return true;
  return LOWER_IS_BETTER.has(recordType) ? c < existing : c > existing;
}

// ── Estimated 1RM ──────────────────────────────────────────────────────────

/**
 * Epley: 1RM = w × (1 + reps/30).
 *
 * Chosen over Brzycki because Brzycki's denominator (37 - reps) collapses
 * toward zero as reps approach 37 and returns nonsense above it — a 40-rep
 * bodyweight set would produce a negative one-rep max. Epley degrades
 * gracefully instead.
 *
 * Capped at 12 reps because every 1RM formula is fitted to low-rep sets and
 * an estimate from a set of 30 is not an estimate, it is a number. Returning
 * null there is more useful than a confident wrong answer.
 */
const ONE_RM_MAX_REPS = 12;

function estimateOneRepMax(weightKg, reps) {
  const w = Number(weightKg);
  const r = Number(reps);
  if (!Number.isFinite(w) || !Number.isFinite(r)) return null;
  if (w <= 0 || r <= 0 || r > ONE_RM_MAX_REPS) return null;
  if (r === 1) return w;
  return w * (1 + r / 30);
}

// ── Candidates from a strength performance ─────────────────────────────────

/**
 * @param {object[]} sets  set_performances rows for ONE exercise
 * @returns {object[]} candidate records — {record_type, value, unit, reps}
 *
 * Only completed sets count. A set left unticked is one the client did not
 * do, and awarding a PR for it would make the record system worth ignoring.
 */
function candidatesFromSets(sets) {
  const done = (sets || []).filter(
    (s) => s && s.completed && Number(s.actual_reps) > 0
  );
  if (!done.length) return [];

  const inKg = (s) => u.toKg(s.actual_weight, s.weight_unit || 'kg');
  const out = [];

  const weighted = done.filter((s) => Number(inKg(s)) > 0);

  if (weighted.length) {
    // Heaviest single set, with the reps that qualify it: 100kg × 1 and
    // 100kg × 5 are different records, which is why reps rides along.
    const heaviest = weighted.reduce((a, b) => (inKg(b) > inKg(a) ? b : a));
    out.push({
      record_type: 'MAX_WEIGHT',
      value: inKg(heaviest),
      unit: 'kg',
      reps: Number(heaviest.actual_reps),
      set_performance_id: heaviest.id ?? null,
    });

    const best1rm = weighted.reduce((best, s) => {
      const e = estimateOneRepMax(inKg(s), s.actual_reps);
      return e != null && (best == null || e > best.value) ? { value: e, set: s } : best;
    }, null);
    if (best1rm) {
      out.push({
        record_type: 'BEST_1RM_ESTIMATE',
        value: best1rm.value,
        unit: 'kg',
        reps: null,
        set_performance_id: best1rm.set.id ?? null,
      });
    }

    // Session volume for this exercise: the load × reps a trainer means by
    // "did more work than last time".
    const volume = weighted.reduce((sum, s) => sum + inKg(s) * Number(s.actual_reps), 0);
    if (volume > 0) {
      out.push({ record_type: 'BEST_VOLUME', value: volume, unit: 'kg', reps: null });
    }
  }

  // Most reps in a single set. Meaningful for bodyweight work, where there is
  // no weight to beat and rep count IS the record.
  const mostReps = done.reduce((a, b) =>
    (Number(b.actual_reps) > Number(a.actual_reps) ? b : a));
  out.push({
    record_type: 'MAX_REPS',
    value: Number(mostReps.actual_reps),
    unit: 'reps',
    reps: null,
    set_performance_id: mostReps.id ?? null,
  });

  return out;
}

// ── Candidates from a cardio performance ───────────────────────────────────

/**
 * @param {object} cardio  one cardio_performances row
 *
 * BEST_TIME is deliberately NOT "longest session". A time record means
 * covering a set distance faster, so it is only a candidate when a distance
 * was recorded — otherwise "best 5 km" and "sat on a bike for an hour" would
 * compete for the same record, and the hour would win.
 */
function candidatesFromCardio(cardio) {
  if (!cardio || !cardio.completed) return [];
  const out = [];
  const id = cardio.id ?? null;

  const metres = u.toMetres(cardio.distance, cardio.distance_unit);
  const secs = Number(cardio.duration_seconds);
  const hasDuration = Number.isFinite(secs) && secs > 0;

  if (metres != null && metres > 0) {
    out.push({ record_type: 'BEST_DISTANCE', value: metres, unit: 'm', reps: null, cardio_performance_id: id });

    if (hasDuration) {
      out.push({ record_type: 'BEST_TIME', value: secs, unit: 'seconds', reps: null, cardio_performance_id: id });

      const mps = u.averageSpeedMps(cardio.distance, cardio.distance_unit, secs);
      if (mps) {
        out.push({ record_type: 'BEST_SPEED', value: mps, unit: 'kmh', reps: null, cardio_performance_id: id });
        // Seconds per kilometre — one reference for every pace record, so two
        // runs are comparable without knowing which unit each was entered in.
        out.push({
          record_type: 'BEST_PACE',
          value: (secs / metres) * 1000,
          unit: 'seconds',
          reps: null,
          cardio_performance_id: id,
        });
      }
    }
  }

  const kcal = Number(cardio.calories_burned);
  if (Number.isFinite(kcal) && kcal > 0) {
    out.push({ record_type: 'MOST_CALORIES', value: kcal, unit: 'kcal', reps: null, cardio_performance_id: id });
  }

  return out;
}

/**
 * Keep only the candidates that beat what is on file.
 *
 * @param {object[]} candidates
 * @param {Map<string, number>} current  key from recordKey() → current value
 *
 * BEST_TIME and BEST_DISTANCE are both distance records in disguise, so a
 * BEST_TIME candidate is only comparable against a time set over the SAME
 * distance. That comparison needs a distance qualifier the caller supplies;
 * without one, a 1 km sprint would beat a 10 km run on time and be recorded
 * as a personal best.
 */
function recordKey(candidate) {
  return [
    candidate.record_type,
    candidate.reps == null ? '-' : String(candidate.reps),
    candidate.qualifier == null ? '-' : String(candidate.qualifier),
  ].join('|');
}

function selectImprovements(candidates, current) {
  const map = current instanceof Map ? current : new Map(Object.entries(current || {}));
  const wins = [];
  // Within one batch two candidates can share a key (two sets at the same
  // weight). Keep the better, so the caller never writes two live records
  // that the partial unique index would reject anyway.
  const bestInBatch = new Map();

  for (const c of candidates || []) {
    const key = recordKey(c);
    const held = bestInBatch.get(key);
    if (!held || isImprovement(c.record_type, c.value, held.value)) bestInBatch.set(key, c);
  }

  for (const [key, c] of bestInBatch) {
    if (isImprovement(c.record_type, c.value, map.get(key) ?? null)) wins.push(c);
  }
  return wins;
}

module.exports = {
  RECORD_TYPES, LOWER_IS_BETTER, ONE_RM_MAX_REPS,
  isImprovement, estimateOneRepMax,
  candidatesFromSets, candidatesFromCardio,
  recordKey, selectImprovements,
};

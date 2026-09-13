'use strict';
// Turning a generated programme into rows a trainer can open in the builder.
//
// ── Why this did not exist ─────────────────────────────────────────────────
//
// The AI workout generator has never been able to save a plan. Traced through
// the frontend, a generated programme reaches exactly three places and all
// three render it: the client card's preview, the generator page, and a few
// lines in the coach panel. The card says so in its own words — "Preview only,
// nothing has been saved". The one dialog that does create a plan creates an
// EMPTY one, deliberately, for the builder to fill by hand.
//
// That is why production shows 95 generations and 9 live plans: the nine were
// typed. Every generated programme this studio has ever paid for was read once
// and closed.
//
// ── The hard part, and why it is decided here ──────────────────────────────
//
// A plan names exercises as free text; workout_exercises.exercise_id is NOT
// NULL with a foreign key. So every exercise has to resolve to a library row
// or it cannot be stored at all — that is the schema's decision, not a policy
// this file chose.
//
// Resolution is by exact normalised name, the same folding plan-critic.js
// uses, and for the same measured reason: trigram similarity resolves
// "Overhead Press" to "Overhead Lat", which would file a shoulder-loading
// press under a lat exercise. Nothing fuzzier is attempted.
//
// What that costs is known. Of the 94 distinct exercise names trainers have
// logged in this studio, 82 match the library — so roughly one in eight will
// not resolve, and those are humans picking from a picker rather than a model
// writing prose. An unresolved exercise is therefore expected, not exceptional:
// it is reported by name and by day so the trainer can add it in the builder,
// and the save still happens for everything that did resolve.
//
// Pure functions, no database: the mapping is where this can be wrong, and it
// is testable directly.

const { planExercises, normaliseName } = require('./plan-critic');

/** 1 = Monday, matching workout_exercises.day_of_week and the builder's tabs. */
const DAYS = Object.freeze({
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
});

/** Plans run a week at a time; week 1 is the anchor progression.js derives from. */
const WEEK_ONE = 1;

/**
 * Reps when the prescription is not reps at all.
 *
 * The column is NOT NULL, and a cardio bout has no rep count. One — a single
 * bout — rather than the 12 the plan-create route defaults to, because 12 is a
 * number a trainer would read as a prescription and nobody wrote it.
 */
const SINGLE_BOUT = 1;

/** Prescription types that owe sets and reps; everything else owes `config`. */
const SETS_REPS = 'SETS_REPS';

/** Cardio and interval fields carried into `config` rather than invented columns. */
const CONFIG_FIELDS = Object.freeze([
  'duration_seconds', 'distance', 'distance_unit', 'speed', 'pace_seconds',
  'incline', 'calories', 'heart_rate', 'cadence', 'rounds',
  'work_interval_seconds', 'rest_interval_seconds',
]);

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The day number a schedule key means.
 *
 * The generator is asked for day NAMES and mostly gives them, but "Day 1" and
 * a bare "1" both appear in the wild and both mean something unambiguous.
 * Anything else returns null and the day is reported rather than filed under
 * Monday, which is what a default would do.
 */
function dayNumber(key) {
  const k = text(key).toLowerCase();
  if (DAYS[k]) return DAYS[k];
  const m = k.match(/^(?:day\s*)?([1-7])$/);
  return m ? Number(m[1]) : null;
}

/**
 * Reps as the column stores them, from the range a coach writes.
 *
 * "8-10" is two numbers and the column holds one. The LOWER bound is kept
 * because it is the number the client must reach for the set to count, and
 * the range as written goes into the notes so nothing is lost.
 */
function parseReps(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(1, Math.round(value)) : null;
  const t = text(value);
  if (!t) return null;
  const m = t.match(/\d+/);
  return m ? Math.max(1, Number(m[0])) : null;
}

/** The prescription a trainer should still be able to read after the mapping. */
function notesFor(ex) {
  const parts = [];
  const reps = text(ex.reps);
  // Only when the range says more than the stored integer does.
  if (reps && !/^\d+$/.test(reps)) parts.push(`Reps: ${reps}`);
  const type = text(ex.prescription_type).toUpperCase();
  if (type && type !== SETS_REPS) parts.push(`Prescription: ${type}`);
  if (text(ex.notes)) parts.push(text(ex.notes));
  return parts.length ? parts.join(' · ') : null;
}

/** Cardio/interval fields, or null when there are none. */
function configFor(ex) {
  const cfg = {};
  for (const f of CONFIG_FIELDS) {
    const v = f === 'distance_unit' ? text(ex[f]) : num(ex[f]);
    if (v !== null && v !== '') cfg[f] = v;
  }
  return Object.keys(cfg).length ? cfg : null;
}

/**
 * A generated plan, as plan fields plus exercise rows.
 *
 * @param {object} plan      the generator's JSON
 * @param {Map}    resolver  normalised exercise name → { id, name } from the
 *                           library, built by the caller through the library's
 *                           own tenancy predicate. Nothing here reads the
 *                           database, so nothing here can widen it.
 */
function materialise(plan, resolver = new Map()) {
  const rows = [];
  const unresolved = [];
  const unknownDays = new Set();

  // Sort order is per day, so slot 3 on Tuesday is Tuesday's third exercise —
  // the same meaning the builder and progression.js already give it.
  const nextSort = new Map();

  for (const ex of planExercises(plan)) {
    const day = dayNumber(ex.day);
    if (day === null) {
      // Filing an unreadable day under Monday would put a leg session in the
      // wrong place silently. Reported instead.
      unknownDays.add(ex.day);
      unresolved.push({ day: ex.day, position: ex.position, name: ex.name, reason: 'unrecognised day' });
      continue;
    }

    const hit = ex.name ? resolver.get(normaliseName(ex.name)) : null;
    if (!hit) {
      unresolved.push({
        day: ex.day,
        position: ex.position,
        name: ex.name || '(unnamed)',
        reason: ex.name ? 'not in the exercise library' : 'no name',
      });
      continue;
    }

    const isSetsReps = !text(ex.prescription_type) || text(ex.prescription_type).toUpperCase() === SETS_REPS;
    const sort = nextSort.get(day) ?? 0;
    nextSort.set(day, sort + 1);

    rows.push({
      exercise_id: hit.id,
      exercise_name: hit.name,
      day_of_week: day,
      week_number: WEEK_ONE,
      sort_order: sort,
      sets: num(ex.sets) ?? (isSetsReps ? null : SINGLE_BOUT),
      reps: isSetsReps ? parseReps(ex.reps) : SINGLE_BOUT,
      rest_seconds: num(ex.rest_seconds),
      tempo: text(ex.tempo) || null,
      // The generator writes "RIR 2" or "RPE 8"; the column holds a number.
      rpe: parseRpe(ex.rir_or_rpe),
      notes: notesFor(ex),
      config: configFor(ex),
    });
  }

  return {
    plan: {
      name: text(plan?.name) || 'AI programme',
      goal: text(plan?.goal) || null,
      difficulty: text(plan?.level) || null,
      duration_weeks: num(plan?.weeks),
      sessions_per_week: num(plan?.days_per_week) ?? new Set(rows.map((r) => r.day_of_week)).size,
    },
    exercises: rows,
    // Never empty silently: the trainer is told which exercises did not make
    // it and why, because one in eight is the expected rate rather than a
    // fault, and a save that quietly dropped them would be worse than one
    // that refused.
    unresolved,
    unknown_days: [...unknownDays],
    counts: { saved: rows.length, unresolved: unresolved.length },
  };
}

/**
 * RPE from "RPE 8", "RIR 2", or a bare number.
 *
 * RIR is inverted onto the RPE scale — 2 reps in reserve is RPE 8 — because
 * the column is named rpe and storing a 2 in it would read as a trivially
 * easy set rather than a hard one.
 */
function parseRpe(value) {
  const t = text(value);
  if (!t) return null;
  const m = t.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (/rir/i.test(t)) return Math.min(10, Math.max(1, 10 - n));
  return n >= 1 && n <= 10 ? n : null;
}

module.exports = {
  materialise, dayNumber, parseReps, parseRpe, notesFor, configFor,
  DAYS, WEEK_ONE, SINGLE_BOUT, CONFIG_FIELDS,
};

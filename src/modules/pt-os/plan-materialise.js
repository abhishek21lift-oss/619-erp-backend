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

const { planExercises, normaliseName, REPS_TYPES } = require('./plan-critic');

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

/** The builder's progression rules; workout_plans rejects anything else. */
const PROGRESSION_TYPES = Object.freeze(['none', 'weight', 'reps', 'rpe']);

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

/** The values the goal and difficulty columns accept (migrations 239 and 006). */
const GOALS = Object.freeze([
  'weight_loss', 'muscle_gain', 'strength', 'endurance',
  'general_fitness', 'body_recomposition', 'recovery',
]);
const LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced']);

/**
 * The generator writes labels ("Weight Loss"); these columns are enums with
 * CHECK constraints. Case and spacing are normalised, and anything still
 * unrecognised is dropped to NULL rather than failing the whole save on the
 * constraint — a missing goal is cosmetic, a lost programme is not.
 */
const enumText = (v, allowed) => {
  const k = text(v).toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.includes(k) ? k : null;
};

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

/** Does this prescription carry a rep count? `''` is the unstated strength mode. */
function isRepsType(value) {
  const type = text(value).toUpperCase();
  return type === '' || REPS_TYPES.includes(type);
}

/** The prescription a trainer should still be able to read after the mapping. */
function notesFor(ex) {
  const parts = [];
  const reps = text(ex.reps);
  // Only when the range says more than the stored integer does.
  if (reps && !/^\d+$/.test(reps)) parts.push(`Reps: ${reps}`);
  const type = text(ex.prescription_type).toUpperCase();
  // WEIGHT_REPS/BODYWEIGHT/REPS are the ordinary strength modes, not a
  // second prescription worth repeating beside the one already stored.
  if (type && !isRepsType(type)) parts.push(`Prescription: ${type}`);
  if (text(ex.notes)) parts.push(text(ex.notes));
  return parts.length ? parts.join(' · ') : null;
}

/** Cardio/interval fields, or null when there are none. */
function configFor(ex) {
  const cfg = {};
  for (const f of CONFIG_FIELDS) {
    if (f === 'distance_unit') continue;
    const v = num(ex[f]);
    if (v === null) continue;
    // A model filling every schema key writes 0 for the ones it did not use.
    // Incline is the exception: 0% is a treadmill setting somebody chose.
    if (v === 0 && f !== 'incline') continue;
    cfg[f] = v;
  }
  const distance = num(ex.distance);
  const unit = text(ex.distance_unit);
  // A unit with no distance labels nothing and reads as a broken bout.
  if (distance !== null && distance !== 0 && unit) cfg.distance_unit = unit;
  return Object.keys(cfg).length ? cfg : null;
}

/** The plan-level text workout_plans has no columns for, kept in `description`. */
function descriptionFor(plan) {
  const parts = [];
  if (text(plan?.description)) parts.push(text(plan.description));
  if (text(plan?.warm_up)) parts.push(`Warm-up: ${text(plan.warm_up)}`);
  if (text(plan?.cool_down)) parts.push(`Cool-down: ${text(plan.cool_down)}`);
  if (text(plan?.progression_notes)) parts.push(`Progression: ${text(plan.progression_notes)}`);
  return parts.length ? parts.join('\n\n') : null;
}

/**
 * The generator's progression rule, in the form workout_plans accepts.
 *
 * A type without a positive amount violates the column's own CHECK, so a
 * half-filled rule is dropped to `none` rather than failing the entire save.
 */
function progressionFor(plan) {
  const rule = plan?.progression || {};
  const type = enumText(rule.type ?? plan?.progression_type, PROGRESSION_TYPES) || 'none';
  const amount = num(rule.amount ?? plan?.progression_amount);
  if (type === 'none' || amount === null || amount <= 0) {
    return { progression_type: 'none', progression_amount: null, progression_every_weeks: 1 };
  }
  const every = num(rule.every_weeks ?? plan?.progression_every_weeks);
  return {
    progression_type: type,
    progression_amount: amount,
    progression_every_weeks: every !== null && every >= 1 ? Math.round(every) : 1,
  };
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

    const isSetsReps = isRepsType(ex.prescription_type);
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
      description: descriptionFor(plan),
      goal: enumText(plan?.goal, GOALS),
      difficulty: enumText(plan?.level, LEVELS),
      duration_weeks: num(plan?.weeks),
      // Counted from the rows that will actually be written. A model that
      // claims four days but names two unresolvable ones leaves a two-day
      // programme, and the plan must not advertise a frequency it does not have.
      sessions_per_week: new Set(rows.map((r) => r.day_of_week)).size,
      ...progressionFor(plan),
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

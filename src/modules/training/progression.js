// Progression: what next week's prescription should say.
//
// ── How this differs from the old progression.js ───────────────────────────
//
// modules/pt-os/progression.js answers "what does week 7 say", by taking the
// single stored week and applying arithmetic. It has to, because the old
// schema stores one week.
//
// The new schema stores every week (training_program_weeks), so this module
// does the opposite job: it PROPOSES next week's numbers from what the client
// actually did, and the proposal is written into a real row a trainer can
// then overrule. That inversion is the point. Progression stops being a
// formula the client is subjected to and becomes a suggestion with a name on
// it.
//
// Every rule returns a proposal — never a mutation, never a write. Deciding
// is the service layer's job; deciding CORRECTLY is this module's, and that
// is testable without a database.
'use strict';

const u = require('./units');

const PROGRESSION_TYPES = [
  'NONE',
  'DOUBLE_PROGRESSION',
  'WEIGHT_INCREMENT',
  'REP_INCREMENT',
  'RPE_BASED',
  'RIR_BASED',
  'PERCENT_1RM',
  'TIME_PROGRESSION',
  'DISTANCE_PROGRESSION',
  'PACE_PROGRESSION',
];

/**
 * A proposal, in the shape every rule returns.
 *
 * `reason` is not decoration. A trainer looking at "80kg → 82.5kg" needs to
 * know whether the system saw every set completed or is just adding 2.5kg on
 * a schedule, and those call for different responses when the client is
 * struggling.
 */
function proposal(changed, patch, reason) {
  return { changed, patch: changed ? patch : {}, reason };
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const done = (sets) => (sets || []).filter((s) => s && s.completed);

// ── Double progression ─────────────────────────────────────────────────────

/**
 * Work up the rep range at a fixed weight; when every set hits the top of the
 * range, add weight and drop back to the bottom.
 *
 * The most common rule in strength coaching, and the one that most needs an
 * explicit "every set" check: a client who hits 12 on set one and 8 on set
 * four has not earned the increase, and a rule that averaged those would add
 * weight the client cannot yet handle.
 */
function doubleProgression(prescription, sets, opts = {}) {
  const repMax = num(prescription.target_reps_max);
  const repMin = num(prescription.target_reps_min);
  const weight = num(prescription.target_weight);
  const unit = prescription.weight_unit || 'kg';
  const increment = num(opts.increment) ?? u.defaultIncrement(unit);

  if (repMax == null || weight == null) {
    return proposal(false, {}, 'Needs a target weight and a rep range to progress');
  }

  const completed = done(sets);
  const expected = num(prescription.target_sets);
  if (!completed.length) return proposal(false, {}, 'No completed sets logged');
  if (expected != null && completed.length < expected) {
    return proposal(false, {}, `Only ${completed.length} of ${expected} sets completed`);
  }

  const allAtTop = completed.every((s) => num(s.actual_reps) >= repMax);
  if (!allAtTop) {
    const lowest = Math.min(...completed.map((s) => num(s.actual_reps) ?? 0));
    return proposal(false, {}, `Lowest set was ${lowest} reps, target is ${repMax}`);
  }

  return proposal(true, {
    target_weight: u.roundToIncrement(weight + increment, increment),
    target_reps_min: repMin,
    target_reps_max: repMax,
  }, `Every set reached ${repMax} reps — weight up ${increment}${unit}, reps back to ${repMin}`);
}

// ── Straight increments ────────────────────────────────────────────────────

function weightIncrement(prescription, sets, opts = {}) {
  const weight = num(prescription.target_weight);
  if (weight == null) return proposal(false, {}, 'No target weight to increment');
  const unit = prescription.weight_unit || 'kg';
  const increment = num(opts.increment) ?? u.defaultIncrement(unit);

  // Still conditional on the work being done. "Linear" describes the size of
  // the jump, not a promise to add weight to a session the client missed.
  const completed = done(sets);
  const expected = num(prescription.target_sets);
  if (expected != null && completed.length < expected) {
    return proposal(false, {}, `Only ${completed.length} of ${expected} sets completed`);
  }
  if (!completed.length) return proposal(false, {}, 'No completed sets logged');

  return proposal(true, {
    target_weight: u.roundToIncrement(weight + increment, increment),
  }, `Session completed — weight up ${increment}${unit}`);
}

function repIncrement(prescription, sets, opts = {}) {
  const repMin = num(prescription.target_reps_min);
  if (repMin == null) return proposal(false, {}, 'No target reps to increment');
  const step = num(opts.increment) ?? 1;
  const cap = num(opts.cap);

  const completed = done(sets);
  if (!completed.length) return proposal(false, {}, 'No completed sets logged');
  if (!completed.every((s) => num(s.actual_reps) >= repMin)) {
    return proposal(false, {}, 'Not every set reached the target reps');
  }

  const next = repMin + step;
  if (cap != null && next > cap) {
    return proposal(false, {}, `Rep target is capped at ${cap}`);
  }
  const repMax = num(prescription.target_reps_max);
  return proposal(true, {
    target_reps_min: next,
    ...(repMax != null ? { target_reps_max: repMax + step } : {}),
  }, `Every set reached ${repMin} reps — target up to ${next}`);
}

// ── Autoregulated ──────────────────────────────────────────────────────────

/**
 * RPE and RIR both mean "how close to failure", on inverted scales: RPE 10 is
 * failure, RIR 0 is failure. So an RPE BELOW target means there was more in
 * the tank and the weight goes up, while an RIR ABOVE target means the same
 * thing. Getting that backwards deloads a client who is progressing, which is
 * why the two live in one function with the direction as a parameter rather
 * than in two functions somebody keeps in sync by hand.
 */
function autoregulated(prescription, sets, opts = {}) {
  const scale = opts.scale === 'RIR' ? 'RIR' : 'RPE';
  const targetField = scale === 'RIR' ? 'target_rir' : 'target_rpe';
  const actualField = scale === 'RIR' ? 'actual_rir' : 'actual_rpe';

  const target = num(prescription[targetField]);
  const weight = num(prescription.target_weight);
  if (target == null) return proposal(false, {}, `No ${scale} target set`);
  if (weight == null) return proposal(false, {}, 'No target weight to adjust');

  const completed = done(sets).filter((s) => num(s[actualField]) != null);
  if (!completed.length) return proposal(false, {}, `No ${scale} logged on any set`);

  const mean = completed.reduce((sum, s) => sum + num(s[actualField]), 0) / completed.length;
  const unit = prescription.weight_unit || 'kg';
  const increment = num(opts.increment) ?? u.defaultIncrement(unit);
  const tolerance = num(opts.tolerance) ?? 0.5;

  // Easier than asked for → add load. In RPE terms that is mean < target; in
  // RIR terms it is mean > target.
  const easier = scale === 'RIR' ? mean > target + tolerance : mean < target - tolerance;
  const harder = scale === 'RIR' ? mean < target - tolerance : mean > target + tolerance;

  const rounded = Math.round(mean * 10) / 10;
  if (easier) {
    return proposal(true, {
      target_weight: u.roundToIncrement(weight + increment, increment),
    }, `Average ${scale} ${rounded} vs target ${target} — room to add ${increment}${unit}`);
  }
  if (harder) {
    return proposal(true, {
      target_weight: u.roundToIncrement(weight - increment, increment),
    }, `Average ${scale} ${rounded} vs target ${target} — back off ${increment}${unit}`);
  }
  return proposal(false, {}, `Average ${scale} ${rounded} is on target — hold`);
}

/** Percentage of an estimated 1RM. The weight follows the estimate. */
function percentOneRepMax(prescription, _sets, opts = {}) {
  const pct = num(prescription.percentage_1rm);
  const oneRm = num(opts.oneRepMaxKg);
  if (pct == null) return proposal(false, {}, 'No percentage_1rm set');
  if (oneRm == null || oneRm <= 0) {
    return proposal(false, {}, 'No estimated 1RM on file for this exercise yet');
  }
  const unit = prescription.weight_unit || 'kg';
  const increment = num(opts.increment) ?? u.defaultIncrement(unit);
  const target = u.fromKg(oneRm * (pct / 100), unit);
  return proposal(true, {
    target_weight: u.roundToIncrement(target, increment),
  }, `${pct}% of an estimated ${Math.round(oneRm)}kg 1RM`);
}

// ── Cardio ─────────────────────────────────────────────────────────────────

function timeProgression(prescription, cardio, opts = {}) {
  const target = num(prescription.target_duration_seconds);
  if (target == null) return proposal(false, {}, 'No target duration to progress');
  if (!cardio || !cardio.completed) return proposal(false, {}, 'Last effort was not completed');
  const step = num(opts.increment) ?? 120;              // two minutes
  const cap = num(opts.cap);
  const actual = num(cardio.duration_seconds) ?? 0;
  if (actual < target) {
    return proposal(false, {}, `Logged ${u.formatDuration(actual)} of a ${u.formatDuration(target)} target`);
  }
  const next = target + step;
  if (cap != null && next > cap) return proposal(false, {}, `Duration is capped at ${u.formatDuration(cap)}`);
  return proposal(true, { target_duration_seconds: next },
    `Target met — up to ${u.formatDuration(next)}`);
}

function distanceProgression(prescription, cardio, opts = {}) {
  const target = num(prescription.target_distance);
  if (target == null) return proposal(false, {}, 'No target distance to progress');
  if (!cardio || !cardio.completed) return proposal(false, {}, 'Last effort was not completed');
  const unit = prescription.distance_unit || 'km';
  const step = num(opts.increment) ?? 0.5;
  const cap = num(opts.cap);

  // Compared in metres, because the prescription and the logged effort may
  // legitimately be in different units — a 5 km target run as 5000 m.
  const targetM = u.toMetres(target, unit);
  const actualM = u.toMetres(cardio.distance, cardio.distance_unit);
  if (actualM == null || targetM == null || actualM < targetM) {
    return proposal(false, {}, 'Target distance not reached');
  }
  const next = Math.round((target + step) * 1000) / 1000;
  if (cap != null && next > cap) return proposal(false, {}, `Distance is capped at ${cap}${unit}`);
  return proposal(true, { target_distance: next, distance_unit: unit },
    `Target met — up to ${next}${unit}`);
}

/** Pace improves DOWNWARD: fewer seconds per unit distance. */
function paceProgression(prescription, cardio, opts = {}) {
  const target = num(prescription.target_pace_seconds);
  if (target == null) return proposal(false, {}, 'No target pace to progress');
  if (!cardio || !cardio.completed) return proposal(false, {}, 'Last effort was not completed');
  const step = num(opts.increment) ?? 5;
  const floor = num(opts.floor);
  const actual = num(cardio.pace_seconds);
  if (actual == null || actual > target) {
    return proposal(false, {}, 'Target pace not held');
  }
  const next = target - step;
  if (floor != null && next < floor) return proposal(false, {}, `Pace is floored at ${u.formatPace(floor)}`);
  return proposal(true, { target_pace_seconds: next },
    `Pace held — target down to ${u.formatPace(next)}`);
}

const RULES = {
  NONE:                 () => proposal(false, {}, 'No progression configured'),
  DOUBLE_PROGRESSION:   doubleProgression,
  WEIGHT_INCREMENT:     weightIncrement,
  REP_INCREMENT:        repIncrement,
  RPE_BASED:            (p, s, o) => autoregulated(p, s, { ...o, scale: 'RPE' }),
  RIR_BASED:            (p, s, o) => autoregulated(p, s, { ...o, scale: 'RIR' }),
  PERCENT_1RM:          percentOneRepMax,
  TIME_PROGRESSION:     timeProgression,
  DISTANCE_PROGRESSION: distanceProgression,
  PACE_PROGRESSION:     paceProgression,
};

/**
 * Apply a named rule.
 *
 * An unknown rule returns "no change" rather than throwing. This runs while
 * building next week's programme, and a typo in a rule name must not take the
 * whole build down — it must leave that one exercise unchanged and say so.
 */
function propose(progressionType, prescription, performance, opts = {}) {
  const rule = RULES[progressionType];
  if (!rule) return proposal(false, {}, `Unknown progression type: ${progressionType}`);
  return rule(prescription || {}, performance, opts);
}

module.exports = {
  PROGRESSION_TYPES, RULES, propose, proposal,
  doubleProgression, weightIncrement, repIncrement, autoregulated,
  percentOneRepMax, timeProgression, distanceProgression, paceProgression,
};

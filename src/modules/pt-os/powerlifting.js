'use strict';

// Powerlifting periodisation: a block, not a strength-flavoured workout.
//
// ── Why this is its own module ─────────────────────────────────────────────
//
// The generic generator answers "what should this client do today". A
// powerlifter needs a different question answered: "what does this week ask of
// my squat, bench and deadlift, and where is that heading". Those are not the
// same problem, and folding the second into `prescribeStrengthLoad` would give
// every client a peaking block by accident.
//
// The model here is the one the audit asked for:
//
//   Base → Strength → Intensification → Peaking → Taper
//
// Each week prescribes a percentage of a TRAINING MAX (not a true 1RM), with an
// RPE and RIR target beside it so a bad day can be autoregulated down without
// changing the block. The training max is the trainer's number: this module
// can suggest one from a logged e1RM, and never writes it.
//
// ── What this module does NOT do ───────────────────────────────────────────
//
// It does not pick exercises, read a database, or invent a max. A lift with no
// recorded training max gets an RPE-only prescription and a note saying why —
// a percentage of a guessed max is a fabricated load, and the one number a
// powerlifter will actually put on the bar is the last place to guess.
//
// Pure functions over plain values, like progression.js and recovery.js: the
// SQL lives with the repository, the arithmetic is testable directly.

const { estimate1RM } = require('./training-history');

const PHASE_ORDER = Object.freeze(['base', 'strength', 'intensification', 'peaking', 'taper']);

const PHASE_LABELS = Object.freeze({
  base: 'Base',
  strength: 'Strength',
  intensification: 'Intensification',
  peaking: 'Peaking',
  taper: 'Taper',
});

/**
 * The shape of each phase.
 *
 * start/end are interpolated across the phase's own weeks, so a four-week Base
 * and a two-week Base both start where the phase starts and finish where it
 * finishes. Sets and reps fall while intensity rises — the volume/intensity
 * trade every block makes. Rest rises with intensity because a 95% single with
 * two minutes rest is a different exercise.
 */
const PHASE_PROFILES = Object.freeze({
  base: {
    startPct: 0.65, endPct: 0.75,
    startSets: 5, endSets: 5,
    startReps: 5, endReps: 5,
    startRpe: 6.5, endRpe: 7.5,
    startRir: 3.5, endRir: 2.5,
    restSeconds: 180,
    focus: 'Volume and technique at a submaximal load.',
  },
  strength: {
    startPct: 0.775, endPct: 0.85,
    startSets: 5, endSets: 4,
    startReps: 4, endReps: 3,
    startRpe: 7.5, endRpe: 8.5,
    startRir: 2.5, endRir: 1.5,
    restSeconds: 180,
    focus: 'Heavier triples and fours; the base becomes a strength expression.',
  },
  intensification: {
    startPct: 0.87, endPct: 0.90,
    startSets: 4, endSets: 3,
    startReps: 3, endReps: 2,
    startRpe: 8.5, endRpe: 9,
    startRir: 1.5, endRir: 1,
    restSeconds: 240,
    focus: 'Low reps at high intensity; specificity to the competition lift.',
  },
  peaking: {
    startPct: 0.925, endPct: 0.95,
    startSets: 3, endSets: 2,
    startReps: 2, endReps: 1,
    startRpe: 9, endRpe: 9.5,
    startRir: 0.5, endRir: 0,
    restSeconds: 300,
    focus: 'Competition-intensity singles and doubles. Volume is deliberately low.',
  },
  taper: {
    startPct: 0.90, endPct: 0.85,
    startSets: 2, endSets: 2,
    startReps: 1, endReps: 1,
    startRpe: 7, endRpe: 6.5,
    startRir: 3, endRir: 4,
    restSeconds: 240,
    focus: 'Openers and sharpening. Enough load to feel fast, not enough to fatigue.',
  },
});

/**
 * The phases a block of `weeks` actually contains.
 *
 * A five-week block cannot hold five phases with any of them useful, so short
 * blocks collapse from the middle: the phases that make a lifter peaked are
 * kept, and the ones that build the base are shortened first. One week is Base
 * only and says so — a taper with no peak before it is not a taper.
 */
function phaseAllocation(weeks) {
  const total = Math.max(1, Math.min(52, Math.floor(Number(weeks) || 1)));
  if (total === 1) return [{ phase: 'base', weeks: 1 }];
  if (total === 2) return [{ phase: 'base', weeks: 1 }, { phase: 'taper', weeks: 1 }];
  if (total === 3) return [
    { phase: 'base', weeks: 1 },
    { phase: 'intensification', weeks: 1 },
    { phase: 'taper', weeks: 1 },
  ];
  if (total === 4) return [
    { phase: 'base', weeks: 1 },
    { phase: 'strength', weeks: 1 },
    { phase: 'peaking', weeks: 1 },
    { phase: 'taper', weeks: 1 },
  ];

  // Five or more: every phase gets at least one week, and the remainder is
  // shared by largest remainder so the block still adds up exactly.
  const weights = { base: 0.30, strength: 0.25, intensification: 0.20, peaking: 0.15, taper: 0.10 };
  const counts = PHASE_ORDER.map((phase) => {
    const exact = total * weights[phase];
    return { phase, exact, weeks: Math.max(1, Math.floor(exact)) };
  });
  let remaining = total - counts.reduce((sum, c) => sum + c.weeks, 0);
  const byRemainder = counts
    .map((c, index) => ({ ...c, index, remainder: c.exact - Math.floor(c.exact) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; remaining > 0; i += 1, remaining -= 1) {
    byRemainder[i % byRemainder.length].weeks += 1;
  }
  // Back into phase order: the allocation is a sequence, not a ranking.
  return byRemainder
    .sort((a, b) => a.index - b.index)
    .map(({ phase, weeks: w }) => ({ phase, weeks: w }));
}

/**
 * Every week of a block with its phase, and whether it is a deload.
 *
 * The deload is placed at the end of Base once the block is long enough to
 * have earned one. That is the week a lifter is most volume-fatigued and least
 * intensity-dependent, so it costs the least and recovers the most. Short
 * blocks do not get one: a three-week block with a deload is two weeks of work.
 */
function phasePlan(weeks) {
  const total = Math.max(1, Math.min(52, Math.floor(Number(weeks) || 1)));
  const allocation = phaseAllocation(total);
  const phases = [];
  const plan = [];
  let cursor = 1;

  for (const entry of allocation) {
    const phaseWeeks = Array.from({ length: entry.weeks }, (_, i) => cursor + i);
    phases.push({
      phase: entry.phase,
      label: PHASE_LABELS[entry.phase],
      start_week: cursor,
      end_week: cursor + entry.weeks - 1,
      weeks: phaseWeeks,
      focus: PHASE_PROFILES[entry.phase].focus,
    });
    for (let i = 0; i < entry.weeks; i += 1) {
      const week = cursor + i;
      const deload = entry.phase === 'base'
        && entry.weeks >= 3
        && i === entry.weeks - 1;
      plan.push({
        week,
        phase: entry.phase,
        label: PHASE_LABELS[entry.phase],
        week_in_phase: i + 1,
        phase_weeks: entry.weeks,
        is_deload: deload,
      });
    }
    cursor += entry.weeks;
  }

  return { weeks: total, phases, plan };
}

/** Round a load to something that can actually be loaded: 2.5 kg. */
function roundToIncrement(value, increment = 2.5) {
  const n = Number(value);
  const step = Number(increment) > 0 ? Number(increment) : 2.5;
  if (!Number.isFinite(n)) return null;
  return Math.round(n / step) * step;
}

function roundTo(value, step) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n / step) * step;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * A training max from a logged estimated 1RM.
 *
 * The training max is deliberately below the true max: 85% for a beginner,
 * 90% for an intermediate, 92.5% for an advanced lifter. The gap is what lets
 * a block run for weeks without the last week becoming a failed max attempt.
 */
function trainingMaxFromE1RM(e1rmKg, experience) {
  const e1rm = Number(e1rmKg);
  if (!Number.isFinite(e1rm) || e1rm <= 0) return null;
  const factor = experience === 'advanced' ? 0.925
    : experience === 'intermediate' ? 0.90
      : 0.85;
  return roundToIncrement(e1rm * factor, 2.5);
}

/**
 * What the trainer might change the training max to, and why.
 *
 * Always a suggestion (`applied: false`). The audit's requirement is
 * trainer-controlled progression: a logged e1RM is evidence, not authority,
 * and an autoregulated block that silently raises its own max is a block
 * nobody is steering.
 */
function suggestTrainingMax({ currentTrainingMaxKg, bestE1rmKg, experience, lastRpe } = {}) {
  const current = Number(currentTrainingMaxKg);
  const hasCurrent = Number.isFinite(current) && current > 0;
  const fromE1rm = trainingMaxFromE1RM(bestE1rmKg, experience);
  const rpe = Number(lastRpe);

  if (fromE1rm == null && !hasCurrent) {
    return {
      suggested_kg: null,
      applied: false,
      reason: 'No e1RM or training max on record. Log a top set, or set a training max before running a percentage block.',
    };
  }
  if (!hasCurrent) {
    return {
      suggested_kg: fromE1rm,
      applied: false,
      reason: `Suggested from the best logged e1RM (${roundToIncrement(bestE1rmKg, 0.1)} kg). A training max is lower than a true max on purpose.`,
    };
  }
  if (fromE1rm == null) {
    return {
      suggested_kg: current,
      applied: false,
      reason: 'No e1RM on record, so there is nothing to compare the current training max against.',
    };
  }
  // A hard set is the strongest signal that the current max is already enough.
  if (Number.isFinite(rpe) && rpe >= 9.5 && fromE1rm <= current) {
    return {
      suggested_kg: current,
      applied: false,
      reason: 'The last top set was RPE 9.5 or harder and the logged e1RM does not support more. Hold the max.',
    };
  }
  if (fromE1rm >= current + 2.5) {
    return {
      suggested_kg: fromE1rm,
      applied: false,
      reason: `The logged e1RM now supports ${fromE1rm} kg, up from ${current} kg.`,
    };
  }
  if (fromE1rm <= current - 2.5) {
    return {
      suggested_kg: fromE1rm,
      applied: false,
      reason: `The logged e1RM is below the current training max; ${fromE1rm} kg would bring the block back to the evidence.`,
    };
  }
  return {
    suggested_kg: current,
    applied: false,
    reason: 'The logged e1RM is within one increment of the current training max. No change.',
  };
}

/**
 * Which competition lift an exercise is, or null.
 *
 * Name first, because movement pattern is too coarse to separate a back squat
 * from a goblet squat and a deadlift from a Romanian deadlift. An exercise this
 * cannot classify is an accessory: it gets an RPE prescription, not a
 * percentage of a max it does not have.
 */
function classifyLift(name, _movementPattern) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;

  if (/\bbench\b/.test(n) && /\bpress\b/.test(n)) return 'bench';
  if (/\bdeadlift\b/.test(n) && !/\b(romanian|rdl|stiff|deficit|rack pull)\b/.test(n)) return 'deadlift';
  if (/\bsquat\b/.test(n) && !/\b(front|goblet|hack|smith|split|bulgarian|pistol|sissy)\b/.test(n)) return 'squat';

  // No pattern fallback. A leg press shares a movement pattern with a squat
  // and a hip thrust shares one with a deadlift; a percentage of the wrong
  // lift's training max is worse than no percentage at all.
  return null;
}

/**
 * The prescription for one competition lift in one week.
 *
 * `weekInPhase` is 1-based. A phase of one week sits at its start, not its end:
 * there is no progression to interpolate, and pretending the single week is
 * both ends would pick the hardest number for the shortest exposure.
 */
function prescribeLift({
  lift,
  phase,
  weekInPhase = 1,
  phaseWeeks = 1,
  trainingMaxKg = null,
  isDeload = false,
  _experience = 'intermediate',
} = {}) {
  const profile = PHASE_PROFILES[phase];
  if (!profile) throw new Error(`Unknown powerlifting phase: ${phase}`);

  const span = Math.max(1, Number(phaseWeeks) || 1);
  const index = clamp(Math.floor(Number(weekInPhase) || 1) - 1, 0, span - 1);
  const t = span <= 1 ? 0 : index / (span - 1);

  const pct = profile.startPct + (profile.endPct - profile.startPct) * t;
  let sets = Math.round(profile.startSets + (profile.endSets - profile.startSets) * t);
  const reps = Math.round(profile.startReps + (profile.endReps - profile.startReps) * t);
  let rpe = roundTo(profile.startRpe + (profile.endRpe - profile.startRpe) * t, 0.5);
  let rir = roundTo(profile.startRir + (profile.endRir - profile.startRir) * t, 0.5);

  // A deload keeps the movement pattern and halves the sets. It does not
  // change the rep target: the point is to recover, not to rehearse a
  // different lift.
  let intensity = pct;
  if (isDeload) {
    intensity = pct * 0.85;
    sets = Math.max(2, sets - 2);
    rpe = 6;
    rir = 4;
  }

  const tm = Number(trainingMaxKg);
  const hasTm = Number.isFinite(tm) && tm > 0;
  const targetWeight = hasTm ? roundToIncrement(tm * intensity, 2.5) : null;

  const notes = [];
  notes.push(`${PHASE_LABELS[phase]}: ${profile.focus}`);
  if (hasTm) {
    notes.push(`${Math.round(intensity * 1000) / 10}% of a ${roundToIncrement(tm, 0.1)} kg training max.`);
  } else {
    notes.push('No training max recorded for this lift, so this is an RPE-only prescription. Set a max to load it by percentage.');
  }
  if (isDeload) notes.push('Deload week: reduced volume and intensity on purpose.');

  return {
    lift,
    phase,
    phase_label: PHASE_LABELS[phase],
    week_in_phase: index + 1,
    phase_weeks: span,
    is_deload: !!isDeload,
    sets,
    reps: String(reps),
    restSeconds: profile.restSeconds,
    rpe,
    rir,
    intensityPct1RM: hasTm ? Math.round(intensity * 1000) / 10 : null,
    target_weight: targetWeight,
    basis: hasTm ? 'training_max' : 'rpe',
    notes: notes.join(' '),
  };
}

/** The week's metadata from a stored block, or null when the plan has none. */
function weekMeta(blockPhases, week) {
  if (!Array.isArray(blockPhases)) return null;
  const w = Math.floor(Number(week) || 1);
  return blockPhases.find((entry) => Number(entry?.week) === w) || null;
}

module.exports = {
  PHASE_ORDER,
  PHASE_LABELS,
  PHASE_PROFILES,
  phaseAllocation,
  phasePlan,
  prescribeLift,
  classifyLift,
  trainingMaxFromE1RM,
  suggestTrainingMax,
  estimateE1RM: estimate1RM,
  roundToIncrement,
  weekMeta,
};

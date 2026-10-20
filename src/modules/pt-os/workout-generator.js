'use strict';

// Deterministic workout generation.
//
// This is the part of "generate me a session" that does not need a model:
// filter out what the client must not do, pick by movement pattern so the
// session is balanced, and sequence what is left. The model, where available,
// may reorder or swap within the pool this returns — never outside it.
//
// Everything here is a pure function over rows the caller fetched (the
// exercise library and the client's recorded constraints), so a generated
// session is reproducible: same input, same output, no clock, no randomness.

const { prescribeStrengthLoad } = require('./rm-prescription');
const { sequenceWorkout } = require('./exercise-sequencing');
const {
  buildFivePhaseCardio, buildFittPrescription, classifyCardioModality,
  getK11IntensityBand, isCardioCalculationMethod, isCardioProgramType, resolveHeartRateInputs,
} = require('./cardio');

/** Movement patterns a balanced session tries to cover, in priority order. */
const PATTERN_COVERAGE = Object.freeze(['Squat', 'Hinge', 'Horizontal Push', 'Horizontal Pull', 'Vertical Push', 'Vertical Pull', 'Carry', 'Anti-Extension']);

/** Goal → how many main exercises and which patterns come first. */
const GOAL_SHAPE = Object.freeze({
  strength: { mainCount: 5, patterns: ['Squat', 'Hinge', 'Horizontal Push', 'Horizontal Pull', 'Vertical Push'], cardioMinutes: 0 },
  powerlifting: { mainCount: 4, patterns: ['Squat', 'Hinge', 'Horizontal Push', 'Vertical Push'], cardioMinutes: 0 },
  hypertrophy: { mainCount: 6, patterns: ['Horizontal Push', 'Horizontal Pull', 'Squat', 'Vertical Push', 'Vertical Pull', 'Hinge'], cardioMinutes: 10 },
  fat_loss: { mainCount: 4, patterns: ['Squat', 'Horizontal Push', 'Horizontal Pull', 'Hinge'], cardioMinutes: 20 },
  endurance: { mainCount: 4, patterns: ['Squat', 'Horizontal Pull', 'Core', 'Hinge'], cardioMinutes: 25 },
  general_fitness: { mainCount: 5, patterns: ['Squat', 'Horizontal Push', 'Horizontal Pull', 'Hinge', 'Anti-Extension'], cardioMinutes: 15 },
});

const DEFAULT_SHAPE = GOAL_SHAPE.general_fitness;

/** Normalize a muscle/pattern name for comparison. */
function norm(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * Is this exercise usable for this client?
 *
 * Returns { ok: true } or { ok: false, reason } — a reason is required, because
 * "why was this left out" is the first question a trainer asks of a generated
 * session, and "not suitable" is not an answer.
 */
function suitability(exercise, client) {
  const avoidPatterns = new Set((client.avoidPatterns || []).map(norm));
  const avoidMuscles = new Set((client.avoidMuscles || []).map(norm));
  const allowedEquipment = client.equipment && client.equipment.length
    ? new Set(client.equipment.map(norm))
    : null;

  if (avoidPatterns.has(norm(exercise.movementPattern))) {
    return { ok: false, reason: `movement pattern "${exercise.movementPattern}" is restricted for this client` };
  }
  if (avoidMuscles.has(norm(exercise.primaryMuscle))) {
    return { ok: false, reason: `primary muscle "${exercise.primaryMuscle}" is restricted for this client` };
  }
  if (allowedEquipment && exercise.equipment && !allowedEquipment.has(norm(exercise.equipment))) {
    return { ok: false, reason: `equipment "${exercise.equipment}" is not available` };
  }
  if (client.maxDifficulty && exercise.difficulty) {
    const order = { beginner: 1, intermediate: 2, advanced: 3 };
    const cap = order[norm(client.maxDifficulty)] || 3;
    const lvl = order[norm(exercise.difficulty)] || 1;
    if (lvl > cap) return { ok: false, reason: `difficulty "${exercise.difficulty}" exceeds the client's level` };
  }
  return { ok: true };
}

function isWarmupCategory(ex) {
  const cat = norm(ex.category);
  const pattern = norm(ex.movementPattern);
  return cat === 'stretching' || cat === 'mobility' || pattern === 'mobility';
}

function isCardioExercise(ex) {
  const cat = norm(ex.category);
  return cat === 'cardio' || norm(ex.movementPattern) === 'locomotion';
}

/**
 * Build a complete session.
 *
 * @param {object} input
 * @param {object} input.client     experience, goal, constraints (see suitability)
 * @param {Array}  input.pool       exercise rows from the library
 * @param {object} [input.options]  { daysPerWeek, cardioMinutes, includeCardio, hasVerified1RM }
 */
function generateWorkout(input) {
  const client = (input && input.client) || {};
  const pool = (input && input.pool) || [];
  const options = (input && input.options) || {};
  const goal = norm(client.goal) || 'general_fitness';
  const shape = GOAL_SHAPE[goal] || DEFAULT_SHAPE;
  const experience = client.experience || 'beginner';
  const hasVerified1RM = !!options.hasVerified1RM;

  const excluded = [];
  const usable = [];
  for (const ex of pool) {
    const verdict = suitability(ex, client);
    if (verdict.ok) usable.push(ex);
    else excluded.push({ id: ex.id, name: ex.name, reason: verdict.reason });
  }

  const strength = usable.filter((e) => !isWarmupCategory(e) && !isCardioExercise(e));
  const cardioOptions = usable.filter(isCardioExercise);

  // Pick one best exercise per target pattern. "Best" = compound first, then
  // the closer the name is to the pattern's home difficulty. No randomness:
  // pool order breaks ties deterministically.
  const chosen = [];
  const chosenIds = new Set();
  const patternTargets = shape.patterns;
  for (const pattern of patternTargets) {
    const candidates = strength.filter((e) => norm(e.movementPattern) === norm(pattern) && !chosenIds.has(e.id));
    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      const ac = norm(a.mechanic) === 'compound' ? 0 : 1;
      const bc = norm(b.mechanic) === 'compound' ? 0 : 1;
      return ac - bc;
    });
    const pick = candidates[0];
    chosen.push(pick);
    chosenIds.add(pick.id);
  }

  // Fill any remaining slots with the next-best compound movements until the
  // session shape is met, so a pool missing "Carry" still yields a full session.
  if (chosen.length < shape.mainCount) {
    const rest = strength
      .filter((e) => !chosenIds.has(e.id) && norm(e.mechanic) === 'compound')
      .concat(strength.filter((e) => !chosenIds.has(e.id) && norm(e.mechanic) !== 'compound'));
    for (const ex of rest) {
      if (chosen.length >= shape.mainCount) break;
      chosen.push(ex);
      chosenIds.add(ex.id);
    }
  }

  // Sequence (power first, compounds before isolation) and prescribe.
  const sequenced = sequenceWorkout(chosen).map((ex) => {
    const rx = prescribeStrengthLoad({
      experience,
      goal: GOAL_SHAPE[goal] ? goal : 'general_fitness',
      mechanic: ex.mechanic,
      hasVerified1RM,
    });
    return { ...ex, prescription: rx };
  });

  const warmup = [
    { name: 'General warm-up', minutes: 5, intensity: 'easy', notes: 'Raise body temperature and heart rate gradually.' },
    {
      name: 'Specific preparation',
      minutes: 5,
      intensity: 'easy',
      notes: sequenced.length
        ? `Rehearse the ${sequenced[0].movementPattern || 'first'} pattern with light load.`
        : 'Rehearse today\'s first movement with light load.',
    },
  ];

  const cardioMinutes = options.cardioMinutes != null ? options.cardioMinutes : shape.cardioMinutes;
  const includeCardio = options.includeCardio != null ? !!options.includeCardio : cardioMinutes > 0;
  let conditioning = null;
  if (includeCardio && cardioMinutes > 0) {
    const modality = options.modality || (cardioOptions[0] ? cardioOptions[0].name : 'Cycling');

    // The request supplies structured FITT choices when the trainer made them;
    // otherwise these are application defaults, not K11 physiological limits.
    // Defaulting to moderate/3x/continuous is a product decision, and it is
    // marked as such on the returned conditioning block.
    const requestedIntensity = options.cardioIntensity;
    const intensityIsDefault = !(requestedIntensity && getK11IntensityBand(requestedIntensity));
    const cardioIntensity = intensityIsDefault ? 'moderate' : requestedIntensity;
    const requestedProgram = options.cardioProgramType;
    const programIsDefault = !(requestedProgram && isCardioProgramType(requestedProgram));
    const programType = programIsDefault ? 'continuous-liss' : requestedProgram;
    const frequencyIsDefault = !(Number.isInteger(options.cardioFrequencyPerWeek)
      && options.cardioFrequencyPerWeek > 0);
    const frequencyPerWeek = frequencyIsDefault ? 3 : options.cardioFrequencyPerWeek;
    // Name each default rather than one all-or-nothing flag: a trainer who
    // chose HIIT but left frequency blank still needs to see that 3x is ours.
    const defaults = [
      ...(intensityIsDefault ? ['intensity'] : []),
      ...(frequencyIsDefault ? ['frequency'] : []),
      ...(programIsDefault ? ['programme'] : []),
    ];

    // Heart-rate targets need an explicit method and client numbers. The repo
    // does not supply age or a measured max, so without request options this
    // stays null rather than guessing one.
    const hasHeartRateInput = options.age != null
      || options.measuredMaxHeartRate != null
      || options.restingHeartRate != null;
    const heartRate = hasHeartRateInput
      ? resolveHeartRateInputs({
        age: options.age,
        measuredMaxHeartRate: options.measuredMaxHeartRate,
        restingHeartRate: options.restingHeartRate,
      })
      : { value: null, errors: [] };
    const fittResult = heartRate.value
      ? buildFittPrescription({
        maxHeartRate: heartRate.value.maxHeartRate,
        restingHeartRate: heartRate.value.restingHeartRate,
        method: isCardioCalculationMethod(options.cardioMethod) ? options.cardioMethod : 'karvonen',
        intensity: cardioIntensity,
        frequencyPerWeek,
        mainWorkMinutes: cardioMinutes,
        modality,
        programType,
      })
      : null;
    const fittValue = fittResult ? fittResult.value : null;
    const warnings = [];
    if (heartRate.errors.length) warnings.push(...heartRate.errors);
    if (fittResult) {
      warnings.push(...fittResult.errors);
      if (fittValue) warnings.push(...fittValue.warnings);
    }

    conditioning = {
      modality,
      minutes: cardioMinutes,
      intensity: cardioIntensity,
      notes: 'Steady state or intervals per tolerance.',
      fitt: {
        frequencyPerWeek,
        timeMinutes: cardioMinutes,
        intensity: cardioIntensity,
        modalityCategory: fittValue
          ? fittValue.modalityCategory
          : classifyCardioModality(modality),
        programType,
        basis: defaults.length === 0 ? 'requested' : 'application-default',
        defaults,
      },
      targetHeartRate: fittValue
        ? {
          method: fittValue.targetHeartRate.method,
          minBpm: fittValue.targetHeartRate.minBpm,
          maxBpm: fittValue.targetHeartRate.maxBpm,
          basisLabel: fittValue.targetHeartRate.basisLabel,
        }
        : null,
      warnings,
    };
  }

  const cooldown = [
    { name: 'Cool-down', minutes: 5, intensity: 'easy', notes: 'Gradually reduce intensity; breathing back to conversational.' },
    { name: 'Static stretching', minutes: 5, intensity: 'rest', notes: 'Hold 20-30s per stretch for muscles trained today.' },
  ];

  const warnings = [];
  if (!sequenced.length) warnings.push('No suitable exercises were found in the library pool for this client\'s constraints.');
  if (excluded.length) warnings.push(`${excluded.length} exercise(s) were excluded by recorded restrictions.`);
  if (conditioning && conditioning.warnings.length) warnings.push(...conditioning.warnings);

  const explanations = sequenced.map((ex) => ({ exerciseId: ex.id, reason: ex.reason, prescriptionBasis: ex.prescription.notes }));

  return {
    goal,
    experience,
    warmup,
    mainWork: sequenced,
    conditioning,
    cooldown,
    excluded,
    warnings,
    explanations,
    totals: {
      exercises: sequenced.length,
      strengthMinutes: sequenced.length * 6,
      cardioMinutes: conditioning ? conditioning.minutes : 0,
      warmupMinutes: warmup.reduce((s, p) => s + p.minutes, 0),
      cooldownMinutes: cooldown.reduce((s, p) => s + p.minutes, 0),
    },
  };
}

module.exports = {
  generateWorkout,
  suitability,
  PATTERN_COVERAGE,
  GOAL_SHAPE,
  // Keep the pure engine helpers reachable through this module too, since the
  // generation path is what most callers want.
  prescribeStrengthLoad,
  sequenceWorkout,
  buildFivePhaseCardio,
};

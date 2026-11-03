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
const powerlifting = require('./powerlifting');
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

function warmupFor(sequenced) {
  return [
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
}

const COOLDOWN = [
  { name: 'Cool-down', minutes: 5, intensity: 'easy', notes: 'Gradually reduce intensity; breathing back to conversational.' },
  { name: 'Static stretching', minutes: 5, intensity: 'rest', notes: 'Hold 20-30s per stretch for muscles trained today.' },
];

/** How many main lifts a powerlifting day holds before it is accessories only. */
const POWERLIFTING_ACCESSORY_PATTERNS = Object.freeze({
  squat: ['Hinge', 'Horizontal Pull', 'Anti-Extension'],
  bench: ['Horizontal Pull', 'Vertical Pull', 'Vertical Push'],
  deadlift: ['Squat', 'Horizontal Push', 'Horizontal Pull'],
});

/** Which competition lifts each training day covers, by days per week. */
function powerliftingDayTemplate(daysPerWeek) {
  const templates = {
    1: [['squat', 'bench', 'deadlift']],
    2: [['squat', 'bench'], ['deadlift', 'bench']],
    3: [['squat'], ['bench'], ['deadlift']],
    4: [['squat'], ['bench'], ['deadlift'], ['bench']],
    5: [['squat'], ['bench'], ['deadlift'], ['squat'], ['bench']],
    6: [['squat'], ['bench'], ['deadlift'], ['squat'], ['bench'], ['deadlift']],
    7: [['squat'], ['bench'], ['deadlift'], ['squat'], ['bench'], ['deadlift'], ['bench']],
  };
  return templates[daysPerWeek] || templates[3];
}

/**
 * The powerlifting block.
 *
 * Kept beside the generic generator rather than inside it: the day shape is
 * different (competition lift first, then accessories), the prescription comes
 * from a training max rather than an RM range, and the return value carries a
 * whole block instead of one week. The shared pieces — suitability filtering,
 * warm-up, cool-down — are reused, not re-implemented.
 */
function buildPowerliftingBlock({
  strength, excluded, options, experience, daysPerWeek, sessionMinutes, dayNumbers,
}) {
  const blockWeeks = Math.max(1, Math.min(24, Math.floor(Number(options.blockWeeks) || 12)));
  const { phases, plan: weekPlan } = powerlifting.phasePlan(blockWeeks);

  const candidates = { squat: [], bench: [], deadlift: [] };
  for (const ex of strength) {
    const lift = powerlifting.classifyLift(ex.name, ex.movementPattern);
    if (lift) candidates[lift].push(ex);
  }
  for (const lift of Object.keys(candidates)) {
    candidates[lift].sort((a, b) => (norm(a.mechanic) === 'compound' ? 0 : 1)
      - (norm(b.mechanic) === 'compound' ? 0 : 1));
  }

  const found = Object.entries(candidates).filter(([, list]) => list.length);
  if (!found.length) {
    return null;
  }

  const tms = options.trainingMaxes && typeof options.trainingMaxes === 'object'
    ? options.trainingMaxes
    : {};
  const usedMaxes = [];
  const missingMaxes = [];
  for (const [lift, list] of found) {
    const ex = list[0];
    const kg = Number(tms[ex.id]);
    if (Number.isFinite(kg) && kg > 0) {
      usedMaxes.push({ exercise_id: ex.id, name: ex.name, lift, training_max_kg: kg });
    } else {
      missingMaxes.push({ exercise_id: ex.id, name: ex.name, lift });
    }
  }

  const templates = powerliftingDayTemplate(daysPerWeek);
  const blockSessions = weekPlan.map((meta) => {
    const sessions = templates.map((liftKeys, dayIndex) => {
      const dayOfWeek = dayNumbers[dayIndex] || dayIndex + 1;
      const chosen = [];
      const chosenIds = new Set();

      const competition = liftKeys
        .map((lift) => candidates[lift][0])
        .filter(Boolean)
        .filter((ex) => {
          if (chosenIds.has(ex.id)) return false;
          chosenIds.add(ex.id);
          return true;
        });

      for (const ex of competition) {
        const lift = powerlifting.classifyLift(ex.name, ex.movementPattern);
        const prescription = powerlifting.prescribeLift({
          lift,
          phase: meta.phase,
          weekInPhase: meta.week_in_phase,
          phaseWeeks: meta.phase_weeks,
          trainingMaxKg: tms[ex.id],
          isDeload: meta.is_deload,
          experience,
        });
        chosen.push({
          ...ex,
          reason: `${powerlifting.PHASE_LABELS[meta.phase]} competition lift — ${prescription.notes}`,
          prescription,
        });
      }

      // Accessories fill the rest of the session. They are RPE-based: a
      // percentage of a competition max says nothing useful about a row.
      const patterns = [...new Set(liftKeys.flatMap((lift) => POWERLIFTING_ACCESSORY_PATTERNS[lift] || []))];
      const accessoryTarget = sessionMinutes
        ? Math.max(competition.length, Math.min(competition.length + 2, Math.floor((sessionMinutes - 20) / 8)))
        : competition.length + 2;
      for (const pattern of patterns) {
        if (chosen.length >= accessoryTarget) break;
        const list = strength.filter((ex) => !chosenIds.has(ex.id) && norm(ex.movementPattern) === norm(pattern));
        if (!list.length) continue;
        const ex = list[dayIndex % list.length];
        chosenIds.add(ex.id);
        const rx = prescribeStrengthLoad({
          experience,
          goal: 'powerlifting',
          mechanic: ex.mechanic,
          hasVerified1RM: false,
        });
        chosen.push({
          ...ex,
          reason: `Accessory for the ${liftKeys.join('/')} day.`,
          prescription: meta.is_deload
            ? { ...rx, sets: Math.max(1, Math.round(rx.sets / 2)), notes: `${rx.notes} Deload: half the sets.` }
            : rx,
        });
      }

      const sequenced = sequenceWorkout(chosen);
      const warmup = warmupFor(sequenced);
      const cooldown = COOLDOWN.map((p) => ({ ...p }));
      const estimatedMinutes = warmup.reduce((s, p) => s + p.minutes, 0)
        + sequenced.length * 8
        + cooldown.reduce((s, p) => s + p.minutes, 0);
      const focus = liftKeys.map((lift) => lift[0].toUpperCase() + lift.slice(1)).join(' + ');

      return {
        day_of_week: dayOfWeek,
        day_name: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][dayOfWeek - 1],
        name: `${focus} — ${meta.label}${meta.is_deload ? ' deload' : ''}`,
        focus,
        phase: meta.phase,
        phase_label: meta.label,
        is_deload: meta.is_deload,
        warmup,
        mainWork: sequenced,
        conditioning: null,
        cooldown,
        estimated_minutes: estimatedMinutes,
        totals: {
          exercises: sequenced.length,
          strengthMinutes: sequenced.length * 8,
          cardioMinutes: 0,
          warmupMinutes: warmup.reduce((s, p) => s + p.minutes, 0),
          cooldownMinutes: cooldown.reduce((s, p) => s + p.minutes, 0),
        },
      };
    });

    return { ...meta, sessions };
  });

  const first = blockSessions[0].sessions[0];
  const warnings = [];
  if (missingMaxes.length) {
    warnings.push(`No training max recorded for ${missingMaxes.map((m) => m.name).join(', ')}. The block prescribes those lifts by RPE only; set a max to load them by percentage.`);
  }
  if (blockWeeks < 5) {
    warnings.push(`A ${blockWeeks}-week block cannot hold every phase. It runs ${phases.map((p) => p.label).join(' → ')}.`);
  }
  if (excluded.length) warnings.push(`${excluded.length} exercise(s) were excluded by recorded restrictions.`);
  if (sessionMinutes && first.estimated_minutes > sessionMinutes) {
    warnings.push(`The competition lifts alone run about ${first.estimated_minutes} minutes, longer than the recorded ${sessionMinutes}-minute slot.`);
  }

  const explanations = first.mainWork.map((ex) => ({
    exerciseId: ex.id,
    reason: ex.reason,
    prescriptionBasis: ex.prescription.notes,
  }));

  return {
    goal: 'powerlifting',
    experience,
    daysPerWeek,
    sessionMinutes,
    warmup: first.warmup,
    mainWork: first.mainWork,
    conditioning: null,
    cooldown: first.cooldown,
    sessions: blockSessions[0].sessions,
    periodization: {
      model: 'powerlifting_block',
      block_weeks: blockWeeks,
      phases,
      weeks: blockSessions,
      training_maxes: usedMaxes,
      missing_training_maxes: missingMaxes,
    },
    excluded,
    warnings,
    explanations,
    totals: {
      ...first.totals,
      sessions: blockSessions[0].sessions.length,
      estimatedMinutes: first.estimated_minutes,
    },
  };
}

/**
 * Build a complete session.
 *
 * @param {object} input
 * @param {object} input.client     experience, goal, constraints (see suitability)
 * @param {Array}  input.pool       exercise rows from the library
 * @param {object} [input.options]  { daysPerWeek, sessionMinutes, preferredDays,
 *                                    cardioMinutes, includeCardio, hasVerified1RM,
 *                                    periodization, blockWeeks, trainingMaxes }
 */
function generateWorkout(input) {
  const client = (input && input.client) || {};
  const pool = (input && input.pool) || [];
  const options = (input && input.options) || {};
  const goal = norm(client.goal) || 'general_fitness';
  const baseShape = GOAL_SHAPE[goal] || DEFAULT_SHAPE;
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

  // ── How many days, and how long is each one? ─────────────────────────────
  //
  // One session used to be the whole answer, which is why the save path wrote
  // sessions_per_week: 1 and day_of_week: 1 for every programme. The caller
  // now supplies the client's real frequency and slot length; both are capped
  // here rather than trusted, because a form can send 12 days or 900 minutes.
  const daysPerWeek = Math.max(1, Math.min(7, Number(options.daysPerWeek) || 1));
  const sessionMinutes = Number(options.sessionMinutes) > 0
    ? Math.max(20, Math.min(180, Number(options.sessionMinutes)))
    : null;

  const requestedCardio = options.cardioMinutes != null
    ? options.cardioMinutes
    : baseShape.cardioMinutes;
  const includeCardio = options.includeCardio != null
    ? !!options.includeCardio
    : requestedCardio > 0;

  // Fit the work to the slot: 10 minutes of warm-up and 10 of cool-down are
  // fixed costs, and a strength set is budgeted at 6 minutes. A short session
  // loses conditioning first, then main exercises — never the warm-up or the
  // cool-down.
  let cardioMinutes = includeCardio ? requestedCardio : 0;
  let mainCount = baseShape.mainCount;
  if (sessionMinutes) {
    const available = sessionMinutes - 20;
    if (available < 20) cardioMinutes = 0;
    const room = Math.max(0, available - cardioMinutes);
    mainCount = Math.max(1, Math.min(baseShape.mainCount, Math.floor(room / 6)));
  }
  const shape = { ...baseShape, mainCount };

  const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const preferred = (Array.isArray(options.preferredDays)
    ? options.preferredDays
    : String(options.preferredDays || '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  const preferredNumbers = preferred
    .map((name) => WEEKDAY_NAMES.findIndex((d) => d.toLowerCase() === name) + 1)
    .filter((n) => n > 0);

  const dayNumbers = [];
  for (let i = 0; i < daysPerWeek; i += 1) {
    if (preferredNumbers[i]) {
      dayNumbers.push(preferredNumbers[i]);
    } else {
      dayNumbers.push([1, 2, 3, 4, 5, 6, 7].find((n) => !dayNumbers.includes(n)) || i + 1);
    }
  }

  // ── Powerlifting: a whole block, not one week ────────────────────────────
  //
  // The generic path below answers "what does this client do today". A
  // powerlifter needs the block, so when the caller asks for it the block
  // engine builds every week and returns it. A pool with no competition lift
  // falls through to the generic generator rather than inventing one.
  if (norm(options.periodization) === 'powerlifting_block') {
    const block = buildPowerliftingBlock({
      strength, excluded, options, experience, daysPerWeek, sessionMinutes, dayNumbers,
    });
    if (block) return block;
  }

  // ── Pick the exercises for one day ───────────────────────────────────────
  //
  // Day 0 reproduces the old single-session choice exactly (compound first,
  // pool order breaking ties). Later days rotate through the same ranked
  // candidates so a three-day programme is not the same session three times.
  const pickForDay = (dayIndex) => {
    const chosen = [];
    const chosenIds = new Set();
    for (const pattern of shape.patterns) {
      if (chosen.length >= shape.mainCount) break;
      const candidates = strength
        .filter((e) => norm(e.movementPattern) === norm(pattern))
        .sort((a, b) => (norm(a.mechanic) === 'compound' ? 0 : 1)
          - (norm(b.mechanic) === 'compound' ? 0 : 1));
      if (!candidates.length) continue;
      const pick = candidates[dayIndex % candidates.length];
      chosen.push(pick);
      chosenIds.add(pick.id);
    }

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
    return chosen;
  };

  const prescribe = (ex) => {
    const rx = prescribeStrengthLoad({
      experience,
      goal: GOAL_SHAPE[goal] ? goal : 'general_fitness',
      mechanic: ex.mechanic,
      hasVerified1RM,
    });
    return { ...ex, prescription: rx };
  };

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

  // ── One session per training day ────────────────────────────────────────
  //
  // The old return value was a single session, so every saved programme said
  // one day a week no matter what the client actually trains. The first
  // session is still returned in the old top-level fields, so existing callers
  // keep working; `sessions` is the complete week.
  const sessions = dayNumbers.map((dayOfWeek, dayIndex) => {
    const sequenced = sequenceWorkout(pickForDay(dayIndex)).map(prescribe);
    const warmup = warmupFor(sequenced);
    const estimatedMinutes = warmup.reduce((s, p) => s + p.minutes, 0)
      + sequenced.length * 6
      + (conditioning ? conditioning.minutes : 0)
      + COOLDOWN.reduce((s, p) => s + p.minutes, 0);
    const focus = [...new Set(sequenced.map((e) => e.movementPattern).filter(Boolean))]
      .slice(0, 2).join(' + ') || 'Full body';
    return {
      day_of_week: dayOfWeek,
      day_name: WEEKDAY_NAMES[dayOfWeek - 1],
      name: `${focus} session`,
      focus,
      warmup,
      mainWork: sequenced,
      conditioning,
      cooldown: COOLDOWN.map((p) => ({ ...p })),
      estimated_minutes: estimatedMinutes,
      totals: {
        exercises: sequenced.length,
        strengthMinutes: sequenced.length * 6,
        cardioMinutes: conditioning ? conditioning.minutes : 0,
        warmupMinutes: warmup.reduce((s, p) => s + p.minutes, 0),
        cooldownMinutes: COOLDOWN.reduce((s, p) => s + p.minutes, 0),
      },
    };
  });

  const first = sessions[0];
  const warnings = [];
  if (!first.mainWork.length) warnings.push('No suitable exercises were found in the library pool for this client\'s constraints.');
  if (excluded.length) warnings.push(`${excluded.length} exercise(s) were excluded by recorded restrictions.`);
  if (conditioning && conditioning.warnings.length) warnings.push(...conditioning.warnings);
  if (sessionMinutes && first.estimated_minutes > sessionMinutes) {
    warnings.push(`The shortest session this library supports is about ${first.estimated_minutes} minutes, longer than the recorded ${sessionMinutes}-minute slot.`);
  }

  const explanations = first.mainWork.map((ex) => ({
    exerciseId: ex.id,
    reason: ex.reason,
    prescriptionBasis: ex.prescription.notes,
  }));

  return {
    goal,
    experience,
    daysPerWeek,
    sessionMinutes,
    // The first session, in the fields callers already read.
    warmup: first.warmup,
    mainWork: first.mainWork,
    conditioning: first.conditioning,
    cooldown: first.cooldown,
    sessions,
    excluded,
    warnings,
    explanations,
    totals: {
      ...first.totals,
      sessions: sessions.length,
      estimatedMinutes: first.estimated_minutes,
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

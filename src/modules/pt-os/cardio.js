'use strict';

// Pure calculation helpers for the Cardio & FITT module.
// Frontend twin: 619-erp-frontend/src/lib/cardio-calculations.ts
//
// Two different percentages live in this file and must never be conflated:
//
//   K11 intensity bands   % of MAX heart rate (MHR)   -> training intensity
//   Progression phases    % of HEART-RATE RESERVE      -> multi-week stage
//
// MHR method:   THR = MHR x fraction
// Karvonen:     HRR = MHR - RHR
//               THR = round(((MHR - RHR) x fraction) + RHR)
//
// K11 band values are the supplied programme reference. RPE and talk-test text
// is application guidance, not part of that reference.
//
// The canonical five-phase template is 5 + 3 + 20 + 5 + 5 = 38 minutes.

const K11_INTENSITY_BANDS = [
  {
    key: 'low',
    label: 'Low',
    traineeLevel: 'Beginner',
    minFraction: 0.5,
    maxFraction: 0.6,
    rpe: 'RPE 3-4',
    talkTest: 'Full conversation is comfortable.',
    guidanceBasis: 'application-guidance',
  },
  {
    key: 'moderate',
    label: 'Moderate',
    traineeLevel: 'Intermediate',
    minFraction: 0.6,
    maxFraction: 0.7,
    rpe: 'RPE 5-6',
    talkTest: 'Short sentences; breathing is noticeable.',
    guidanceBasis: 'application-guidance',
  },
  {
    key: 'high',
    label: 'High',
    traineeLevel: 'Advanced',
    minFraction: 0.7,
    maxFraction: 0.85,
    rpe: 'RPE 7-8',
    talkTest: 'A few words at a time.',
    guidanceBasis: 'application-guidance',
  },
  {
    key: 'very-high',
    label: 'Very high',
    traineeLevel: 'Super advanced',
    minFraction: 0.85,
    maxFraction: 1,
    rpe: 'RPE 9-10',
    talkTest: 'Talking is difficult; use only where the client is prepared for it.',
    guidanceBasis: 'application-guidance',
  },
];

const K11_TRAINEE_LEVELS = [
  { key: 'beginner', label: 'Beginner', suggestedIntensity: 'low' },
  { key: 'intermediate', label: 'Intermediate', suggestedIntensity: 'moderate' },
  { key: 'advanced', label: 'Advanced', suggestedIntensity: 'high' },
  { key: 'super-advanced', label: 'Super advanced', suggestedIntensity: 'very-high' },
];

const CARDIO_GOALS = [
  { key: 'general-fitness', label: 'General fitness' },
  { key: 'fat-loss', label: 'Fat loss' },
  { key: 'endurance', label: 'Endurance' },
  { key: 'recovery', label: 'Recovery / active recovery' },
  { key: 'performance', label: 'Performance' },
];

const CARDIO_PROGRAM_TYPES = [
  { key: 'continuous-liss', label: 'Continuous / LISS', description: 'Steady effort held for the main-work duration.' },
  { key: 'liit-miit', label: 'LIIT / MIIT', description: 'Light or moderate intervals with recovery between efforts.' },
  { key: 'hiit', label: 'HIIT', description: 'Short, hard efforts with planned recovery.' },
  { key: 'fartlek', label: 'Fartlek', description: 'Unstructured pace changes within one continuous session.' },
];

const CARDIO_MODALITY_CATEGORIES = [
  {
    key: 'weight-bearing-high-impact',
    label: 'Weight-bearing, impact-based',
    examples: ['Running', 'Jogging', 'Jump rope'],
  },
  {
    key: 'weight-bearing-low-impact',
    label: 'Weight-bearing, non-impact',
    examples: ['Elliptical', 'Walking', 'Stair climber'],
  },
  {
    key: 'non-weight-bearing',
    label: 'Non-weight-bearing, non-impact',
    examples: ['Cycling', 'Swimming', 'Rowing', 'Ski erg'],
  },
];

const K11_FITT_REFERENCE = {
  frequencyPerWeek: { min: 3, max: 5 },
  mainWorkMinutes: { min: 20, max: 60 },
};

// Application guardrails, not physiological maxima.
const CARDIO_FREQUENCY_LIMITS = { min: 1, max: 14 };
const CARDIO_MAIN_WORK_LIMITS = { min: 5, max: 180 };
/** Matches the frontend twin and the generator route schema. */
const CARDIO_MODALITY_MAX_LENGTH = 80;

const K11_PROGRESSION_PHASES = [
  {
    key: 'initial',
    label: 'Initial Conditioning',
    durationWeeks: { min: 4, max: 8 },
    intensityHrr: { min: 0.4, max: 0.6 },
    frequencyDays: { min: 3, max: 5 },
    minutes: { min: 20, max: 40 },
    note: 'Build the habit and tolerate the work.',
  },
  {
    key: 'improvement',
    label: 'Improvement',
    durationWeeks: { min: 8, max: 20 },
    intensityHrr: { min: 0.6, max: 0.8 },
    frequencyDays: { min: 3, max: 6 },
    minutes: { min: 45, max: 60 },
    note: 'Increase the stimulus while keeping technique and recovery intact.',
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    durationWeeks: { min: 24, max: 50 },
    intensityHrr: { min: 0.8, max: 0.9 },
    frequencyDays: null,
    minutes: null,
    note: 'Frequency and time vary. Set them from the client’s schedule and response; no default is supplied.',
  },
];

const FIVE_PHASE_DEFAULTS = [
  { key: 'generalWarmup', name: 'General warm-up', durationMinutes: 5, intensityFraction: 0.4 },
  { key: 'rewarmup', name: 'Re-warm-up / specific prep', durationMinutes: 3, intensityFraction: 0.5 },
  { key: 'work', name: 'Main work', durationMinutes: 20, intensityFraction: 0.7 },
  { key: 'cooldown', name: 'Cool-down', durationMinutes: 5, intensityFraction: 0.4 },
  { key: 'stretching', name: 'Static stretching', durationMinutes: 5, intensityFraction: 0.3 },
];

const FIVE_PHASE_CARDIO_TOTAL_MINUTES = FIVE_PHASE_DEFAULTS.reduce((sum, p) => sum + p.durationMinutes, 0);

const CARDIO_MODALITY_CATEGORY = {
  running: 'weight-bearing-high-impact',
  jogging: 'weight-bearing-high-impact',
  sprinting: 'weight-bearing-high-impact',
  'jump rope': 'weight-bearing-high-impact',
  'treadmill running': 'weight-bearing-high-impact',
  elliptical: 'weight-bearing-low-impact',
  walking: 'weight-bearing-low-impact',
  hiking: 'weight-bearing-low-impact',
  'stair climber': 'weight-bearing-low-impact',
  'stair mill': 'weight-bearing-low-impact',
  cycling: 'non-weight-bearing',
  rowing: 'non-weight-bearing',
  swimming: 'non-weight-bearing',
  'stationary bike': 'non-weight-bearing',
  'assault bike': 'non-weight-bearing',
  'ski erg': 'non-weight-bearing',
};

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFraction(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function dedupe(values) {
  return [...new Set(values)];
}

function getK11IntensityBand(key) {
  if (!key) return null;
  return K11_INTENSITY_BANDS.find((band) => band.key === key) || null;
}

function getProgressionPhase(key) {
  if (!key) return null;
  return K11_PROGRESSION_PHASES.find((phase) => phase.key === key) || null;
}

function isCardioIntensity(value) {
  return typeof value === 'string' && K11_INTENSITY_BANDS.some((band) => band.key === value);
}

function isCardioCalculationMethod(value) {
  return value === 'mhr' || value === 'karvonen';
}

function isCardioProgramType(value) {
  return typeof value === 'string' && CARDIO_PROGRAM_TYPES.some((type) => type.key === value);
}

function isProgressionPhase(value) {
  return typeof value === 'string' && K11_PROGRESSION_PHASES.some((phase) => phase.key === value);
}

function isCardioModalityCategory(value) {
  return typeof value === 'string' && CARDIO_MODALITY_CATEGORIES.some((c) => c.key === value);
}

function formatIntensityPercent(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

function validateAge(age) {
  if (typeof age !== 'number' || !Number.isFinite(age) || !Number.isInteger(age)) {
    return 'Age must be a whole number.';
  }
  if (age < 1 || age > 120) return 'Age must be between 1 and 120.';
  return null;
}

function validateRestingHeartRate(restingHeartRate) {
  if (!isPositiveFinite(restingHeartRate)) return 'Resting heart rate must be a positive number.';
  return null;
}

function validateMaxHeartRate(maxHeartRate) {
  if (!isPositiveFinite(maxHeartRate)) return 'Max heart rate must be a positive number.';
  return null;
}

function validateMeasuredMaxHeartRate(measuredMaxHeartRate, restingHeartRate) {
  if (!isPositiveFinite(measuredMaxHeartRate)) return 'Measured max heart rate must be a positive number.';
  if (isPositiveFinite(restingHeartRate) && measuredMaxHeartRate <= restingHeartRate) {
    return 'Measured max heart rate must be greater than resting heart rate.';
  }
  return null;
}

function validateIntensityFraction(fraction) {
  if (!isFraction(fraction)) return 'Intensity must be between 0% and 100%.';
  return null;
}

function validateFrequencyPerWeek(frequency) {
  if (typeof frequency !== 'number' || !Number.isInteger(frequency)) {
    return 'Frequency must be a whole number of sessions per week.';
  }
  if (frequency < CARDIO_FREQUENCY_LIMITS.min || frequency > CARDIO_FREQUENCY_LIMITS.max) {
    return `Frequency must be between ${CARDIO_FREQUENCY_LIMITS.min} and ${CARDIO_FREQUENCY_LIMITS.max} sessions per week.`;
  }
  return null;
}

function validateMainWorkMinutes(minutes) {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes)) {
    return 'Main-work time must be a whole number of minutes.';
  }
  if (minutes < CARDIO_MAIN_WORK_LIMITS.min || minutes > CARDIO_MAIN_WORK_LIMITS.max) {
    return `Main-work time must be between ${CARDIO_MAIN_WORK_LIMITS.min} and ${CARDIO_MAIN_WORK_LIMITS.max} minutes.`;
  }
  return null;
}

function calcHrr(maxHeartRate, restingHeartRate) {
  if (!isPositiveFinite(maxHeartRate) || !isPositiveFinite(restingHeartRate)) return null;
  if (restingHeartRate >= maxHeartRate) return null;
  return maxHeartRate - restingHeartRate;
}

/** Karvonen target: % of heart-rate reserve, added back to resting HR. */
function calcTargetHeartRate(maxHeartRate, restingHeartRate, intensityFraction) {
  const hrr = calcHrr(maxHeartRate, restingHeartRate);
  if (hrr == null || !isFraction(intensityFraction)) return null;
  return Math.round(hrr * intensityFraction + restingHeartRate);
}

function calcTargetHeartRateRange(maxHeartRate, restingHeartRate, minFraction, maxFraction) {
  const min = calcTargetHeartRate(maxHeartRate, restingHeartRate, minFraction);
  const max = calcTargetHeartRate(maxHeartRate, restingHeartRate, maxFraction);
  if (min == null || max == null) return null;
  if (min > max) return { min: max, max: min };
  return { min, max };
}

/** MHR target: % of maximum heart rate, no resting HR in the formula. */
function calcMhrTargetHeartRate(maxHeartRate, fraction) {
  if (!isPositiveFinite(maxHeartRate) || !isFraction(fraction)) return null;
  return Math.round(maxHeartRate * fraction);
}

function calcMhrTargetHeartRateRange(maxHeartRate, minFraction, maxFraction) {
  const min = calcMhrTargetHeartRate(maxHeartRate, minFraction);
  const max = calcMhrTargetHeartRate(maxHeartRate, maxFraction);
  if (min == null || max == null) return null;
  if (min > max) return { min: max, max: min };
  return { min, max };
}

// Age-based estimate only. Clearly labelled as an estimate, not a measurement.
function estimateMaxHeartRate(age) {
  if (validateAge(age) != null) return null;
  return 220 - age;
}

/**
 * Measured MHR wins. The age estimate is used only when no measured value was
 * supplied, and it never overwrites one.
 */
function resolveHeartRateInputs(input) {
  const errors = [];
  const resting = input.restingHeartRate;
  const restingError = validateRestingHeartRate(resting);
  if (restingError) errors.push(restingError);

  const age = input.age;
  const ageError = age == null ? null : validateAge(age);
  if (ageError) errors.push(ageError);

  const estimated = age != null && ageError == null ? estimateMaxHeartRate(age) : null;

  let maxHeartRate = null;
  let source = null;

  if (input.measuredMaxHeartRate != null) {
    const measuredError = validateMeasuredMaxHeartRate(input.measuredMaxHeartRate, resting);
    if (measuredError) errors.push(measuredError);
    else {
      maxHeartRate = input.measuredMaxHeartRate;
      source = 'measured';
    }
  } else if (age == null) {
    errors.push('Enter an age for the estimate, or a measured max heart rate.');
  } else if (ageError == null) {
    maxHeartRate = estimated;
    source = 'estimated';
  }

  if (maxHeartRate == null || source == null || !isPositiveFinite(resting)) {
    return { value: null, errors: dedupe(errors) };
  }
  if (resting >= maxHeartRate) {
    errors.push('Resting heart rate must be lower than max heart rate.');
    return { value: null, errors: dedupe(errors) };
  }

  return {
    value: {
      maxHeartRate,
      maxHeartRateSource: source,
      estimatedMaxHeartRate: estimated,
      restingHeartRate: resting,
      heartRateReserve: maxHeartRate - resting,
    },
    errors: dedupe(errors),
  };
}

function calcTargetRangeForBand(input) {
  const band = getK11IntensityBand(input.intensity);
  if (!band || !isCardioCalculationMethod(input.method)) return null;
  const range = input.method === 'mhr'
    ? calcMhrTargetHeartRateRange(input.maxHeartRate, band.minFraction, band.maxFraction)
    : calcTargetHeartRateRange(input.maxHeartRate, input.restingHeartRate, band.minFraction, band.maxFraction);
  if (!range) return null;
  return {
    minBpm: range.min,
    maxBpm: range.max,
    minFraction: band.minFraction,
    maxFraction: band.maxFraction,
    method: input.method,
    basisLabel: input.method === 'mhr' ? '% MHR' : '% HRR',
  };
}

function classifyCardioModality(modality) {
  if (!modality) return null;
  const key = String(modality).trim().toLowerCase();
  if (!key) return null;
  if (CARDIO_MODALITY_CATEGORY[key]) return CARDIO_MODALITY_CATEGORY[key];
  if (/(^|\s)(run|jog|sprint|jump rope|treadmill)(\s|$)/.test(key)) return 'weight-bearing-high-impact';
  if (/(^|\s)(walk|elliptical|hike|stair|climber)(\s|$)/.test(key)) return 'weight-bearing-low-impact';
  if (/(^|\s)(cycl|row|swim|bike|erg)(\s|$)/.test(key)) return 'non-weight-bearing';
  return null;
}

function buildCardioSession(maxHeartRate, restingHeartRate, phases) {
  if (calcHrr(maxHeartRate, restingHeartRate) == null) return null;
  if (!Array.isArray(phases)) return null;
  const out = [];
  let total = 0;
  for (const p of phases) {
    if (!p || !Number.isInteger(p.durationMinutes) || p.durationMinutes < 0) return null;
    let thr = null;
    let range = null;
    if (p.intensityFraction != null) {
      if (!isFraction(p.intensityFraction)) return null;
      thr = calcTargetHeartRate(maxHeartRate, restingHeartRate, p.intensityFraction);
      if (thr == null) return null;
    }
    if (p.minFraction != null || p.maxFraction != null) {
      if (p.minFraction == null || p.maxFraction == null) return null;
      if (!isFraction(p.minFraction) || !isFraction(p.maxFraction)) return null;
      range = calcTargetHeartRateRange(maxHeartRate, restingHeartRate, p.minFraction, p.maxFraction);
      if (range == null) return null;
    }
    out.push({
      name: p.name,
      durationMinutes: p.durationMinutes,
      intensityFraction: p.intensityFraction != null ? p.intensityFraction : null,
      targetHeartRate: thr,
      targetHeartRateRange: range,
      notes: p.notes,
    });
    total += p.durationMinutes;
  }
  return { phases: out, totalMinutes: total };
}

function buildFivePhaseCardio(maxHeartRate, restingHeartRate, overrides) {
  const phases = FIVE_PHASE_DEFAULTS.map((base) => {
    // Keys are canonical; names remain accepted for callers written before
    // the keyed template existed.
    const ov = (overrides && (overrides[base.key] || overrides[base.name])) || {};
    return {
      name: base.name,
      durationMinutes: ov.durationMinutes != null ? ov.durationMinutes : base.durationMinutes,
      intensityFraction: ov.intensityFraction != null ? ov.intensityFraction : base.intensityFraction,
    };
  });
  return buildCardioSession(maxHeartRate, restingHeartRate, phases);
}

function buildProgressionPrescription(input) {
  const errors = [];
  const warnings = [];

  const phase = getProgressionPhase(String(input.phase));
  if (!phase) errors.push('Choose a valid progression phase.');

  if (calcHrr(input.maxHeartRate, input.restingHeartRate) == null) {
    errors.push('Max heart rate and resting heart rate must be valid, with resting below max.');
  }

  const intensityError = validateIntensityFraction(input.intensityFraction);
  if (intensityError) errors.push(intensityError);
  else if (phase && (input.intensityFraction < phase.intensityHrr.min || input.intensityFraction > phase.intensityHrr.max)) {
    errors.push(
      `${formatIntensityPercent(input.intensityFraction)} HRR is outside ${phase.label}'s `
      + `${formatIntensityPercent(phase.intensityHrr.min)}-${formatIntensityPercent(phase.intensityHrr.max)} HRR range.`,
    );
  }

  const frequencyError = validateFrequencyPerWeek(input.frequencyPerWeek);
  if (frequencyError) errors.push(frequencyError);
  const minutesError = validateMainWorkMinutes(input.minutesPerSession);
  if (minutesError) errors.push(minutesError);

  if (phase && frequencyError == null && phase.frequencyDays) {
    if (input.frequencyPerWeek < phase.frequencyDays.min || input.frequencyPerWeek > phase.frequencyDays.max) {
      warnings.push(
        `${input.frequencyPerWeek} sessions/week is outside ${phase.label}'s `
        + `${phase.frequencyDays.min}-${phase.frequencyDays.max} day reference.`,
      );
    }
  }
  if (phase && minutesError == null && phase.minutes) {
    if (input.minutesPerSession < phase.minutes.min || input.minutesPerSession > phase.minutes.max) {
      warnings.push(
        `${input.minutesPerSession} min is outside ${phase.label}'s `
        + `${phase.minutes.min}-${phase.minutes.max} min reference.`,
      );
    }
  }
  if (
    frequencyError == null
    && (input.frequencyPerWeek < K11_FITT_REFERENCE.frequencyPerWeek.min
      || input.frequencyPerWeek > K11_FITT_REFERENCE.frequencyPerWeek.max)
  ) {
    warnings.push(
      `${input.frequencyPerWeek} sessions/week is outside the K11 FITT reference of `
      + `${K11_FITT_REFERENCE.frequencyPerWeek.min}-${K11_FITT_REFERENCE.frequencyPerWeek.max}.`,
    );
  }
  if (
    minutesError == null
    && (input.minutesPerSession < K11_FITT_REFERENCE.mainWorkMinutes.min
      || input.minutesPerSession > K11_FITT_REFERENCE.mainWorkMinutes.max)
  ) {
    warnings.push(
      `${input.minutesPerSession} min is outside the K11 FITT main-work reference of `
      + `${K11_FITT_REFERENCE.mainWorkMinutes.min}-${K11_FITT_REFERENCE.mainWorkMinutes.max} min.`,
    );
  }

  if (errors.length > 0 || !phase) return { value: null, errors: dedupe(errors) };

  const prescribedBpm = calcTargetHeartRate(input.maxHeartRate, input.restingHeartRate, input.intensityFraction);
  const referenceRangeBpm = calcTargetHeartRateRange(
    input.maxHeartRate,
    input.restingHeartRate,
    phase.intensityHrr.min,
    phase.intensityHrr.max,
  );
  if (prescribedBpm == null || referenceRangeBpm == null) {
    return { value: null, errors: ['Max heart rate and resting heart rate must be valid, with resting below max.'] };
  }

  return {
    value: {
      phase,
      intensityFraction: input.intensityFraction,
      prescribedBpm,
      referenceRangeBpm,
      frequencyPerWeek: input.frequencyPerWeek,
      minutesPerSession: input.minutesPerSession,
      warnings: dedupe(warnings),
    },
    errors: dedupe(errors),
  };
}

function buildFittPrescription(input) {
  const errors = [];
  const warnings = [];

  if (!isCardioCalculationMethod(input.method)) errors.push('Choose the MHR or Karvonen method.');
  const band = getK11IntensityBand(input.intensity);
  if (!band) errors.push('Choose a valid K11 intensity.');

  const frequencyError = validateFrequencyPerWeek(input.frequencyPerWeek);
  if (frequencyError) errors.push(frequencyError);
  const minutesError = validateMainWorkMinutes(input.mainWorkMinutes);
  if (minutesError) errors.push(minutesError);

  if (!isCardioProgramType(input.programType)) errors.push('Choose a valid cardio programme type.');

  const modality = typeof input.modality === 'string' ? input.modality.trim() : '';
  if (!modality) errors.push('Enter a cardio modality.');
  else if (modality.length > CARDIO_MODALITY_MAX_LENGTH) {
    errors.push(`Modality must be ${CARDIO_MODALITY_MAX_LENGTH} characters or fewer.`);
  }

  if (calcHrr(input.maxHeartRate, input.restingHeartRate) == null) {
    errors.push('Max heart rate and resting heart rate must be valid, with resting below max.');
  }

  if (
    frequencyError == null
    && (input.frequencyPerWeek < K11_FITT_REFERENCE.frequencyPerWeek.min
      || input.frequencyPerWeek > K11_FITT_REFERENCE.frequencyPerWeek.max)
  ) {
    warnings.push(
      `${input.frequencyPerWeek} sessions/week is outside the K11 FITT reference of `
      + `${K11_FITT_REFERENCE.frequencyPerWeek.min}-${K11_FITT_REFERENCE.frequencyPerWeek.max}.`,
    );
  }
  if (
    minutesError == null
    && (input.mainWorkMinutes < K11_FITT_REFERENCE.mainWorkMinutes.min
      || input.mainWorkMinutes > K11_FITT_REFERENCE.mainWorkMinutes.max)
  ) {
    warnings.push(
      `${input.mainWorkMinutes} min is outside the K11 FITT main-work reference of `
      + `${K11_FITT_REFERENCE.mainWorkMinutes.min}-${K11_FITT_REFERENCE.mainWorkMinutes.max} min.`,
    );
  }

  const modalityCategory = modality ? classifyCardioModality(modality) : null;
  if (modality && !modalityCategory) {
    warnings.push('This modality is unclassified; the prescription is still valid.');
  }

  if (errors.length > 0 || !band) return { value: null, errors: dedupe(errors) };

  const targetHeartRate = calcTargetRangeForBand({
    maxHeartRate: input.maxHeartRate,
    restingHeartRate: input.restingHeartRate,
    method: input.method,
    intensity: band.key,
  });
  if (!targetHeartRate) {
    return { value: null, errors: ['Max heart rate and resting heart rate must be valid, with resting below max.'] };
  }

  return {
    value: {
      frequencyPerWeek: input.frequencyPerWeek,
      intensity: band,
      targetHeartRate,
      mainWorkMinutes: input.mainWorkMinutes,
      modality,
      modalityCategory,
      programType: input.programType,
      warnings: dedupe(warnings),
    },
    errors: dedupe(errors),
  };
}

/**
 * `target_heart_rate` is the rounded midpoint of the prescribed band. The
 * min/max pair is authoritative. These are flat config keys because the
 * canonical workout_exercises table has no heart-rate column; the column of
 * that name lives on the training-domain tables retired by migration 195.
 *
 * Only the progression phase and its %HRR are persisted. The phase reference
 * frequency/time are context, not a second prescription; the FITT frequency
 * and main-work time are the active ones for this exercise.
 */
function toCardioPlanConfig(prescription) {
  const t = prescription.targetHeartRate;
  return {
    cardio_source: 'k11',
    target_heart_rate: Math.round((t.minBpm + t.maxBpm) / 2),
    target_heart_rate_min: t.minBpm,
    target_heart_rate_max: t.maxBpm,
    target_heart_rate_basis: t.basisLabel,
    cardio_method: prescription.method,
    cardio_intensity: prescription.intensity,
    cardio_frequency_per_week: prescription.frequencyPerWeek,
    cardio_main_work_minutes: prescription.mainWorkMinutes,
    cardio_modality: prescription.modality,
    cardio_modality_category: prescription.modalityCategory,
    cardio_program_type: prescription.programType,
    cardio_goal: prescription.goal != null ? prescription.goal : null,
    cardio_progression_phase: prescription.progression != null ? prescription.progression.phase : null,
    cardio_progression_intensity_percent: prescription.progression != null
      ? prescription.progression.intensityPercent
      : null,
  };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/**
 * Validate the cardio keys before a plan PATCH can persist them. A config with
 * no `cardio_source` is legacy/other and is left alone.
 */
function validateCardioPlanConfig(config) {
  if (config == null) return { ok: true, errors: [] };
  if (!isPlainObject(config)) return { ok: false, errors: ['config must be an object.'] };
  if (config.cardio_source == null) return { ok: true, errors: [] };

  const errors = [];
  if (config.cardio_source !== 'k11') errors.push('cardio_source must be "k11".');

  if (!isPositiveInteger(config.target_heart_rate)) {
    errors.push('target_heart_rate must be a positive whole number of beats per minute.');
  }
  if (!isPositiveInteger(config.target_heart_rate_min)) {
    errors.push('target_heart_rate_min must be a positive whole number of beats per minute.');
  }
  if (!isPositiveInteger(config.target_heart_rate_max)) {
    errors.push('target_heart_rate_max must be a positive whole number of beats per minute.');
  }
  if (
    isPositiveInteger(config.target_heart_rate_min)
    && isPositiveInteger(config.target_heart_rate_max)
    && config.target_heart_rate_min > config.target_heart_rate_max
  ) {
    errors.push('target_heart_rate_min must not exceed target_heart_rate_max.');
  }
  if (
    isPositiveInteger(config.target_heart_rate)
    && isPositiveInteger(config.target_heart_rate_min)
    && isPositiveInteger(config.target_heart_rate_max)
    && (config.target_heart_rate < config.target_heart_rate_min || config.target_heart_rate > config.target_heart_rate_max)
  ) {
    errors.push('target_heart_rate must be within target_heart_rate_min and target_heart_rate_max.');
  }
  if (config.target_heart_rate_basis !== '% MHR' && config.target_heart_rate_basis !== '% HRR') {
    errors.push('target_heart_rate_basis must be "% MHR" or "% HRR".');
  }
  if (!isCardioCalculationMethod(config.cardio_method)) errors.push('cardio_method must be "mhr" or "karvonen".');
  if (
    isCardioCalculationMethod(config.cardio_method)
    && (config.target_heart_rate_basis === '% MHR' || config.target_heart_rate_basis === '% HRR')
  ) {
    const expectedBasis = config.cardio_method === 'mhr' ? '% MHR' : '% HRR';
    if (config.target_heart_rate_basis !== expectedBasis) {
      errors.push(`cardio_method "${config.cardio_method}" must use the "${expectedBasis}" basis.`);
    }
  }
  if (!isCardioIntensity(config.cardio_intensity)) errors.push('cardio_intensity must be a K11 intensity.');
  if (validateFrequencyPerWeek(config.cardio_frequency_per_week) != null) {
    errors.push(validateFrequencyPerWeek(config.cardio_frequency_per_week));
  }
  if (validateMainWorkMinutes(config.cardio_main_work_minutes) != null) {
    errors.push(validateMainWorkMinutes(config.cardio_main_work_minutes));
  }
  if (typeof config.cardio_modality !== 'string' || config.cardio_modality.trim() === '') {
    errors.push('cardio_modality must be a non-empty string.');
  } else if (config.cardio_modality.length > CARDIO_MODALITY_MAX_LENGTH) {
    errors.push(`cardio_modality must be ${CARDIO_MODALITY_MAX_LENGTH} characters or fewer.`);
  }
  if (config.cardio_modality_category != null && !isCardioModalityCategory(config.cardio_modality_category)) {
    errors.push('cardio_modality_category is not recognised.');
  }
  if (typeof config.cardio_modality === 'string' && config.cardio_modality.trim() !== '') {
    const expectedCategory = classifyCardioModality(config.cardio_modality);
    if (config.cardio_modality_category !== expectedCategory) {
      errors.push('cardio_modality_category must match cardio_modality.');
    }
  }
  if (!isCardioProgramType(config.cardio_program_type)) {
    errors.push('cardio_program_type is not recognised.');
  }
  if (config.cardio_goal != null && (typeof config.cardio_goal !== 'string' || config.cardio_goal.length > 80)) {
    errors.push('cardio_goal must be a string of 80 characters or fewer, or null.');
  }
  if (config.cardio_progression_phase != null && !isProgressionPhase(config.cardio_progression_phase)) {
    errors.push('cardio_progression_phase is not recognised.');
  }
  if (config.cardio_progression_intensity_percent != null) {
    const pct = config.cardio_progression_intensity_percent;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      errors.push('cardio_progression_intensity_percent must be between 0 and 100.');
    }
  }
  const progressionPhase = getProgressionPhase(config.cardio_progression_phase);
  if (config.cardio_progression_phase != null && config.cardio_progression_intensity_percent == null) {
    errors.push('cardio_progression_intensity_percent is required with a progression phase.');
  }
  if (config.cardio_progression_phase == null && config.cardio_progression_intensity_percent != null) {
    errors.push('cardio_progression_phase is required with a progression intensity.');
  }
  if (progressionPhase && typeof config.cardio_progression_intensity_percent === 'number') {
    const fraction = config.cardio_progression_intensity_percent / 100;
    if (fraction < progressionPhase.intensityHrr.min || fraction > progressionPhase.intensityHrr.max) {
      errors.push(
        `cardio_progression_intensity_percent is outside ${progressionPhase.label}'s `
        + `${progressionPhase.intensityHrr.min * 100}-${progressionPhase.intensityHrr.max * 100}% HRR range.`,
      );
    }
  }

  return { ok: errors.length === 0, errors: dedupe(errors) };
}

module.exports = {
  K11_INTENSITY_BANDS,
  K11_TRAINEE_LEVELS,
  CARDIO_GOALS,
  CARDIO_PROGRAM_TYPES,
  CARDIO_MODALITY_CATEGORIES,
  K11_FITT_REFERENCE,
  CARDIO_FREQUENCY_LIMITS,
  CARDIO_MAIN_WORK_LIMITS,
  CARDIO_MODALITY_MAX_LENGTH,
  K11_PROGRESSION_PHASES,
  FIVE_PHASE_DEFAULTS,
  FIVE_PHASE_CARDIO_TOTAL_MINUTES,
  CARDIO_MODALITY_CATEGORY,
  getK11IntensityBand,
  getProgressionPhase,
  isCardioIntensity,
  isCardioCalculationMethod,
  isCardioProgramType,
  isProgressionPhase,
  isCardioModalityCategory,
  formatIntensityPercent,
  validateAge,
  validateRestingHeartRate,
  validateMaxHeartRate,
  validateMeasuredMaxHeartRate,
  validateIntensityFraction,
  validateFrequencyPerWeek,
  validateMainWorkMinutes,
  calcHrr,
  calcTargetHeartRate,
  calcTargetHeartRateRange,
  calcMhrTargetHeartRate,
  calcMhrTargetHeartRateRange,
  estimateMaxHeartRate,
  resolveHeartRateInputs,
  calcTargetRangeForBand,
  classifyCardioModality,
  buildCardioSession,
  buildFivePhaseCardio,
  buildProgressionPrescription,
  buildFittPrescription,
  toCardioPlanConfig,
  validateCardioPlanConfig,
};

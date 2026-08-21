// What a prescription type means, and which fields it makes sense of.
//
// ── The problem this solves ────────────────────────────────────────────────
//
// workout_template_exercises is deliberately wide: target_sets sits next to
// target_distance sits next to work_interval_seconds. That is right for
// storage — every one of those columns is queried — but it means a row on its
// own does not say which of its columns are meaningful. A SETS_REPS row with
// a stray target_incline is not a treadmill workout; it is a data-entry
// accident that a validator should have caught.
//
// prescription_type is the discriminator, and this module is the one place
// that knows what each type implies. Everything downstream — the validator,
// the API, the builder UI's field list, the client's logging screen — asks
// here rather than carrying its own copy of the rules. A second copy is how
// the UI ends up offering a field the API rejects.
//
// Pure data and pure functions. No database, no request, no clock.
'use strict';

const PRESCRIPTION_TYPES = [
  'SETS_REPS', 'WEIGHT_REPS', 'RPE_BASED', 'RIR_BASED', 'PERCENT_1RM',
  'TIME', 'DISTANCE', 'TIME_DISTANCE', 'TIME_SPEED', 'DISTANCE_LOAD', 'TIME_LOAD',
  'PACE', 'SPEED', 'CALORIES', 'HEART_RATE', 'RPE', 'RPM', 'STEPS', 'FLOORS', 'HOLD',
  'INTERVAL', 'ROUNDS', 'AMRAP', 'EMOM', 'CIRCUIT', 'BODYWEIGHT', 'MOBILITY', 'CUSTOM',
];

const SECTIONS = [
  'WARMUP', 'ACTIVATION', 'MAIN', 'ACCESSORY',
  'CARDIO', 'CONDITIONING', 'COOLDOWN', 'MOBILITY',
];

/**
 * Which fields each type uses.
 *
 *   required  at least one of these must be present, or the prescription says
 *             nothing. "4 sets" with no reps is still a prescription; a
 *             SETS_REPS row with neither is an empty row wearing a type.
 *   optional  meaningful, not demanded.
 *
 * Anything in neither list is NOT APPLICABLE for that type, and setting it is
 * the accident described above.
 *
 * `rest`, `notes` and `tempo` are omitted throughout because they apply to
 * every type and listing them seventeen times would bury the distinctions.
 */
const FIELDS = {
  SETS_REPS:    { required: ['target_sets', 'target_reps_min'],
                  optional: ['target_reps_max', 'target_weight', 'target_rpe', 'target_rir'] },
  WEIGHT_REPS:  { required: ['target_weight', 'target_reps_min'],
                  optional: ['target_sets', 'target_reps_max', 'target_rpe'] },
  RPE_BASED:    { required: ['target_rpe'],
                  optional: ['target_sets', 'target_reps_min', 'target_reps_max', 'target_weight'] },
  RIR_BASED:    { required: ['target_rir'],
                  optional: ['target_sets', 'target_reps_min', 'target_reps_max', 'target_weight'] },
  PERCENT_1RM:  { required: ['percentage_1rm'],
                  optional: ['target_sets', 'target_reps_min', 'target_reps_max', 'percentage_metric'] },

  TIME:         { required: ['target_duration_seconds'],
                  optional: ['target_rpe', 'target_heart_rate', 'target_calories'] },
  DISTANCE:     { required: ['target_distance'],
                  optional: ['distance_unit', 'target_rpe', 'target_heart_rate', 'target_calories'] },
  TIME_DISTANCE:{ required: ['target_duration_seconds', 'target_distance'],
                  optional: ['distance_unit', 'target_speed', 'target_incline', 'target_resistance',
                             'target_heart_rate', 'target_calories', 'target_rpe'] },
  TIME_SPEED:   { required: ['target_duration_seconds'],
                  optional: ['target_speed', 'target_incline', 'target_resistance',
                             'target_heart_rate', 'target_calories', 'target_rpe'] },
  DISTANCE_LOAD:{ required: ['target_distance'],
                  optional: ['distance_unit', 'target_weight', 'weight_unit', 'target_rounds',
                             'target_rest_seconds', 'target_rpe'] },
  TIME_LOAD:    { required: ['target_duration_seconds'],
                  optional: ['target_weight', 'weight_unit', 'target_resistance',
                             'target_rounds', 'target_rest_seconds', 'target_rpe'] },
  PACE:         { required: ['target_pace_seconds'],
                  optional: ['target_distance', 'distance_unit', 'target_duration_seconds', 'target_rpe'] },
  SPEED:        { required: ['target_speed'],
                  optional: ['target_duration_seconds', 'target_distance', 'distance_unit',
                             'target_incline', 'target_resistance', 'target_rpe'] },
  CALORIES:     { required: ['target_calories'],
                  optional: ['target_duration_seconds', 'target_distance', 'distance_unit',
                             'target_rpe', 'target_heart_rate'] },
  HEART_RATE:   { required: ['target_heart_rate'],
                  optional: ['target_duration_seconds', 'target_distance', 'distance_unit',
                             'target_rpe'] },
  RPE:          { required: ['target_rpe'],
                  optional: ['target_duration_seconds', 'target_distance', 'distance_unit',
                             'target_speed', 'target_heart_rate'] },
  RPM:          { required: ['target_cadence'],
                  optional: ['target_duration_seconds', 'target_distance', 'distance_unit',
                             'target_resistance', 'target_rpe'] },
  STEPS:        { required: ['target_steps'],
                  optional: ['target_duration_seconds', 'target_rpe', 'target_heart_rate'] },
  FLOORS:       { required: ['target_floors'],
                  optional: ['target_duration_seconds', 'target_steps', 'target_rpe', 'target_heart_rate'] },
  HOLD:         { required: ['target_duration_seconds'],
                  optional: ['target_sets', 'target_rest_seconds', 'target_rpe'] },

  INTERVAL:     { required: ['work_interval_seconds', 'target_rounds'],
                  optional: ['rest_interval_seconds', 'target_rpe', 'target_heart_rate'] },
  ROUNDS:       { required: ['target_rounds'],
                  optional: ['target_duration_seconds', 'work_interval_seconds',
                             'rest_interval_seconds', 'target_rpe'] },
  AMRAP:        { required: ['target_duration_seconds'],
                  optional: ['target_reps_min', 'target_weight', 'target_rpe'] },
  EMOM:         { required: ['target_rounds'],
                  optional: ['work_interval_seconds', 'target_reps_min', 'target_weight'] },
  CIRCUIT:      { required: ['target_rounds'],
                  optional: ['work_interval_seconds', 'rest_interval_seconds', 'target_reps_min',
                             'target_duration_seconds'] },

  BODYWEIGHT:   { required: ['target_sets', 'target_reps_min'],
                  optional: ['target_reps_max', 'target_rpe', 'target_rir'] },
  MOBILITY:     { required: ['target_duration_seconds'],
                  optional: ['target_sets', 'target_reps_min'] },
  // The escape hatch. A trainer describing something the model does not cover
  // writes it in notes, and nothing is demanded — the alternative is a
  // validator that refuses a legitimate workout because it lacks a category.
  CUSTOM:       { required: [], optional: Object.freeze([]) },
};

/** Types whose performance is logged as sets. */
const SET_BASED = new Set([
  'SETS_REPS', 'WEIGHT_REPS', 'RPE_BASED', 'RIR_BASED', 'PERCENT_1RM',
  'AMRAP', 'EMOM', 'BODYWEIGHT',
]);

/** Types whose performance is logged as a cardio effort. */
const CARDIO_BASED = new Set([
  'TIME', 'DISTANCE', 'TIME_DISTANCE', 'TIME_SPEED', 'DISTANCE_LOAD', 'TIME_LOAD',
  'PACE', 'SPEED', 'CALORIES', 'HEART_RATE', 'RPE', 'RPM', 'STEPS', 'FLOORS', 'HOLD',
  'INTERVAL', 'ROUNDS', 'CIRCUIT', 'MOBILITY',
]);

/**
 * Which performance table a prescription is logged into.
 *
 * This is the decision the whole schema split turns on, and it belongs here
 * rather than in the route: the client's logging screen, the API's validator
 * and the PR engine all need the same answer, and they must not each guess.
 *
 * CUSTOM returns 'either' honestly rather than picking one — a custom
 * prescription may be logged whichever way suits it, and a function that
 * pretended to know would be wrong half the time.
 */
function performanceKind(prescriptionType) {
  if (SET_BASED.has(prescriptionType)) return 'sets';
  if (CARDIO_BASED.has(prescriptionType)) return 'cardio';
  return 'either';
}

function isKnownType(t) { return PRESCRIPTION_TYPES.includes(t); }

/** Every field this type can meaningfully carry. */
function fieldsFor(prescriptionType) {
  const spec = FIELDS[prescriptionType];
  if (!spec) return [];
  return [...spec.required, ...spec.optional];
}

function appliesTo(prescriptionType, field) {
  return fieldsFor(prescriptionType).includes(field);
}

const isSet = (v) => v !== null && v !== undefined && v !== '';

/**
 * Check a prescription against its own type.
 *
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 *
 * The split matters. An `error` is a prescription that cannot be performed —
 * a TIME_DISTANCE row with no duration and no distance tells the client
 * nothing. A `warning` is a field that does not belong to the type: harmless
 * to store, worth surfacing, and NOT a reason to refuse a trainer's save.
 * Refusing here would mean a trainer changing a row from SETS_REPS to TIME
 * cannot save until they have hunted down every stale field, which is how a
 * validator gets switched off.
 */
function validate(row) {
  const errors = [];
  const warnings = [];
  const type = row?.prescription_type;

  if (!isKnownType(type)) {
    return { valid: false, errors: [`Unknown prescription_type: ${type}`], warnings };
  }

  const spec = FIELDS[type];
  if (spec.required.length && !spec.required.some((f) => isSet(row[f]))) {
    errors.push(
      `A ${type} prescription needs at least one of: ${spec.required.join(', ')}`
    );
  }

  // A distance with no unit is a number nobody can read back. The database
  // says so too (cp_distance_needs_unit); saying it here as well means the
  // trainer gets a sentence rather than a constraint violation.
  if (isSet(row.target_distance) && !isSet(row.distance_unit)) {
    errors.push('A target distance needs a distance_unit (m, km or mile)');
  }

  if (isSet(row.target_reps_min) && isSet(row.target_reps_max)
      && Number(row.target_reps_max) < Number(row.target_reps_min)) {
    errors.push('target_reps_max cannot be below target_reps_min');
  }

  for (const [field, range] of Object.entries({
    target_rpe: [0, 10], target_rir: [0, 10], percentage_1rm: [0, 200],
  })) {
    if (isSet(row[field])) {
      const n = Number(row[field]);
      if (!Number.isFinite(n) || n < range[0] || n > range[1]) {
        errors.push(`${field} must be between ${range[0]} and ${range[1]}`);
      }
    }
  }

  for (const field of Object.keys(row)) {
    if (!field.startsWith('target_') && !['percentage_1rm', 'work_interval_seconds',
      'rest_interval_seconds', 'distance_unit', 'percentage_metric'].includes(field)) continue;
    if (isSet(row[field]) && !appliesTo(type, field)) {
      warnings.push(`${field} has no meaning for a ${type} prescription and will be ignored`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * A prescription as a trainer would say it out loud.
 *
 * Used by the PDF, the client's screen and the AI brief, so it lives here
 * rather than in a React component — three renderers of the same sentence
 * drift, and the one in the PDF is the one nobody notices has drifted.
 */
function describe(row, exerciseName = '') {
  const type = row?.prescription_type;
  const bits = [];
  const name = exerciseName ? `${exerciseName}: ` : '';

  const reps = isSet(row.target_reps_max) && Number(row.target_reps_max) !== Number(row.target_reps_min)
    ? `${row.target_reps_min}-${row.target_reps_max}`
    : row.target_reps_min;

  if (SET_BASED.has(type)) {
    if (isSet(row.target_sets) && isSet(reps)) bits.push(`${row.target_sets} × ${reps}`);
    else if (isSet(row.target_sets)) bits.push(`${row.target_sets} sets`);
    else if (isSet(reps)) bits.push(`${reps} reps`);
    if (isSet(row.target_weight)) bits.push(`${row.target_weight}${row.weight_unit || 'kg'}`);
    if (isSet(row.percentage_1rm)) bits.push(`${row.percentage_1rm}% 1RM`);
  } else {
    if (isSet(row.target_rounds)) bits.push(`${row.target_rounds} rounds`);
    if (isSet(row.work_interval_seconds)) {
      const rest = isSet(row.rest_interval_seconds) ? ` / ${row.rest_interval_seconds}s rest` : '';
      bits.push(`${row.work_interval_seconds}s work${rest}`);
    }
    if (isSet(row.target_duration_seconds)) bits.push(`${Math.round(row.target_duration_seconds / 60)} min`);
    if (isSet(row.target_distance)) bits.push(`${row.target_distance} ${row.distance_unit || ''}`.trim());
    if (isSet(row.target_pace_seconds)) bits.push(`pace ${row.target_pace_seconds}s`);
    if (isSet(row.target_speed)) bits.push(`${row.target_speed} km/h`);
    if (isSet(row.target_weight)) bits.push(`${row.target_weight}${row.weight_unit || 'kg'}`);
    if (isSet(row.target_cadence)) bits.push(`${row.target_cadence} rpm`);
    if (isSet(row.target_floors)) bits.push(`${row.target_floors} floors`);
    if (isSet(row.target_steps)) bits.push(`${row.target_steps} steps`);
    if (isSet(row.target_incline)) bits.push(`${row.target_incline}% incline`);
    if (isSet(row.target_resistance)) bits.push(`resistance ${row.target_resistance}`);
    if (isSet(row.target_calories)) bits.push(`${row.target_calories} kcal`);
    if (isSet(row.target_heart_rate)) bits.push(`${row.target_heart_rate} bpm`);
  }

  if (isSet(row.target_rpe)) bits.push(`RPE ${row.target_rpe}`);
  else if (isSet(row.target_rir)) bits.push(`RIR ${row.target_rir}`);
  if (isSet(row.target_rest_seconds)) bits.push(`rest ${row.target_rest_seconds}s`);

  return `${name}${bits.join(' · ')}`.trim();
}

module.exports = {
  PRESCRIPTION_TYPES, SECTIONS, FIELDS,
  SET_BASED, CARDIO_BASED,
  performanceKind, isKnownType, fieldsFor, appliesTo,
  validate, describe,
};

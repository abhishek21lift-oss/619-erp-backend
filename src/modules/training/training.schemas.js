// Request validation for the training domain.
//
// Every write endpoint validates here before it reaches a service. Frontend
// validation is a convenience for the person typing; this is the one that
// decides what enters the database.
//
// The enums are imported from the domain modules rather than retyped, so a
// prescription type the schema accepts is always one prescription.js knows
// how to interpret. Two lists would drift, and the failure is quiet: the API
// stores a type nothing downstream can read.
'use strict';

const { z } = require('../../lib/validation');
const { PRESCRIPTION_TYPES, SECTIONS } = require('./prescription');
const { PROGRESSION_TYPES } = require('./progression');

const uuid = z.string().uuid();
const optionalUuid = uuid.optional().nullable();
// Clients, trainers and users still carry TEXT ids, so a uuid() here would
// reject every real client. See migration 164's header.
const legacyId = z.string().min(1).max(64);

const weightUnit   = z.enum(['kg', 'lb']);
const distanceUnit = z.enum(['m', 'km', 'mile']);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** 0-10 covers both scales: RIR is 0-5, RPE is 6-10. */
const rpe = z.coerce.number().min(0).max(10);
const rir = z.coerce.number().int().min(0).max(10);

const nonNegative = z.coerce.number().min(0);
const positiveInt = z.coerce.number().int().positive();

// Bounded rather than open: a duration of 10^9 seconds is a typo or an
// attack, and either way it is not a workout. 24 hours is generous for a
// single effort and still refuses a number that would break every chart.
const durationSeconds = z.coerce.number().int().min(0).max(86400);
const distance = z.coerce.number().min(0).max(1000000);

const metadata = z.record(z.string(), z.unknown()).optional();

// ── Programs ───────────────────────────────────────────────────────────────

const programCreate = {
  body: z.object({
    name: z.string().min(1).max(200),
    client_id: legacyId.optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    goal: z.string().max(200).optional().nullable(),
    program_type: z.enum([
      'GENERAL_FITNESS', 'FAT_LOSS', 'MUSCLE_GAIN', 'STRENGTH', 'POWERLIFTING',
      'BODYBUILDING', 'CONDITIONING', 'SPORT_SPECIFIC', 'REHAB', 'CUSTOM',
    ]).optional(),
    duration_weeks: z.coerce.number().int().min(1).max(104).optional().nullable(),
    start_date: isoDate.optional().nullable(),
    end_date: isoDate.optional().nullable(),
    notes: z.string().max(4000).optional().nullable(),
    metadata,
  }),
};

const programUpdate = {
  body: programCreate.body.partial().extend({
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
  }),
};

const phaseCreate = {
  body: z.object({
    name: z.string().min(1).max(200),
    phase_order: z.coerce.number().int().min(1).max(50).optional(),
    week_start: z.coerce.number().int().min(1).max(104),
    week_end: z.coerce.number().int().min(1).max(104),
    goal: z.string().max(200).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  // A phase ending before it starts is a typo. Caught here so the operator
  // gets a sentence instead of a constraint violation from Postgres.
  }).refine((b) => b.week_end >= b.week_start, {
    message: 'week_end cannot be before week_start', path: ['week_end'],
  }),
};

const weekCreate = {
  body: z.object({
    week_number: z.coerce.number().int().min(1).max(104),
    phase_id: optionalUuid,
    name: z.string().max(200).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    is_deload: z.boolean().optional(),
  }),
};

// ── Templates and prescriptions ────────────────────────────────────────────

// The base object, kept separate from the refined create schema: .refine()
// returns a wrapped type with no way back to the object, so the update
// schema has to build from this rather than unwrap that.
const templateBody = z.object({
    name: z.string().min(1).max(200),
    program_id: optionalUuid,
    week_id: optionalUuid,
    day_number: z.coerce.number().int().min(1).max(7).optional().nullable(),
    day_label: z.string().max(50).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    goal: z.string().max(200).optional().nullable(),
    estimated_duration_minutes: z.coerce.number().int().min(0).max(600).optional().nullable(),
    notes: z.string().max(4000).optional().nullable(),
    metadata,
});

// Mirrors the wt_week_day_agree CHECK: a day inside a week must say which day
// it is, and a standalone template must not pretend to.
const templateCreate = {
  body: templateBody.refine((b) => (b.week_id == null) === (b.day_number == null), {
    message: 'week_id and day_number must be set together', path: ['day_number'],
  }),
};

const templateUpdate = { body: templateBody.partial() };

/**
 * A prescription.
 *
 * Deliberately permissive about WHICH target fields are present — that is
 * prescription.validate()'s job, and it knows the type's field map. Doing it
 * twice, in two places, is how the two disagree.
 *
 * What this layer owns is shape and range: a number is a number, an enum is
 * in its set, a distance carries a unit.
 */
const prescriptionBody = z.object({
  exercise_id: legacyId,
  section: z.enum(SECTIONS).optional(),
  order_index: z.coerce.number().int().min(0).max(999).optional(),
  superset_group: z.string().max(20).optional().nullable(),
  circuit_group: z.string().max(20).optional().nullable(),
  prescription_type: z.enum(PRESCRIPTION_TYPES).optional(),

  target_sets: z.coerce.number().int().min(0).max(99).optional().nullable(),
  target_reps_min: z.coerce.number().int().min(0).max(999).optional().nullable(),
  target_reps_max: z.coerce.number().int().min(0).max(999).optional().nullable(),
  target_weight: nonNegative.max(2000).optional().nullable(),
  weight_unit: weightUnit.optional(),
  target_rpe: rpe.optional().nullable(),
  target_rir: rir.optional().nullable(),
  target_tempo: z.string().max(20).optional().nullable(),
  target_rest_seconds: z.coerce.number().int().min(0).max(3600).optional().nullable(),
  percentage_1rm: z.coerce.number().min(0).max(200).optional().nullable(),
  percentage_metric: z.string().max(40).optional().nullable(),

  target_duration_seconds: durationSeconds.optional().nullable(),
  target_distance: distance.optional().nullable(),
  distance_unit: distanceUnit.optional().nullable(),
  target_speed: nonNegative.max(100).optional().nullable(),
  target_incline: z.coerce.number().min(-30).max(100).optional().nullable(),
  target_resistance: nonNegative.max(100).optional().nullable(),
  target_cadence: z.coerce.number().int().min(0).max(300).optional().nullable(),
  target_floors: z.coerce.number().int().min(0).max(100000).optional().nullable(),
  target_steps: z.coerce.number().int().min(0).max(1000000).optional().nullable(),
  target_heart_rate: z.coerce.number().int().min(20).max(250).optional().nullable(),
  target_calories: z.coerce.number().int().min(0).max(100000).optional().nullable(),
  target_pace_seconds: z.coerce.number().int().min(0).max(86400).optional().nullable(),

  work_interval_seconds: z.coerce.number().int().min(0).max(86400).optional().nullable(),
  rest_interval_seconds: z.coerce.number().int().min(0).max(86400).optional().nullable(),
  target_rounds: z.coerce.number().int().min(0).max(999).optional().nullable(),

  warmup: z.boolean().optional(),
  optional: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
  progression_type: z.enum(PROGRESSION_TYPES).optional(),
  metadata,
});

const prescriptionCreate = { body: prescriptionBody };
const prescriptionUpdate = { body: prescriptionBody.partial() };

const reorder = {
  body: z.object({ exercise_ids: z.array(uuid).min(1).max(200) }),
};

module.exports = {
  programCreate, programUpdate, phaseCreate, weekCreate,
  templateCreate, templateUpdate,
  prescriptionCreate, prescriptionUpdate, reorder,
  positiveInt,
};

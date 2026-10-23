'use strict';
// K11 four-test flexibility battery (protocol k11-2026.01).
//
// Step 7 of the fitness assessment used to be a free-form two-slot battery.
// The supplied K11 protocol replaces it with four tests recorded in a fixed
// order, each measuring a different joint with its own raw values and its own
// interpretation. Two consequences are deliberate:
//
//   - The derived score columns for a v3 row stay null. There is no honest
//     single 0-100 "mobility score" across centimetres, degrees and inches.
//   - The hamstrings 70-80° window is THIS protocol's reference range (the one
//     the supplied K11 material defines), not a population norm. The supplied
//     material also has the YMCA sit-and-reach table, applied when age and sex
//     are known; without them a stored norm is preserved rather than invented.
//
// The stored payload is built here and only here (assembleStored), and the
// frontend mirrors deriveFlexibility in src/lib/flexibility-protocol.ts for
// live display; scripts/assert-scoring-parity.ts keeps the mirror honest.

const { z } = require('../../lib/validation');
const { checkAsymmetry, classifySitAndReach, K11_SIT_AND_REACH_TABLE_VERSION } = require('./fitness-scoring');

const PROTOCOL_VERSION = 'k11-2026.01';
const ZERO_POINT_INCHES = 15;
const HAMSTRINGS_REFERENCE = Object.freeze({
  min_deg: 70,
  max_deg: 80,
  note: 'Reference range from the supplied K11 protocol',
});
const NORM_UNAVAILABLE = Object.freeze({
  table_version: null,
  category: null,
  message: 'Norm classification unavailable',
});

const TIGHTNESS = ['Normal', 'Mild', 'Moderate', 'Marked'];
const HIP_TIGHTNESS = ['Normal', 'Possible restriction', 'Requires reassessment'];
const THIGH_POSITIONS = ['below', 'at', 'above'];

const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);
const str = (v) => (typeof v === 'string' ? v : '');
const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(x) ? x : null;
};
const enumOrNull = (allowed, v) => (allowed.includes(v) ? v : null);
const round2 = (x) => Math.round(x * 100) / 100;

/** A test is recorded two ways: completed, or unable to complete with a reason. */
function testState(raw) {
  const r = raw || {};
  const unable = r.unable_to_complete === true;
  return {
    completed: !unable && r.completed === true,
    unable_to_complete: unable,
    unable_reason: unable && typeof r.unable_reason === 'string' ? r.unable_reason : null,
  };
}

function unableResult(state) {
  return { completed: false, unable_to_complete: true, unable_reason: state.unable_reason };
}

function deriveQuadriceps(raw) {
  const state = testState(raw);
  if (state.unable_to_complete) return unableResult(state);
  const src = (raw && raw.sides) || {};
  const side = (s) => {
    s = s || {};
    return {
      contact: boolOrNull(s.contact),
      distance_cm: n(s.distance_cm),
      pain: boolOrNull(s.pain),
      pelvic_compensation: boolOrNull(s.pelvic_compensation),
      tightness: enumOrNull(TIGHTNESS, s.tightness),
      notes: str(s.notes),
    };
  };
  const left = side(src.left);
  const right = side(src.right);
  // Contact with no pain and no pelvic compensation is the protocol's Normal.
  const interpret = (s) => (s.contact == null ? null
    : s.contact === true && s.pain === false && s.pelvic_compensation === false ? 'Normal' : 'Possible tightness');
  const li = interpret(left);
  const ri = interpret(right);
  return {
    sides: { left, right },
    sides_interpretation: { left: li, right: ri },
    overall_interpretation: li && ri ? (li === 'Normal' && ri === 'Normal' ? 'Normal' : 'Possible tightness') : null,
    completed: state.completed,
    unable_to_complete: false,
    unable_reason: null,
  };
}

function deriveHamstrings(raw) {
  const state = testState(raw);
  if (state.unable_to_complete) return unableResult(state);
  const src = (raw && raw.sides) || {};
  const side = (s) => {
    s = s || {};
    return {
      hip_flexion_deg: n(s.hip_flexion_deg),
      knee_extended: boolOrNull(s.knee_extended),
      pelvic_compensation: boolOrNull(s.pelvic_compensation),
      pain: boolOrNull(s.pain),
      tightness: enumOrNull(TIGHTNESS, s.tightness),
      notes: str(s.notes),
    };
  };
  const left = side(src.left);
  const right = side(src.right);
  const interpret = (s) => {
    if (s.hip_flexion_deg == null) return null;
    if (s.hip_flexion_deg < HAMSTRINGS_REFERENCE.min_deg) return 'Below reference range';
    if (s.hip_flexion_deg > HAMSTRINGS_REFERENCE.max_deg) return 'Above reference range';
    return 'Within reference range';
  };
  // A bent knee or a compensated pelvis moves the pelvis, not the hamstring:
  // the angle no longer measures what the test says, so the reading is
  // repeated instead of interpreted.
  const validity = (s) => (s.knee_extended === false || s.pelvic_compensation === true ? 'invalid_repeat' : 'valid');
  return {
    sides: { left, right },
    reference: {
      min_deg: HAMSTRINGS_REFERENCE.min_deg,
      max_deg: HAMSTRINGS_REFERENCE.max_deg,
      note: HAMSTRINGS_REFERENCE.note,
    },
    sides_interpretation: { left: interpret(left), right: interpret(right) },
    sides_validity: { left: validity(left), right: validity(right) },
    completed: state.completed,
    unable_to_complete: false,
    unable_reason: null,
  };
}

function deriveHipFlexors(raw) {
  const state = testState(raw);
  if (state.unable_to_complete) return unableResult(state);
  const src = (raw && raw.sides) || {};
  const side = (s) => {
    s = s || {};
    return {
      thigh_position: enumOrNull(THIGH_POSITIONS, s.thigh_position),
      knee_flexion_deg: n(s.knee_flexion_deg),
      pelvic_compensation: boolOrNull(s.pelvic_compensation),
      pain: boolOrNull(s.pain),
      tightness: enumOrNull(HIP_TIGHTNESS, s.tightness),
      notes: str(s.notes),
    };
  };
  const left = side(src.left);
  const right = side(src.right);
  // Thomas test: a thigh that stays below the table line with no pelvic
  // compensation is Clear; anything else is a possible restriction, never a
  // diagnosis — the wording is deliberate.
  const interpret = (s) => (s.thigh_position == null ? null
    : s.thigh_position === 'below' && s.pelvic_compensation === false ? 'Clear' : 'Possible hip flexor restriction');
  return {
    sides: { left, right },
    sides_interpretation: { left: interpret(left), right: interpret(right) },
    completed: state.completed,
    unable_to_complete: false,
    unable_reason: null,
  };
}

function deriveSitAndReach(raw, context = {}) {
  const state = testState(raw);
  if (state.unable_to_complete) return unableResult(state);
  const t = raw || {};
  const attempts = (Array.isArray(t.attempts) ? t.attempts : []).map((a) => ({
    inches: n(a && a.inches),
    valid: (a && a.valid) === true,
  }));
  let bestAttemptIndex = null;
  let bestRaw = null;
  attempts.forEach((a, i) => {
    if (a.valid && a.inches != null && (bestRaw == null || a.inches > bestRaw)) {
      bestRaw = a.inches;
      bestAttemptIndex = i;
    }
  });

  // With age and sex, classify the raw reach against K11. Without them (the
  // PDF/history path), preserve a norm already stored in the payload instead
  // of erasing it; a live preview has no stored norm and stays unavailable.
  const contextProvided = context.age != null && context.gender != null;
  const category = classifySitAndReach(bestRaw, context.age, context.gender);
  const stored = t.norm && typeof t.norm === 'object' ? t.norm : null;
  const storedCategory = stored && typeof stored.category === 'string' ? stored.category : null;
  const norm = category
    ? {
      table_version: K11_SIT_AND_REACH_TABLE_VERSION,
      category,
      message: 'K11 age/sex sit-and-reach norm',
    }
    : (!contextProvided && storedCategory
      ? {
        table_version: typeof stored.table_version === 'string' ? stored.table_version : null,
        category: storedCategory,
        message: typeof stored.message === 'string' ? stored.message : NORM_UNAVAILABLE.message,
      }
      : NORM_UNAVAILABLE);

  return {
    attempts,
    best_attempt_index: bestAttemptIndex,
    best_raw_inches: bestRaw,
    zero_point_inches: ZERO_POINT_INCHES,
    // The YMCA board's 15-inch mark is the zero point, so the score is the
    // reach measured past (or short of) it and is legitimately negative.
    score_inches: bestRaw == null ? null : round2(bestRaw - ZERO_POINT_INCHES),
    knee_bending: t.knee_bending === true,
    bouncing: t.bouncing === true,
    notes: str(t.notes),
    norm: {
      table_version: norm.table_version,
      category: norm.category,
      message: norm.message,
    },
    completed: state.completed,
    unable_to_complete: false,
    unable_reason: null,
  };
}

/**
 * The shared derivation: raw recorded observations in, interpretations out.
 * Pure and deterministic — the frontend runs this same function's mirror for
 * the live preview, and the parity script fails if the two ever drift.
 * `context` is the client's age and sex at the time of testing; omit it when
 * replaying a stored payload and the stored norm should be kept.
 */
function deriveFlexibility(recorded, context = {}) {
  const r = recorded || {};
  const t = r.tests || {};
  const quadriceps = deriveQuadriceps(t.quadriceps);
  const hamstrings = deriveHamstrings(t.hamstrings);
  const hip_flexors = deriveHipFlexors(t.hip_flexors);
  const sit_and_reach = deriveSitAndReach(t.sit_and_reach, context);
  const all = [quadriceps, hamstrings, hip_flexors, sit_and_reach];
  const allRecorded = all.every((x) => x.completed);
  const incomplete = all.filter((x) => !x.completed);
  const overrideReason = r.override && typeof r.override.reason === 'string' ? r.override.reason.trim() : '';
  const override_used = !allRecorded && incomplete.length > 0
    && incomplete.every((x) => x.unable_to_complete) && overrideReason !== '';
  const followUp = quadriceps.overall_interpretation === 'Possible tightness'
    || ['left', 'right'].some((s) => (hamstrings.sides_interpretation || {})[s] === 'Below reference range')
    || ['left', 'right'].some((s) => (hamstrings.sides_validity || {})[s] === 'invalid_repeat')
    || ['left', 'right'].some((s) => (hip_flexors.sides_interpretation || {})[s] === 'Possible hip flexor restriction');
  const overall_status = allRecorded
    ? (followUp ? 'follow_up_recommended' : 'all_tests_recorded')
    : (override_used ? 'completed_with_override' : 'incomplete');
  const ql = (quadriceps.sides || {}).left || {};
  const qr = (quadriceps.sides || {}).right || {};
  const hl = (hip_flexors.sides || {}).left || {};
  const hr = (hip_flexors.sides || {}).right || {};
  const has_asymmetry = checkAsymmetry(
    (hamstrings.sides || {}).left ? hamstrings.sides.left.hip_flexion_deg : null,
    (hamstrings.sides || {}).right ? hamstrings.sides.right.hip_flexion_deg : null,
  )
    || (typeof ql.contact === 'boolean' && typeof qr.contact === 'boolean' && ql.contact !== qr.contact)
    || (hl.thigh_position != null && hr.thigh_position != null
      && (hl.thigh_position === 'below') !== (hr.thigh_position === 'below'));
  return {
    tests: { quadriceps, hamstrings, hip_flexors, sit_and_reach },
    override_used,
    overall_status,
    has_asymmetry,
  };
}

// ── Validation ──────────────────────────────────────────────
// Shape and range validation runs on the raw recorded input (never on the
// derived form it produced), so a stored payload replayed through PATCH is
// validated by exactly the same rules as the first save.

const notesField = z.string().max(2000).optional().nullable();

const quadricepsSideSchema = z.object({
  contact: z.boolean(),
  distance_cm: z.coerce.number().min(0).max(60).nullable().optional(),
  pain: z.boolean(),
  pelvic_compensation: z.boolean(),
  tightness: z.enum(['Normal', 'Mild', 'Moderate', 'Marked']),
  notes: notesField,
});

const hamstringsSideSchema = z.object({
  hip_flexion_deg: z.coerce.number().int().min(0).max(180),
  knee_extended: z.boolean(),
  pelvic_compensation: z.boolean(),
  pain: z.boolean(),
  tightness: z.enum(['Normal', 'Mild', 'Moderate', 'Marked']),
  notes: notesField,
});

const hipFlexorsSideSchema = z.object({
  thigh_position: z.enum(['below', 'at', 'above']),
  knee_flexion_deg: z.coerce.number().int().min(0).max(160).nullable().optional(),
  pelvic_compensation: z.boolean(),
  pain: z.boolean(),
  tightness: z.enum(['Normal', 'Possible restriction', 'Requires reassessment']),
  notes: notesField,
});

/** One test: either the recorded values, or unable with a reason. */
function batteryTest(parts, isComplete, message) {
  return z.object({
    ...parts,
    completed: z.boolean().optional(),
    unable_to_complete: z.boolean().optional(),
    unable_reason: z.string().max(500).optional().nullable(),
  }).refine(
    (v) => (v.unable_to_complete === true
      ? typeof v.unable_reason === 'string' && v.unable_reason.trim().length > 0
      : isComplete(v)),
    { message }
  );
}

const quadricepsTestSchema = batteryTest(
  { sides: z.object({ left: quadricepsSideSchema, right: quadricepsSideSchema }).optional() },
  (v) => !!v.sides,
  'Record both sides of the quadriceps test, or record why it cannot be completed.'
);
const hamstringsTestSchema = batteryTest(
  { sides: z.object({ left: hamstringsSideSchema, right: hamstringsSideSchema }).optional() },
  (v) => !!v.sides,
  'Record both sides of the hamstrings test, or record why it cannot be completed.'
);
const hipFlexorsTestSchema = batteryTest(
  { sides: z.object({ left: hipFlexorsSideSchema, right: hipFlexorsSideSchema }).optional() },
  (v) => !!v.sides,
  'Record both sides of the hip flexors test, or record why it cannot be completed.'
);
const sitAndReachTestSchema = batteryTest(
  {
    attempts: z.array(z.object({
      inches: z.coerce.number().min(0).max(60),
      valid: z.boolean(),
    })).min(1).max(3).optional(),
    knee_bending: z.boolean().optional(),
    bouncing: z.boolean().optional(),
    notes: notesField,
  },
  (v) => Array.isArray(v.attempts) && v.attempts.some((a) => a.valid === true),
  'Record 1-3 attempts with at least one valid attempt, or record why it cannot be completed.'
);

const recordedSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  tests: z.object({
    quadriceps: quadricepsTestSchema,
    hamstrings: hamstringsTestSchema,
    hip_flexors: hipFlexorsTestSchema,
    sit_and_reach: sitAndReachTestSchema,
  }),
  override: z.object({ reason: z.string().max(500).optional().nullable() }).optional().nullable(),
});

/** A payload carrying the K11 protocol marker (anything else is legacy). */
const isRecordedBattery = (v) => !!(v && v.protocol_version != null);

/**
 * Strict parse of a recorded battery. Returns the parsed (normalized) input or
 * `{ ok: false, message }` — the route turns that into FLEXIBILITY_INVALID.
 */
function parseRecorded(input) {
  const result = recordedSchema.safeParse(input);
  if (result.success) return { ok: true, recorded: result.data };
  const issue = (result.error.issues && result.error.issues[0]) || {};
  const where = issue.path && issue.path.length ? `${issue.path.join('.')}: ` : '';
  return { ok: false, message: `flexibility_test_data — ${where}${issue.message}` };
}

const TEST_LABELS = {
  quadriceps: 'Quadriceps (prone heel-to-buttock)',
  hamstrings: 'Hamstrings 70° Reach',
  hip_flexors: 'Hip Flexors (Thomas test)',
  sit_and_reach: 'YMCA Sit and Reach',
};

/** Why the battery may not be stored yet, or null when it may. */
function validateForStorage(recorded) {
  const tests = recorded.tests || {};
  const incomplete = Object.keys(TEST_LABELS).filter((k) => !tests[k] || tests[k].completed !== true);
  if (!incomplete.length) return null;
  const stillRecorded = incomplete.filter((k) => !tests[k] || tests[k].unable_to_complete !== true);
  if (stillRecorded.length) {
    return `Still to record: ${stillRecorded.map((k) => TEST_LABELS[k]).join(', ')}. Record each test and mark it complete, or record why it cannot be completed.`;
  }
  const reason = recorded.override && typeof recorded.override.reason === 'string'
    ? recorded.override.reason.trim() : '';
  if (!reason) return 'An override reason is required when a test cannot be completed.';
  return null;
}

/**
 * The stored v3 payload. `prev` is the row's existing stored payload (PATCH
 * only): provenance — who recorded it, when, and who authorized an override —
 * is write-once, so an unrelated edit round-trips the payload byte-identically
 * instead of re-stamping it.
 */
function assembleStored(recorded, { userId = null, prev = null, now = new Date(), age = null, gender = null } = {}) {
  const derived = deriveFlexibility(recorded, { age, gender });
  const previous = prev && prev.protocol_version === PROTOCOL_VERSION ? prev : null;
  const prevOverride = (previous && previous.override) || {};
  const reason = recorded.override && typeof recorded.override.reason === 'string' ? recorded.override.reason.trim() : '';
  const used = derived.override_used;
  return {
    protocol_version: PROTOCOL_VERSION,
    tests: derived.tests,
    override: {
      used,
      reason: used ? reason : null,
      by: used ? (prevOverride.by ?? userId ?? null) : null,
      at: used ? (prevOverride.at ?? now.toISOString()) : null,
    },
    overall_status: derived.overall_status,
    recorded_at: previous && previous.recorded_at ? previous.recorded_at : now.toISOString(),
    assessor_id: previous && previous.assessor_id ? previous.assessor_id : (userId ?? null),
  };
}

module.exports = {
  PROTOCOL_VERSION,
  ZERO_POINT_INCHES,
  HAMSTRINGS_REFERENCE,
  deriveFlexibility,
  assembleStored,
  parseRecorded,
  validateForStorage,
  isRecordedBattery,
};

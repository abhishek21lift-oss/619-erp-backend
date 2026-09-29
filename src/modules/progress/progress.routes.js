const router = require('express').Router();
const pool = require('../../db/pool');
const { auth, requireTrainer } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const { tenantScope, orgIdOf, orgWhere } = require('../../lib/tenant-db');
const { clientInOrg } = require('../../lib/orgGuard');
const { checkScreeningGate } = require('../../lib/screeningGate');
const scoring = require('./fitness-scoring');
const goalScoring = require('./goal-scoring');
const lifestyleScoring = require('./lifestyle-scoring');
const nutritionScoring = require('./nutrition-scoring');
const mobilityScoring = require('./mobility-scoring');
const postureScoring = require('./posture-scoring');
const strengthLogs = require('./strength-logs.repo');
const assessmentsRepo = require('./assessments.repo');
const { today: studioToday } = require('../../lib/appTime');

// The studio trainer only. server.js mounts this router behind requireTrainer
// too; declaring it here as well means the guard travels with the router and
// cannot be lost if the mount is edited or the router is mounted again.
router.use(auth, requireTrainer);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}


// A number with a plausible range. Nothing on these forms was range-checked
// on either side: a stress level of 55 on a 1-10 scale, -3 hours of sleep and
// a 150% body-fat target were all stored, and the scores built on them.
const numIn = (min, max) => z.coerce.number().min(min).max(max).optional().nullable();
const intIn = (min, max) => z.coerce.number().int().min(min).max(max).optional().nullable();

// Free text: bounded here, and the same bound is the field's maxLength on the
// page, so a long note is stopped as it is typed rather than at the last Save.
const text = (max) => z.string().max(max).optional().nullable();
const textList = (item = 200, count = 40) => z.array(z.string().max(item)).max(count).optional().nullable();
const coachNotesSchema = z.record(z.string().max(60), z.string().max(2000)).optional().nullable();

// An assessment is of something that has happened. The screening gate and
// every "latest" read order by this date, so a future-dated one would sit on
// top of today's. One day of slack for a device clock ahead of the server's.
const pastDate = () => z.string().optional().nullable().refine(
  (v) => !v || (!Number.isNaN(Date.parse(v)) && Date.parse(v) <= Date.now() + 86400000),
  { message: 'Date must be a valid date, not in the future' }
);

const assessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    trainer_id: z.string().optional().nullable(),
    assessment_date: pastDate(),
    assessment_type: z.enum(['initial', 'week_4', 'week_8', 'week_12', 'monthly', 'quarterly', 'follow_up', 'custom']).optional(),
    assessment_notes: text(2000),
    age: intIn(5, 110), gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),

    // Step 1 — Blood Pressure
    // Outside these a reading is a typo, not a patient: 900/60 used to be
    // stored with no category, which also switched the safety stop off.
    bp_systolic: numIn(60, 260), bp_diastolic: numIn(30, 160), resting_heart_rate: numIn(25, 220), resting_spo2: numIn(50, 100),

    // Step 2 — Anthropometric
    weight: numIn(20, 350), height_cm: numIn(80, 250), waist_cm: numIn(30, 250), waist_iliac_cm: numIn(30, 250), hips_cm: numIn(30, 250), neck_cm: numIn(15, 80), chest_cm: numIn(40, 250),
    arm_right_cm: numIn(10, 100), arm_left_cm: numIn(10, 100), thigh_right_cm: numIn(20, 150), thigh_left_cm: numIn(20, 150),
    calf_right_cm: numIn(15, 100), calf_left_cm: numIn(15, 100),

    // Step 3 — Body Composition
    body_comp_method: z.enum(['BIA Machine', 'Skinfold', 'DEXA', 'Manual', 'Other']).optional().nullable(),
    body_fat_pct: numIn(2, 75), muscle_mass_pct: numIn(5, 80), visceral_fat: numIn(1, 60), subcutaneous_fat_pct: numIn(1, 70),
    body_water_pct: numIn(20, 80), bone_mass_kg: numIn(0.5, 10), bmr: numIn(500, 5000), bmr_auto_suggested: z.boolean().optional(),
    metabolic_age: intIn(10, 110),

    // Step 4 — Cardiorespiratory Endurance
    cardio_test_type: z.enum(['YMCA 3-Minute Step Test', 'Rockport 1-Mile Walk', 'Cooper 12-Minute Run', 'Bruce Protocol', 'Harvard Step Test', 'Custom']).optional().nullable(),
    cardio_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 5 — Muscular Strength (two distinct tests required, same battery
    // pattern as Endurance below — any exercise can be tested, but exactly
    // two are needed to complete the step)
    strength_exercise: z.string().max(100).optional().nullable(),
    strength_exercise_2: z.string().max(100).optional().nullable(),
    strength_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 6 — Muscular Endurance (two distinct tests required)
    endurance_test_type: z.enum(['Push Up Test', 'Curl Up Test', 'Wall Sit', 'Plank', 'Bodyweight Squat', 'Custom']).optional().nullable(),
    endurance_test_type_2: z.enum(['Push Up Test', 'Curl Up Test', 'Wall Sit', 'Plank', 'Bodyweight Squat', 'Custom']).optional().nullable(),
    endurance_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 7 — Flexibility (two distinct tests required — same battery
    // pattern; flexibility_test_data now holds {test1, test2})
    flexibility_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    posture_notes: text(2000),
    health_notes: text(2000),
    trainer_notes: text(2000),
    // An acknowledged skip of the blood-pressure reading (see BP_REQUIRED).
    bp_not_measured: z.boolean().optional(),
  }),
};

// Edit: the same rules, every field optional, the client not movable.
const assessmentUpdateSchema = {
  body: assessmentCreateSchema.body.omit({ client_id: true }).partial(),
};

router.get('/assessments', auth, wrap(async (req, res) => {
  const { client_id, limit, offset } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  // Multi-tenant isolation (Phase 1): only the caller's org's assessments.
  // Qualify with the pa alias — this query joins `trainers`, which also has an
  // organization_id column, so an unqualified reference is ambiguous.
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`pa.organization_id = $${params.length}`);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  params.push(lim); const limIdx = params.length;
  params.push(off); const offIdx = params.length;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT pa.*, t.name AS trainer_name FROM pt_assessments pa
     LEFT JOIN trainers t ON t.id = pa.trainer_id AND t.organization_id = pa.organization_id ${whereSql}
     ORDER BY assessment_date DESC LIMIT $${limIdx} OFFSET $${offIdx}`, params
  );
  res.json({ data: rows });
}));

// Numeric columns come back from pg as strings; the scoring wants numbers.
const ASSESSMENT_NUMERIC = [
  'bp_systolic', 'bp_diastolic', 'resting_heart_rate', 'resting_spo2',
  'weight', 'height_cm', 'waist_cm', 'waist_iliac_cm', 'hips_cm', 'neck_cm', 'chest_cm',
  'arm_right_cm', 'arm_left_cm', 'thigh_right_cm', 'thigh_left_cm', 'calf_right_cm', 'calf_left_cm',
  'body_fat_pct', 'muscle_mass_pct', 'visceral_fat', 'subcutaneous_fat_pct', 'body_water_pct',
  'bone_mass_kg', 'bmr', 'metabolic_age',
];
const ASSESSMENT_INPUTS = [
  ...ASSESSMENT_NUMERIC, 'assessment_type', 'assessment_date', 'body_comp_method',
  'cardio_test_type', 'cardio_test_data', 'strength_exercise', 'strength_exercise_2', 'strength_test_data',
  'endurance_test_type', 'endurance_test_type_2', 'endurance_test_data', 'flexibility_test_data',
  'posture_notes', 'health_notes', 'trainer_notes',
];

/** A stored test, read back as the request body that would have produced it. */
function assessmentAsBody(row) {
  const out = {};
  for (const k of ASSESSMENT_INPUTS) {
    const v = row[k];
    out[k] = ASSESSMENT_NUMERIC.includes(k) && v != null ? Number(v) : v;
  }
  if (row.assessment_date) out.assessment_date = String(row.assessment_date instanceof Date ? row.assessment_date.toISOString() : row.assessment_date).slice(0, 10);
  // A BMR the server suggested is re-derived from the new weight, not frozen.
  if (row.bmr_auto_suggested) out.bmr = null;
  return out;
}

async function demographics(req, clientId, b) {
  // Age/gender: prefer what the frontend sent (it already has the client
  // record loaded); fall back to a DB lookup so BMR/VO2max/norms still work
  // if the caller omits them.
  let age = b.age ?? null;
  let gender = b.gender ?? null;
  if (age == null || gender == null) {
    const dScope = tenantScope(req);
    const { rows: cRows } = await pool.query('SELECT dob, gender FROM pt_clients WHERE id = $1 AND organization_id = $2', [clientId, dScope.orgId]);
    const c = cRows[0];
    if (c) {
      if (age == null && c.dob) {
        const dob = new Date(c.dob);
        const today = new Date();
        age = today.getFullYear() - dob.getFullYear() - (today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
      }
      if (gender == null) gender = c.gender;
    }
  }
  return { age, gender };
}

/**
 * Every derived column of a fitness test, from its inputs. Shared by create
 * and edit so the two can never score the same numbers differently.
 * Returns `{ error }` when the safety rules refuse the test.
 */
function computeAssessment(b, age, gender) {
  // ── Step 1: Blood Pressure ──
  const bp = scoring.classifyBp(b.bp_systolic ?? null, b.bp_diastolic ?? null);
  const exertion = [b.cardio_test_type, b.strength_exercise, b.strength_exercise_2, b.endurance_test_type, b.endurance_test_type_2]
    .some((v) => v != null && v !== '');
  // An unsafe resting reading (stage-2 hypertension or hypotension) stops
  // the exertion tests: a step test, a 1RM or an endurance set to failure
  // on top of it is the risk the reading exists to catch. The reading itself,
  // the measurements and flexibility are still recorded.
  if (bp.isUnsafe && exertion) {
    return { error: { status: 400, code: 'BP_UNSAFE',
      message: `Resting blood pressure is ${bp.category} — exertion tests (cardio, strength, endurance) cannot be recorded. Refer for medical clearance.` } };
  }
  // No reading at all used to pass the same check: a 1RM and a step test
  // were recorded with blood pressure never taken. The trainer may still
  // skip it, but must say so.
  const hasBp = b.bp_systolic != null || b.bp_diastolic != null;
  if (exertion && !hasBp && !b.bp_not_measured) {
    return { error: { status: 400, code: 'BP_REQUIRED',
      message: 'Take a resting blood pressure before recording cardio, strength or endurance tests — or confirm it was not measured.' } };
  }

  // ── Step 2: Anthropometric ──
  const bmi = scoring.calcBmi(b.weight, b.height_cm);
  const waistHipRatio = scoring.calcWhr(b.waist_cm, b.hips_cm);

  // ── Step 3: Body Composition ──
  const leanBodyMass = scoring.calcLeanBodyMass(b.weight, b.body_fat_pct);
  const fatMass = scoring.calcFatMass(b.weight, b.body_fat_pct);
  let bmr = b.bmr ?? null;
  let bmrAutoSuggested = false;
  if (bmr == null) {
    bmr = scoring.calcBmr(b.weight, b.height_cm, age, gender);
    bmrAutoSuggested = bmr != null;
  }

  // ── Step 4: Cardio ── (formula depends on the selected test)
  const cd = { ...(b.cardio_test_data || {}) };
  let vo2Max = null;
  let cardioCategory = null;
  if (b.cardio_test_type === 'Rockport 1-Mile Walk') {
    vo2Max = scoring.calcVo2MaxRockport(b.weight, age, gender, num(cd.timeMin, null), num(cd.heartRate, null));
  } else if (b.cardio_test_type === 'Cooper 12-Minute Run') {
    vo2Max = scoring.calcVo2MaxCooper(num(cd.distanceMeters, null));
  } else if (b.cardio_test_type === 'Bruce Protocol') {
    vo2Max = scoring.calcVo2MaxBruce(num(cd.treadmillMinutes, null));
  } else if (b.cardio_test_type === 'Harvard Step Test') {
    const pei = scoring.calcHarvardPei(num(cd.durationSec, null), num(cd.pulse1, null), num(cd.pulse2, null), num(cd.pulse3, null));
    cardioCategory = scoring.classifyHarvardPei(pei);
    cd.pei = pei;
  } else if (b.cardio_test_type === 'YMCA 3-Minute Step Test') {
    cardioCategory = scoring.classifyStepTestRecovery(num(cd.recoveryHr, null));
  }
  if (vo2Max != null && !cardioCategory) cardioCategory = scoring.classifyVo2Max(vo2Max, age, gender);
  const cardioScore = scoring.scoreCategory(cardioCategory);

  // ── Step 5: Strength (two-test battery; the combined score averages both) ──
  const sd = b.strength_test_data || {};
  const lifts = [];
  const oneRmFor = (t, exercise) => {
    const formula = t.formula === 'brzycki' ? 'brzycki' : 'epley';
    const oneRm = t.isDirect ? num(t.direct1RM, null) : scoring.calc1RM(num(t.weightKg, null), num(t.reps, null), formula);
    if (oneRm != null && exercise) {
      lifts.push({
        exerciseName: exercise, oneRm, formula, direct: Boolean(t.isDirect),
        weightKg: t.isDirect ? oneRm : num(t.weightKg), reps: t.isDirect ? 1 : num(t.reps),
      });
    }
    return oneRm;
  };
  const strengthOneRm1 = oneRmFor(sd.test1 || {}, b.strength_exercise);
  const strengthOneRm2 = oneRmFor(sd.test2 || {}, b.strength_exercise_2);
  const strengthCategory = scoring.classifyStrength(strengthOneRm1, b.weight ?? null, b.strength_exercise || null, gender);
  const strengthCategory2 = scoring.classifyStrength(strengthOneRm2, b.weight ?? null, b.strength_exercise_2 || null, gender);
  const strengthScore = scoring.scoreEnduranceBattery(scoring.scoreCategory(strengthCategory), scoring.scoreCategory(strengthCategory2));

  // ── Step 6: Endurance (two tests, combined into one averaged score) ──
  const ed = b.endurance_test_data || {};
  const t1 = ed.test1 || {};
  const t2 = ed.test2 || {};
  const enduranceCategory = scoring.classifyEndurance(b.endurance_test_type, num(t1.reps, null) ?? num(t1.durationSec, null), gender);
  const enduranceCategory2 = scoring.classifyEndurance(b.endurance_test_type_2, num(t2.reps, null) ?? num(t2.durationSec, null), gender);
  const enduranceScore = scoring.scoreEnduranceBattery(scoring.scoreCategory(enduranceCategory), scoring.scoreCategory(enduranceCategory2));

  // ── Step 7: Flexibility (two-test battery) ──
  const fd = b.flexibility_test_data || {};
  const ft1 = fd.test1 || {};
  const ft2 = fd.test2 || {};
  const hasAsymmetry = scoring.checkAsymmetry(num(ft1.left, null), num(ft1.right, null))
    || scoring.checkAsymmetry(num(ft2.left, null), num(ft2.right, null));
  const flexibilityCategory = scoring.classifyFlexibilityScore(num(ft1.score, null));
  const flexibilityCategory2 = scoring.classifyFlexibilityScore(num(ft2.score, null));
  const mobilityScore = scoring.scoreEnduranceBattery(scoring.scoreCategory(flexibilityCategory), scoring.scoreCategory(flexibilityCategory2));

  // ── Dashboard scores ──
  const bodyCompositionScore = scoring.scoreBodyComposition(b.body_fat_pct ?? null, gender);
  const healthRiskScore = scoring.scoreHealthRisk(bp.category, bmi);
  const overallScore = scoring.computeOverallScore({
    bodyComposition: bodyCompositionScore, endurance: enduranceScore,
    mobility: mobilityScore, cardio: cardioScore, healthRisk: healthRiskScore, strength: strengthScore,
  });

  const NOT_MEASURED = 'Resting blood pressure not measured (confirmed by trainer).';
  const priorNotes = String(b.health_notes || '').split('\n').filter((l) => l && l !== NOT_MEASURED).join('\n');
  const healthNotes = (!hasBp && exertion && b.bp_not_measured
    ? [priorNotes, NOT_MEASURED].filter(Boolean).join('\n')
    : priorNotes) || null;

  return {
    bpUnsafe: bp.isUnsafe,
    lifts,
    cols: {
      assessment_type: b.assessment_type || 'initial',
      assessment_date: b.assessment_date || studioToday(),
      trainer_notes: b.trainer_notes || b.assessment_notes || null,
      bp_systolic: b.bp_systolic ?? null, bp_diastolic: b.bp_diastolic ?? null,
      resting_heart_rate: b.resting_heart_rate ?? null, resting_spo2: b.resting_spo2 ?? null, bp_category: bp.category,
      weight: b.weight ?? null, height_cm: b.height_cm ?? null, bmi,
      waist_cm: b.waist_cm ?? null, waist_iliac_cm: b.waist_iliac_cm ?? null, hips_cm: b.hips_cm ?? null, waist_hip_ratio: waistHipRatio,
      neck_cm: b.neck_cm ?? null, chest_cm: b.chest_cm ?? null,
      arm_right_cm: b.arm_right_cm ?? null, arm_left_cm: b.arm_left_cm ?? null,
      thigh_right_cm: b.thigh_right_cm ?? null, thigh_left_cm: b.thigh_left_cm ?? null,
      calf_right_cm: b.calf_right_cm ?? null, calf_left_cm: b.calf_left_cm ?? null,
      body_comp_method: b.body_comp_method || null, body_fat_pct: b.body_fat_pct ?? null, muscle_mass_pct: b.muscle_mass_pct ?? null,
      lean_body_mass_kg: leanBodyMass, fat_mass_kg: fatMass,
      visceral_fat: b.visceral_fat ?? null, subcutaneous_fat_pct: b.subcutaneous_fat_pct ?? null, body_water_pct: b.body_water_pct ?? null,
      bone_mass_kg: b.bone_mass_kg ?? null, bmr, bmr_auto_suggested: bmrAutoSuggested, metabolic_age: b.metabolic_age ?? null,
      cardio_test_type: b.cardio_test_type || null, cardio_test_data: JSON.stringify(cd), vo2_max: vo2Max,
      cardio_category: cardioCategory, cardio_score_computed: cardioScore,
      strength_exercise: b.strength_exercise || null, strength_exercise_2: b.strength_exercise_2 || null,
      strength_category: strengthCategory, strength_category_2: strengthCategory2,
      strength_test_data: JSON.stringify(sd), strength_score_computed: strengthScore,
      endurance_test_type: b.endurance_test_type || null, endurance_test_type_2: b.endurance_test_type_2 || null,
      endurance_test_data: JSON.stringify(ed), endurance_category: enduranceCategory, endurance_category_2: enduranceCategory2,
      endurance_score_computed: enduranceScore,
      flexibility_test_data: JSON.stringify(fd), flexibility_category: flexibilityCategory, flexibility_category_2: flexibilityCategory2,
      has_asymmetry: hasAsymmetry, mobility_score_computed: mobilityScore,
      body_composition_score: bodyCompositionScore, health_risk_score: healthRiskScore, overall_fitness_score: overallScore,
      posture_notes: b.posture_notes || null, health_notes: healthNotes,
    },
  };
}

router.post('/assessments', auth, requireTrainer, validate(assessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  // Fitness testing includes maximal efforts — a 1RM, a step test, endurance
  // to failure — so the same medical stop that guards assigning a workout
  // guards recording one of these. Missing paperwork is only a warning here
  // too, returned as screening_warnings.
  const { blocked, warnings: screeningWarnings } = await checkScreeningGate(req, b.client_id);
  if (blocked) return res.status(blocked.status).json(blocked.body);

  const { age, gender } = await demographics(req, b.client_id, b);
  const result = computeAssessment(b, age, gender);
  if (result.error) return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });

  // The assessor is the studio's trainer profile, from the session. A
  // trainer_id in the body is ignored: it is a foreign key, and taking it
  // from the request would let a row point at another studio's trainer.
  const row = await assessmentsRepo.insertAssessment({
    client_id: b.client_id, trainer_id: req.user.trainer_id || null,
    ...result.cols, created_by: req.user.id, organization_id: orgIdOf(req),
  });
  await assessmentsRepo.replaceAssessmentLifts(row, result.lifts);
  await assessmentsRepo.updateClientBody(row.client_id, row.organization_id, result.cols.weight, result.cols.height_cm);
  res.status(201).json({ data: { ...row, bp_unsafe: result.bpUnsafe }, screening_warnings: screeningWarnings });
}));

// A test used to be permanent: a typo in the weight fed the goal's starting
// weight and the strength badges for good. Edit re-scores the merged test
// with the same function create uses.
router.patch('/assessments/:id', auth, requireTrainer, validate(assessmentUpdateSchema), wrap(async (req, res) => {
  const existing = await assessmentsRepo.findAssessment(req, req.params.id);
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  const merged = { ...assessmentAsBody(existing), ...req.body };
  const { age, gender } = await demographics(req, existing.client_id, merged);
  const result = computeAssessment(merged, age, gender);
  if (result.error) return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
  const row = await assessmentsRepo.updateAssessment(existing.id, result.cols);
  await assessmentsRepo.replaceAssessmentLifts(row, result.lifts);
  await assessmentsRepo.updateClientBody(row.client_id, row.organization_id, result.cols.weight, result.cols.height_cm);
  res.json({ data: { ...row, bp_unsafe: result.bpUnsafe } });
}));

router.delete('/assessments/:id', auth, requireTrainer, wrap(async (req, res) => {
  if (!await assessmentsRepo.deleteAssessment(req, req.params.id)) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.status(204).end();
}));

const GOAL_TYPES = [
  'fat_loss', 'muscle_gain', 'body_recomposition', 'strength_gain', 'powerlifting',
  'endurance', 'general_fitness', 'mobility', 'marathon_prep', 'wedding_transformation',
  'medical_fitness', 'senior_fitness', 'athletic_performance', 'custom',
];

// A target date is ahead of the client, not behind: a past date used to be
// accepted and every derived figure (weekly rate, difficulty, weeks) came
// back blank without saying why.
const futureDate = () => z.string().optional().nullable().refine(
  (v) => !v || (!Number.isNaN(Date.parse(v)) && Date.parse(v) >= Date.now() - 86400000),
  { message: 'Target date must be today or later' }
);

const goalFields = {
  goal_type: z.enum(GOAL_TYPES),
  goal_other: text(200),
  goal_description: text(2000),
  target_weight: numIn(25, 300), target_body_fat: numIn(3, 60),
  target_date: futureDate(),
  priority_goal: text(50),
  motivation_reason: text(2000),
  motivation_level: intIn(1, 10), commitment_level: intIn(1, 10),
  biggest_challenges: textList(200, 20),
  lifestyle_readiness: z.record(z.string().max(60), z.boolean()).optional().nullable(),
  starting_weight: numIn(25, 350), starting_body_fat_pct: numIn(2, 75),
  notes: text(2000),
};

const goalCreateSchema = {
  body: z.object({ client_id: z.string(), ...goalFields }),
};

// PATCH took any body at all: `target_weight: "abc"` reached the database and
// came back as a 500 carrying the raw error. Same rules as create.
const goalUpdateSchema = {
  body: z.object({ ...goalFields, is_active: z.boolean().optional() }).partial(),
};

// Shared by POST (create) and PATCH (update) so the Smart Goal Analysis
// columns never drift out of sync between the two write paths.
function computeGoalAnalysis({ startingWeight, targetWeight, targetDate, lifestyleReadiness, motivationLevel, commitmentLevel }) {
  const daysRemaining = targetDate ? Math.ceil((new Date(targetDate).getTime() - Date.now()) / 86400000) : null;
  const direction = goalScoring.goalDirection(startingWeight, targetWeight);
  const requiredRate = goalScoring.calcRequiredWeeklyRate(startingWeight, targetWeight, daysRemaining);
  const safeRate = goalScoring.calcSafeWeeklyRate(startingWeight, direction);
  const lifestyleScore = goalScoring.calcLifestyleReadinessScore(lifestyleReadiness || null);
  const difficulty = goalScoring.classifyGoalDifficulty(requiredRate, safeRate, lifestyleScore, motivationLevel, commitmentLevel);
  const estimatedWeeks = goalScoring.calcEstimatedDurationWeeks(startingWeight, targetWeight, safeRate);
  const recommendedMonths = goalScoring.recommendPtDurationMonths(estimatedWeeks);
  const riskFactors = goalScoring.buildRiskFactors({
    requiredRate, safeRate, lifestyleReadinessScore: lifestyleScore,
    medicalRestrictions: lifestyleReadiness ? lifestyleReadiness.medical_restrictions === true : null,
    daysRemaining, motivationLevel, commitmentLevel,
  });
  return { lifestyleScore, difficulty, estimatedWeeks, recommendedMonths, requiredRate, safeRate, riskFactors };
}

router.get('/goals', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`organization_id = $${params.length}`);
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_goals ${whereSql} ORDER BY is_active DESC, created_at DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/goals', auth, validate(goalCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  // Starting weight/body-fat: prefer client-submitted (manual entry when no
  // assessment exists yet), else snapshot the client's latest assessment.
  let startingWeight = b.starting_weight ?? null;
  let startingBodyFat = b.starting_body_fat_pct ?? null;
  if (startingWeight == null || startingBodyFat == null) {
    const { rows: aRows } = await pool.query(
      'SELECT weight, body_fat_pct FROM pt_assessments WHERE client_id = $1 ORDER BY assessment_date DESC LIMIT 1',
      [b.client_id]
    );
    const latest = aRows[0];
    if (latest) {
      if (startingWeight == null && latest.weight != null) startingWeight = parseFloat(latest.weight);
      if (startingBodyFat == null && latest.body_fat_pct != null) startingBodyFat = parseFloat(latest.body_fat_pct);
    }
  }

  const analysis = computeGoalAnalysis({
    startingWeight, targetWeight: b.target_weight ?? null, targetDate: b.target_date || null,
    lifestyleReadiness: b.lifestyle_readiness || null, motivationLevel: b.motivation_level ?? null, commitmentLevel: b.commitment_level ?? null,
  });

  const { rows } = await pool.query(
    `INSERT INTO pt_goals (
       client_id, goal_type, goal_other, goal_description, target_weight, target_body_fat, target_date, notes,
       motivation_reason, priority_goal, motivation_level, commitment_level, biggest_challenges,
       lifestyle_readiness, lifestyle_readiness_score,
       starting_weight, starting_body_fat_pct,
       goal_difficulty, estimated_duration_weeks, recommended_pt_duration_months,
       estimated_weekly_rate_kg, safe_weekly_rate_kg, risk_factors,
       created_by, organization_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,
       $14::jsonb,$15,
       $16,$17,
       $18,$19,$20,
       $21,$22,$23,
       $24,$25
     ) RETURNING *`,
    [
      b.client_id, b.goal_type, b.goal_other || null, b.goal_description || null,
      b.target_weight ?? null, b.target_body_fat ?? null, b.target_date || null, b.notes || null,
      b.motivation_reason || null, b.priority_goal || null, b.motivation_level ?? null, b.commitment_level ?? null,
      b.biggest_challenges && b.biggest_challenges.length ? b.biggest_challenges : null,
      b.lifestyle_readiness ? JSON.stringify(b.lifestyle_readiness) : null, analysis.lifestyleScore,
      startingWeight, startingBodyFat,
      analysis.difficulty, analysis.estimatedWeeks, analysis.recommendedMonths,
      analysis.requiredRate, analysis.safeRate, analysis.riskFactors.length ? analysis.riskFactors : null,
      req.user.id, orgIdOf(req),
    ]
  );
  // The new goal replaces the old one. Goals used to pile up, all active.
  await assessmentsRepo.deactivateOtherGoals(b.client_id, rows[0].organization_id, rows[0].id);
  res.status(201).json({ data: rows[0] });
}));

router.patch('/goals/:id', auth, validate(goalUpdateSchema), wrap(async (req, res) => {
  const allowed = [
    'goal_type', 'goal_other', 'goal_description', 'target_weight', 'target_body_fat', 'target_date', 'notes', 'is_active',
    'motivation_reason', 'priority_goal', 'motivation_level', 'commitment_level', 'biggest_challenges',
    'lifestyle_readiness', 'starting_weight', 'starting_body_fat_pct',
  ];

  const scope = tenantScope(req);
  const guard = ' AND organization_id = $2';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_goals WHERE id = $1${guard}`,
    [req.params.id, scope.orgId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = key === 'lifestyle_readiness' && req.body[key] != null ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = computeGoalAnalysis({
    startingWeight: merged.starting_weight != null ? parseFloat(merged.starting_weight) : null,
    targetWeight: merged.target_weight != null ? parseFloat(merged.target_weight) : null,
    targetDate: merged.target_date || null,
    lifestyleReadiness: merged.lifestyle_readiness || null,
    motivationLevel: merged.motivation_level != null ? parseInt(merged.motivation_level, 10) : null,
    commitmentLevel: merged.commitment_level != null ? parseInt(merged.commitment_level, 10) : null,
  });

  for (const [col, val] of Object.entries({
    lifestyle_readiness_score: analysis.lifestyleScore,
    goal_difficulty: analysis.difficulty,
    estimated_duration_weeks: analysis.estimatedWeeks,
    recommended_pt_duration_months: analysis.recommendedMonths,
    estimated_weekly_rate_kg: analysis.requiredRate,
    safe_weekly_rate_kg: analysis.safeRate,
    risk_factors: analysis.riskFactors.length ? analysis.riskFactors : null,
  })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_goals SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  // Re-opening an archived goal makes it THE goal again.
  if (req.body.is_active === true) await assessmentsRepo.deactivateOtherGoals(rows[0].client_id, rows[0].organization_id, rows[0].id);
  res.json({ data: rows[0] });
}));

router.get('/weekly-checkins', auth, wrap(async (req, res) => {
  const { client_id, limit } = req.query;
  const where = []; const params = [];
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`organization_id = $${params.length}`);
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 52);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM weekly_checkins ${whereSql} ORDER BY week_start_date DESC LIMIT $${params.length}`, params
  );
  res.json({ data: rows });
}));

router.post('/weekly-checkins', auth, wrap(async (req, res) => {
  const { client_id, week_start_date, weight, mood, sleep_hours, water_glasses, workout_count, calories_avg, adherence_pct, trainer_notes, client_notes, stress_level, energy_level, soreness_level } = req.body;
  if (!await clientInOrg(req, client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  // Stress, energy and soreness are the three readings the readiness score
  // needs, and all three are optional — a thirty-second check-in at the door
  // should record what the client said and leave the rest blank. Out-of-scale
  // values are stored as NULL rather than rejected: a mistyped 75 must not
  // fail the whole check-in, and it must not drag the score either. The column
  // CHECKs are the backstop; this is the polite version.
  const scale10 = (v) => {
    const n = num(v, null);
    return n !== null && n >= 1 && n <= 10 ? Math.round(n) : null;
  };

  const { rows } = await pool.query(
    `INSERT INTO weekly_checkins (client_id, week_start_date, weight, mood, sleep_hours, water_glasses,
      workout_count, calories_avg, adherence_pct, trainer_notes, client_notes, created_by, organization_id,
      stress_level, energy_level, soreness_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (client_id, week_start_date) DO UPDATE SET
       weight = EXCLUDED.weight, mood = EXCLUDED.mood, sleep_hours = EXCLUDED.sleep_hours,
       water_glasses = EXCLUDED.water_glasses, workout_count = EXCLUDED.workout_count,
       calories_avg = EXCLUDED.calories_avg, adherence_pct = EXCLUDED.adherence_pct,
       trainer_notes = EXCLUDED.trainer_notes, client_notes = EXCLUDED.client_notes,
       stress_level = EXCLUDED.stress_level, energy_level = EXCLUDED.energy_level,
       soreness_level = EXCLUDED.soreness_level,
       updated_at = NOW()
     -- (client_id, week_start_date) says nothing about the studio. The client
     -- was verified in the caller's organization above, so this can only ever
     -- exclude a row that could not legitimately be the target.
     WHERE weekly_checkins.organization_id IS NULL
        OR weekly_checkins.organization_id = EXCLUDED.organization_id
     RETURNING *`,
    [client_id, week_start_date, num(weight, null), mood || null, num(sleep_hours, null),
     num(water_glasses, null), num(workout_count, 0), num(calories_avg, null),
     num(adherence_pct, null), trainer_notes || null, client_notes || null, req.user.id, orgIdOf(req),
     scale10(stress_level), scale10(energy_level), scale10(soreness_level)]
  );
  res.status(201).json({ data: rows[0] });
}));

router.get('/strength-logs', auth, wrap(async (req, res) => {
  const { client_id, exercise_name, limit } = req.query;
  const where = []; const params = [];
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`organization_id = $${params.length}`);
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  if (exercise_name) { params.push(exercise_name); where.push(`exercise_name = $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM strength_logs ${whereSql} ORDER BY log_date DESC LIMIT $${params.length}`, params
  );
  res.json({ data: rows });
}));

// Bounded because a strength log is permanent — there is no edit or delete —
// and a typo (2000 kg, -60 kg, 0 reps) would otherwise become the client's
// "latest" lift and a spike on their trend for good. The ceilings sit well
// above any human lift (the heaviest raw deadlift is ~500 kg). Reps are
// required for an estimated 1RM: defaulting a missing count to 10 invented a
// 1RM from a set nobody performed.
const strengthLogCreateSchema = {
  body: z.object({
    client_id: z.string(),
    exercise_name: z.string().trim().min(1).max(100),
    weight_kg: z.coerce.number().positive().max(1000),
    sets_done: z.coerce.number().int().min(1).max(50).optional().nullable(),
    reps_done: z.coerce.number().int().min(1).max(100).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
    assessment_id: z.string().optional().nullable(),
    one_rm_formula: z.enum(['epley', 'brzycki']).optional(),
    is_direct_1rm: z.boolean().optional(),
    one_rm_estimate: z.coerce.number().positive().max(1000).optional().nullable(),
    log_date: z.string().optional().nullable().refine(
      (v) => !v || (!Number.isNaN(Date.parse(v)) && Date.parse(v) <= Date.now() + 86400000),
      { message: 'log_date must be a valid date, not in the future' }
    ),
  }).refine((b) => b.is_direct_1rm || b.reps_done != null, {
    message: 'reps_done is required unless the lift is a direct 1RM', path: ['reps_done'],
  }),
};

router.post('/strength-logs', auth, requireTrainer, validate(strengthLogCreateSchema), wrap(async (req, res) => {
  const { client_id, exercise_name, weight_kg, sets_done, reps_done, notes,
    assessment_id, one_rm_formula, is_direct_1rm, one_rm_estimate, log_date } = req.body;
  if (!await clientInOrg(req, client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  // An assessment link is a foreign key into another table; it must be one
  // of this studio's assessments for this client, or none.
  if (assessment_id && !await strengthLogs.assessmentBelongs(req, assessment_id, client_id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Assessment not found' } });
  }
  const formula = one_rm_formula === 'brzycki' ? 'brzycki' : 'epley';
  const direct = Boolean(is_direct_1rm);
  // A direct 1RM is one rep at the weight lifted; the estimate, if sent,
  // is the same number.
  const reps = direct ? 1 : num(reps_done);
  const oneRm = direct
    ? num(one_rm_estimate, num(weight_kg))
    : scoring.calc1RM(num(weight_kg), reps, formula);
  const row = await strengthLogs.insertLog({
    clientId: client_id, exerciseName: exercise_name, weightKg: num(weight_kg), setsDone: num(sets_done, direct ? 1 : 3),
    repsDone: reps, oneRm, notes: notes || null, assessmentId: assessment_id || null, formula, direct,
    organizationId: orgIdOf(req), logDate: log_date || null,
  });
  res.status(201).json({ data: row });
}));

// PATCH / DELETE /strength-logs/:id — a strength log used to be permanent,
// so a 2000 kg typo stayed the client's "latest" lift and a spike on their
// trend for good. Same bounds as create; the 1RM is recomputed from the
// merged row, never taken from the body for an estimated lift.
const strengthLogUpdateSchema = {
  body: z.object({
    exercise_name: z.string().trim().min(1).max(100).optional(),
    weight_kg: z.coerce.number().positive().max(1000).optional(),
    sets_done: z.coerce.number().int().min(1).max(50).optional().nullable(),
    reps_done: z.coerce.number().int().min(1).max(100).optional(),
    notes: z.string().max(1000).optional().nullable(),
    one_rm_formula: z.enum(['epley', 'brzycki']).optional(),
    is_direct_1rm: z.boolean().optional(),
    one_rm_estimate: z.coerce.number().positive().max(1000).optional().nullable(),
    log_date: z.string().optional().refine(
      (v) => !v || (!Number.isNaN(Date.parse(v)) && Date.parse(v) <= Date.now() + 86400000),
      { message: 'log_date must be a valid date, not in the future' }
    ),
  }),
};

router.patch('/strength-logs/:id', auth, requireTrainer, validate(strengthLogUpdateSchema), wrap(async (req, res) => {
  const existing = await strengthLogs.findLog(req, req.params.id);
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const b = req.body;
  const m = { ...existing, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
  const direct = Boolean(m.is_direct_1rm);
  const formula = m.one_rm_formula === 'brzycki' ? 'brzycki' : 'epley';
  const weight = num(m.weight_kg);
  const reps = direct ? 1 : num(m.reps_done);
  const oneRm = direct
    ? num(b.one_rm_estimate, weight)
    : scoring.calc1RM(weight, reps, formula);

  const row = await strengthLogs.updateLog(existing.id, {
    exerciseName: m.exercise_name, weightKg: weight, setsDone: m.sets_done ?? null, repsDone: reps, oneRm,
    notes: m.notes ?? null, formula, direct, logDate: m.log_date,
  });
  res.json({ data: row });
}));

router.delete('/strength-logs/:id', auth, requireTrainer, wrap(async (req, res) => {
  if (!await strengthLogs.deleteLog(req, req.params.id)) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.status(204).end();
}));

router.get('/progress-photos', auth, wrap(async (req, res) => {
  const { client_id, limit } = req.query;
  const where = []; const params = [];
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`organization_id = $${params.length}`);
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM progress_photos ${whereSql} ORDER BY taken_at DESC LIMIT $${params.length}`, params
  );
  res.json({ data: rows });
}));

const progressPhotoCreateSchema = {
  body: z.object({
    client_id: z.string(),
    photo_url: z.string().min(1),
    photo_type: z.enum(['front', 'side', 'back', 'flexed', 'full_body', 'other']).optional(),
    taken_at: z.string().optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
  }),
};

router.post('/progress-photos', auth, requireTrainer, validate(progressPhotoCreateSchema), wrap(async (req, res) => {
  const { client_id, photo_url, photo_type, taken_at, notes } = req.body;
  if (!await clientInOrg(req, client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const { rows } = await pool.query(
    `INSERT INTO progress_photos (client_id, photo_url, photo_type, taken_at, notes, uploaded_by, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [client_id, photo_url, photo_type || 'front', taken_at || new Date().toISOString().split('T')[0],
     notes || null, req.user.id, orgIdOf(req)]
  );
  res.status(201).json({ data: rows[0] });
}));

router.delete('/progress-photos/:id', auth, wrap(async (req, res) => {
  const scope = tenantScope(req);
  await pool.query('DELETE FROM progress_photos WHERE id = $1 AND organization_id = $2', [req.params.id, scope.orgId]);
  res.status(204).end();
}));

const LIFESTYLE_OCCUPATION_TYPES = [
  'desk_job', 'active_job', 'physical_labor', 'student', 'homemaker',
  'driver', 'healthcare', 'police', 'fitness_professional', 'retired', 'other',
];

const lifestyleAssessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: pastDate(),

    sleep_duration_hours: numIn(0, 16), bed_time: text(8), wake_time: text(8),
    sleep_quality: intIn(1, 10),

    stress_level: intIn(1, 10),

    water_intake_liters: numIn(0, 10),

    occupation_type: z.enum(LIFESTYLE_OCCUPATION_TYPES).optional().nullable(),
    daily_steps_bracket: z.enum(['<3000', '3000_5000', '5000_8000', '8000_10000', '10000_plus']).optional().nullable(),

    workout_experience_level: z.enum(['beginner', 'intermediate', 'advanced', 'athlete']).optional().nullable(),
    years_of_experience: numIn(0, 80),

    food_preferences: textList(60, 20),

    meal_frequency: intIn(1, 10),
    breakfast_habit: z.enum(['daily', 'sometimes', 'never']).optional().nullable(),
    late_night_eating: z.boolean().optional().nullable(),

    smoking_status: z.enum(['never', 'occasionally', 'daily', 'former']).optional().nullable(),
    cigarettes_per_day: intIn(0, 100), years_smoking: intIn(0, 80),
    alcohol_status: z.enum(['never', 'occasionally', 'weekly', 'frequently']).optional().nullable(),
    drinks_per_week: intIn(0, 100),

    screen_time_bracket: z.enum(['<2', '2_4', '4_6', '6_8', '8_plus']).optional().nullable(),
    travel_frequency: z.enum(['rarely', 'monthly', 'weekly', 'daily']).optional().nullable(),
    energy_level: intIn(1, 10), motivation_to_exercise: intIn(1, 10),
    recovery_quality: z.enum(['poor', 'average', 'good', 'excellent']).optional().nullable(),

    coach_notes: coachNotesSchema,
  }),
};

const lifestyleAssessmentUpdateSchema = {
  body: lifestyleAssessmentCreateSchema.body.omit({ client_id: true }).partial(),
};

// A count for a habit the client does not have is left over from an earlier
// answer: choose Daily, type 10 cigarettes, switch to Never — the 10 used to
// be stored beside "never".
function clearHabitCounts(b) {
  const out = { ...b };
  if (out.smoking_status === 'never') { out.cigarettes_per_day = null; out.years_smoking = null; }
  if (out.alcohol_status === 'never') out.drinks_per_week = null;
  return out;
}

// Water and meals are asked in Nutrition, not here (they used to be asked in
// both, or scored here without being asked). The latest Nutrition answers
// fill them in when this assessment has none of its own.
async function withNutritionHabits(clientId, b) {
  const n = await assessmentsRepo.latestNutritionHabits(clientId);
  const pick = (own, theirs) => (own != null ? own : theirs != null ? theirs : null);
  return {
    ...b,
    water_intake_liters: pick(b.water_intake_liters, n.water_intake_liters != null ? Number(n.water_intake_liters) : null),
    meal_frequency: pick(b.meal_frequency, n.meals_per_day != null ? Number(n.meals_per_day) : null),
    breakfast_habit: pick(b.breakfast_habit, n.breakfast_regularity),
    late_night_eating: pick(b.late_night_eating, n.late_night_eating),
  };
}

// Shared by POST (create) and PATCH (update) so the Smart Lifestyle
// Analysis columns never drift out of sync between the two write paths.
function computeLifestyleAnalysis(b) {
  const sleep = lifestyleScoring.classifySleep(b.sleep_duration_hours ?? null, b.sleep_quality ?? null);
  const stressScore = lifestyleScoring.calcStressScore(b.stress_level ?? null);
  const hydration = lifestyleScoring.classifyHydration(b.water_intake_liters ?? null);
  const activity = lifestyleScoring.classifyActivity(b.daily_steps_bracket || null, b.occupation_type || null);
  const nutritionScore = lifestyleScoring.calcNutritionScore(b.meal_frequency ?? null, b.breakfast_habit || null, b.late_night_eating ?? null);
  const recoveryScore = lifestyleScoring.calcRecoveryScore(sleep.score, stressScore, b.energy_level ?? null, b.recovery_quality || null);
  const sedentaryRisk = lifestyleScoring.classifyRisk(activity.score);
  const recoveryRisk = lifestyleScoring.classifyRisk(recoveryScore);

  const habitInputs = {
    smokingStatus: b.smoking_status || null, alcoholStatus: b.alcohol_status || null,
    sleepScore: sleep.score, stressScore, hydrationScore: hydration.score, activityScore: activity.score, nutritionScore,
  };
  const habitRiskScore = lifestyleScoring.calcHabitRiskScore(habitInputs);
  const riskFactors = lifestyleScoring.buildLifestyleRiskFactors(habitInputs);

  const lifestyleScoreVal = lifestyleScoring.calcLifestyleScore(
    { sleep: sleep.score, stress: stressScore, hydration: hydration.score, activity: activity.score, nutrition: nutritionScore, recovery: recoveryScore },
    habitRiskScore
  );
  const lifestyleReadiness = lifestyleScoring.classifyLifestyleReadiness(lifestyleScoreVal);

  return {
    sleepCategory: sleep.category, sleepScore: sleep.score,
    stressScore,
    hydrationCategory: hydration.category, hydrationScore: hydration.score,
    activityLevel: activity.level, activityScore: activity.score,
    nutritionScore,
    recoveryScore,
    sedentaryRisk, recoveryRisk,
    habitRiskScore, riskFactors,
    lifestyleScore: lifestyleScoreVal, lifestyleReadiness,
  };
}

// GET /lifestyle-assessments
//
// client_id is REQUIRED, which it was not before. Called bare, this endpoint
// used to return every lifestyle assessment on the platform — sleep, stress,
// smoking status, alcohol intake, coach notes — for every studio, to any
// authenticated account. A list endpoint over health records has no honest
// use for "all of them", so the parameter is mandatory and the org filter is
// applied whether or not it is supplied.
router.get('/lifestyle-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'client_id is required' } });
  }
  if (!await clientInOrg(req, client_id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  }
  const params = [client_id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1${org} ORDER BY assessment_date DESC`,
    params
  );
  return res.json({ data: rows });
}));

router.post('/lifestyle-assessments', auth, requireTrainer, validate(lifestyleAssessmentCreateSchema), wrap(async (req, res) => {
  const b = clearHabitCounts(req.body);
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const analysis = computeLifestyleAnalysis(await withNutritionHabits(b.client_id, b));

  const { rows } = await pool.query(
    `INSERT INTO pt_lifestyle_assessments (
       client_id, assessment_number, assessment_date,
       sleep_duration_hours, bed_time, wake_time, sleep_quality, sleep_category, sleep_score,
       stress_level, stress_score,
       water_intake_liters, hydration_category, hydration_score,
       occupation_type, daily_steps_bracket, activity_level, activity_score,
       workout_experience_level, years_of_experience,
       food_preferences,
       meal_frequency, breakfast_habit, late_night_eating, nutrition_score,
       smoking_status, cigarettes_per_day, years_smoking, alcohol_status, drinks_per_week,
       screen_time_bracket, travel_frequency, energy_level, motivation_to_exercise, recovery_quality, recovery_score,
       sedentary_risk, recovery_risk, habit_risk_score, risk_factors, lifestyle_score, lifestyle_readiness,
       coach_notes, created_by, organization_id
     ) VALUES (
       $1,(SELECT COUNT(*)+1 FROM pt_lifestyle_assessments WHERE client_id = $1),COALESCE($2, CURRENT_DATE),
       $3,$4,$5,$6,$7,$8,
       $9,$10,
       $11,$12,$13,
       $14,$15,$16,$17,
       $18,$19,
       $20,
       $21,$22,$23,$24,
       $25,$26,$27,$28,$29,
       $30,$31,$32,$33,$34,$35,
       $36,$37,$38,$39,$40,$41,
       $42::jsonb,$43,$44
     ) RETURNING *`,
    [
      b.client_id, b.assessment_date || studioToday(),
      b.sleep_duration_hours ?? null, b.bed_time || null, b.wake_time || null, b.sleep_quality ?? null, analysis.sleepCategory, analysis.sleepScore,
      b.stress_level ?? null, analysis.stressScore,
      b.water_intake_liters ?? null, analysis.hydrationCategory, analysis.hydrationScore,
      b.occupation_type || null, b.daily_steps_bracket || null, analysis.activityLevel, analysis.activityScore,
      b.workout_experience_level || null, b.years_of_experience ?? null,
      b.food_preferences && b.food_preferences.length ? b.food_preferences : null,
      b.meal_frequency ?? null, b.breakfast_habit || null, b.late_night_eating ?? null, analysis.nutritionScore,
      b.smoking_status || null, b.cigarettes_per_day ?? null, b.years_smoking ?? null, b.alcohol_status || null, b.drinks_per_week ?? null,
      b.screen_time_bracket || null, b.travel_frequency || null, b.energy_level ?? null, b.motivation_to_exercise ?? null, b.recovery_quality || null, analysis.recoveryScore,
      analysis.sedentaryRisk, analysis.recoveryRisk, analysis.habitRiskScore, analysis.riskFactors.length ? analysis.riskFactors : null, analysis.lifestyleScore, analysis.lifestyleReadiness,
      b.coach_notes ? JSON.stringify(b.coach_notes) : null, req.user.id, orgIdOf(req),
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/lifestyle-assessments/:id', auth, validate(lifestyleAssessmentUpdateSchema), wrap(async (req, res) => {
  const allowed = [
    'assessment_date', 'sleep_duration_hours', 'bed_time', 'wake_time', 'sleep_quality', 'stress_level',
    'water_intake_liters', 'occupation_type', 'daily_steps_bracket', 'workout_experience_level', 'years_of_experience',
    'food_preferences', 'meal_frequency', 'breakfast_habit', 'late_night_eating',
    'smoking_status', 'cigarettes_per_day', 'years_smoking', 'alcohol_status', 'drinks_per_week',
    'screen_time_bracket', 'travel_frequency', 'energy_level', 'motivation_to_exercise', 'recovery_quality', 'coach_notes',
  ];

  // Scoped read before the write. Unscoped, this loaded — and the UPDATE below
  // then rewrote — any studio's health record by id.
  const exParams = [req.params.id];
  const exOrg = orgWhere(req, exParams);
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_lifestyle_assessments WHERE id = $1${exOrg}`, exParams
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const body = clearHabitCounts(req.body);
  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      const val = key === 'coach_notes' && body[key] != null ? JSON.stringify(body[key]) : body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...body };
  const analysis = computeLifestyleAnalysis(await withNutritionHabits(existing.client_id, {
    sleep_duration_hours: merged.sleep_duration_hours != null ? parseFloat(merged.sleep_duration_hours) : null,
    sleep_quality: merged.sleep_quality != null ? parseInt(merged.sleep_quality, 10) : null,
    stress_level: merged.stress_level != null ? parseInt(merged.stress_level, 10) : null,
    water_intake_liters: merged.water_intake_liters != null ? parseFloat(merged.water_intake_liters) : null,
    occupation_type: merged.occupation_type || null,
    daily_steps_bracket: merged.daily_steps_bracket || null,
    meal_frequency: merged.meal_frequency != null ? parseInt(merged.meal_frequency, 10) : null,
    breakfast_habit: merged.breakfast_habit || null,
    late_night_eating: merged.late_night_eating,
    energy_level: merged.energy_level != null ? parseInt(merged.energy_level, 10) : null,
    recovery_quality: merged.recovery_quality || null,
    smoking_status: merged.smoking_status || null,
    alcohol_status: merged.alcohol_status || null,
  }));

  for (const [col, val] of Object.entries({
    sleep_category: analysis.sleepCategory, sleep_score: analysis.sleepScore,
    stress_score: analysis.stressScore,
    hydration_category: analysis.hydrationCategory, hydration_score: analysis.hydrationScore,
    activity_level: analysis.activityLevel, activity_score: analysis.activityScore,
    nutrition_score: analysis.nutritionScore,
    recovery_score: analysis.recoveryScore,
    sedentary_risk: analysis.sedentaryRisk, recovery_risk: analysis.recoveryRisk,
    habit_risk_score: analysis.habitRiskScore, risk_factors: analysis.riskFactors.length ? analysis.riskFactors : null,
    lifestyle_score: analysis.lifestyleScore, lifestyle_readiness: analysis.lifestyleReadiness,
  })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const upOrg = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_lifestyle_assessments SET ${sets.join(', ')} WHERE id = $1${upOrg} RETURNING *`, params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ data: rows[0] });
}));

const nutritionSupplementSchema = z.object({
  name: z.string().trim().min(1).max(100), dose: text(100),
  frequency: text(100), brand: text(100),
});
const nutritionDigestiveIssueSchema = z.object({
  issue: z.string().max(100), frequency: z.enum(['daily', 'weekly', 'rare']).optional().nullable(),
  severity: intIn(1, 10),
});

const nutritionAssessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: pastDate(),

    diet_preferences: textList(60, 20),

    food_allergies: textList(100, 30),
    foods_to_avoid: textList(100, 30),
    foods_to_avoid_reason: z.enum(['medical', 'religious', 'personal_preference', 'taste', 'digestive_issue']).optional().nullable(),

    favourite_foods: textList(100, 30),

    takes_supplements: z.boolean().optional().nullable(),
    supplements: z.array(nutritionSupplementSchema).max(30).optional().nullable(),

    digestive_issues: z.array(nutritionDigestiveIssueSchema).max(20).optional().nullable(),

    meals_per_day: intIn(1, 10),
    breakfast_regularity: z.enum(['daily', 'sometimes', 'never']).optional().nullable(),
    lunch_regularity: z.enum(['daily', 'sometimes', 'never']).optional().nullable(),
    dinner_regularity: z.enum(['daily', 'sometimes', 'never']).optional().nullable(),
    snacks_per_day: intIn(0, 15),
    late_night_eating: z.boolean().optional().nullable(),
    meal_timing_consistency: z.enum(['consistent', 'somewhat_consistent', 'inconsistent']).optional().nullable(),
    eating_out_frequency: z.enum(['rarely', 'weekly', 'frequently', 'daily']).optional().nullable(),
    weekend_eating_habits: z.enum(['similar_to_weekday', 'somewhat_different', 'very_different_indulgent']).optional().nullable(),
    eating_behaviours: textList(100, 30),

    water_intake_liters: numIn(0, 10),
    tea_cups_per_day: intIn(0, 30), coffee_cups_per_day: intIn(0, 30), soft_drinks_per_day: intIn(0, 30), juices_per_day: intIn(0, 30),
    alcoholic_drinks_per_week: intIn(0, 100),
    cravings: textList(100, 30),
    craving_frequency: z.enum(['rare', 'sometimes', 'daily']).optional().nullable(),

    meal_preparer: z.enum(['self', 'family', 'cook', 'restaurant', 'food_delivery', 'mess', 'hostel', 'office_cafeteria']).optional().nullable(),
    nutrition_budget: z.enum(['low', 'medium', 'high', 'premium']).optional().nullable(),
    medical_conditions: textList(100, 30),
    medical_notes: text(2000),

    coach_notes: coachNotesSchema,
  }),
};

const nutritionAssessmentUpdateSchema = {
  body: nutritionAssessmentCreateSchema.body.omit({ client_id: true }).partial(),
};

// Shared by POST (create) and PATCH (update) so the Smart Nutrition
// Analysis columns never drift out of sync between the two write paths.
// Reads the client's latest Lifestyle Assessment (if any) for the
// smoking/alcohol risk inputs — a plain read of an existing table, no
// hard dependency: the two risk factors simply don't fire without it.
async function computeNutritionAnalysis(clientId, b) {
  // Alcohol and smoking are asked in Lifestyle; this form shows them rather
  // than asking a second time. A drinks-per-week on an older Nutrition row
  // still counts when Lifestyle has none.
  const lifestyle = await assessmentsRepo.latestLifestyleHabits(clientId);
  const drinksPerWeek = b.alcoholic_drinks_per_week ?? (lifestyle.drinks_per_week != null ? Number(lifestyle.drinks_per_week) : null);

  const dietQualityScore = nutritionScoring.calcDietQualityScore(
    b.foods_to_avoid ?? null, b.favourite_foods ?? null, b.cravings ?? null,
    b.craving_frequency ?? null, b.eating_behaviours ?? null, b.breakfast_regularity ?? null, b.late_night_eating ?? null
  );
  const protein = nutritionScoring.assessProtein(b.favourite_foods ?? null, b.takes_supplements ?? null, b.supplements ?? null);
  const dailyFluidIntake = nutritionScoring.calcDailyFluidIntake(
    b.water_intake_liters ?? null, b.tea_cups_per_day ?? null, b.coffee_cups_per_day ?? null, b.soft_drinks_per_day ?? null, b.juices_per_day ?? null
  );
  const hydrationScore = nutritionScoring.calcHydrationScore(b.water_intake_liters ?? null, b.soft_drinks_per_day ?? null, drinksPerWeek);
  const digestiveHealthScore = nutritionScoring.calcDigestiveHealthScore(b.digestive_issues ?? null);
  const supplementScore = nutritionScoring.calcSupplementScore(b.takes_supplements ?? null, b.supplements ?? null);

  const riskInputs = {
    proteinAssessment: protein.assessment, hydrationScore, digestiveHealthScore,
    cravings: b.cravings ?? null, cravingFrequency: b.craving_frequency ?? null,
    medicalConditions: b.medical_conditions ?? null, medicalNotes: b.medical_notes ?? null,
    alcoholStatus: lifestyle.alcohol_status || null, smokingStatus: lifestyle.smoking_status || null,
  };
  const nutritionRiskScore = nutritionScoring.calcNutritionRiskScore(riskInputs);
  const riskFactors = nutritionScoring.buildNutritionRiskFactors(riskInputs);

  const nutritionScoreVal = nutritionScoring.calcNutritionScore(
    { dietQuality: dietQualityScore, protein: protein.score, hydration: hydrationScore, digestive: digestiveHealthScore, supplement: supplementScore },
    nutritionRiskScore
  );
  const nutritionReadiness = nutritionScoring.classifyNutritionReadiness(nutritionScoreVal);

  return {
    dietQualityScore,
    proteinScore: protein.score, proteinAssessment: protein.assessment,
    dailyFluidIntake,
    hydrationScore,
    digestiveHealthScore,
    supplementScore,
    nutritionRiskScore, riskFactors,
    nutritionScore: nutritionScoreVal, nutritionReadiness,
  };
}

// GET /nutrition-assessments
//
// Same shape, and the same reasoning, as /lifestyle-assessments above — this
// table additionally holds food_allergies, medical_conditions and
// medical_notes, so the bare call was the widest medical-data read in the API.
router.get('/nutrition-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'client_id is required' } });
  }
  if (!await clientInOrg(req, client_id)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  }
  const params = [client_id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `SELECT * FROM pt_nutrition_assessments WHERE client_id = $1${org} ORDER BY assessment_date DESC`,
    params
  );
  return res.json({ data: rows });
}));

router.post('/nutrition-assessments', auth, requireTrainer, validate(nutritionAssessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const analysis = await computeNutritionAnalysis(b.client_id, b);

  const { rows } = await pool.query(
    `INSERT INTO pt_nutrition_assessments (
       client_id, assessment_number, assessment_date,
       diet_preferences,
       food_allergies, foods_to_avoid, foods_to_avoid_reason,
       favourite_foods,
       takes_supplements, supplements,
       digestive_issues,
       meals_per_day, breakfast_regularity, lunch_regularity, dinner_regularity, snacks_per_day,
       late_night_eating, meal_timing_consistency, eating_out_frequency, weekend_eating_habits, eating_behaviours,
       water_intake_liters, tea_cups_per_day, coffee_cups_per_day, soft_drinks_per_day, juices_per_day,
       alcoholic_drinks_per_week, daily_fluid_intake_liters, cravings, craving_frequency,
       meal_preparer, nutrition_budget, medical_conditions, medical_notes,
       diet_quality_score, protein_score, protein_assessment, hydration_score, digestive_health_score,
       supplement_score, nutrition_risk_score, risk_factors, nutrition_score, nutrition_readiness,
       coach_notes, created_by, organization_id
     ) VALUES (
       $1,(SELECT COUNT(*)+1 FROM pt_nutrition_assessments WHERE client_id = $1),COALESCE($2, CURRENT_DATE),
       $3,
       $4,$5,$6,
       $7,
       $8,$9::jsonb,
       $10::jsonb,
       $11,$12,$13,$14,$15,
       $16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,
       $26,$27,$28,$29,
       $30,$31,$32,$33,
       $34,$35,$36,$37,$38,
       $39,$40,$41,$42,$43,
       $44::jsonb,$45,$46
     ) RETURNING *`,
    [
      b.client_id, b.assessment_date || studioToday(),
      b.diet_preferences && b.diet_preferences.length ? b.diet_preferences : null,
      b.food_allergies && b.food_allergies.length ? b.food_allergies : null,
      b.foods_to_avoid && b.foods_to_avoid.length ? b.foods_to_avoid : null,
      b.foods_to_avoid_reason || null,
      b.favourite_foods && b.favourite_foods.length ? b.favourite_foods : null,
      b.takes_supplements ?? null, b.supplements ? JSON.stringify(b.supplements) : null,
      b.digestive_issues ? JSON.stringify(b.digestive_issues) : null,
      b.meals_per_day ?? null, b.breakfast_regularity || null, b.lunch_regularity || null, b.dinner_regularity || null, b.snacks_per_day ?? null,
      b.late_night_eating ?? null, b.meal_timing_consistency || null, b.eating_out_frequency || null, b.weekend_eating_habits || null,
      b.eating_behaviours && b.eating_behaviours.length ? b.eating_behaviours : null,
      b.water_intake_liters ?? null, b.tea_cups_per_day ?? null, b.coffee_cups_per_day ?? null, b.soft_drinks_per_day ?? null, b.juices_per_day ?? null,
      b.alcoholic_drinks_per_week ?? null, analysis.dailyFluidIntake, b.cravings && b.cravings.length ? b.cravings : null, b.craving_frequency || null,
      b.meal_preparer || null, b.nutrition_budget || null, b.medical_conditions && b.medical_conditions.length ? b.medical_conditions : null, b.medical_notes || null,
      analysis.dietQualityScore, analysis.proteinScore, analysis.proteinAssessment, analysis.hydrationScore, analysis.digestiveHealthScore,
      analysis.supplementScore, analysis.nutritionRiskScore, analysis.riskFactors.length ? analysis.riskFactors : null, analysis.nutritionScore, analysis.nutritionReadiness,
      b.coach_notes ? JSON.stringify(b.coach_notes) : null, req.user.id, orgIdOf(req),
    ]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/nutrition-assessments/:id', auth, validate(nutritionAssessmentUpdateSchema), wrap(async (req, res) => {
  const allowed = [
    'assessment_date',
    'diet_preferences',
    'food_allergies', 'foods_to_avoid', 'foods_to_avoid_reason',
    'favourite_foods',
    'takes_supplements', 'supplements',
    'digestive_issues',
    'meals_per_day', 'breakfast_regularity', 'lunch_regularity', 'dinner_regularity', 'snacks_per_day',
    'late_night_eating', 'meal_timing_consistency', 'eating_out_frequency', 'weekend_eating_habits', 'eating_behaviours',
    'water_intake_liters', 'tea_cups_per_day', 'coffee_cups_per_day', 'soft_drinks_per_day', 'juices_per_day',
    'alcoholic_drinks_per_week', 'cravings', 'craving_frequency',
    'meal_preparer', 'nutrition_budget', 'medical_conditions', 'medical_notes', 'coach_notes',
  ];

  // Scoped read before the write, as on the lifestyle PATCH above.
  const exParams = [req.params.id];
  const exOrg = orgWhere(req, exParams);
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_nutrition_assessments WHERE id = $1${exOrg}`, exParams
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = (key === 'coach_notes' || key === 'supplements' || key === 'digestive_issues') && req.body[key] != null
        ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = await computeNutritionAnalysis(existing.client_id, {
    foods_to_avoid: merged.foods_to_avoid, favourite_foods: merged.favourite_foods,
    cravings: merged.cravings, craving_frequency: merged.craving_frequency,
    eating_behaviours: merged.eating_behaviours, breakfast_regularity: merged.breakfast_regularity,
    late_night_eating: merged.late_night_eating,
    takes_supplements: merged.takes_supplements, supplements: merged.supplements,
    water_intake_liters: merged.water_intake_liters != null ? parseFloat(merged.water_intake_liters) : null,
    tea_cups_per_day: merged.tea_cups_per_day != null ? parseInt(merged.tea_cups_per_day, 10) : null,
    coffee_cups_per_day: merged.coffee_cups_per_day != null ? parseInt(merged.coffee_cups_per_day, 10) : null,
    soft_drinks_per_day: merged.soft_drinks_per_day != null ? parseInt(merged.soft_drinks_per_day, 10) : null,
    juices_per_day: merged.juices_per_day != null ? parseInt(merged.juices_per_day, 10) : null,
    alcoholic_drinks_per_week: merged.alcoholic_drinks_per_week != null ? parseInt(merged.alcoholic_drinks_per_week, 10) : null,
    digestive_issues: merged.digestive_issues,
    medical_conditions: merged.medical_conditions, medical_notes: merged.medical_notes,
  });

  for (const [col, val] of Object.entries({
    diet_quality_score: analysis.dietQualityScore,
    protein_score: analysis.proteinScore, protein_assessment: analysis.proteinAssessment,
    daily_fluid_intake_liters: analysis.dailyFluidIntake,
    hydration_score: analysis.hydrationScore,
    digestive_health_score: analysis.digestiveHealthScore,
    supplement_score: analysis.supplementScore,
    nutrition_risk_score: analysis.nutritionRiskScore, risk_factors: analysis.riskFactors.length ? analysis.riskFactors : null,
    nutrition_score: analysis.nutritionScore, nutrition_readiness: analysis.nutritionReadiness,
  })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const upOrg = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_nutrition_assessments SET ${sets.join(', ')} WHERE id = $1${upOrg} RETURNING *`, params
  );
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json({ data: rows[0] });
}));

// Scores are the page's 1-5 scale. A 42 used to be stored and pushed the
// mobility score to 100.
const bodyRegionSchema = z.object({
  region: z.string().max(60), score: intIn(1, 5), pain: z.boolean().optional().nullable(), restriction: z.boolean().optional().nullable(),
});
const mobilityTestSchema = z.object({
  test: z.string().max(60), score: intIn(1, 5), notes: text(500),
  pain: z.boolean().optional().nullable(), restriction: z.boolean().optional().nullable(),
});

const mobilityPerformanceAssessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: pastDate(),

    body_regions: z.array(bodyRegionSchema).max(20).optional().nullable(),
    mobility_tests: z.array(mobilityTestSchema).max(20).optional().nullable(),

    grip_strength_kg: numIn(1, 150), vertical_jump_cm: numIn(1, 150), sit_reach_cm: numIn(-50, 80),
    balance_test_seconds: numIn(0, 600), reaction_time_ms: numIn(50, 3000),
    performance_notes: text(2000),
  }),
};

const mobilityPerformanceAssessmentUpdateSchema = {
  body: mobilityPerformanceAssessmentCreateSchema.body.omit({ client_id: true }).partial(),
};

// Referrals are derived from what is stored (pain flags, scoliosis), never
// stored themselves, so every row read back carries them — including rows
// saved before the rule existed.
function withMobilityReferrals(row) {
  if (!row) return row;
  return { ...row, referrals: mobilityScoring.calcMobilityReferrals(row.body_regions, row.mobility_tests) };
}
function withPostureReferrals(row) {
  if (!row) return row;
  return { ...row, referrals: postureScoring.calcPostureReferrals(row.front_issues, row.side_issues, row.back_issues) };
}

function computeMobilityAnalysis(b) {
  const mobilityScore = mobilityScoring.calcMobilityScore(b.body_regions ?? null, b.mobility_tests ?? null);
  const mobilityCategory = mobilityScoring.classifyMobility(mobilityScore);
  return { mobilityScore, mobilityCategory };
}

router.get('/mobility-performance-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  // Multi-tenant isolation: this table missed the 084 sweep (weekly_checkins/
  // strength_logs/progress_photos) — client_id alone let a caller who knows or
  // guesses another org's client_id list that org's mobility records.
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`organization_id = $${params.length}`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_mobility_performance_assessments ${whereSql} ORDER BY assessment_date DESC`, params
  );
  res.json({ data: rows.map(withMobilityReferrals) });
}));

router.post('/mobility-performance-assessments', auth, requireTrainer, validate(mobilityPerformanceAssessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const analysis = computeMobilityAnalysis(b);

  const { rows } = await pool.query(
    `INSERT INTO pt_mobility_performance_assessments (
       client_id, assessment_number, assessment_date,
       body_regions, mobility_tests,
       grip_strength_kg, vertical_jump_cm, sit_reach_cm, balance_test_seconds, reaction_time_ms, performance_notes,
       mobility_score, mobility_category, created_by, organization_id
     ) VALUES (
       $1,(SELECT COUNT(*)+1 FROM pt_mobility_performance_assessments WHERE client_id = $1),COALESCE($2, CURRENT_DATE),
       $3::jsonb,$4::jsonb,
       $5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14
     ) RETURNING *`,
    [
      b.client_id, b.assessment_date || studioToday(),
      b.body_regions ? JSON.stringify(b.body_regions) : null, b.mobility_tests ? JSON.stringify(b.mobility_tests) : null,
      b.grip_strength_kg ?? null, b.vertical_jump_cm ?? null, b.sit_reach_cm ?? null, b.balance_test_seconds ?? null, b.reaction_time_ms ?? null, b.performance_notes || null,
      analysis.mobilityScore, analysis.mobilityCategory, req.user.id, orgIdOf(req),
    ]
  );
  res.status(201).json({ data: withMobilityReferrals(rows[0]) });
}));

router.patch('/mobility-performance-assessments/:id', auth, validate(mobilityPerformanceAssessmentUpdateSchema), wrap(async (req, res) => {
  const allowed = [
    'assessment_date', 'body_regions', 'mobility_tests',
    'grip_strength_kg', 'vertical_jump_cm', 'sit_reach_cm', 'balance_test_seconds', 'reaction_time_ms', 'performance_notes',
  ];

  const scope = tenantScope(req);
  const guard = ' AND organization_id = $2';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_mobility_performance_assessments WHERE id = $1${guard}`,
    [req.params.id, scope.orgId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = (key === 'body_regions' || key === 'mobility_tests') && req.body[key] != null ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = computeMobilityAnalysis({ body_regions: merged.body_regions, mobility_tests: merged.mobility_tests });

  for (const [col, val] of Object.entries({ mobility_score: analysis.mobilityScore, mobility_category: analysis.mobilityCategory })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_mobility_performance_assessments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: withMobilityReferrals(rows[0]) });
}));

const postureAssessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    assessment_date: pastDate(),

    front_issues: textList(60, 20),
    side_issues: textList(60, 20),
    back_issues: textList(60, 20),
    other_issue_notes: text(1000),

    coach_notes: coachNotesSchema,
  }),
};

const postureAssessmentUpdateSchema = {
  body: postureAssessmentCreateSchema.body.omit({ client_id: true }).partial(),
};

function computePostureAnalysis(b) {
  const postureRiskScore = postureScoring.calcPostureRiskScore(b.front_issues ?? null, b.side_issues ?? null, b.back_issues ?? null);
  const postureRiskLevel = postureScoring.classifyRisk(postureRiskScore);
  return { postureRiskScore, postureRiskLevel };
}

router.get('/posture-assessments', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push(`client_id = $${params.length}`); }
  // Multi-tenant isolation: this table missed the 084 sweep the same way
  // mobility-performance-assessments did — see that route for the finding.
  const scope = tenantScope(req);
  params.push(scope.orgId); where.push(`organization_id = $${params.length}`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_posture_assessments ${whereSql} ORDER BY assessment_date DESC`, params
  );
  res.json({ data: rows.map(withPostureReferrals) });
}));

router.post('/posture-assessments', auth, requireTrainer, validate(postureAssessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!await clientInOrg(req, b.client_id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });
  const analysis = computePostureAnalysis(b);

  const { rows } = await pool.query(
    `INSERT INTO pt_posture_assessments (
       client_id, assessment_number, assessment_date,
       front_issues, side_issues, back_issues, other_issue_notes,
       posture_risk_score, posture_risk_level,
       coach_notes, created_by, organization_id
     ) VALUES (
       $1,(SELECT COUNT(*)+1 FROM pt_posture_assessments WHERE client_id = $1),COALESCE($2, CURRENT_DATE),
       $3,$4,$5,$6,
       $7,$8,
       $9::jsonb,$10,$11
     ) RETURNING *`,
    [
      b.client_id, b.assessment_date || studioToday(),
      b.front_issues && b.front_issues.length ? b.front_issues : null,
      b.side_issues && b.side_issues.length ? b.side_issues : null,
      b.back_issues && b.back_issues.length ? b.back_issues : null,
      b.other_issue_notes || null,
      analysis.postureRiskScore, analysis.postureRiskLevel,
      b.coach_notes ? JSON.stringify(b.coach_notes) : null, req.user.id, orgIdOf(req),
    ]
  );
  res.status(201).json({ data: withPostureReferrals(rows[0]) });
}));

router.patch('/posture-assessments/:id', auth, validate(postureAssessmentUpdateSchema), wrap(async (req, res) => {
  const allowed = ['assessment_date', 'front_issues', 'side_issues', 'back_issues', 'other_issue_notes', 'coach_notes'];

  const scope = tenantScope(req);
  const guard = ' AND organization_id = $2';
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM pt_posture_assessments WHERE id = $1${guard}`,
    [req.params.id, scope.orgId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND' } });

  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = key === 'coach_notes' && req.body[key] != null ? JSON.stringify(req.body[key]) : req.body[key];
      params.push(val); sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });

  const merged = { ...existing, ...req.body };
  const analysis = computePostureAnalysis({ front_issues: merged.front_issues, side_issues: merged.side_issues, back_issues: merged.back_issues });

  for (const [col, val] of Object.entries({ posture_risk_score: analysis.postureRiskScore, posture_risk_level: analysis.postureRiskLevel })) {
    params.push(val); sets.push(`${col} = $${params.length}`);
  }

  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_posture_assessments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: withPostureReferrals(rows[0]) });
}));

module.exports = router;

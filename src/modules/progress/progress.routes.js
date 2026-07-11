const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const scoring = require('./fitness-scoring');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const numOpt = () => z.coerce.number().optional().nullable();

const assessmentCreateSchema = {
  body: z.object({
    client_id: z.string(),
    trainer_id: z.string().optional().nullable(),
    assessment_date: z.string().optional().nullable(),
    assessment_type: z.enum(['initial', 'week_4', 'week_8', 'week_12', 'monthly', 'quarterly', 'follow_up', 'custom']).optional(),
    assessment_notes: z.string().max(2000).optional().nullable(),
    age: numOpt(), gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),

    // Step 1 — Blood Pressure
    bp_systolic: numOpt(), bp_diastolic: numOpt(), resting_heart_rate: numOpt(), resting_spo2: numOpt(),

    // Step 2 — Anthropometric
    weight: numOpt(), height_cm: numOpt(), waist_cm: numOpt(), hips_cm: numOpt(), neck_cm: numOpt(), chest_cm: numOpt(),
    arm_right_cm: numOpt(), arm_left_cm: numOpt(), thigh_right_cm: numOpt(), thigh_left_cm: numOpt(),
    calf_right_cm: numOpt(), calf_left_cm: numOpt(),

    // Step 3 — Body Composition
    body_comp_method: z.enum(['BIA Machine', 'Skinfold', 'DEXA', 'Manual', 'Other']).optional().nullable(),
    body_fat_pct: numOpt(), muscle_mass_pct: numOpt(), visceral_fat: numOpt(), subcutaneous_fat_pct: numOpt(),
    body_water_pct: numOpt(), bone_mass_kg: numOpt(), bmr: numOpt(), bmr_auto_suggested: z.boolean().optional(),
    metabolic_age: numOpt(),

    // Step 4 — Cardiorespiratory Endurance
    cardio_test_type: z.enum(['YMCA 3-Minute Step Test', 'Rockport 1-Mile Walk', 'Cooper 12-Minute Run', 'Bruce Protocol', 'Harvard Step Test', 'Custom']).optional().nullable(),
    cardio_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 5 — Muscular Strength
    strength_exercise: z.string().max(100).optional().nullable(),
    strength_weight_kg: numOpt(), strength_reps: numOpt(),
    strength_formula: z.enum(['brzycki', 'epley']).optional(),
    strength_direct_1rm: numOpt(), strength_is_direct: z.boolean().optional(),

    // Step 6 — Muscular Endurance
    endurance_test_type: z.enum(['Push Up Test', 'Curl Up Test', 'Wall Sit', 'Plank', 'Bodyweight Squat', 'Custom']).optional().nullable(),
    endurance_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    // Step 7 — Flexibility
    flexibility_test_data: z.record(z.string(), z.unknown()).optional().nullable(),

    posture_notes: z.string().max(2000).optional().nullable(),
    health_notes: z.string().max(2000).optional().nullable(),
    trainer_notes: z.string().max(2000).optional().nullable(),
  }),
};

router.get('/assessments', auth, wrap(async (req, res) => {
  const { client_id, limit, offset } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  params.push(lim); params.push(Math.max(parseInt(offset, 10) || 0, 0));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT pa.*, t.name AS trainer_name FROM pt_assessments pa
     LEFT JOIN trainers t ON t.id = pa.trainer_id ${whereSql}
     ORDER BY assessment_date DESC LIMIT $${where.length + 1} OFFSET $${where.length + 2}`, params
  );
  res.json({ data: rows });
}));

router.post('/assessments', auth, requireRole('admin','manager','trainer'), validate(assessmentCreateSchema), wrap(async (req, res) => {
  const b = req.body;
  const trainer_id = req.user.role === 'trainer' ? req.user.trainer_id : b.trainer_id;

  // Age/gender: prefer what the frontend sent (it already has the client
  // record loaded); fall back to a DB lookup so BMR/VO2max/norms still work
  // if the caller omits them.
  let age = b.age ?? null;
  let gender = b.gender ?? null;
  if (age == null || gender == null) {
    const { rows: cRows } = await pool.query('SELECT dob, gender FROM pt_clients WHERE id = $1', [b.client_id]);
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

  // ── Step 1: Blood Pressure ──
  const bp = scoring.classifyBp(b.bp_systolic ?? null, b.bp_diastolic ?? null);

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
  const cd = b.cardio_test_data || {};
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

  // ── Step 5: Strength ──
  const strengthFormula = b.strength_formula === 'brzycki' ? 'brzycki' : 'epley';
  const strengthOneRm = b.strength_is_direct
    ? (b.strength_direct_1rm ?? null)
    : scoring.calc1RM(b.strength_weight_kg ?? null, b.strength_reps ?? null, strengthFormula);
  const strengthCategory = scoring.classifyStrength(strengthOneRm, b.weight ?? null, b.strength_exercise || 'Bench Press', gender);
  const strengthScore = scoring.scoreCategory(strengthCategory);

  // ── Step 6: Endurance ──
  const ed = b.endurance_test_data || {};
  const enduranceValue = num(ed.reps, null) ?? num(ed.durationSec, null);
  const enduranceCategory = scoring.classifyEndurance(b.endurance_test_type, enduranceValue, gender);
  const enduranceScore = scoring.scoreCategory(enduranceCategory);

  // ── Step 7: Flexibility ──
  const fd = b.flexibility_test_data || {};
  const hasAsymmetry = scoring.checkAsymmetry(num(fd.left, null), num(fd.right, null));
  const flexibilityCategory = scoring.classifyFlexibilityScore(num(fd.score, null));
  const mobilityScore = scoring.scoreCategory(flexibilityCategory);

  // ── Dashboard scores ──
  const bodyCompositionScore = scoring.scoreBodyComposition(b.body_fat_pct ?? null, gender);
  const healthRiskScore = scoring.scoreHealthRisk(bp.category, bmi);
  const overallScore = scoring.computeOverallScore({
    bodyComposition: bodyCompositionScore, endurance: enduranceScore,
    mobility: mobilityScore, cardio: cardioScore, healthRisk: healthRiskScore,
    strength: strengthScore,
  });

  const { rows } = await pool.query(
    `INSERT INTO pt_assessments (
       client_id, trainer_id, assessment_type, assessment_number, assessment_date,
       trainer_notes,
       bp_systolic, bp_diastolic, resting_heart_rate, resting_spo2, bp_category,
       weight, height_cm, bmi, waist_cm, hips_cm, waist_hip_ratio, neck_cm, chest_cm,
       arm_right_cm, arm_left_cm, thigh_right_cm, thigh_left_cm, calf_right_cm, calf_left_cm,
       body_comp_method, body_fat_pct, muscle_mass_pct, lean_body_mass_kg, fat_mass_kg,
       visceral_fat, subcutaneous_fat_pct, body_water_pct, bone_mass_kg, bmr, bmr_auto_suggested, metabolic_age,
       cardio_test_type, cardio_test_data, vo2_max, cardio_category, cardio_score_computed,
       strength_score_computed,
       endurance_test_data, endurance_category, endurance_score_computed,
       flexibility_test_data, flexibility_category, has_asymmetry, mobility_score_computed,
       body_composition_score, health_risk_score, overall_fitness_score,
       posture_notes, health_notes, created_by
     ) VALUES (
       $1,$2,$3,(SELECT COUNT(*)+1 FROM pt_assessments WHERE client_id = $1),COALESCE($4, NOW()),
       $5,
       $6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22,$23,$24,
       $25,$26,$27,$28,$29,
       $30,$31,$32,$33,$34,$35,$36,
       $37,$38::jsonb,$39,$40,$41,
       $42,
       $43::jsonb,$44,$45,
       $46::jsonb,$47,$48,$49,
       $50,$51,$52,
       $53,$54,$55
     ) RETURNING *`,
    [
      b.client_id, trainer_id, b.assessment_type || 'initial', b.assessment_date || null,
      b.trainer_notes || b.assessment_notes || null,
      b.bp_systolic ?? null, b.bp_diastolic ?? null, b.resting_heart_rate ?? null, b.resting_spo2 ?? null, bp.category,
      b.weight ?? null, b.height_cm ?? null, bmi, b.waist_cm ?? null, b.hips_cm ?? null, waistHipRatio, b.neck_cm ?? null, b.chest_cm ?? null,
      b.arm_right_cm ?? null, b.arm_left_cm ?? null, b.thigh_right_cm ?? null, b.thigh_left_cm ?? null, b.calf_right_cm ?? null, b.calf_left_cm ?? null,
      b.body_comp_method || null, b.body_fat_pct ?? null, b.muscle_mass_pct ?? null, leanBodyMass, fatMass,
      b.visceral_fat ?? null, b.subcutaneous_fat_pct ?? null, b.body_water_pct ?? null, b.bone_mass_kg ?? null, bmr, bmrAutoSuggested, b.metabolic_age ?? null,
      b.cardio_test_type || null, JSON.stringify(cd), vo2Max, cardioCategory, cardioScore,
      strengthScore,
      JSON.stringify(ed), enduranceCategory, enduranceScore,
      JSON.stringify(fd), flexibilityCategory, hasAsymmetry, mobilityScore,
      bodyCompositionScore, healthRiskScore, overallScore,
      b.posture_notes || null, b.health_notes || null, req.user.id,
    ]
  );
  res.status(201).json({ data: { ...rows[0], bp_unsafe: bp.isUnsafe } });
}));

router.get('/goals', auth, wrap(async (req, res) => {
  const { client_id } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_goals ${whereSql} ORDER BY is_active DESC, created_at DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/goals', auth, wrap(async (req, res) => {
  const { client_id, goal_type, goal_other, target_weight, target_body_fat, target_date, notes } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO pt_goals (client_id, goal_type, goal_other, target_weight, target_body_fat, target_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [client_id, goal_type, goal_other || null, num(target_weight, null), num(target_body_fat, null),
     target_date || null, notes || null, req.user.id]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/goals/:id', auth, wrap(async (req, res) => {
  const allowed = ['goal_type','goal_other','target_weight','target_body_fat','target_date','notes','is_active'];
  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE pt_goals SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

router.get('/weekly-checkins', auth, wrap(async (req, res) => {
  const { client_id, limit } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 52);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM weekly_checkins ${whereSql} ORDER BY week_start_date DESC LIMIT $${where.length + 1}`, params
  );
  res.json({ data: rows });
}));

router.post('/weekly-checkins', auth, wrap(async (req, res) => {
  const { client_id, week_start_date, weight, mood, sleep_hours, water_glasses, workout_count, calories_avg, adherence_pct, trainer_notes, client_notes } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO weekly_checkins (client_id, week_start_date, weight, mood, sleep_hours, water_glasses,
      workout_count, calories_avg, adherence_pct, trainer_notes, client_notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (client_id, week_start_date) DO UPDATE SET
       weight = EXCLUDED.weight, mood = EXCLUDED.mood, sleep_hours = EXCLUDED.sleep_hours,
       water_glasses = EXCLUDED.water_glasses, workout_count = EXCLUDED.workout_count,
       calories_avg = EXCLUDED.calories_avg, adherence_pct = EXCLUDED.adherence_pct,
       trainer_notes = EXCLUDED.trainer_notes, client_notes = EXCLUDED.client_notes,
       updated_at = NOW()
     RETURNING *`,
    [client_id, week_start_date, num(weight, null), mood || null, num(sleep_hours, null),
     num(water_glasses, null), num(workout_count, 0), num(calories_avg, null),
     num(adherence_pct, null), trainer_notes || null, client_notes || null, req.user.id]
  );
  res.status(201).json({ data: rows[0] });
}));

router.get('/strength-logs', auth, wrap(async (req, res) => {
  const { client_id, exercise_name, limit } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  if (exercise_name) { params.push(exercise_name); where.push(`exercise_name = $${where.length + 1}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM strength_logs ${whereSql} ORDER BY log_date DESC LIMIT $${where.length + 1}`, params
  );
  res.json({ data: rows });
}));

router.post('/strength-logs', auth, wrap(async (req, res) => {
  const { client_id, exercise_name, weight_kg, sets_done, reps_done, notes,
    assessment_id, one_rm_formula, is_direct_1rm, one_rm_estimate } = req.body;
  const formula = one_rm_formula === 'brzycki' ? 'brzycki' : 'epley';
  const oneRm = is_direct_1rm
    ? num(one_rm_estimate, null)
    : scoring.calc1RM(num(weight_kg), num(reps_done, 10), formula);
  const { rows } = await pool.query(
    `INSERT INTO strength_logs (client_id, exercise_name, weight_kg, sets_done, reps_done, one_rm_estimate, notes, assessment_id, one_rm_formula, is_direct_1rm)
     VALUES ($1,$2,$3,$4,$5,ROUND($6::NUMERIC,2),$7,$8,$9,$10) RETURNING *`,
    [client_id, exercise_name, num(weight_kg), num(sets_done, 3), num(reps_done, 10), oneRm, notes || null,
     assessment_id || null, formula, Boolean(is_direct_1rm)]
  );
  res.status(201).json({ data: rows[0] });
}));

router.get('/progress-photos', auth, wrap(async (req, res) => {
  const { client_id, limit } = req.query;
  const where = []; const params = [];
  if (client_id) { params.push(client_id); where.push('client_id = $1'); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(lim);
  const { rows } = await pool.query(
    `SELECT * FROM progress_photos ${whereSql} ORDER BY taken_at DESC LIMIT $${where.length + 1}`, params
  );
  res.json({ data: rows });
}));

router.post('/progress-photos', auth, wrap(async (req, res) => {
  const { client_id, photo_url, photo_type, taken_at, notes } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO progress_photos (client_id, photo_url, photo_type, taken_at, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [client_id, photo_url, photo_type || 'front', taken_at || new Date().toISOString().split('T')[0],
     notes || null, req.user.id]
  );
  res.status(201).json({ data: rows[0] });
}));

router.delete('/progress-photos/:id', auth, wrap(async (req, res) => {
  await pool.query('DELETE FROM progress_photos WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

module.exports = router;

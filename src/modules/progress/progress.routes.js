const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

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

router.post('/assessments', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const { client_id, assessment_type, weight, height_cm, body_fat_pct, muscle_mass_pct,
    chest_cm, waist_cm, hips_cm, arms_cm, thighs_cm, flexibility_score,
    cardio_score, strength_score, posture_notes, health_notes, trainer_notes } = req.body;
  const bmi = num(height_cm) > 0 ? num(weight) / ((num(height_cm) / 100) ** 2) : null;
  const trainer_id = req.user.role === 'trainer' ? req.user.trainer_id : req.body.trainer_id;
  const { rows } = await pool.query(
    `INSERT INTO pt_assessments (client_id, trainer_id, assessment_type, weight, height_cm,
      body_fat_pct, muscle_mass_pct, bmi, chest_cm, waist_cm, hips_cm, arms_cm, thighs_cm,
      flexibility_score, cardio_score, strength_score, posture_notes, health_notes, trainer_notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [client_id, trainer_id, assessment_type || 'initial', num(weight, null), num(height_cm, null),
     num(body_fat_pct, null), num(muscle_mass_pct, null), bmi ? Math.round(bmi * 10) / 10 : null,
     num(chest_cm, null), num(waist_cm, null), num(hips_cm, null), num(arms_cm, null), num(thighs_cm, null),
     num(flexibility_score, null), num(cardio_score, null), num(strength_score, null),
     posture_notes || null, health_notes || null, trainer_notes || null, req.user.id]
  );
  res.status(201).json({ data: rows[0] });
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
  const { client_id, exercise_name, weight_kg, sets_done, reps_done, notes } = req.body;
  const oneRm = num(weight_kg) * (1 + num(reps_done, 10) / 30);
  const { rows } = await pool.query(
    `INSERT INTO strength_logs (client_id, exercise_name, weight_kg, sets_done, reps_done, one_rm_estimate, notes)
     VALUES ($1,$2,$3,$4,$5,ROUND($6::NUMERIC,2),$7) RETURNING *`,
    [client_id, exercise_name, num(weight_kg), num(sets_done, 3), num(reps_done, 10), oneRm, notes || null]
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

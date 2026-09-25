'use strict';
// The member app's own data: my programme, my diet, my weekly check-ins.
//
// Same rule as client-portal.routes.js, and the reason this module is safe:
// every function takes the client id and org id the ROUTE read from the
// session (selfOf(req)). Nothing here accepts an id from a request, so there
// is no parameter a member could change to read someone else's plan.
//
// Every query is also bounded by organization_id as a second lock, and every
// column list is an allow-list — trainer-only fields (trainer_notes, plan
// authorship, pricing) are never selected.

const pool = require('../../db/pool');
const { today } = require('../../lib/appTime');

const MOODS = ['great', 'good', 'okay', 'tired', 'stressed'];

class PortalInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** 'YYYY-MM-DD' of the Monday of the week containing `ymd`. */
function mondayOf(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Whole weeks since `start` (1-based), for picking a programme's current week. */
function weekNumberSince(startYmd, nowYmd) {
  if (!startYmd) return 1;
  const start = new Date(`${String(startYmd).slice(0, 10)}T00:00:00Z`);
  const now = new Date(`${nowYmd}T00:00:00Z`);
  const days = Math.floor((now - start) / 86400000);
  return days < 0 ? 1 : Math.floor(days / 7) + 1;
}

// ── My programme ─────────────────────────────────────────────────────────────

/**
 * The client's active workout programmes, each with the exercises for the
 * current week grouped by training day.
 *
 * A plan may be written week by week (week_number set) or as one repeating
 * week (week_number NULL). For the former the current week is the one the
 * assignment has reached, clamped to the last week written, so a client past
 * the end still sees their final week rather than nothing.
 */
async function myWorkout(clientId, orgId) {
  const { rows: assignments } = await pool.query(
    `SELECT a.id AS assignment_id, a.start_date, a.end_date, a.progress_pct,
            p.id AS plan_id, p.name, p.description, p.goal, p.difficulty,
            p.duration_weeks, p.sessions_per_week
       FROM workout_assignments a
       JOIN workout_plans p ON p.id = a.workout_plan_id AND p.deleted_at IS NULL
      WHERE a.client_id = $1 AND a.organization_id = $2 AND a.status = 'active'
      ORDER BY a.start_date DESC NULLS LAST, a.created_at DESC
      LIMIT 5`,
    [clientId, orgId],
  );
  if (assignments.length === 0) return [];

  const { rows: exercises } = await pool.query(
    `SELECT we.workout_plan_id, we.day_of_week, we.week_number, we.sort_order,
            we.sets, we.reps, we.rest_seconds, we.target_weight, we.tempo, we.rpe,
            we.notes, e.name, e.equipment, e.video_url, e.image_url, e.gif_url
       FROM workout_exercises we
       LEFT JOIN exercises e ON e.id = we.exercise_id
      WHERE we.workout_plan_id = ANY($1::text[])
      ORDER BY we.workout_plan_id, we.week_number NULLS FIRST, we.day_of_week, we.sort_order`,
    [assignments.map((a) => a.plan_id)],
  );

  const now = today();
  return assignments.map((a) => {
    const own = exercises.filter((x) => x.workout_plan_id === a.plan_id);
    const weeks = [...new Set(own.map((x) => x.week_number).filter((w) => w != null))].sort((x, y) => x - y);
    const reached = weekNumberSince(a.start_date, now);
    const currentWeek = weeks.length ? Math.min(reached, weeks[weeks.length - 1]) : null;
    const thisWeek = own.filter((x) => x.week_number == null || x.week_number === currentWeek);

    const byDay = new Map();
    for (const x of thisWeek) {
      const day = x.day_of_week ?? 0;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({
        name: x.name || 'Exercise',
        sets: x.sets, reps: x.reps, rest_seconds: x.rest_seconds,
        target_weight: x.target_weight != null ? Number(x.target_weight) : null,
        tempo: x.tempo, rpe: x.rpe != null ? Number(x.rpe) : null, notes: x.notes,
        equipment: x.equipment, media_url: x.gif_url || x.image_url || null, video_url: x.video_url,
      });
    }

    return {
      assignment_id: a.assignment_id,
      name: a.name,
      description: a.description,
      goal: a.goal,
      difficulty: a.difficulty,
      duration_weeks: a.duration_weeks,
      sessions_per_week: a.sessions_per_week,
      start_date: a.start_date,
      end_date: a.end_date,
      current_week: currentWeek ?? (a.duration_weeks ? Math.min(reached, a.duration_weeks) : null),
      days: [...byDay.entries()]
        .sort(([x], [y]) => x - y)
        .map(([day_of_week, list]) => ({ day_of_week, exercises: list })),
    };
  });
}

// ── My diet ──────────────────────────────────────────────────────────────────

/** The client's active diet plans with their daily targets and meals. */
async function myDiet(clientId, orgId) {
  const { rows: plans } = await pool.query(
    `SELECT da.id AS assignment_id, da.start_date, da.end_date,
            dt.id AS template_id, dt.name, dt.description, dt.goal, dt.daily_calories,
            dt.daily_protein_g, dt.daily_carbs_g, dt.daily_fats_g
       FROM diet_assignments da
       JOIN diet_templates dt ON dt.id = da.diet_template_id
      WHERE da.client_id = $1 AND da.organization_id = $2 AND da.status = 'active'
        AND (dt.organization_id IS NULL OR dt.organization_id = $2)
      ORDER BY da.start_date DESC, da.created_at DESC
      LIMIT 5`,
    [clientId, orgId],
  );
  if (plans.length === 0) return [];

  const { rows: meals } = await pool.query(
    `SELECT dpm.diet_template_id, dpm.day_of_week, dpm.sort_order,
            m.name, m.description, m.meal_type, m.calories, m.protein_g, m.carbs_g, m.fats_g, m.serving_size
       FROM diet_plan_meals dpm
       JOIN meals m ON m.id = dpm.meal_id
      WHERE dpm.diet_template_id = ANY($1::text[])
        AND (m.organization_id IS NULL OR m.organization_id = $2)
      ORDER BY dpm.diet_template_id, dpm.day_of_week NULLS FIRST, dpm.sort_order`,
    [plans.map((p) => p.template_id), orgId],
  );

  const n = (v) => (v == null ? null : Number(v));
  return plans.map((p) => ({
    assignment_id: p.assignment_id,
    name: p.name,
    description: p.description,
    goal: p.goal,
    start_date: p.start_date,
    end_date: p.end_date,
    daily: {
      calories: p.daily_calories,
      protein_g: n(p.daily_protein_g),
      carbs_g: n(p.daily_carbs_g),
      fats_g: n(p.daily_fats_g),
    },
    meals: meals
      .filter((m) => m.diet_template_id === p.template_id)
      .map((m) => ({
        name: m.name, description: m.description, meal_type: m.meal_type,
        day_of_week: m.day_of_week, calories: m.calories,
        protein_g: n(m.protein_g), carbs_g: n(m.carbs_g), fats_g: n(m.fats_g),
        serving_size: m.serving_size,
      })),
  }));
}

// ── My weekly check-ins ──────────────────────────────────────────────────────

/** Recent check-ins, newest first. trainer_notes is deliberately not selected. */
async function myCheckins(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT id, week_start_date, weight, mood, sleep_hours, water_glasses,
            stress_level, energy_level, soreness_level, client_notes, created_at, updated_at
       FROM weekly_checkins
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY week_start_date DESC
      LIMIT 26`,
    [clientId, orgId],
  );
  return { this_week: mondayOf(today()), checkins: rows };
}

function optNumber(v, min, max, field, { integer = false } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new PortalInputError(`${field} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}`);
  }
  return n;
}

/** Validate a member's own check-in into exactly the columns they may write. */
function normaliseCheckin(body = {}) {
  const mood = body.mood == null || body.mood === '' ? null : String(body.mood);
  if (mood !== null && !MOODS.includes(mood)) throw new PortalInputError(`mood must be one of ${MOODS.join(', ')}`);
  const notes = body.client_notes == null ? null : String(body.client_notes).trim().slice(0, 1000) || null;
  const out = {
    weight: optNumber(body.weight, 20, 400, 'weight'),
    mood,
    sleep_hours: optNumber(body.sleep_hours, 0, 24, 'sleep_hours'),
    water_glasses: optNumber(body.water_glasses, 0, 40, 'water_glasses', { integer: true }),
    stress_level: optNumber(body.stress_level, 1, 10, 'stress_level', { integer: true }),
    energy_level: optNumber(body.energy_level, 1, 10, 'energy_level', { integer: true }),
    soreness_level: optNumber(body.soreness_level, 1, 10, 'soreness_level', { integer: true }),
    client_notes: notes,
  };
  if (Object.values(out).every((v) => v === null)) {
    throw new PortalInputError('Add at least one reading to your check-in');
  }
  return out;
}

/**
 * Create or update THIS week's check-in for the signed-in client.
 *
 * The week is the server's, not the request's — a member cannot back-date or
 * pre-date a check-in. On an existing row only the member's own readings are
 * replaced: trainer_notes, adherence and calories are the trainer's, and a
 * member submitting must never erase what their trainer wrote.
 */
async function upsertMyCheckin(clientId, orgId, userId, body) {
  const c = normaliseCheckin(body);
  const week = mondayOf(today());
  const { rows } = await pool.query(
    `INSERT INTO weekly_checkins (client_id, week_start_date, weight, mood, sleep_hours, water_glasses,
       stress_level, energy_level, soreness_level, client_notes, created_by, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (client_id, week_start_date) DO UPDATE SET
       weight = EXCLUDED.weight, mood = EXCLUDED.mood, sleep_hours = EXCLUDED.sleep_hours,
       water_glasses = EXCLUDED.water_glasses, stress_level = EXCLUDED.stress_level,
       energy_level = EXCLUDED.energy_level, soreness_level = EXCLUDED.soreness_level,
       client_notes = EXCLUDED.client_notes, updated_at = NOW()
     WHERE weekly_checkins.organization_id = EXCLUDED.organization_id
     RETURNING id, week_start_date, weight, mood, sleep_hours, water_glasses,
               stress_level, energy_level, soreness_level, client_notes, created_at, updated_at`,
    [clientId, week, c.weight, c.mood, c.sleep_hours, c.water_glasses,
      c.stress_level, c.energy_level, c.soreness_level, c.client_notes, userId, orgId],
  );
  return rows[0] || null;
}

module.exports = {
  myWorkout, myDiet, myCheckins, upsertMyCheckin,
  normaliseCheckin, mondayOf, weekNumberSince, PortalInputError, MOODS,
};

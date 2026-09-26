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
const logger = require('../../lib/logger');

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

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The sessions the trainer logged for this client — newest first, with each
 * exercise and the sets actually done (load, reps, RPE, personal-best flags,
 * and time/distance for cardio work).
 *
 * The trainer's free-text notes on a session, exercise or set are NOT
 * returned: they are written for the studio, not for the client, and nothing
 * about them promises the client will read them.
 *
 * Scoped to the client AND the studio on the session row; exercises and sets
 * are reached only through those sessions' ids.
 */
async function mySessions(clientId, orgId, { limit = 30 } = {}) {
  const { rows: sessions } = await pool.query(
    `SELECT id, session_date, program_name, workout_day, duration_minutes, status
       FROM workout_sessions
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY session_date DESC, created_at DESC
      LIMIT $3`,
    [clientId, orgId, limit],
  );
  if (sessions.length === 0) return [];

  const { rows: sets } = await pool.query(
    `SELECT e.session_id, e.id AS exercise_row_id, e.exercise_name, e.sort_order,
            s.set_number, s.weight_kg, s.reps, s.rpe, s.completed,
            s.is_pr_weight, s.is_pr_reps, s.is_pr_volume,
            s.duration_seconds, s.distance, s.distance_unit
       FROM workout_session_exercises e
       LEFT JOIN workout_sets s ON s.session_exercise_id = e.id
      WHERE e.session_id = ANY($1::text[])
      ORDER BY e.session_id, e.sort_order NULLS LAST, e.created_at, s.set_number NULLS LAST`,
    [sessions.map((s) => s.id)],
  );

  const bySession = new Map(sessions.map((s) => [s.id, []]));
  const exerciseIndex = new Map();
  for (const r of sets) {
    let ex = exerciseIndex.get(r.exercise_row_id);
    if (!ex) {
      ex = { name: r.exercise_name, sets: [] };
      exerciseIndex.set(r.exercise_row_id, ex);
      bySession.get(r.session_id)?.push(ex);
    }
    if (r.set_number === null && r.reps === null && r.weight_kg === null && r.duration_seconds === null) continue;
    ex.sets.push({
      set_number: r.set_number,
      weight_kg: num(r.weight_kg),
      reps: r.reps,
      rpe: num(r.rpe),
      completed: r.completed,
      is_pr: Boolean(r.is_pr_weight || r.is_pr_reps || r.is_pr_volume),
      duration_seconds: r.duration_seconds,
      distance: num(r.distance),
      distance_unit: r.distance_unit,
    });
  }

  return sessions.map((s) => ({
    id: s.id,
    session_date: s.session_date,
    program_name: s.program_name,
    workout_day: s.workout_day,
    duration_minutes: s.duration_minutes,
    status: s.status,
    exercises: bySession.get(s.id) || [],
  }));
}

// ── Contact details the member keeps up to date themselves ──────────────────
//
// Mobile and address only. Email is the sign-in identity and changing it
// needs verification this flow does not have; name, dates, package and
// money are the studio's record and stay the trainer's to edit.
const MOBILE_RE = /^[6-9]\d{9}$/; // the same rule the trainer's client form applies

function normaliseContact(body = {}) {
  const out = {};
  if (body.mobile !== undefined) {
    const m = String(body.mobile ?? '').replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=[6-9]\d{9}$)/, '');
    if (!MOBILE_RE.test(m)) throw new PortalInputError('Enter a valid 10-digit Indian mobile number.');
    out.mobile = m;
  }
  if (body.address !== undefined) {
    const a = body.address === null ? '' : String(body.address).trim();
    if (a.length > 500) throw new PortalInputError('Address must be 500 characters or fewer.');
    out.address = a || null;
  }
  if (Object.keys(out).length === 0) throw new PortalInputError('Nothing to update.');
  return out;
}

async function updateMyContact(clientId, orgId, body) {
  const c = normaliseContact(body);
  const { rows } = await pool.query(
    `UPDATE pt_clients
        SET mobile  = CASE WHEN $3::boolean THEN $4 ELSE mobile END,
            address = CASE WHEN $5::boolean THEN $6 ELSE address END,
            updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
      RETURNING mobile, address`,
    [clientId, orgId, 'mobile' in c, c.mobile ?? null, 'address' in c, c.address ?? null],
  );
  return rows[0] || null;
}

// ── The member's own signed forms ───────────────────────────────────────────
//
// Their latest PAR-Q (what they declared, and the risk level it came to) and
// their latest informed consent. The trainer's private notes on the PAR-Q are
// not returned; nor are signature images or device/IP audit fields.
async function myForms(clientId, orgId) {
  const { rows: parq } = await pool.query(
    `SELECT id, assessment_date, status, risk_level, risk_message, parq_yes_count,
            parq_answers, current_health, past_history, created_at
       FROM pt_parq_forms
      WHERE client_id = $1 AND organization_id = $2 AND deleted_at IS NULL
      ORDER BY assessment_date DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [clientId, orgId],
  );
  const { rows: consent } = await pool.query(
    `SELECT id, version, status, client_signed_at, trainer_signed_at, completed_at,
            (pdf_url IS NOT NULL) AS has_pdf, created_at
       FROM pt_informed_consents
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId, orgId],
  );
  return { parq: parq[0] || null, consent: consent[0] || null };
}

/**
 * The storage key of the member's OWN consent PDF, or null. Ownership is the
 * query: the row must be this client's, in this studio, with a PDF. The key
 * is derived from the record id, the same way lib/informedConsentPdf.js wrote
 * it, so nothing about the stored URL's format is trusted.
 */
async function myConsentPdfKey(clientId, orgId, consentId) {
  const { rows } = await pool.query(
    `SELECT id FROM pt_informed_consents
      WHERE id::text = $1 AND client_id = $2 AND organization_id = $3 AND pdf_url IS NOT NULL`,
    [String(consentId), clientId, orgId],
  );
  return rows[0] ? `informed-consent/pdf/${rows[0].id}.pdf` : null;
}

// ── Records and streaks ─────────────────────────────────────────────────────
//
// Everything here is counted from what was actually logged: the sessions the
// trainer recorded, the member's studio visits and their weekly check-ins.
// Nothing is estimated. A session counts as trained when it has at least one
// set logged, whatever its status — most sessions are never formally closed.

/** 'YYYY-MM-DD' of the Monday `n` weeks before `ymd`'s Monday. */
function weeksBefore(ymd, n) {
  const d = new Date(`${mondayOf(ymd)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7 * n);
  return d.toISOString().slice(0, 10);
}

/**
 * Consecutive active weeks. The current streak is still alive while this week
 * is empty (it only breaks once a whole week passes with nothing), so it is
 * counted back from this week if it is active, otherwise from last week.
 */
function weekStreaks(weeks, nowYmd) {
  const set = new Set(weeks);
  const thisWeek = mondayOf(nowYmd);
  let current = 0;
  const start = set.has(thisWeek) ? 0 : 1;
  while (set.has(weeksBefore(thisWeek, start + current))) current += 1;

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const w of [...set].sort()) {
    run = prev && weeksBefore(w, 1) === prev ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = w;
  }
  return { current, longest: Math.max(longest, current), this_week: set.has(thisWeek) };
}

async function myAchievements(clientId, orgId) {
  const [weeks, checkinWeeks, totals, records, recent] = await Promise.all([
    pool.query(
      `SELECT DISTINCT to_char(date_trunc('week', d)::date, 'YYYY-MM-DD') AS wk
         FROM (
           SELECT ws.session_date AS d
             FROM workout_sessions ws
            WHERE ws.client_id = $1 AND ws.organization_id = $2
              AND EXISTS (SELECT 1 FROM workout_session_exercises e
                            JOIN workout_sets s ON s.session_exercise_id = e.id
                           WHERE e.session_id = ws.id)
           UNION ALL
           SELECT a.date FROM attendance_logs a
            WHERE a.ref_id = $1 AND a.ref_type = 'client' AND a.organization_id = $2
         ) x
        WHERE d IS NOT NULL`,
      [clientId, orgId],
    ),
    pool.query(
      `SELECT DISTINCT to_char(week_start_date, 'YYYY-MM-DD') AS wk
         FROM weekly_checkins WHERE client_id = $1 AND organization_id = $2`,
      [clientId, orgId],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT ws.id)::int AS sessions,
              COUNT(s.id) FILTER (WHERE s.completed IS NOT FALSE)::int AS sets,
              COALESCE(SUM(s.weight_kg * s.reps) FILTER (WHERE s.completed IS NOT FALSE), 0)::float AS volume_kg,
              COUNT(s.id) FILTER (WHERE s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)::int AS prs,
              MIN(ws.session_date) AS first_session,
              (SELECT COUNT(*)::int FROM attendance_logs a
                WHERE a.ref_id = $1 AND a.ref_type = 'client' AND a.organization_id = $2) AS visits
         FROM workout_sessions ws
         JOIN workout_session_exercises e ON e.session_id = ws.id
         JOIN workout_sets s ON s.session_exercise_id = e.id
        WHERE ws.client_id = $1 AND ws.organization_id = $2`,
      [clientId, orgId],
    ),
    // Heaviest completed set per exercise; ties go to more reps, then the
    // earlier date (the day it was first lifted).
    pool.query(
      `SELECT DISTINCT ON (lower(btrim(e.exercise_name)))
              e.exercise_name AS exercise, s.weight_kg, s.reps, ws.session_date AS date
         FROM workout_sets s
         JOIN workout_session_exercises e ON e.id = s.session_exercise_id
         JOIN workout_sessions ws ON ws.id = e.session_id
        WHERE ws.client_id = $1 AND ws.organization_id = $2
          AND s.weight_kg > 0 AND s.completed IS NOT FALSE AND e.exercise_name IS NOT NULL
        ORDER BY lower(btrim(e.exercise_name)), s.weight_kg DESC, s.reps DESC NULLS LAST, ws.session_date ASC`,
      [clientId, orgId],
    ),
    pool.query(
      `SELECT e.exercise_name AS exercise, s.weight_kg, s.reps, ws.session_date AS date,
              CASE WHEN s.is_pr_weight THEN 'weight' WHEN s.is_pr_reps THEN 'reps' ELSE 'volume' END AS kind
         FROM workout_sets s
         JOIN workout_session_exercises e ON e.id = s.session_exercise_id
         JOIN workout_sessions ws ON ws.id = e.session_id
        WHERE ws.client_id = $1 AND ws.organization_id = $2
          AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
        ORDER BY ws.session_date DESC, s.created_at DESC
        LIMIT 6`,
      [clientId, orgId],
    ),
  ]);

  const now = today();
  const t = totals.rows[0] || {};
  const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
  const lift = (r) => ({ exercise: r.exercise, weight_kg: num(r.weight_kg), reps: r.reps, date: r.date });

  return {
    training: weekStreaks(weeks.rows.map((r) => r.wk), now),
    checkins: weekStreaks(checkinWeeks.rows.map((r) => r.wk), now),
    totals: {
      sessions: t.sessions || 0,
      sets: t.sets || 0,
      volume_kg: Math.round(Number(t.volume_kg) || 0),
      prs: t.prs || 0,
      visits: t.visits || 0,
      first_session: t.first_session || null,
    },
    records: records.rows.map(lift).sort(byDate).slice(0, 20),
    recent_prs: recent.rows.map((r) => ({ ...lift(r), kind: r.kind })),
  };
}

// ── Progress photos ─────────────────────────────────────────────────────────
//
// The member's own photos, whoever took them: the trainer at the studio (the
// existing /pt-os/progress-photos page, which stores a data URL) or the member
// from their phone (a file in storage, see the route). Only photos the member
// uploaded themselves can be deleted by them — a trainer's record of their
// starting point is not the member's to erase.

const PHOTO_TYPES = ['front', 'side', 'back', 'flexed', 'full_body', 'other'];
/** Uploads a member may make in 24 hours: a full set every day is 3; this is a wall for scripts. */
const PHOTO_DAILY_LIMIT = 12;

async function myPhotos(clientId, orgId, userId) {
  const { rows } = await pool.query(
    `SELECT id, photo_type, taken_at, notes, photo_url, created_at,
            (uploaded_by IS NOT NULL AND uploaded_by = $3) AS by_me
       FROM progress_photos
      WHERE client_id = $1 AND organization_id = $2
      ORDER BY taken_at DESC, created_at DESC
      LIMIT 120`,
    [clientId, orgId, userId],
  );
  return rows;
}

function normalisePhotoMeta(body = {}) {
  const type = String(body.photo_type || 'front');
  if (!PHOTO_TYPES.includes(type)) throw new PortalInputError('Choose front, side, back, flexed, full body or other.');
  let takenAt = today();
  if (body.taken_at) {
    const d = String(body.taken_at).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || d > today()) {
      throw new PortalInputError('The date must be today or earlier.');
    }
    takenAt = d;
  }
  return { photoType: type, takenAt };
}

async function photoUploadsToday(clientId, orgId, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM progress_photos
      WHERE client_id = $1 AND organization_id = $2 AND uploaded_by = $3
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [clientId, orgId, userId],
  );
  return rows[0].n;
}

async function insertMyPhoto(clientId, orgId, userId, { id, photoType, takenAt, url }) {
  const { rows } = await pool.query(
    `INSERT INTO progress_photos (id, client_id, photo_url, photo_type, taken_at, uploaded_by, organization_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, photo_type, taken_at, notes, photo_url, created_at, TRUE AS by_me`,
    [id, clientId, url, photoType, takenAt, userId, orgId],
  );

  // Tell the trainer, once per day's batch rather than once per photo.
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT u.id, 'progress_photo', c.name || ' added progress photos',
              'New photos are in their progress timeline.',
              '/pt-os/progress-photos?client_id=' || c.id
         FROM pt_clients c
         JOIN users u ON u.organization_id = c.organization_id AND u.role = 'trainer'
                     AND u.is_active = TRUE AND u.deleted_at IS NULL
        WHERE c.id = $1 AND c.organization_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.user_id = u.id AND n.type = 'progress_photo' AND n.is_read = FALSE
               AND n.link = '/pt-os/progress-photos?client_id=' || c.id)`,
      [clientId, orgId],
    );
  } catch (err) {
    // A missed notification must never lose the photo.
    logger.warn({ err: err.message, clientId }, 'client-portal: progress photo notification failed');
  }
  return rows[0];
}

/** Deletes one of the member's OWN uploads; returns its storage URL, or null if none matched. */
async function deleteMyPhoto(clientId, orgId, userId, photoId) {
  const { rows } = await pool.query(
    `DELETE FROM progress_photos
      WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND uploaded_by = $4
      RETURNING photo_url`,
    [String(photoId), clientId, orgId, userId],
  );
  return rows[0] ? rows[0].photo_url : null;
}

module.exports = {
  myAchievements, weekStreaks,
  myPhotos, normalisePhotoMeta, photoUploadsToday, insertMyPhoto, deleteMyPhoto, PHOTO_TYPES, PHOTO_DAILY_LIMIT,
  updateMyContact, normaliseContact, myForms, myConsentPdfKey,
  myWorkout, myDiet, myCheckins, upsertMyCheckin, mySessions,
  normaliseCheckin, mondayOf, weekNumberSince, PortalInputError, MOODS,
};

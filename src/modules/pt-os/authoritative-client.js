'use strict';
// The one place an AI surface loads a client's canonical facts.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Six code paths read the same tables for the same client and each decided
// "latest" for itself. `routes/ai.js` ordered fitness tests by `created_at`;
// the digital twin, the training brief and the profile snapshot ordered by
// `assessment_date`. Both look reasonable alone. Together they are a data
// integrity bug: a test entered today about last month won the generator's
// prompt and lost the coach's, so two surfaces disagreed about the same body
// on the same day, and neither knew.
//
// This module owns the reads. Callers choose WHICH groups they need; they no
// longer choose the SQL, the predicate, or the ordering.
//
// ── Canonical ordering ─────────────────────────────────────────────────────
//
// Content date first, insertion time second:
//
//     assessment_date DESC NULLS LAST, created_at DESC
//
// `assessment_date` is the day the measurement describes; `created_at` is the
// day somebody typed it. A form entered today about a test from last month
// belongs last month, not today. Check-ins use the same rule on
// `week_start_date`, and goals on their own `created_at` (the wizard stamps
// the day the goal was set).
//
// ── Tenant boundary ────────────────────────────────────────────────────────
//
// The parent `pt_clients` row is looked up FIRST, org-scoped, and logged-out
// clients are excluded. No child query runs until that row exists. That is the
// property every prior loader maintained individually; here it is maintained
// once.

const pool = require('../../db/pool');
const { latestParqMedical } = require('../progress/assessments.repo');

const LATEST = 'assessment_date DESC NULLS LAST, created_at DESC';
const LATEST_CHECKIN = 'week_start_date DESC NULLS LAST, created_at DESC';
const DEFAULT_WINDOW_WEEKS = 12;
const DEFAULT_HISTORY = 12;
const MAX_SETS = 2000;

/**
 * The parent client row, or null when it is not this organization's.
 *
 * `deleted_at IS NULL` and strict org equality are both in the statement, not
 * in a following check: a wrong-org id matches no row at all, so a caller can
 * never read a child of a client it cannot see by forgetting to branch.
 */
async function loadClientRow(clientId, orgId) {
  const { rows } = await pool.query(
    'SELECT * FROM pt_clients WHERE id=$1 AND deleted_at IS NULL AND organization_id = $2',
    [clientId, orgId],
  );
  return rows[0] || null;
}

/**
 * Canonical rows for one client.
 *
 * Options select GROUPS, never raw SQL:
 *
 *   clinical   PAR-Q, latest fitness test, posture, mobility, lifestyle
 *              (default true — every AI consumer may discuss the body)
 *   checkin    the latest weekly check-in
 *   training   the active assignment and sessions inside the window
 *   sets       every logged set inside the window
 *   landmarks  the studio's weekly-set ranges
 *   checkins   the check-in history (recovery reads it)
 *   snapshot   profile-screen inputs: lifestyle, measurements, fitness-test
 *              history, PR flags, last session, check-in history
 *   generator  the plan generators' extra inputs: fitness profile, active
 *              assignments, studio equipment, interview, nutrition, and the
 *              submitted/reviewed PAR-Q medical read
 *   interview / nutrition  selected individually when a caller needs one
 *
 * `historyLimit` bounds every history read; `windowWeeks` and `sessionDays`
 * bound training. `client` may be supplied when the caller already loaded the
 * row under its own (wider) select, e.g. the profile's computed balance.
 */
async function loadClientSources(clientId, orgId, {
  client = null,
  clinical = true,
  assessment = false,
  checkin = false,
  training = false,
  sessionDays = null,
  windowWeeks = DEFAULT_WINDOW_WEEKS,
  sets = false,
  landmarks = false,
  checkins = false,
  snapshot = false,
  generator = false,
  interview = false,
  nutrition = false,
  historyLimit = DEFAULT_HISTORY,
} = {}) {
  const row = client || await loadClientRow(clientId, orgId);
  if (!row) return null;

  const weeks = Math.max(1, Math.min(104, Number(windowWeeks) || DEFAULT_WINDOW_WEEKS));
  const limit = Math.max(1, Math.min(200, Number(historyLimit) || DEFAULT_HISTORY));

  const jobs = [];
  const keys = [];
  const add = (key, sqlOrFn, params = [clientId]) => {
    keys.push(key);
    jobs.push(Promise.resolve().then(
      typeof sqlOrFn === 'function'
        ? sqlOrFn
        : () => pool.query(sqlOrFn, params).then((r) => r.rows),
    ));
  };

  if (clinical) {
    add('parq', `SELECT * FROM pt_parq_forms WHERE client_id=$1 AND deleted_at IS NULL
          ORDER BY ${LATEST} LIMIT 1`);
    add('posture', `SELECT * FROM pt_posture_assessments WHERE client_id=$1
          ORDER BY ${LATEST} LIMIT 1`);
    add('mobility', `SELECT * FROM pt_mobility_performance_assessments WHERE client_id=$1
          ORDER BY ${LATEST} LIMIT 1`);
  }
  if (clinical || snapshot) {
    add('lifestyle', `SELECT * FROM pt_lifestyle_assessments WHERE client_id=$1
          ORDER BY ${LATEST} LIMIT 1`);
  }

  // The goal is read for every consumer. The three newest active rows are the
  // generator's full disagreement set; `goal` is the one every other surface
  // uses, and it is the same first row.
  add('goals', `SELECT * FROM pt_goals WHERE client_id=$1 AND is_active = true
        ORDER BY created_at DESC LIMIT 3`);

  if (training) {
    add('assignment', `SELECT wa.start_date, wa.progress_pct, wp.id AS plan_id, wp.name AS plan_name,
                wp.duration_weeks,
                (SELECT COUNT(DISTINCT we.day_of_week) FROM workout_exercises we
                  WHERE we.workout_plan_id = wp.id AND we.week_number = 1)::int AS planned_days_count
           FROM workout_assignments wa
           JOIN workout_plans wp ON wp.id = wa.workout_plan_id
          WHERE wa.client_id = $1 AND wa.status = 'active'
          ORDER BY wa.start_date DESC LIMIT 1`);
    if (sessionDays) {
      const days = Math.max(1, Math.min(365, Number(sessionDays) || 28));
      add('sessions', `SELECT status, session_date FROM workout_sessions
          WHERE client_id = $1 AND session_date >= CURRENT_DATE - $2::int
          ORDER BY session_date DESC`, [clientId, days]);
    } else {
      add('sessions', `SELECT status, session_date FROM workout_sessions
          WHERE client_id = $1 AND session_date >= CURRENT_DATE - ($2 * INTERVAL '1 week')
          ORDER BY session_date DESC`, [clientId, weeks]);
    }
  }

  if (sets) {
    add('sets', `SELECT wse.exercise_name, s.weight_kg, s.reps, s.rpe, s.rir, s.completed,
              ws.session_date, e.target_muscle
         FROM workout_sets s
         JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
         JOIN workout_sessions ws ON ws.id = wse.session_id
         LEFT JOIN exercises e ON e.id = wse.exercise_id
        WHERE ws.client_id = $1
          AND ws.session_date >= CURRENT_DATE - ($2 * INTERVAL '1 week')
        ORDER BY ws.session_date DESC
        LIMIT ${MAX_SETS}`, [clientId, weeks]);
  }

  if (snapshot) {
    add('measurements', `SELECT weight_kg, measured_at FROM pt_os_measurements
           WHERE client_id = $1 AND weight_kg IS NOT NULL
           ORDER BY measured_at DESC LIMIT $2`, [clientId, limit]);
    add('assessments', `SELECT * FROM pt_assessments WHERE client_id = $1
           ORDER BY ${LATEST} LIMIT $2`, [clientId, limit]);
    add('prRows', `SELECT wse.exercise_name, s.weight_kg, s.reps, ws.session_date
            FROM workout_sets s
            JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
            JOIN workout_sessions ws ON ws.id = wse.session_id
           WHERE ws.client_id = $1
             AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
           ORDER BY ws.session_date DESC LIMIT 60`);
    add('lastSession', `SELECT session_date, status FROM workout_sessions
           WHERE client_id = $1 AND session_date <= CURRENT_DATE
           ORDER BY session_date DESC LIMIT 1`);
  } else if (clinical || assessment) {
    add('assessment', `SELECT * FROM pt_assessments WHERE client_id = $1
          ORDER BY ${LATEST} LIMIT 1`);
  }

  if (checkins) {
    add('checkins', `SELECT week_start_date, mood, sleep_hours, water_glasses,
               stress_level, energy_level, soreness_level
          FROM weekly_checkins WHERE client_id = $1
         ORDER BY ${LATEST_CHECKIN} LIMIT $2`, [clientId, limit]);
  }
  if (checkin) {
    add('checkin', `SELECT weight, mood, sleep_hours, client_notes, week_start_date, created_at
          FROM weekly_checkins WHERE client_id = $1
         ORDER BY ${LATEST_CHECKIN} LIMIT 1`);
  }

  if (generator) {
    add('profile', `SELECT * FROM client_fitness_profiles WHERE client_id=$1 LIMIT 1`);
    add('interview', `SELECT * FROM pt_client_interviews WHERE client_id=$1
          ORDER BY (status = 'completed') DESC, created_at DESC LIMIT 1`);
    add('nutrition', `SELECT * FROM pt_nutrition_assessments WHERE client_id=$1
          ORDER BY ${LATEST} LIMIT 1`);
    add('workoutAssignments', `SELECT wp.name AS plan_name, wa.status, wa.start_date, wa.end_date
           FROM workout_assignments wa LEFT JOIN workout_plans wp ON wp.id=wa.workout_plan_id
          WHERE wa.client_id=$1 AND wa.status='active' ORDER BY wa.created_at DESC LIMIT 3`);
    add('dietAssignments', `SELECT dt.name AS template_name, da.status, da.start_date, da.end_date
           FROM diet_assignments da LEFT JOIN diet_templates dt ON dt.id=da.diet_template_id
          WHERE da.client_id=$1 AND da.status='active' ORDER BY da.created_at DESC LIMIT 3`);
    add('equipment', `SELECT value, updated_at FROM system_settings
          WHERE organization_id = $1 AND key = 'studio_equipment' LIMIT 1`, [orgId]);
  } else {
    if (interview) {
      add('interview', `SELECT * FROM pt_client_interviews WHERE client_id=$1
            ORDER BY (status = 'completed') DESC, created_at DESC LIMIT 1`);
    }
    if (nutrition) {
      add('nutrition', `SELECT * FROM pt_nutrition_assessments WHERE client_id=$1
            ORDER BY ${LATEST} LIMIT 1`);
    }
  }

  if (generator) {
    // Submitted/reviewed only: a draft answers nothing about clearance, which
    // is why the generator's medical read and the twin's safety read differ.
    add('parqMedical', () => latestParqMedical(clientId).then((row) => (row ? [row] : [])));
  }

  if (landmarks) add('landmarks', () => resolveLandmarks(orgId));

  const results = await Promise.all(jobs);
  const bag = Object.fromEntries(keys.map((key, i) => [key, results[i]]));

  const one = (key) => (bag[key]?.length ? bag[key][0] : null);
  const many = (key) => bag[key] || [];

  return {
    client: row,
    profile: one('profile'),
    goals: many('goals'),
    goal: many('goals')[0] || null,
    latestAssessment: one('assessment') || many('assessments')[0] || null,
    latestCheckin: one('checkin'),
    lifestyle: one('lifestyle'),
    interview: one('interview'),
    nutrition: one('nutrition'),
    parq: one('parq'),
    parqMedical: one('parqMedical'),
    posture: one('posture'),
    mobility: one('mobility'),
    assignment: one('assignment'),
    workoutAssignments: many('workoutAssignments'),
    dietAssignments: many('dietAssignments'),
    studioEquipment: one('equipment')?.value ?? null,
    studioEquipmentAt: one('equipment')?.updated_at ?? null,
    sessions: many('sessions'),
    sets: many('sets'),
    checkins: many('checkins'),
    landmarks: bag.landmarks || new Map(),
    measurements: many('measurements'),
    assessments: many('assessments'),
    prRows: many('prRows'),
    lastSession: one('lastSession'),
    window_weeks: weeks,
  };
}

/**
 * The studio's weekly set ranges by muscle, keyed on the library's spelling.
 * Kept here because the digital twin and the generator both consume it.
 */
async function resolveLandmarks(orgId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (target_muscle) target_muscle, mev_sets, mrv_sets
       FROM muscle_volume_landmarks
      WHERE organization_id IS NULL OR ($1::uuid IS NOT NULL AND organization_id = $1)
      ORDER BY target_muscle, organization_id NULLS LAST`,
    [orgId || null],
  );
  const out = new Map();
  for (const r of rows) {
    out.set(titleCaseMuscle(r.target_muscle), { mev_sets: r.mev_sets, mrv_sets: r.mrv_sets });
  }
  return out;
}

function titleCaseMuscle(name) {
  return String(name || '').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  LATEST,
  LATEST_CHECKIN,
  loadClientRow,
  loadClientSources,
  resolveLandmarks,
};

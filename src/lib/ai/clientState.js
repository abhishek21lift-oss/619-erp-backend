'use strict';

// src/lib/ai/clientState.js — Canonical Client State (Phase 2A + 2B Memory)
//
// One authoritative function that answers: "what does the deterministic
// system know about this client right now?"
//
// This replaces the four partial context builders that existed before:
//   buildClientContext     (chat route — thin, no training history)
//   loadAuthoritativeClient (workout/diet generators — richer, no history)
//   buildBrief            (PT-Os frontend only — comprehensive, not used by AI)
//   buildSnapshot         (PT-Os frontend only — alerts + PRs, not used by AI)
//
// Design principles:
//   1. Parent-first tenant isolation (pt_clients gate before any child query)
//   2. Every value classified: MEASURED / CALCULATED / REPORTED / INFERRED / MISSING / STALE
//   3. Missing data is explicitly listed — silence is not an answer
//   4. Freshness timestamps on important values
//   5. Compact enough for task-specific AI context projection
//   6. Deterministic services reused, never duplicated
//   7. Durable memory (Phase 2B) integrated as read-only projection

const pool = require('../../db/pool');
const logger = require('../logger');
const { tenantScope } = require('../tenant-db');
const { buildMemoryProjection } = require('./memory');
// Deterministic analytics modules — these own the authoritative computations.
// The AI never recalculates; it receives their output as compact summaries.
const { hardSetsByMuscle } = require('../../modules/training/volume');
const { readinessOf, readinessBand } = require('../../modules/pt-os/recovery');

// ── Freshness thresholds ──────────────────────────────────────────────────
const FRESHNESS = {
  assessment:  { current: 14, recent: 30, stale: 90 },
  measurement: { current: 7,  recent: 14, stale: 30 },
  checkin:     { current: 7,  recent: 14, stale: 30 },
  lifestyle:   { current: 30, recent: 90, stale: 180 },
  program:     { current: 14, recent: 90, stale: 365 },  // relative to end_date
};

function classifyFreshness(dateStr, thresholds) {
  if (!dateStr) return 'never';
  const days = daysSince(dateStr);
  if (days == null) return 'never';
  if (days <= thresholds.current) return 'current';
  if (days <= thresholds.recent) return 'recent';
  if (days <= thresholds.stale) return 'stale';
  return 'stale';
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return Math.floor((now - d) / 86_400_000);
}

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function dateStr(v) {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Fact classification tags ──────────────────────────────────────────────
const FACT = {
  MEASURED:   'measured',    // directly recorded by trainer/client
  CALCULATED: 'calculated',  // deterministically computed from measured data
  REPORTED:   'reported',    // self-reported by client (check-in)
  INFERRED:   'inferred',    // derived by analysis from multiple sources
  MISSING:    'missing',     // no data available
  STALE:      'stale',       // data exists but is old
};

/**
 * Build the canonical client state.
 *
 * @param {string} clientId
 * @param {string|null} organizationId — null for platform super admin
 * @param {object} [options]
 * @param {number} [options.historyWeeks=12] — weeks of training history
 * @param {boolean} [options.includeRaw=false] — include raw DB rows for debugging
 * @returns {Promise<object>} canonical client state
 */
async function buildClientState(clientId, organizationId, options = {}) {
  const { historyWeeks = 12 } = options;

  if (!clientId) return null;

  // ── Parent-first authorization ─────────────────────────────────────────
  // The pt_clients lookup is the gate. A wrong-org or deleted client yields
  // null, and no child query ever executes.
  const clientRes = await pool.query(
    `SELECT id, name, dob, gender, mobile, status, goal, notes, injuries,
            health_conditions, weight, height, frequency,
            pt_start_date, pt_end_date, balance_amount,
            workout_experience_level, previous_trainer_experience,
            trainer_id, organization_id,
            created_at, updated_at
     FROM pt_clients
     WHERE id = $1 AND deleted_at IS NULL
       AND ($2::uuid IS NULL OR organization_id = $2)`,
    [clientId, organizationId]
  );
  const client = clientRes.rows[0];
  if (!client) return null;

  // ── All child queries in parallel ──────────────────────────────────────
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - historyWeeks * 7);
  const sinceDate = since.toISOString().slice(0, 10);

  const [
    profileRes, goalsRes, assessRes, assessHistoryRes,
    checkinsRes, lifestyleRes, nutritionRes,
    workoutAssignRes, workoutPlanRes,
    dietAssignRes, dietTemplateRes,
    sessionRes, setRes, prRes, landmarkRes,
    postureRes, mobilityRes,
    parqRes, consentRes,
    attendanceRes,
    measurementRes,
    memoryRes,
  ] = await Promise.all([
    // Fitness profile
    pool.query(
      `SELECT goal, goal_other, height_cm, body_fat_pct, health_conditions, injuries,
              fitness_level, sleep_hours, stress_level, diet_preference
       FROM client_fitness_profiles WHERE client_id=$1 LIMIT 1`, [clientId]),
    // Active goals
    pool.query(
      `SELECT id, goal_type, target_weight, target_body_fat, target_date,
              priority_goal, goal_description, commitment_level,
              motivation_level, biggest_challenges, estimated_duration_weeks,
              created_at
       FROM pt_goals WHERE client_id=$1 AND is_active=true
       ORDER BY created_at DESC LIMIT 3`, [clientId]),
    // Latest assessment (detailed)
    pool.query(
      `SELECT assessment_date, assessment_type, weight, height_cm, bmi,
              body_fat_pct, muscle_mass_pct, lean_body_mass_kg, fat_mass_kg,
              chest_cm, waist_cm, hips_cm, waist_hip_ratio,
              neck_cm, arm_right_cm, arm_left_cm,
              thigh_right_cm, thigh_left_cm, calf_right_cm, calf_left_cm,
              bp_systolic, bp_diastolic, bp_category,
              resting_heart_rate, resting_spo2,
              body_comp_method, visceral_fat, subcutaneous_fat_pct,
              body_water_pct, bone_mass_kg, bmr, metabolic_age,
              cardio_test_type, vo2_max, cardio_category, cardio_score_computed,
              strength_exercise, strength_exercise_2, strength_score_computed,
              endurance_test_type, endurance_category, endurance_score_computed,
              mobility_score_computed, flexibility_category, has_asymmetry,
              body_composition_score, health_risk_score, overall_fitness_score,
              flexibility_score, cardio_score, strength_score
       FROM pt_assessments WHERE client_id=$1
       ORDER BY assessment_date DESC LIMIT 1`, [clientId]),
    // Assessment history (for trends — weight + body fat only)
    pool.query(
      `SELECT assessment_date, weight, body_fat_pct, bmi
       FROM pt_assessments WHERE client_id=$1
       ORDER BY assessment_date DESC LIMIT 10`, [clientId]),
    // Weekly check-ins
    pool.query(
      `SELECT week_start_date, weight, mood, sleep_hours, water_glasses,
              stress_level, energy_level, soreness_level,
              client_notes, created_at
       FROM weekly_checkins WHERE client_id=$1
       ORDER BY created_at DESC LIMIT 8`, [clientId]),
    // Lifestyle assessment
    pool.query(
      `SELECT assessment_date, activity_level, workout_experience_level,
              years_of_experience, meal_frequency, sleep_duration_hours,
              sleep_quality, sleep_category, stress_level, occupation_type,
              daily_steps_bracket, energy_level, recovery_quality,
              recovery_risk, recovery_score, lifestyle_score,
              food_preferences, coach_notes
       FROM pt_lifestyle_assessments WHERE client_id=$1
       ORDER BY assessment_date DESC, created_at DESC LIMIT 1`, [clientId]),
    // Nutrition assessment
    pool.query(
      `SELECT assessment_date, diet_preferences, food_allergies,
              foods_to_avoid, meals_per_day, nutrition_budget,
              medical_conditions, medical_notes
       FROM pt_nutrition_assessments WHERE client_id=$1
       ORDER BY assessment_date DESC, created_at DESC LIMIT 1`, [clientId]),
    // Active workout assignments
    pool.query(
      `SELECT wa.id AS assignment_id, wa.workout_plan_id, wa.start_date, wa.end_date, wa.status,
              wp.name AS plan_name, wp.duration_weeks,
              wp.progression_type, wp.progression_amount, wp.progression_every_weeks
       FROM workout_assignments wa
       LEFT JOIN workout_plans wp ON wp.id = wa.workout_plan_id
       WHERE wa.client_id=$1 AND wa.status='active'
       ORDER BY wa.created_at DESC LIMIT 3`, [clientId]),
    // Workout plan details (for the primary active plan)
    pool.query(
      `SELECT wp.id, wp.name, wp.duration_weeks, wp.sessions_per_week,
              wp.progression_type, wp.progression_amount, wp.progression_every_weeks
       FROM workout_assignments wa
       JOIN workout_plans wp ON wp.id = wa.workout_plan_id
       WHERE wa.client_id=$1 AND wa.status='active'
       ORDER BY wa.start_date DESC LIMIT 1`, [clientId]),
    // Active diet assignments
    pool.query(
      `SELECT da.id AS assignment_id, da.diet_template_id, da.start_date, da.end_date, da.status,
              dt.name AS template_name
       FROM diet_assignments da
       LEFT JOIN diet_templates dt ON dt.id = da.diet_template_id
       WHERE da.client_id=$1 AND da.status='active'
       ORDER BY da.created_at DESC LIMIT 3`, [clientId]),
    // Diet template details
    pool.query(
      `SELECT dt.name, dt.meal_count
       FROM diet_assignments da
       JOIN diet_templates dt ON dt.id = da.diet_template_id
       WHERE da.client_id=$1 AND da.status='active'
       ORDER BY da.start_date DESC LIMIT 1`, [clientId]),
    // Training sessions (recent window)
    pool.query(
      `SELECT ws.session_date, ws.status, ws.duration_seconds
       FROM workout_sessions ws
       WHERE ws.client_id = $1 AND ws.session_date >= $2::date
       ORDER BY ws.session_date ASC`,
      [clientId, sinceDate]),
    // Hard sets per muscle (recent window)
    pool.query(
      `SELECT e.target_muscle,
              COUNT(*)::int AS sets,
              MAX(ws.session_date) AS last_date
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
       LEFT JOIN exercises e ON e.id = wse.exercise_id
       WHERE ws.client_id = $1 AND s.completed = true AND ws.session_date >= $2::date
       GROUP BY e.target_muscle`,
      [clientId, sinceDate]),
    // Personal records (live)
    pool.query(
      `SELECT exercise_name, record_type, value, unit, reps, achieved_on
       FROM personal_records
       WHERE client_id = $1 AND superseded_at IS NULL
       ORDER BY achieved_on DESC LIMIT 20`, [clientId]),
    // Muscle volume landmarks
    pool.query(
      `SELECT DISTINCT ON (target_muscle) target_muscle, mev_sets, mrv_sets
       FROM muscle_volume_landmarks
       WHERE organization_id IS NULL
         OR organization_id = $1
       ORDER BY target_muscle, organization_id NULLS LAST`,
      [organizationId]),
    // Posture assessment (latest)
    pool.query(
      `SELECT assessment_date, posture_risk_level, front_issues, side_issues, back_issues, coach_notes
       FROM pt_posture_assessments WHERE client_id=$1
       ORDER BY assessment_date DESC LIMIT 1`, [clientId]),
    // Mobility assessment (latest)
    pool.query(
      `SELECT assessment_date, mobility_category, mobility_score,
              body_regions, performance_notes
       FROM pt_mobility_performance_assessments WHERE client_id=$1
       ORDER BY assessment_date DESC LIMIT 1`, [clientId]),
    // PAR-Q (latest)
    pool.query(
      `SELECT assessment_date, risk_level, risk_message, workout_gate_status,
              parq_yes_count, current_health, past_history, blood_group, trainer_notes
       FROM pt_parq_forms WHERE client_id=$1 AND deleted_at IS NULL
       ORDER BY assessment_date DESC LIMIT 1`, [clientId]),
    // Informed consent (latest)
    pool.query(
      `SELECT status, created_at FROM pt_informed_consents
       WHERE client_id=$1 AND status NOT IN ('archived')
       ORDER BY created_at DESC LIMIT 1`, [clientId]),
    // Attendance (recent window)
    pool.query(
      `SELECT date, status FROM attendance_logs
       WHERE ref_id = $1 AND ref_type = 'client'
         AND date >= $2::date
       ORDER BY date ASC`,
      [clientId, sinceDate]),
    // Body measurements log (separate from assessments)
    pool.query(
      `SELECT measured_at, weight_kg, body_fat_pct, chest_cm, waist_cm, hips_cm
       FROM pt_os_measurements WHERE client_id=$1
       ORDER BY measured_at DESC LIMIT 10`, [clientId]),
    // Phase 2B: Durable memory (semantic + episodic)
    buildMemoryProjection(clientId, organizationId),
  ]);

  // ── Helper: first defined non-empty value ──────────────────────────────
  const firstDefined = (...vals) => vals.find(
    (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
  ) ?? null;

  // ── Helper: JSONB → array of labels ────────────────────────────────────
  function labelsFrom(value) {
    if (!value) return [];
    const raw = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.map((v) => (typeof v === 'string' ? v : v?.label ?? v?.name ?? v?.region ?? null)).filter(Boolean);
    }
    if (typeof raw === 'object') {
      return Object.entries(raw)
        .filter(([, v]) => v === true || v === 'yes' || v === 'Yes')
        .map(([k]) => k.replace(/_/g, ' '));
    }
    return [];
  }

  // ── Helper: textFrom JSONB ─────────────────────────────────────────────
  function textFrom(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const t = value.trim();
      if (!t) return null;
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const parsed = JSON.parse(t);
          if (parsed && typeof parsed === 'object') return textFrom(parsed);
        } catch { /* not JSON */ }
      }
      return t;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      const items = value.map((v) => textFrom(v)).filter(Boolean);
      return items.length ? items.join(', ') : null;
    }
    if (typeof value === 'object') {
      const lines = Object.entries(value)
        .map(([k, v]) => [k, textFrom(v)])
        .filter(([, v]) => v)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
      return lines.length ? lines.join('; ') : null;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BUILD THE STATE
  // ═══════════════════════════════════════════════════════════════════════

  const latestAssess = assessRes.rows[0] || null;
  const latestCheckin = checkinsRes.rows[0] || null;
  const latestLifestyle = lifestyleRes.rows[0] || null;
  const latestNutrition = nutritionRes.rows[0] || null;
  const latestParq = parqRes.rows[0] || null;
  const latestConsent = consentRes.rows[0] || null;
  const primaryGoal = goalsRes.rows[0] || null;
  const activeWorkout = workoutAssignRes.rows[0] || null;
  const activeDiet = dietAssignRes.rows[0] || null;
  const profile = profileRes.rows[0] || null;
  const plan = workoutPlanRes.rows[0] || null;

  // ── Freshness classification ───────────────────────────────────────────
  const assessDate = dateStr(latestAssess?.assessment_date);
  const checkinDate = dateStr(latestCheckin?.week_start_date) || dateStr(latestCheckin?.created_at);
  const lifestyleDate = dateStr(latestLifestyle?.assessment_date);
  const measurementDate = dateStr(measurementRes.rows[0]?.measured_at);

  const freshness = {
    assessment: classifyFreshness(assessDate, FRESHNESS.assessment),
    measurements: classifyFreshness(measurementDate, FRESHNESS.measurement),
    checkins: classifyFreshness(checkinDate, FRESHNESS.checkin),
    lifestyle: classifyFreshness(lifestyleDate, FRESHNESS.lifestyle),
    program: activeWorkout ? 'current' : (workoutAssignRes.rows.length > 0 ? 'stale' : 'never'),
  };

  // ── Missing data ───────────────────────────────────────────────────────
  const sections = {
    identity: true,  // always present (parent gate)
    goals: goalsRes.rows.length > 0,
    assessment: !!latestAssess,
    measurements: measurementRes.rows.length > 0,
    checkins: checkinsRes.rows.length > 0,
    lifestyle: !!latestLifestyle,
    nutrition: !!latestNutrition,
    program: !!activeWorkout,
    trainingHistory: sessionRes.rows.length > 0,
    personalRecords: prRes.rows.length > 0,
    muscleVolume: setRes.rows.length > 0,
    posture: !!postureRes.rows[0],
    mobility: !!mobilityRes.rows[0],
    medicalClearance: !!latestParq,
  };

  const missing = Object.entries(sections)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  const completeness_pct = Math.round(
    (Object.values(sections).filter(Boolean).length / Object.keys(sections).length) * 100
  );

  // Critical gaps affect programming safety
  const critical_gaps = [];
  if (!sections.medicalClearance) critical_gaps.push('No PAR-Q screening on file');
  if (!sections.assessment) critical_gaps.push('No fitness assessment completed');
  if (!sections.lifestyle) critical_gaps.push('No lifestyle assessment — recovery capacity unknown');

  // ── Adherence (computed from sessions + plan) ──────────────────────────
  let adherence = null;
  if (plan && activeWorkout) {
    const planDays = new Set();
    // Count distinct day_of_week from workout_exercises for this plan
    const planExRes = await pool.query(
      `SELECT DISTINCT day_of_week FROM workout_exercises WHERE workout_plan_id = $1 ORDER BY day_of_week`,
      [plan.id]
    ).catch(() => ({ rows: [] }));
    for (const r of planExRes.rows) planDays.add(Number(r.day_of_week));

    const perWeek = planDays.size;
    if (perWeek > 0 && activeWorkout.start_date) {
      const startDate = String(activeWorkout.start_date).slice(0, 10);
      const now = new Date();
      now.setUTCHours(0, 0, 0, 0);
      const elapsed = Math.floor((now - new Date(startDate + 'T00:00:00Z')) / 86_400_000);
      const begun = Math.min(Math.max(1, Math.floor(elapsed / 7) + 1), plan.duration_weeks || 52);

      const done = new Map();
      for (const s of sessionRes.rows) {
        if (s.status !== 'completed') continue;
        const ws = dateStr(s.session_date);
        if (ws) done.set(ws, (done.get(ws) || 0) + 1);
      }

      // Monday-based week counting
      const firstMonday = new Date(startDate + 'T00:00:00Z');
      const dow = (firstMonday.getUTCDay() + 6) % 7;
      firstMonday.setUTCDate(firstMonday.getUTCDate() - dow);

      let planned = 0;
      let completed = 0;
      for (let i = 0; i < begun; i++) {
        const d = new Date(firstMonday);
        d.setUTCDate(d.getUTCDate() + i * 7);
        const key = d.toISOString().slice(0, 10);
        const sessionCount = Math.min(done.get(key) || 0, perWeek);
        planned += perWeek;
        completed += sessionCount;
      }

      adherence = {
        planned,
        completed,
        pct: planned === 0 ? null : Math.round((completed / planned) * 100),
        source: FACT.CALCULATED,
      };
    }
  }

  // ── Weight trend (measured, not inferred) ──────────────────────────────
  let weightTrend = null;
  const weightHistory = assessHistoryRes.rows
    .filter((r) => r.weight != null)
    .map((r) => ({ date: dateStr(r.assessment_date), kg: num(r.weight) }))
    .filter((r) => r.date && r.kg != null);

  if (weightHistory.length >= 3) {
    const recent = weightHistory[0].kg - weightHistory[1].kg;
    const before = weightHistory[1].kg - weightHistory[2].kg;
    if (Math.abs(recent) < 0.3 && Math.abs(before) < 0.3) {
      weightTrend = 'stable';
    } else if (Math.abs(recent) > Math.abs(before) && Math.sign(recent) === Math.sign(before)) {
      weightTrend = recent < 0 ? 'declining' : 'increasing';
    } else {
      weightTrend = 'variable';
    }
  }

  // ── Days since last session ────────────────────────────────────────────
  const completedSessions = sessionRes.rows.filter((s) => s.status === 'completed');
  const lastSessionDate = completedSessions.length
    ? dateStr(completedSessions[completedSessions.length - 1].session_date)
    : null;

  // ── Attendance summary ─────────────────────────────────────────────────
  const attendance = { present: 0, absent: 0, total: 0 };
  for (const a of attendanceRes.rows) {
    attendance.total++;
    if (a.status === 'present') attendance.present++;
    else if (a.status === 'absent') attendance.absent++;
  }

  // ── Lifestyle readiness score (from latest check-in) ──────────────────
  let readinessScore = null;
  if (latestCheckin) {
    const sleepHours = num(latestCheckin.sleep_hours);
    const stress = num(latestCheckin.stress_level);
    const energy = num(latestCheckin.energy_level);
    const soreness = num(latestCheckin.soreness_level);
    const components = {};
    let inputs = 0;

    if (sleepHours != null && sleepHours > 0 && sleepHours <= 24) {
      components.sleep = sleepHours >= 7.5 ? 100 : sleepHours >= 7 ? 90 : sleepHours >= 6.5 ? 78 : sleepHours >= 6 ? 65 : sleepHours >= 5 ? 45 : 25;
      inputs++;
    }
    if (stress != null && stress >= 1 && stress <= 10) {
      components.stress = Math.round((10 - stress) * (100 / 9));
      inputs++;
    }
    if (energy != null && energy >= 1 && energy <= 10) {
      components.energy = Math.round((energy - 1) * (100 / 9));
      inputs++;
    }
    if (soreness != null && soreness >= 1 && soreness <= 10) {
      components.soreness = Math.round((10 - soreness) * (100 / 9));
      inputs++;
    }

    if (inputs >= 2) {
      const total = Object.values(components).reduce((s, v) => s + v, 0);
      readinessScore = {
        score: Math.round(total / inputs),
        inputs,
        max_inputs: 4,
        components,
        source: FACT.REPORTED,
        as_of: dateStr(latestCheckin.week_start_date) || dateStr(latestCheckin.created_at),
      };
    }
  }

  // ── Mobility findings (filtered to painful/restricted only) ────────────
  const mobilityFindings = [];
  const mobilityData = mobilityRes.rows[0];
  if (mobilityData?.body_regions) {
    const raw = typeof mobilityData.body_regions === 'string'
      ? (() => { try { return JSON.parse(mobilityData.body_regions); } catch { return []; } })()
      : mobilityData.body_regions;
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (r && typeof r === 'object' && (r.pain === true || r.restriction === true)) {
          mobilityFindings.push({
            region: r.region ?? r.label ?? 'Unknown',
            pain: r.pain === true,
            restriction: r.restriction === true,
          });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ASSEMBLE THE CANONICAL STATE
  // ═══════════════════════════════════════════════════════════════════════

  const state = {
    // ── Identity ─────────────────────────────────────────────────────────
    identity: {
      id: client.id,
      name: client.name,
      gender: client.gender,
      age: ageFromDob(client.dob),
      dob: dateStr(client.dob),
      goal: client.goal,
      status: client.status,
      organization_id: client.organization_id,
      trainer_id: client.trainer_id,
    },

    // ── Goals ────────────────────────────────────────────────────────────
    goals: {
      active: goalsRes.rows.map((g) => ({
        goal_type: g.goal_type,
        target_weight: num(g.target_weight),
        target_body_fat: num(g.target_body_fat),
        target_date: dateStr(g.target_date),
        created_at: dateStr(g.created_at),
      })),
      primary: primaryGoal ? {
        goal_type: primaryGoal.goal_type,
        target_weight: num(primaryGoal.target_weight),
        target_body_fat: num(primaryGoal.target_body_fat),
      } : null,
      as_of: dateStr(primaryGoal?.created_at),
      source: primaryGoal ? FACT.MEASURED : FACT.MISSING,
    },

    // ── Body / Assessment ────────────────────────────────────────────────
    body: latestAssess ? {
      as_of: assessDate,
      source: FACT.MEASURED,
      measurements: {
        weight_kg: num(latestAssess.weight),
        height_cm: num(latestAssess.height_cm),
        bmi: num(latestAssess.bmi),
        body_fat_pct: num(latestAssess.body_fat_pct),
        lean_mass_kg: num(latestAssess.lean_body_mass_kg),
        fat_mass_kg: num(latestAssess.fat_mass_kg),
        chest_cm: num(latestAssess.chest_cm),
        waist_cm: num(latestAssess.waist_cm),
        hips_cm: num(latestAssess.hips_cm),
        waist_hip_ratio: num(latestAssess.waist_hip_ratio),
      },
      vitals: {
        bp_systolic: num(latestAssess.bp_systolic),
        bp_diastolic: num(latestAssess.bp_diastolic),
        bp_category: latestAssess.bp_category || null,
        resting_heart_rate: num(latestAssess.resting_heart_rate),
        resting_spo2: num(latestAssess.resting_spo2),
      },
      body_comp: {
        muscle_mass_pct: num(latestAssess.muscle_mass_pct),
        body_water_pct: num(latestAssess.body_water_pct),
        bone_mass_kg: num(latestAssess.bone_mass_kg),
        visceral_fat: num(latestAssess.visceral_fat),
        metabolic_age: num(latestAssess.metabolic_age),
        bmr: num(latestAssess.bmr),
      },
      cardio: {
        vo2_max: num(latestAssess.vo2_max),
        category: latestAssess.cardio_category || null,
        score: num(latestAssess.cardio_score_computed),
      },
      strength: {
        exercise: latestAssess.strength_exercise || null,
        score: num(latestAssess.strength_score_computed),
      },
      endurance: {
        test_type: latestAssess.endurance_test_type || null,
        category: latestAssess.endurance_category || null,
        score: num(latestAssess.endurance_score_computed),
      },
      mobility: {
        score: num(latestAssess.mobility_score_computed),
        flexibility_category: latestAssess.flexibility_category || null,
        has_asymmetry: latestAssess.has_asymmetry || null,
      },
      scores: {
        body_composition: num(latestAssess.body_composition_score),
        health_risk: num(latestAssess.health_risk_score),
        overall_fitness: num(latestAssess.overall_fitness_score),
      },
      freshness: freshness.assessment,
    } : {
      source: FACT.MISSING,
      measurements: null,
      scores: null,
      freshness: 'never',
    },

    // ── Measurements History ─────────────────────────────────────────────
    measurements: {
      recent: measurementRes.rows.slice(0, 10).map((m) => ({
        weight_kg: num(m.weight_kg),
        body_fat_pct: num(m.body_fat_pct),
        chest_cm: num(m.chest_cm),
        waist_cm: num(m.waist_cm),
        hips_cm: num(m.hips_cm),
        measured_at: dateStr(m.measured_at),
        source: FACT.MEASURED,
      })),
      trend: weightTrend,
      source: FACT.INFERRED,
      as_of: measurementDate || assessDate,
      freshness: freshness.measurements,
    },

    // ── Training / Program ───────────────────────────────────────────────
    program: {
      active: !!activeWorkout,
      assignment_id: activeWorkout?.assignment_id || null,
      plan_id: activeWorkout?.workout_plan_id || null,
      plan_name: activeWorkout?.plan_name || null,
      started_on: dateStr(activeWorkout?.start_date),
      ends_on: dateStr(activeWorkout?.end_date),
      duration_weeks: plan?.duration_weeks || null,
      sessions_per_week: plan?.sessions_per_week || null,
      progression_type: plan?.progression_type || activeWorkout?.progression_type || null,
      progression_amount: num(plan?.progression_amount ?? activeWorkout?.progression_amount),
      progression_every_weeks: num(plan?.progression_every_weeks ?? activeWorkout?.progression_every_weeks),
      source: activeWorkout ? FACT.MEASURED : FACT.MISSING,
      freshness: freshness.program,
    },

    // ── Diet Program ─────────────────────────────────────────────────────
    diet: {
      active: !!activeDiet,
      template_name: activeDiet?.template_name || null,
      started_on: dateStr(activeDiet?.start_date),
      ends_on: dateStr(activeDiet?.end_date),
      source: activeDiet ? FACT.MEASURED : FACT.MISSING,
    },

    // ── Performance ──────────────────────────────────────────────────────
    performance: {
      sessions: sessionRes.rows.map((s) => ({
        date: dateStr(s.session_date),
        status: s.status,
        duration_seconds: num(s.duration_seconds),
      })),
      adherence,
      personalRecords: prRes.rows.map((r) => ({
        exercise: r.exercise_name,
        type: r.record_type,
        value: num(r.value),
        unit: r.unit,
        reps: num(r.reps),
        achieved_on: dateStr(r.achieved_on),
        source: FACT.MEASURED,
      })),
      muscleVolume: setRes.rows.map((r) => ({
        muscle: r.target_muscle,
        sets: r.sets,
        last_trained: dateStr(r.last_date),
        days_since: daysSince(r.last_date),
      })),
      lastSessionDate,
      daysSinceLastSession: lastSessionDate ? daysSince(lastSessionDate) : null,
    },

    // ── Attendance ───────────────────────────────────────────────────────
    attendance: {
      ...attendance,
      source: FACT.MEASURED,
      as_of: sinceDate,
    },

    // ── Recovery / Check-ins ─────────────────────────────────────────────
    recovery: {
      latest: latestCheckin ? {
        week_start: dateStr(latestCheckin.week_start_date),
        mood: latestCheckin.mood || null,
        sleep_hours: num(latestCheckin.sleep_hours),
        water_glasses: num(latestCheckin.water_glasses),
        stress_level: num(latestCheckin.stress_level),
        energy_level: num(latestCheckin.energy_level),
        soreness_level: num(latestCheckin.soreness_level),
        notes: textFrom(latestCheckin.client_notes),
        source: FACT.REPORTED,
      } : null,
      readiness: readinessScore,
      days_since_checkin: checkinDate ? daysSince(checkinDate) : null,
      as_of: checkinDate,
      freshness: freshness.checkins,
    },

    // ── Lifestyle ────────────────────────────────────────────────────────
    lifestyle: latestLifestyle ? {
      as_of: lifestyleDate,
      experience_level: latestLifestyle.workout_experience_level || null,
      years_of_experience: num(latestLifestyle.years_of_experience),
      sleep_hours: num(latestLifestyle.sleep_duration_hours),
      sleep_quality: latestLifestyle.sleep_quality || null,
      sleep_category: latestLifestyle.sleep_category || null,
      stress_level: latestLifestyle.stress_level || null,
      occupation_type: latestLifestyle.occupation_type || null,
      activity_level: latestLifestyle.activity_level || null,
      daily_steps: latestLifestyle.daily_steps_bracket || null,
      energy_level: latestLifestyle.energy_level || null,
      recovery_quality: latestLifestyle.recovery_quality || null,
      recovery_risk: latestLifestyle.recovery_risk || null,
      recovery_score: num(latestLifestyle.recovery_score),
      lifestyle_score: num(latestLifestyle.lifestyle_score),
      source: FACT.REPORTED,
      freshness: freshness.lifestyle,
    } : {
      source: FACT.MISSING,
      freshness: 'never',
    },

    // ── Nutrition ────────────────────────────────────────────────────────
    nutrition: latestNutrition ? {
      as_of: dateStr(latestNutrition.assessment_date),
      diet_preferences: textFrom(latestNutrition.diet_preferences),
      food_allergies: textFrom(latestNutrition.food_allergies),
      foods_to_avoid: textFrom(latestNutrition.foods_to_avoid),
      meals_per_day: num(latestNutrition.meals_per_day),
      nutrition_budget: latestNutrition.nutrition_budget || null,
      medical_conditions: textFrom(latestNutrition.medical_conditions),
      medical_notes: textFrom(latestNutrition.medical_notes),
      source: FACT.REPORTED,
    } : {
      source: FACT.MISSING,
    },

    // ── Limitations ──────────────────────────────────────────────────────
    limitations: {
      injuries: textFrom(client.injuries),
      health_conditions: textFrom(client.health_conditions),
      fitness_profile_injuries: textFrom(profile?.injuries),
      fitness_profile_conditions: textFrom(profile?.health_conditions),
      posture: postureRes.rows[0] ? {
        as_of: dateStr(postureRes.rows[0].assessment_date),
        risk_level: postureRes.rows[0].posture_risk_level || null,
        issues: [
          ...labelsFrom(postureRes.rows[0].front_issues),
          ...labelsFrom(postureRes.rows[0].side_issues),
          ...labelsFrom(postureRes.rows[0].back_issues),
        ],
        notes: textFrom(postureRes.rows[0].coach_notes),
        source: FACT.MEASURED,
      } : null,
      mobility: mobilityData ? {
        as_of: dateStr(mobilityData.assessment_date),
        category: mobilityData.mobility_category || null,
        score: num(mobilityData.mobility_score),
        findings: mobilityFindings,
        notes: textFrom(mobilityData.performance_notes),
        source: FACT.MEASURED,
      } : null,
      has_asymmetry: latestAssess?.has_asymmetry || null,
    },

    // ── Medical Clearance ────────────────────────────────────────────────
    clearance: {
      parq: latestParq ? {
        as_of: dateStr(latestParq.assessment_date),
        risk_level: latestParq.risk_level || null,
        risk_message: latestParq.risk_message || null,
        gate_status: latestParq.workout_gate_status || null,
        flagged_answers: num(latestParq.parq_yes_count),
        current_health: labelsFrom(latestParq.current_health),
        past_history: labelsFrom(latestParq.past_history),
        notes: textFrom(latestParq.trainer_notes),
        source: FACT.MEASURED,
      } : null,
      consent: latestConsent ? {
        status: latestConsent.status,
        as_of: dateStr(latestConsent.created_at),
        source: FACT.MEASURED,
      } : null,
    },

    // ── Missing Data ─────────────────────────────────────────────────────
    missing: {
      sections: missing,
      completeness_pct,
      critical_gaps,
    },

    // ── Deterministic Analytics (Phase 2C) ──────────────────────────────
    // Compact analytical summaries computed from existing deterministic modules.
    // The AI receives these conclusions — it never recalculates them.
    analytics: (() => {
      const a = {};

      // Programme completion
      if (activeWorkout && plan) {
        const startDate = String(activeWorkout.start_date).slice(0, 10);
        const now = new Date();
        now.setUTCHours(0, 0, 0, 0);
        const elapsed = Math.floor((now - new Date(startDate + 'T00:00:00Z')) / 86_400_000);
        const currentWeek = Math.min(Math.floor(elapsed / 7) + 1, plan.duration_weeks || 52);
        a.programme = {
          current_week: currentWeek,
          total_weeks: plan.duration_weeks || null,
          completion_pct: plan.duration_weeks ? Math.round((currentWeek / plan.duration_weeks) * 100) : null,
          weeks_remaining: plan.duration_weeks ? Math.max(0, plan.duration_weeks - currentWeek) : null,
        };
      }

      // Session adherence trend (last 4 weeks)
      if (sessionRes.rows.length && activeWorkout && plan) {
        const completedSessions = sessionRes.rows.filter((s) => s.status === 'completed');
        const last4Weeks = completedSessions.slice(-16); // ~4 weeks of sessions
        a.adherence = {
          recent_completed: last4Weeks.length,
          trend: adherence ? (adherence.pct >= 80 ? 'good' : adherence.pct >= 50 ? 'moderate' : 'low') : 'unknown',
          overall_pct: adherence?.pct || null,
        };
      }

      // Volume status per muscle (from hard sets query)
      if (setRes.rows.length) {
        const landmarkMap = {};
        for (const l of landmarkRes.rows) {
          landmarkMap[l.target_muscle] = { mev: l.mev_sets, mrv: l.mrv_sets };
        }
        a.muscleVolume = setRes.rows.map((r) => {
          const lm = landmarkMap[r.muscle];
          let status = 'unknown';
          if (lm) {
            if (r.sets < lm.mev) status = 'below_mev';
            else if (r.sets <= lm.mrv) status = 'within_range';
            else status = 'above_mrv';
          }
          return {
            muscle: r.muscle,
            weekly_sets: r.sets,
            mev: lm?.mev || null,
            mrv: lm?.mrv || null,
            status,
            last_trained_days_ago: daysSince(r.last_date),
          };
        });
      }

      // PR signals (recent PRs vs older ones)
      if (prRes.rows.length >= 2) {
        const recent = prRes.rows[0];
        const older = prRes.rows[1];
        const recentDate = new Date(recent.achieved_on);
        const olderDate = new Date(older.achieved_on);
        const daysBetween = Math.floor((recentDate - olderDate) / 86_400_000);
        a.prTrend = {
          latest_pr: recent.exercise_name,
          latest_value: `${recent.value} ${recent.unit}`,
          latest_date: dateStr(recent.achieved_on),
          days_since_previous: daysBetween,
          frequency: daysBetween <= 14 ? 'frequent' : daysBetween <= 30 ? 'regular' : 'infrequent',
        };
      }

      // Recovery trend (last 4 check-ins)
      if (checkinsRes.rows.length >= 2) {
        const recentCheckins = checkinsRes.rows.slice(0, 4);
        const scores = recentCheckins.map((c) => {
          const components = {};
          let inputs = 0;
          const sh = num(c.sleep_hours);
          const st = num(c.stress_level);
          const en = num(c.energy_level);
          const so = num(c.soreness_level);
          if (sh != null && sh > 0 && sh <= 24) { components.sleep = sh >= 7.5 ? 100 : sh >= 7 ? 90 : sh >= 6.5 ? 78 : sh >= 6 ? 65 : 45; inputs++; }
          if (st != null && st >= 1 && st <= 10) { components.stress = Math.round((10 - st) * (100 / 9)); inputs++; }
          if (en != null && en >= 1 && en <= 10) { components.energy = Math.round((en - 1) * (100 / 9)); inputs++; }
          if (so != null && so >= 1 && so <= 10) { components.soreness = Math.round((10 - so) * (100 / 9)); inputs++; }
          if (inputs >= 2) return Math.round(Object.values(components).reduce((s, v) => s + v, 0) / inputs);
          return null;
        }).filter((s) => s != null);

        if (scores.length >= 2) {
          const first = scores[0];
          const last = scores[scores.length - 1];
          const delta = first - last;
          a.recoveryTrend = {
            latest_score: first,
            oldest_score: last,
            direction: delta > 5 ? 'improving' : delta < -5 ? 'declining' : 'stable',
            delta,
          };
        }
      }

      // Days since last session
      a.lastSession = {
        date: lastSessionDate,
        days_ago: lastSessionDate ? daysSince(lastSessionDate) : null,
      };

      return a;
    })(),

    // ── Durable Memory (Phase 2B) ──────────────────────────────────────
    memory: memoryRes,

    // ── Freshness Summary ────────────────────────────────────────────────
    freshness,
  };

  return state;
}

// ═══════════════════════════════════════════════════════════════════════════
// TASK-SPECIFIC CONTEXT SELECTORS
//
// The canonical state is the source; these are projections for specific
// AI tasks. Each returns a compact text summary optimized for token
// efficiency while preserving all relevant facts.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Coaching context — for AI Coach chat.
 * Compact: identity, goals, recovery, limitations, missing data.
 */
function coachingContext(state) {
  if (!state) return '';
  const L = [];

  L.push(`CLIENT: ${state.identity.name}${state.identity.age != null ? `, ${state.identity.age}` : ''}${state.identity.gender ? `, ${state.identity.gender}` : ''}`);

  if (state.goals.primary) {
    const g = state.goals.primary;
    L.push(`GOAL: ${g.goal_type || 'unspecified'}${g.target_weight != null ? `, target ${g.target_weight} kg` : ''}`);
  } else {
    L.push('GOAL: none set');
  }

  if (state.body?.measurements?.weight_kg) {
    L.push(`Weight: ${state.body.measurements.weight_kg} kg`);
  }
  if (state.body?.measurements?.body_fat_pct) {
    L.push(`Body fat: ${state.body.measurements.body_fat_pct}%`);
  }

  if (state.recovery?.readiness) {
    const r = state.recovery.readiness;
    L.push(`Recovery: ${r.score}/100 (${r.inputs}/${r.max_inputs} inputs)`);
  }

  if (state.recovery?.days_since_checkin != null) {
    L.push(`Last check-in: ${state.recovery.days_since_checkin} days ago`);
  }

  if (state.performance?.daysSinceLastSession != null) {
    L.push(`Last session: ${state.performance.daysSinceLastSession} days ago`);
  }

  if (state.program?.active) {
    L.push(`Active program: ${state.program.plan_name} (week ${state.program.started_on})`);
  }

  // Phase 2C: Deterministic analytics summary
  if (state.analytics?.programme) {
    const p = state.analytics.programme;
    L.push(`Programme: week ${p.current_week}/${p.total_weeks} (${p.completion_pct}% complete, ${p.weeks_remaining} weeks remaining)`);
  }
  if (state.analytics?.adherence) {
    L.push(`Adherence: ${state.analytics.adherence.overall_pct || '?'}% (${state.analytics.adherence.trend})`);
  }
  if (state.analytics?.recoveryTrend) {
    const rt = state.analytics.recoveryTrend;
    L.push(`Recovery trend: ${rt.direction} (${rt.delta > 0 ? '+' : ''}${rt.delta} over recent check-ins)`);
  }

  if (state.limitations?.injuries) {
    L.push(`Injuries: ${state.limitations.injuries}`);
  }
  if (state.limitations?.mobility?.findings?.length) {
    const findings = state.limitations.mobility.findings.map((f) => `${f.region}: ${[f.pain && 'pain', f.restriction && 'restricted'].filter(Boolean).join('+')}`).join(', ');
    L.push(`Mobility: ${findings}`);
  }

  if (state.missing?.sections?.length) {
    L.push('', 'NOT MEASURED:');
    for (const s of state.missing.sections) L.push(`- ${s}`);
  }

  // Phase 2B: Durable memory
  if (state.memory?.semantic?.length) {
    L.push('', 'KNOWN FACTS:');
    for (const m of state.memory.semantic.slice(0, 10)) {
      L.push(`- ${m.fact}${m.confidence < 1 ? ` (${Math.round(m.confidence * 100)}% confident)` : ''}`);
    }
  }

  if (state.memory?.episodes?.length) {
    L.push('', 'RECENT EVENTS:');
    for (const e of state.memory.episodes.slice(0, 5)) {
      L.push(`- [${e.type}] ${e.title}`);
    }
  }

  return L.join('\n');
}

/**
 * Progress context — for progress analysis.
 * Includes measurements history, adherence, weight trend.
 */
function progressContext(state) {
  if (!state) return '';
  const L = [];

  L.push(`CLIENT: ${state.identity.name}${state.identity.age != null ? `, ${state.identity.age}` : ''}`);

  if (state.goals.primary) {
    const g = state.goals.primary;
    L.push(`GOAL: ${g.goal_type}, target ${g.target_weight || '?'} kg`);
  }

  if (state.body?.measurements) {
    const m = state.body.measurements;
    L.push('', 'CURRENT MEASUREMENTS:');
    if (m.weight_kg) L.push(`- Weight: ${m.weight_kg} kg`);
    if (m.body_fat_pct) L.push(`- Body fat: ${m.body_fat_pct}%`);
    if (m.waist_cm) L.push(`- Waist: ${m.waist_cm} cm`);
    if (m.chest_cm) L.push(`- Chest: ${m.chest_cm} cm`);
  }

  if (state.measurements?.recent?.length > 1) {
    L.push('', 'WEIGHT HISTORY:');
    for (const m of state.measurements.recent.slice(0, 5)) {
      L.push(`- ${m.measured_at}: ${m.weight_kg} kg`);
    }
    if (state.measurements.trend) {
      L.push(`Trend: ${state.measurements.trend}`);
    }
  }

  if (state.performance?.adherence) {
    const a = state.performance.adherence;
    L.push('', `ADHERENCE: ${a.completed}/${a.planned} sessions (${a.pct}%)`);
  }

  if (state.performance?.personalRecords?.length) {
    L.push('', 'PERSONAL RECORDS:');
    for (const pr of state.performance.personalRecords.slice(0, 5)) {
      L.push(`- ${pr.exercise}: ${pr.value} ${pr.unit} (${pr.achieved_on})`);
    }
  }

  if (state.recovery?.readiness) {
    L.push('', `RECOVERY: ${state.recovery.readiness.score}/100`);
  }

  if (state.missing?.sections?.length) {
    L.push('', 'DATA GAPS:');
    for (const s of state.missing.sections) L.push(`- ${s}`);
  }

  // Phase 2B: Durable memory
  if (state.memory?.semantic?.length) {
    L.push('', 'KNOWN FACTS:');
    for (const m of state.memory.semantic.slice(0, 8)) {
      L.push(`- ${m.fact}`);
    }
  }

  return L.join('\n');
}

/**
 * Workout context — for workout plan generation.
 * Includes body, limitations, program, experience, equipment.
 */
function workoutContext(state) {
  if (!state) return '';
  const L = [];

  L.push(`CLIENT: ${state.identity.name}${state.identity.age != null ? `, ${state.identity.age}` : ''}`);
  if (state.identity.gender) L.push(`Gender: ${state.identity.gender}`);

  if (state.body?.measurements) {
    const m = state.body.measurements;
    if (m.weight_kg) L.push(`Weight: ${m.weight_kg} kg`);
    if (m.height_cm) L.push(`Height: ${m.height_cm} cm`);
  }

  if (state.goals.primary) {
    L.push(`Goal: ${state.goals.primary.goal_type}`);
  }

  if (state.limitations?.injuries) {
    L.push(`Injuries: ${state.limitations.injuries}`);
  }
  if (state.limitations?.mobility?.findings?.length) {
    const findings = state.limitations.mobility.findings.map((f) => `${f.region}: ${[f.pain && 'pain', f.restriction && 'restricted'].filter(Boolean).join('+')}`).join('; ');
    L.push(`Mobility restrictions: ${findings}`);
  }

  if (state.lifestyle?.experience_level) {
    L.push(`Experience: ${state.lifestyle.experience_level}`);
  }

  if (state.clearance?.parq) {
    L.push(`Medical gate: ${state.clearance.parq.gate_status || 'unknown'}`);
    if (state.clearance.parq.current_health?.length) {
      L.push(`Health conditions: ${state.clearance.parq.current_health.join(', ')}`);
    }
  }

  if (state.program?.active) {
    L.push(`Current program: ${state.program.plan_name}`);
  }

  if (state.performance?.personalRecords?.length) {
    L.push('', 'BEST LIFTS:');
    for (const pr of state.performance.personalRecords.slice(0, 6)) {
      L.push(`- ${pr.exercise}: ${pr.value} ${pr.unit}`);
    }
  }

  // Phase 2B: Durable memory (exercise/scheduling preferences)
  if (state.memory?.semantic?.length) {
    const relevant = state.memory.semantic.filter((m) =>
      m.category === 'preference' || m.category === 'constraint' || m.category === 'equipment'
    );
    if (relevant.length) {
      L.push('', 'CLIENT PREFERENCES:');
      for (const m of relevant.slice(0, 6)) {
        L.push(`- ${m.fact}`);
      }
    }
  }

  return L.join('\n');
}

/**
 * Programming context — for the programmer agent.
 * Full state minus sensitive data, plus performance details.
 */
function programmingContext(state) {
  if (!state) return '';
  const L = [];

  L.push(`CLIENT: ${state.identity.name}${state.identity.age != null ? `, ${state.identity.age}` : ''}${state.identity.gender ? `, ${state.identity.gender}` : ''}`);

  if (state.goals.primary) {
    L.push(`GOAL: ${state.goals.primary.goal_type}, target ${state.goals.primary.target_weight || '?'} kg`);
  }

  if (state.body?.scores) {
    L.push(`Fitness scores: overall ${state.body.scores.overall_fitness}, strength ${state.body.scores.body_composition}, health risk ${state.body.scores.health_risk}`);
  }

  if (state.program?.active) {
    L.push(`\nACTIVE PROGRAM: ${state.program.plan_name}`);
    L.push(`Duration: ${state.program.duration_weeks} weeks`);
    L.push(`Progression: ${state.program.progression_type || 'none'}${state.program.progression_amount ? ` (${state.program.progression_amount})` : ''}`);
  }

  // Phase 2C: Deterministic analytics
  if (state.analytics?.programme) {
    const p = state.analytics.programme;
    L.push(`Programme progress: week ${p.current_week}/${p.total_weeks} (${p.completion_pct}% complete)`);
  }
  if (state.analytics?.adherence) {
    L.push(`Adherence: ${state.analytics.adherence.overall_pct || '?'}% (${state.analytics.adherence.trend})`);
  }
  if (state.analytics?.recoveryTrend) {
    const rt = state.analytics.recoveryTrend;
    L.push(`Recovery trend: ${rt.direction} (score ${rt.latest_score}/100, delta ${rt.delta > 0 ? '+' : ''}${rt.delta})`);
  }
  if (state.analytics?.prTrend) {
    const pr = state.analytics.prTrend;
    L.push(`PR trend: latest ${pr.latest_pr} ${pr.latest_value} on ${pr.latest_date} (${pr.frequency} PRs)`);
  }

  if (state.performance?.adherence) {
    const a = state.performance.adherence;
    L.push(`\nADHERENCE: ${a.completed}/${a.planned} (${a.pct}%)`);
  }

  if (state.analytics?.muscleVolume?.length) {
    L.push('\nMUSCLE VOLUME (weekly hard sets vs landmarks):');
    for (const m of state.analytics.muscleVolume) {
      const statusLabel = m.status === 'within_range' ? '✓' : m.status === 'below_mev' ? '↓ below MEV' : m.status === 'above_mrv' ? '↑ above MRV' : '?';
      L.push(`- ${m.muscle}: ${m.weekly_sets} sets ${m.mev != null ? `(MEV ${m.mev}–MRV ${m.mrv})` : ''} ${statusLabel}, last ${m.last_trained_days_ago != null ? `${m.last_trained_days_ago}d ago` : 'unknown'}`);
    }
  } else if (state.performance?.muscleVolume?.length) {
    L.push('\nMUSCLE VOLUME (weekly hard sets):');
    for (const m of state.performance.muscleVolume) {
      L.push(`- ${m.muscle}: ${m.sets} sets, last ${m.days_since != null ? `${m.days_since}d ago` : 'unknown'}`);
    }
  }

  if (state.performance?.personalRecords?.length) {
    L.push('\nPERSONAL RECORDS:');
    for (const pr of state.performance.personalRecords.slice(0, 8)) {
      L.push(`- ${pr.exercise}: ${pr.value} ${pr.unit} (${pr.achieved_on})`);
    }
  }

  if (state.recovery?.readiness) {
    L.push(`\nRECOVERY: ${state.recovery.readiness.score}/100 (${state.recovery.readiness.inputs}/${state.recovery.readiness.max_inputs} inputs)`);
  }

  if (state.lifestyle?.recovery_risk) {
    L.push(`Recovery risk: ${state.lifestyle.recovery_risk}`);
  }

  if (state.limitations?.injuries) {
    L.push(`\nInjuries: ${state.limitations.injuries}`);
  }
  if (state.limitations?.mobility?.findings?.length) {
    const findings = state.limitations.mobility.findings.map((f) => `${f.region}: ${[f.pain && 'pain', f.restriction && 'restricted'].filter(Boolean).join('+')}`).join('; ');
    L.push(`Mobility: ${findings}`);
  }

  if (state.nutrition?.source === 'missing') {
    L.push('\nNutrition data: NOT RECORDED');
  }

  if (state.missing?.critical_gaps?.length) {
    L.push('\nCRITICAL GAPS:');
    for (const g of state.missing.critical_gaps) L.push(`- ${g}`);
  }

  // Phase 2B: Durable memory (all categories)
  if (state.memory?.semantic?.length) {
    L.push('\nKNOWN CLIENT FACTS:');
    for (const m of state.memory.semantic.slice(0, 12)) {
      L.push(`- [${m.category}] ${m.fact}`);
    }
  }

  if (state.memory?.episodes?.length) {
    L.push('\nRECENT EPISODES:');
    for (const e of state.memory.episodes.slice(0, 8)) {
      L.push(`- [${e.type}] ${e.title}${e.detail ? ` — ${e.detail}` : ''}`);
    }
  }

  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY CONTEXT (for AI prompt injection)
//
// Formats durable memory into a compact text block that can be injected
// into system prompts. The LLM reads this as authoritative client facts —
// it must NOT be able to create or modify memory through prompts.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a memory context string for AI prompts.
 * Filters to relevant categories based on the task.
 *
 * @param {object|null} state — canonical client state
 * @param {object} [opts]
 * @param {string[]} [opts.categories] — filter to specific categories (null = all)
 * @param {number} [opts.maxSemantic=10] — max semantic memories
 * @param {number} [opts.maxEpisodes=5] — max episodes
 * @param {boolean} [opts.includeEpisodes=true] — include episodic memory
 * @returns {string} formatted memory context for prompt injection
 */
function memoryContext(state, opts = {}) {
  if (!state?.memory) return '';
  const {
    categories = null,
    maxSemantic = 10,
    maxEpisodes = 5,
    includeEpisodes = true,
  } = opts;

  const L = [];

  // Semantic memory
  let semantic = state.memory.semantic || [];
  if (categories && categories.length) {
    semantic = semantic.filter((m) => categories.includes(m.category));
  }
  semantic = semantic.slice(0, maxSemantic);

  if (semantic.length) {
    L.push('DURABLE CLIENT MEMORY:');
    L.push('The following are confirmed facts about this client, established through trainer observations, assessments, and confirmed client feedback. Treat these as authoritative.');
    for (const m of semantic) {
      const conf = m.confidence < 1 ? ` (${Math.round(m.confidence * 100)}% confident)` : '';
      L.push(`- [${m.category}] ${m.fact}${conf}`);
    }
  }

  // Episodic memory
  if (includeEpisodes) {
    const episodes = (state.memory.episodes || []).slice(0, maxEpisodes);
    if (episodes.length) {
      if (L.length) L.push('');
      L.push('RECENT COACHING EVENTS:');
      for (const e of episodes) {
        const detail = e.detail ? ` — ${e.detail}` : '';
        L.push(`- [${e.type}] ${e.title}${detail}`);
      }
    }
  }

  if (!L.length) return '';
  return L.join('\n');
}

module.exports = {
  buildClientState,
  coachingContext,
  progressContext,
  workoutContext,
  programmingContext,
  memoryContext,
  FACT,
  FRESHNESS,
  // Exported for testing
  classifyFreshness,
  daysSince,
  ageFromDob,
};

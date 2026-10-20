'use strict';
// src/modules/progress/habits.service.js
// Daily journal + the trainer/member progress dashboards. Orchestration only;
// the arithmetic lives in the pure engines.

const repo = require('./habits.repo');
const retests = require('./retests.service');
const analyticsEngine = require('./habit-analytics');
const insightEngine = require('./progress-insights');
const scheduling = require('./retest-scheduling');
const { deriveProvenance } = require('./journal-provenance');
const { dbDate } = require('../../lib/appTime');

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function dateOnly(value) {
  return value ? dbDate(value) : null;
}

function normalizeLog(row) {
  if (!row) return null;
  // Explicit fields, not `...row`: a member response must not carry the
  // internal user ids or organization id that the table happens to store.
  return {
    id: row.id,
    log_date: dateOnly(row.log_date),
    sleep_hours: row.sleep_hours == null ? null : Number(row.sleep_hours),
    sleep_quality: row.sleep_quality == null ? null : Number(row.sleep_quality),
    water_ml: row.water_ml == null ? null : Number(row.water_ml),
    electrolytes: row.electrolytes == null ? null : Boolean(row.electrolytes),
    steps: row.steps == null ? null : Number(row.steps),
    steps_source: row.steps_source || null,
    stress_level: row.stress_level == null ? null : Number(row.stress_level),
    energy_level: row.energy_level == null ? null : Number(row.energy_level),
    fatigue_level: row.fatigue_level == null ? null : Number(row.fatigue_level),
    soreness_level: row.soreness_level == null ? null : Number(row.soreness_level),
    recovery_level: row.recovery_level == null ? null : Number(row.recovery_level),
    notes: row.notes ?? null,
    source: row.source || 'manual',
    updated_at: row.updated_at || null,
  };
}

function defaultPreferences() {
  return {
    sleep_target_min: 7, sleep_target_max: 9, water_target_ml: null,
    step_target: null, reminder_enabled: true, reminder_time: null, wearable_provider: null,
  };
}

function normalizePreferences(row) {
  if (!row) return defaultPreferences();
  return {
    sleep_target_min: Number(row.sleep_target_min),
    sleep_target_max: Number(row.sleep_target_max),
    water_target_ml: row.water_target_ml == null ? null : Number(row.water_target_ml),
    step_target: row.step_target == null ? null : Number(row.step_target),
    reminder_enabled: row.reminder_enabled,
    reminder_time: row.reminder_time,
    wearable_provider: row.wearable_provider,
  };
}

async function todayFor(orgId) {
  return scheduling.todayInZone(await retests.timezoneFor(orgId));
}

async function getLog(orgId, clientId, logDate) {
  return normalizeLog(await repo.getLog(orgId, clientId, logDate));
}

async function listLogs(orgId, clientId, fromDate, toDate) {
  return (await repo.listLogs(orgId, clientId, fromDate, toDate)).map(normalizeLog);
}

async function upsertLog({ orgId, clientId, logDate, values, userId }) {
  const today = await todayFor(orgId);
  const date = logDate || today;
  if (date > today) throw httpError(400, 'DATE_IN_FUTURE', 'A journal entry cannot be dated in the future.');
  if (date < analyticsEngine.addDays(today, -365)) {
    throw httpError(400, 'DATE_TOO_OLD', 'Journal entries can be edited up to one year back.');
  }

  const existing = normalizeLog(await repo.getLog(orgId, clientId, date));
  const merged = { ...(existing || {}), ...values };
  const provenance = deriveProvenance(existing, values, merged);
  const record = {
    sleep_hours: merged.sleep_hours ?? null,
    sleep_quality: merged.sleep_quality ?? null,
    water_ml: merged.water_ml ?? null,
    electrolytes: merged.electrolytes ?? null,
    steps: merged.steps ?? null,
    steps_source: provenance.steps_source,
    stress_level: merged.stress_level ?? null,
    energy_level: merged.energy_level ?? null,
    fatigue_level: merged.fatigue_level ?? null,
    soreness_level: merged.soreness_level ?? null,
    recovery_level: merged.recovery_level ?? null,
    notes: merged.notes ?? null,
    source: provenance.source,
  };
  return normalizeLog(await repo.upsertLog(orgId, clientId, date, record, userId));
}

async function getPreferences(orgId, clientId) {
  return normalizePreferences(await repo.getPreferences(orgId, clientId));
}

async function savePreferences(orgId, clientId, body) {
  const current = await getPreferences(orgId, clientId);
  const min = body.sleep_target_min ?? current.sleep_target_min;
  const max = body.sleep_target_max ?? current.sleep_target_max;
  if (max < min) throw httpError(400, 'INVALID_SLEEP_TARGET', 'Sleep target maximum must be at least the minimum.');
  const row = await repo.upsertPreferences(orgId, clientId, {
    sleepTargetMin: min,
    sleepTargetMax: max,
    waterTargetMl: body.water_target_ml !== undefined ? body.water_target_ml : current.water_target_ml,
    stepTarget: body.step_target !== undefined ? body.step_target : current.step_target,
    reminderEnabled: body.reminder_enabled !== undefined ? body.reminder_enabled : current.reminder_enabled,
    reminderTime: body.reminder_time !== undefined ? body.reminder_time : current.reminder_time,
    wearableProvider: body.wearable_provider !== undefined ? body.wearable_provider : current.wearable_provider,
  });
  return normalizePreferences(row);
}

function goalProgress(goal, assessments) {
  if (!goal) return null;
  const target = goal.target_weight != null ? Number(goal.target_weight)
    : goal.target_body_fat != null ? Number(goal.target_body_fat) : null;
  const key = goal.target_weight != null ? 'weight' : goal.target_body_fat != null ? 'body_fat_pct' : null;
  const measured = assessments
    .map((a) => ({ date: dateOnly(a.assessment_date), value: a[key] == null ? null : Number(a[key]) }))
    .filter((a) => a.value != null);
  if (!key || target == null) {
    return {
      goal_type: goal.goal_type, target_date: dateOnly(goal.target_date),
      target: null, current: null, start: null, progress_percent: null,
      summary: 'This goal has no numeric target; progress is not computed.',
    };
  }
  if (!measured.length) {
    return {
      goal_type: goal.goal_type, target_date: dateOnly(goal.target_date),
      target, current: null, start: null, progress_percent: null,
      summary: 'No recorded measurement for this goal yet.',
    };
  }
  const start = measured[0];
  const current = measured[measured.length - 1];
  const span = target - start.value;
  const progress = span === 0 ? null : ((current.value - start.value) / span) * 100;
  const capped = progress == null ? null : Math.max(0, Math.min(100, Math.round(progress)));
  return {
    goal_type: goal.goal_type,
    target_date: dateOnly(goal.target_date),
    target: { metric: key, value: target, unit: key === 'weight' ? 'kg' : '%' },
    current: { metric: key, value: current.value, unit: key === 'weight' ? 'kg' : '%', date: current.date },
    start: { metric: key, value: start.value, unit: key === 'weight' ? 'kg' : '%', date: start.date },
    progress_percent: capped,
    summary: capped == null
      ? 'The target equals the starting measurement, so percentage progress is not meaningful.'
      : `${capped}% of the way from ${start.value}${key === 'weight' ? ' kg' : '%'} to ${target}${key === 'weight' ? ' kg' : '%'}, based on recorded assessments.`,
  };
}

function workoutSummary(row, days) {
  const completed = Number(row?.completed) || 0;
  const perWeek = Number(row?.sessions_per_week) || 0;
  const planned = perWeek > 0 ? Math.round((perWeek * days) / 7) : null;
  return {
    completed,
    planned,
    sessions_per_week: perWeek || null,
    adherence_percent: planned ? Math.min(100, Math.round((completed / planned) * 100)) : null,
    period_days: days,
  };
}

async function dashboard(orgId, clientId, { date, days = 30 } = {}) {
  const timezone = await retests.timezoneFor(orgId);
  const today = scheduling.todayInZone(timezone);
  const endDate = date || today;
  if (endDate > today) throw httpError(400, 'DATE_IN_FUTURE', 'The dashboard date cannot be in the future.');
  const windowDays = Math.min(Math.max(Number(days) || 30, 7), 90);
  const fromDate = analyticsEngine.addDays(endDate, -(windowDays + 30));
  const [rawLogs, preferences, overview, rawGoal, workouts] = await Promise.all([
    repo.listLogs(orgId, clientId, fromDate, endDate),
    getPreferences(orgId, clientId),
    retests.overview(orgId, clientId),
    repo.activeGoal(orgId, clientId),
    repo.workoutAdherence(orgId, clientId, analyticsEngine.addDays(endDate, -(windowDays - 1)), endDate),
  ]);
  const logs = rawLogs.map(normalizeLog);
  const analytics = analyticsEngine.buildHabitAnalytics({ logs, preferences, endDate, days: windowDays });
  // One assessment has nothing to compare against; do not run the comparison
  // at all, and never hide a database failure behind a no-data dashboard.
  const assessments = overview.assessment_count >= 2
    ? await retests.comparisonFor(orgId, clientId)
    : null;
  const assessmentRows = overview.assessment_count > 0
    ? [overview.baseline, overview.latest].filter(Boolean) : [];
  const goal = goalProgress(rawGoal, assessmentRows);
  const workout = workoutSummary(workouts, windowDays);
  const schedule = overview.schedule
    ? { ...overview.schedule, state: overview.schedule.state || overview.state.state }
    : overview.state;
  const insights = insightEngine.buildInsights({
    comparison: assessments, analytics, schedule, goal, workouts: workout,
  });
  const [reviews] = await Promise.all([
    repo.listInsightReviews(orgId, clientId, 20),
  ]);
  return {
    client_id: clientId,
    today,
    timezone,
    period: { end_date: endDate, days: windowDays, start_date: analyticsEngine.addDays(endDate, -(windowDays - 1)) },
    schedule,
    assessment: {
      count: overview.assessment_count,
      baseline: overview.baseline,
      latest: overview.latest,
      comparison: assessments,
    },
    habits: analytics,
    goal,
    workouts: workout,
    insights,
    insight_reviews: reviews,
    data_sources: {
      assessments: 'pt_assessments',
      journal: 'client_habit_logs',
      goal: 'pt_goals',
      workouts: 'workout_sessions/workout_assignments',
    },
  };
}

/** The member's own view: no trainer insight queue, no other clients. */
async function memberDashboard(orgId, clientId, options = {}) {
  const full = await dashboard(orgId, clientId, options);
  return {
    today: full.today,
    timezone: full.timezone,
    period: full.period,
    schedule: full.schedule,
    assessment: full.assessment,
    habits: full.habits,
    goal: full.goal,
    workouts: full.workouts,
    reference: full.habits.reference,
  };
}

async function reviewInsight(orgId, clientId, review, userId) {
  return repo.insertInsightReview(orgId, clientId, review, userId);
}

async function listReviews(orgId, clientId) {
  return repo.listInsightReviews(orgId, clientId, 50);
}

module.exports = {
  getLog, listLogs, upsertLog, getPreferences, savePreferences, dashboard,
  memberDashboard, goalProgress, workoutSummary, reviewInsight, listReviews,
  normalizeLog, todayFor,
};

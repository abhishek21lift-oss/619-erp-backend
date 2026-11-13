'use strict';
// The unified Client 360 read.
//
// One trainer screen used to require opening seven tabs and remembering what
// each one said. This module assembles the same authoritative rows the tabs
// already read — the profile, the training brief, the snapshot, attendance,
// payments, session packages and the active diet — into one bounded payload.
//
// It owns no new storage and no new business rule. Every derived number comes
// from a row below it, and a missing source stays null rather than becoming a
// zero that reads like a measurement.

const pool = require('../../db/pool');
const { today: studioToday } = require('../../lib/appTime');
const { getClientProfile } = require('./client-read.service');
const { loadClientSources } = require('./authoritative-client');
const { buildSnapshot, weightSeries } = require('./client-snapshot');
const { buildRecovery } = require('./recovery');
const { buildBrief } = require('./training-brief');

const TIMELINE_LIMIT = 20;
const RECENT_LIMIT = 10;

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Whole days from a YYYY-MM-DD to another; null when either is undatable. */
function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const ymd = (value) => (value ? String(value).slice(0, 10) : null);

/**
 * Assemble the dashboard from rows the caller already fetched.
 *
 * Pure so the aggregation and the missing-data behaviour can be tested without
 * a database. `today` is injected for the same reason the snapshot injects it:
 * a window that reads the wall clock cannot be pinned by a test.
 */
function buildClient360({
  profile,
  sources,
  snapshot,
  recovery,
  brief,
  attendance = [],
  payments = [],
  balances = [],
  diet = null,
  nutritionLogs = [],
  subscription = null,
  today = studioToday(),
}) {
  const weights = weightSeries({
    measurements: sources.measurements,
    assessments: sources.assessments,
    clientId: profile.id,
  });
  const latestWeight = weights[0] || null;
  const oldestWeight = weights.length > 1 ? weights[weights.length - 1] : null;
  const attended = attendance.filter((a) => a.status !== 'absent');
  const inWindow = (days) => attended.filter((a) => {
    const age = daysBetween(a.date, today);
    return age !== null && age >= 0 && age < days;
  }).length;

  const sessions = sources.sessions || [];
  const completedSessions = sessions.filter((s) => s.status === 'completed').length;
  const loggedNutrition = nutritionLogs.filter((l) => num(l.calories_consumed) > 0);
  const remainingSessions = balances.length
    ? balances.reduce((sum, b) => sum + (num(b.remaining_sessions) ?? 0), 0)
    : null;

  const membershipActive = profile.status === 'active'
    && (profile.days_left === null || profile.days_left === undefined || Number(profile.days_left) >= 0);

  const timeline = [];
  for (const a of attendance.slice(0, RECENT_LIMIT)) {
    timeline.push({
      id: `attendance-${a.id}`,
      kind: 'attendance',
      at: ymd(a.date),
      title: a.status === 'absent' ? 'Marked absent' : 'Checked in',
      detail: a.method ? String(a.method) : null,
    });
  }
  for (const s of sessions) {
    timeline.push({
      id: `workout-${s.session_date}-${s.status}`,
      kind: 'workout',
      at: ymd(s.session_date),
      title: s.status === 'completed' ? 'Workout completed' : 'Workout in progress',
      detail: null,
    });
  }
  for (const p of payments.slice(0, RECENT_LIMIT)) {
    timeline.push({
      id: `payment-${p.id}`,
      kind: 'payment',
      at: ymd(p.date),
      title: 'Payment received',
      detail: `₹${Number(p.amount).toLocaleString('en-IN')}`,
    });
  }
  for (const c of (sources.checkins || []).slice(0, RECENT_LIMIT)) {
    timeline.push({
      id: `checkin-${c.week_start_date}`,
      kind: 'checkin',
      at: ymd(c.week_start_date),
      title: 'Weekly check-in',
      detail: c.weight != null ? `${c.weight} kg` : null,
    });
  }
  for (const a of (sources.assessments || []).slice(0, 3)) {
    timeline.push({
      id: `assessment-${a.id}`,
      kind: 'assessment',
      at: ymd(a.assessment_date),
      title: 'Fitness assessment',
      detail: a.weight != null ? `${a.weight} kg` : null,
    });
  }
  if (diet) {
    timeline.push({
      id: `diet-${diet.id}`,
      kind: 'nutrition',
      at: ymd(diet.start_date),
      title: 'Diet plan started',
      detail: diet.template_name || null,
    });
  }
  timeline.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    generated_at: new Date().toISOString(),
    client: {
      id: profile.id,
      name: profile.name,
      unique_id: profile.unique_id ?? null,
      gender: profile.gender ?? null,
      age: brief.client.age ?? null,
      mobile: profile.mobile ?? null,
      email: profile.email ?? null,
      trainer_name: profile.trainer_name ?? null,
      goal: profile.goal ?? null,
      injuries: brief.sections.limitations.injuries ?? null,
      notes: brief.client.notes ?? null,
      status: profile.status ?? null,
      joined_on: ymd(profile.pt_start_date),
      term_end: ymd(profile.pt_end_date),
      days_left: num(profile.days_left),
    },
    membership: {
      active: membershipActive,
      plan_name: subscription?.plan_name ?? profile.package_type ?? null,
      start_date: ymd(subscription?.start_date ?? profile.pt_start_date),
      end_date: ymd(subscription?.end_date ?? profile.pt_end_date),
      days_left: num(profile.days_left),
      due_status: profile.due_status ?? null,
      current_term_fee: num(profile.current_term_fee),
      current_term_paid: num(profile.current_term_paid),
      current_term_balance: num(profile.current_term_balance),
    },
    kpis: {
      weight_kg: latestWeight?.kg ?? num(profile.weight),
      weight_change_kg: latestWeight && oldestWeight
        ? Math.round((latestWeight.kg - oldestWeight.kg) * 10) / 10
        : null,
      weight_change_since: oldestWeight?.on ?? null,
      body_fat_pct: brief.sections.body.body_fat_pct ?? num(profile.body_fat),
      bmi: brief.sections.body.bmi ?? null,
      sessions_remaining: remainingSessions,
      attendance_30d: inWindow(30),
      workout_adherence_pct: pct(completedSessions, sessions.length),
      nutrition_adherence_pct: diet ? pct(loggedNutrition.length, 7) : null,
      outstanding_balance: num(profile.current_term_balance) ?? num(profile.balance_amount),
    },
    assessment: {
      present: brief.sections.capacity.present || brief.sections.body.present,
      as_of: brief.sections.capacity.as_of ?? brief.sections.body.as_of ?? null,
      readiness: brief.sections.readiness,
      body: brief.sections.body,
      capacity: brief.sections.capacity,
      overall_max: num(sources.latestAssessment?.overall_max),
      limitations: brief.sections.limitations,
    },
    training: {
      present: brief.sections.history.present,
      plan_name: brief.sections.history.plan_name ?? null,
      started_on: brief.sections.history.started_on ?? null,
      progress_pct: brief.sections.history.progress_pct ?? null,
      sessions_28d: sessions.length,
      completed_28d: completedSessions,
      adherence_pct: pct(completedSessions, sessions.length),
      last_session: sources.lastSession
        ? { date: ymd(sources.lastSession.session_date), status: sources.lastSession.status }
        : null,
    },
    nutrition: {
      present: Boolean(diet),
      plan_name: diet?.template_name ?? null,
      start_date: ymd(diet?.start_date),
      targets: diet
        ? {
          calories: num(diet.daily_calories),
          protein_g: num(diet.daily_protein_g),
          carbs_g: num(diet.daily_carbs_g),
          fats_g: num(diet.daily_fats_g),
        }
        : null,
      logged_days_7d: loggedNutrition.length,
      avg_calories_7d: loggedNutrition.length
        ? Math.round(loggedNutrition.reduce((sum, l) => sum + num(l.calories_consumed), 0) / loggedNutrition.length)
        : null,
      adherence_pct: diet ? pct(loggedNutrition.length, 7) : null,
    },
    attendance: {
      last_30d: inWindow(30),
      last_90d: inWindow(90),
      recent: attendance.slice(0, RECENT_LIMIT).map((a) => ({
        id: a.id,
        date: ymd(a.date),
        status: a.status,
        method: a.method ?? null,
        check_in_time: a.check_in_time ?? null,
      })),
      packages: balances.map((b) => ({
        id: b.id,
        name: b.package_name ?? null,
        total_sessions: num(b.total_sessions),
        used_sessions: num(b.used_sessions),
        remaining_sessions: num(b.remaining_sessions),
        start_date: ymd(b.start_date),
        end_date: ymd(b.end_date),
      })),
      sessions_remaining: remainingSessions,
    },
    progress: {
      weight_series: weights.slice(0, 12),
      measurements: {
        weight_kg: brief.sections.body.weight_kg,
        body_fat_pct: brief.sections.body.body_fat_pct,
        lean_mass_kg: brief.sections.body.lean_mass_kg,
        waist_cm: brief.sections.body.waist_cm,
        as_of: brief.sections.body.as_of ?? null,
      },
    },
    goals: {
      primary: snapshot.goal,
      detail: brief.sections.goal,
    },
    notes: {
      client: brief.client.notes ?? null,
    },
    finance: {
      recent_payments: payments.slice(0, RECENT_LIMIT),
      outstanding: num(profile.current_term_balance) ?? num(profile.balance_amount),
      due_status: profile.due_status ?? null,
    },
    timeline: timeline.slice(0, TIMELINE_LIMIT),
    insights: (snapshot.coach || []).slice(0, 6),
    alerts: snapshot.alerts || [],
    recovery,
    completeness: {
      pct: brief.completeness_pct,
      missing: brief.missing,
      stale: brief.stale,
    },
  };
}

/**
 * The client, or null when it is not this organization's.
 *
 * The profile read is the tenant gate: it binds `organization_id` and excludes
 * soft-deleted rows, and no child query runs until it returns a row. Every
 * child read below repeats the org predicate as defence in depth.
 */
async function getClient360(orgId, clientId) {
  const profile = await getClientProfile(orgId, clientId);
  if (!profile) return null;

  const sources = await loadClientSources(clientId, orgId, {
    client: profile,
    clinical: true,
    snapshot: true,
    training: true,
    sessionDays: 28,
    checkins: true,
    nutrition: true,
  });
  if (!sources) return null;

  const [attendance, payments, balances, diets, nutritionLogs, subscriptions] = await Promise.all([
    pool.query(
      `SELECT id, date, check_in_time, check_out_time, method, status, notes
         FROM attendance_logs
        WHERE ref_id = $1 AND ref_type = 'client'
          AND (organization_id = $2 OR organization_id IS NULL)
          AND date >= CURRENT_DATE - INTERVAL '90 days'
        ORDER BY date DESC, check_in_time DESC`,
      [clientId, orgId],
    ).then((r) => r.rows),
    pool.query(
      `SELECT id, amount, payment_method AS method, date,
              payment_ref AS receipt_no, notes
         FROM pt_payments
        WHERE client_id = $1 AND deleted_at IS NULL
          AND (organization_id = $2 OR organization_id IS NULL)
        ORDER BY date DESC, created_at DESC
        LIMIT $3`,
      [clientId, orgId, RECENT_LIMIT],
    ).then((r) => r.rows),
    pool.query(
      `SELECT id, package_name, total_sessions, used_sessions, remaining_sessions,
              start_date::text AS start_date, end_date::text AS end_date, status
         FROM session_balance
        WHERE client_id = $1 AND organization_id = $2 AND status = 'active'
        ORDER BY end_date NULLS LAST, created_at`,
      [clientId, orgId],
    ).then((r) => r.rows),
    pool.query(
      `SELECT da.id, da.start_date, da.end_date, da.status,
              dt.name AS template_name, dt.goal,
              dt.daily_calories, dt.daily_protein_g, dt.daily_carbs_g, dt.daily_fats_g
         FROM diet_assignments da
         JOIN diet_templates dt ON dt.id = da.diet_template_id
        WHERE da.client_id = $1 AND da.organization_id = $2 AND da.status = 'active'
        ORDER BY da.created_at DESC
        LIMIT 1`,
      [clientId, orgId],
    ).then((r) => r.rows[0] || null),
    pool.query(
      `SELECT log_date::text AS log_date, calories_consumed, protein_g, carbs_g, fats_g, water_glasses
         FROM nutrition_logs
        WHERE client_id = $1 AND organization_id = $2
          AND log_date >= CURRENT_DATE - INTERVAL '6 days'
        ORDER BY log_date DESC`,
      [clientId, orgId],
    ).then((r) => r.rows),
    pool.query(
      `SELECT plan_name, start_date::text AS start_date, end_date::text AS end_date, status
         FROM pt_client_subscriptions
        WHERE client_id = $1
        ORDER BY start_date DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [clientId],
    ).then((r) => r.rows[0] || null),
  ]);

  const snapshot = buildSnapshot({
    client: profile,
    lifestyle: sources.lifestyle,
    measurements: sources.measurements,
    assessments: sources.assessments,
    goal: sources.goal,
    prRows: sources.prRows,
    lastSession: sources.lastSession,
  });

  const brief = buildBrief({
    client: sources.client,
    parq: sources.parq,
    assessment: sources.latestAssessment,
    posture: sources.posture,
    mobility: sources.mobility,
    lifestyle: sources.lifestyle,
    goal: sources.goal,
    assignment: sources.assignment,
    recentSessions: sources.sessions,
  });

  return buildClient360({
    profile,
    sources,
    snapshot,
    recovery: buildRecovery(sources.checkins),
    brief,
    attendance,
    payments,
    balances,
    diet: diets,
    nutritionLogs,
    subscription: subscriptions,
  });
}

module.exports = { buildClient360, getClient360, daysBetween };

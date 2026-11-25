'use strict';
// The member assistant's tool registry.
//
// Each tool returns a small, typed object rather than raw rows. That is the
// data-minimisation boundary described in AGENTS.md §3.2: the model gets the
// facts the question needs, and nothing about the trainer's private notes,
// commission, signatures or PAR-Q answers can leak through a `SELECT *`.
//
// A failed read is a typed failure, never an exception: the service answers
// with the tools that worked and tells the member which one did not.

const pool = require('../../db/pool');
const portal = require('../client-portal/client-portal.service');
const coach = require('../client-portal/member-coach.service');
const booking = require('../client-portal/client-booking.repository');
const { daysUntil } = require('../client-portal/member-renewal.service');
const read = require('./member-ai.read');

const num = (v) => (v == null || v === '' ? null : Number(v));
const ymd = (v) => (v == null ? null : String(v).slice(0, 10));

/** 'YYYY-MM-DD' `n` days before `today`, in UTC like the rest of the app. */
function daysAgo(today, n) {
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday, the convention every day_of_week column uses. */
function dayOfWeek(today) {
  return ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

function presentExercise(x) {
  return {
    name: x.name ?? null,
    sets: x.sets ?? null,
    reps: x.reps ?? null,
    rest_seconds: x.rest_seconds ?? null,
    target_weight: num(x.target_weight),
    rpe: num(x.rpe),
    cues: x.cues ?? null,
  };
}

async function getMyProfile(ctx) {
  const [row, memberCoach] = await Promise.all([
    read.profile(ctx.clientId, ctx.orgId),
    coach.coachFor(pool, { clientId: ctx.clientId, orgId: ctx.orgId }),
  ]);
  const p = row || {};
  return {
    name: p.name ?? null,
    goal: p.goal ?? null,
    height_cm: num(p.height),
    weight_kg: num(p.weight),
    package_type: p.package_type ?? null,
    trainer_name: memberCoach?.name ?? null,
    joining_date: p.joining_date ?? null,
    status: p.status ?? null,
  };
}

async function getMyWorkout(ctx) {
  const plans = await portal.myWorkout(ctx.clientId, ctx.orgId);
  const first = Array.isArray(plans) ? plans[0] : null;
  if (!first) return { plan: null };

  const dow = dayOfWeek(ctx.today);
  const days = Array.isArray(first.days) ? first.days : [];
  const dayAt = (d) => ({
    day_of_week: d.day_of_week,
    exercises: (d.exercises || []).map(presentExercise),
  });

  const today = days.find((d) => d.day_of_week === dow) || null;
  const later = days.find((d) => d.day_of_week > dow);
  const next = later || (days.length > 0 ? days[0] : null);

  return {
    plan: first.name ?? null,
    current_week: first.current_week ?? null,
    today: today ? dayAt(today) : null,
    next: next ? dayAt(next) : null,
  };
}

async function getMyDiet(ctx) {
  const plans = await portal.myDiet(ctx.clientId, ctx.orgId);
  const first = Array.isArray(plans) ? plans[0] : null;
  if (!first) return { plan: null };

  const dow = dayOfWeek(ctx.today);
  const meals = (first.meals || [])
    .filter((m) => m.day_of_week == null || Number(m.day_of_week) === dow)
    .slice(0, 8)
    .map((m) => ({
      name: m.name ?? null,
      serve_time: m.serve_time ?? null,
      calories: num(m.calories),
      protein_g: num(m.protein_g),
      carbs_g: num(m.carbs_g),
      fats_g: num(m.fats_g),
      foods: (m.foods || []).slice(0, 15).map((f) => ({
        name: f.name ?? null,
        quantity: num(f.quantity),
        unit: f.unit ?? null,
      })),
    }));

  return { plan: first.name ?? null, daily: first.daily || null, meals };
}

async function getMyCheckins(ctx) {
  const result = await portal.myCheckins(ctx.clientId, ctx.orgId);
  const rows = Array.isArray(result?.checkins) ? result.checkins : [];
  const weeks = rows.slice(0, 8).map((c) => ({
    week_start_date: ymd(c.week_start_date),
    weight: num(c.weight),
    mood: c.mood ?? null,
    sleep_hours: num(c.sleep_hours),
    water_glasses: num(c.water_glasses),
    stress_level: num(c.stress_level),
    energy_level: num(c.energy_level),
    soreness_level: num(c.soreness_level),
    client_notes: c.client_notes ?? null,
  }));
  return { weeks };
}

async function getMyMeasurements(ctx) {
  const rows = await portal.myMeasurements(ctx.clientId, ctx.orgId);
  const entries = (Array.isArray(rows) ? rows : []).slice(0, 10).map((m) => ({
    weight_kg: num(m.weight_kg),
    waist_cm: num(m.waist_cm),
    body_fat_pct: num(m.body_fat_pct),
    measured_at: ymd(m.measured_at),
    source: m.source ?? null,
  }));

  const first = entries[0];
  const last = entries[entries.length - 1];
  const delta = (a, b) => (
    a == null || b == null ? null : Number((a - b).toFixed(2))
  );
  const change = entries.length >= 2
    ? {
      weight_kg: delta(first.weight_kg, last.weight_kg),
      waist_cm: delta(first.waist_cm, last.waist_cm),
      body_fat_pct: delta(first.body_fat_pct, last.body_fat_pct),
    }
    : { weight_kg: null, waist_cm: null, body_fat_pct: null };

  return { latest: first || null, change, entries };
}

const VISIT_STATUSES = new Set(['present', 'late']);

async function getMyAttendance(ctx) {
  const rows = await read.attendance(ctx.clientId, ctx.orgId, { days: 90 });
  const visits = (Array.isArray(rows) ? rows : [])
    .filter((r) => VISIT_STATUSES.has(r.status))
    .map((r) => r.date);

  return {
    last_visit: visits[0] ?? null,
    visits_last_7_days: visits.filter((d) => d >= daysAgo(ctx.today, 7)).length,
    visits_last_30_days: visits.filter((d) => d >= daysAgo(ctx.today, 30)).length,
    recent: visits.slice(0, 5),
  };
}

async function getMyMembership(ctx) {
  const row = await read.membership(ctx.clientId, ctx.orgId);
  const r = row || {};
  return {
    package_type: r.package_type ?? null,
    pt_start_date: r.pt_start_date ?? null,
    pt_end_date: r.pt_end_date ?? null,
    duration_months: num(r.duration_months),
    final_amount: num(r.final_amount),
    paid_amount: num(r.paid_amount),
    balance_amount: num(r.balance_amount),
    status: r.status ?? null,
    days_left: daysUntil(r.pt_end_date, ctx.today),
  };
}

async function getMyPayments(ctx) {
  const rows = await read.payments(ctx.clientId, ctx.orgId, { limit: 10 });
  return {
    payments: (Array.isArray(rows) ? rows : []).map((p) => ({
      date: ymd(p.date),
      amount: num(p.amount),
      method: p.payment_method ?? null,
    })),
  };
}

async function getMyBookings(ctx) {
  const rows = await booking.upcomingForClient(ctx.clientId, ctx.orgId, ctx.today);
  return {
    sessions: (Array.isArray(rows) ? rows : []).slice(0, 3).map((s) => ({
      date: s.session_date,
      start_time: s.start_time,
      end_time: s.end_time,
      duration_minutes: num(s.duration_minutes),
      status: s.status,
    })),
  };
}

async function getMyForms(ctx) {
  const forms = await portal.myForms(ctx.clientId, ctx.orgId);
  const parq = forms?.parq;
  const consent = forms?.consent;
  return {
    parq: parq ? {
      status: parq.status ?? null,
      assessment_date: ymd(parq.assessment_date),
      risk_level: parq.risk_level ?? null,
    } : null,
    consent: consent ? {
      status: consent.status ?? null,
      completed_at: ymd(consent.completed_at),
    } : null,
  };
}

const TOOLS = {
  getMyProfile: { label: 'member profile', run: getMyProfile },
  getMyWorkout: { label: 'current workout plan', run: getMyWorkout },
  getMyDiet: { label: 'current diet plan', run: getMyDiet },
  getMyCheckins: { label: 'weekly check-ins', run: getMyCheckins },
  getMyMeasurements: { label: 'measurements', run: getMyMeasurements },
  getMyAttendance: { label: 'attendance', run: getMyAttendance },
  getMyMembership: { label: 'membership and dues', run: getMyMembership },
  getMyPayments: { label: 'payments', run: getMyPayments },
  getMyBookings: { label: 'upcoming sessions', run: getMyBookings },
  getMyForms: { label: 'forms status', run: getMyForms },
};

/** Run one tool by name; unknown names and read failures are typed results. */
async function run(name, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, tool: name, message: 'Unknown tool.' };
  try {
    return { ok: true, tool: name, label: tool.label, data: await tool.run(ctx) };
  } catch {
    return { ok: false, tool: name, message: 'Could not read this right now.' };
  }
}

module.exports = { run, TOOLS };

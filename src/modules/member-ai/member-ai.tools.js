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
const read = require('./member-ai.read');

const num = (v) => (v == null || v === '' ? null : Number(v));
const ymd = (v) => (v == null ? null : String(v).slice(0, 10));

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

const TOOLS = {
  getMyProfile: { label: 'member profile', run: getMyProfile },
  getMyWorkout: { label: 'current workout plan', run: getMyWorkout },
  getMyDiet: { label: 'current diet plan', run: getMyDiet },
  getMyCheckins: { label: 'weekly check-ins', run: getMyCheckins },
  getMyMeasurements: { label: 'measurements', run: getMyMeasurements },
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

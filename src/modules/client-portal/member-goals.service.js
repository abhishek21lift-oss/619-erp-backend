'use strict';
// Member goals: targets a member sets for themselves, and the trainer's
// weight target shown beside them.
//
// ── Nothing here is stored that the records already say ────────────────────
//
// member_goals holds the target and the starting point. Where the member is
// now, how far they have come and when they will get there are computed from
// the logged records on every read (see migration 212), so a goal cannot
// drift from the sets, sessions and weigh-ins it is about.
//
// ── Projections are honest or absent ───────────────────────────────────────
//
// "You'll get there around 14 Dec" is a least-squares line through the
// member's own readings, and is only offered when there is enough of them and
// the line is heading the right way. Otherwise the projection is null and the
// app says what it needs ("two more weigh-ins"), never a guess.
//
// Same identity rule as the rest of client-portal: clientId/orgId are the
// session's, never the request's.

const pool = require('../../db/pool');
const { today } = require('../../lib/appTime');
const logger = require('../../lib/logger');
const { TRAINING_HAPPENED } = require('../pt-os/client-context');

class GoalInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const KINDS = ['weight', 'lift', 'sessions'];
const MAX_ACTIVE = 5;
const DAY_MS = 86_400_000;
const LIMITS = { weight: [25, 300], lift: [1, 500], sessions: [1, 1000] };

const ymd = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const dayNumber = (v) => Math.floor(new Date(`${ymd(v)}T00:00:00Z`).getTime() / DAY_MS);
const addDays = (v, n) => new Date(new Date(`${ymd(v)}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;

// ── The records a goal is measured against ─────────────────────────────────

/** Weight readings, oldest first: trainer measurements and check-in weigh-ins. */
async function weightSeries(clientId, orgId, db = pool) {
  const { rows } = await db.query(
    `SELECT d, kg FROM (
       SELECT measured_at::date AS d, weight_kg::float AS kg
         FROM pt_os_measurements
        WHERE client_id = $1 AND weight_kg IS NOT NULL
       UNION ALL
       SELECT week_start_date AS d, weight::float
         FROM weekly_checkins
        WHERE client_id = $1 AND organization_id = $2 AND weight IS NOT NULL
     ) m
     ORDER BY d ASC
     LIMIT 500`,
    [clientId, orgId],
  );
  // One reading per day; the later row of a day wins.
  const byDay = new Map();
  for (const r of rows) byDay.set(ymd(r.d), Number(r.kg));
  return [...byDay.entries()].map(([date, kg]) => ({ date, value: kg }));
}

/** Heaviest completed set per training day for one exercise, oldest first. */
async function liftSeries(clientId, orgId, exercise, db = pool) {
  const { rows } = await db.query(
    `SELECT ws.session_date AS d, MAX(s.weight_kg)::float AS kg
       FROM workout_sets s
       JOIN workout_session_exercises e ON e.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = e.session_id
      WHERE ws.client_id = $1 AND ws.organization_id = $2
        AND lower(btrim(e.exercise_name)) = lower(btrim($3))
        AND s.weight_kg > 0 AND s.completed IS NOT FALSE
      GROUP BY ws.session_date
      ORDER BY ws.session_date ASC`,
    [clientId, orgId, exercise],
  );
  return rows.map((r) => ({ date: ymd(r.d), value: Number(r.kg) }));
}

/** Days the member trained since `fromYmd` (inclusive), oldest first. */
async function trainingDaysSince(clientId, orgId, fromYmd, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT ws.session_date AS d
       FROM workout_sessions ws
      WHERE ws.client_id = $1 AND ws.organization_id = $2 AND ws.session_date >= $3
        AND ${TRAINING_HAPPENED}
      ORDER BY 1`,
    [clientId, orgId, fromYmd],
  );
  return rows.map((r) => ymd(r.d));
}

// ── Projection ─────────────────────────────────────────────────────────────

/** Least-squares slope (value per day) and intercept through the points. */
function fitLine(points) {
  const n = points.length;
  const xs = points.map((p) => dayNumber(p.date));
  const ys = points.map((p) => p.value);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, at: (d) => my + slope * (dayNumber(d) - mx) };
}

/**
 * When the trend reaches `target`, as 'YYYY-MM-DD', or null with the reason.
 * Uses the readings from the last `windowDays` so an old plateau does not
 * drown out what is happening now.
 */
function projectTrend(series, target, nowYmd, { windowDays = 90, minPoints = 3, minSpanDays = 10 } = {}) {
  const from = addDays(nowYmd, -windowDays);
  const recent = series.filter((p) => p.date >= from);
  if (recent.length < minPoints) return { eta: null, reason: 'more_data', needed: minPoints - recent.length };
  const span = dayNumber(recent[recent.length - 1].date) - dayNumber(recent[0].date);
  if (span < minSpanDays) return { eta: null, reason: 'more_time' };

  const line = fitLine(recent);
  if (!line) return { eta: null, reason: 'more_time' };
  const current = line.at(nowYmd);
  const remaining = target - current;
  if (Math.abs(remaining) < 1e-9) return { eta: nowYmd, reason: null, per_week: round1(line.slope * 7) };
  // Flat, or moving away from the target: no date to promise.
  if (line.slope === 0 || Math.sign(line.slope) !== Math.sign(remaining)) {
    return { eta: null, reason: 'off_trend', per_week: round1(line.slope * 7) };
  }
  const days = Math.ceil(remaining / line.slope);
  if (days > 3 * 365) return { eta: null, reason: 'far', per_week: round1(line.slope * 7) };
  return { eta: addDays(nowYmd, days), reason: null, per_week: round1(line.slope * 7) };
}

/** Sessions goal: the member's pace since the goal was set. */
function projectSessions(done, target, createdYmd, nowYmd) {
  const elapsed = Math.max(1, dayNumber(nowYmd) - dayNumber(createdYmd) + 1);
  if (done >= target) return { eta: nowYmd, reason: null, per_week: round1((done / elapsed) * 7) };
  if (elapsed < 7 && done < 2) return { eta: null, reason: 'more_time' };
  if (done === 0) return { eta: null, reason: 'off_trend', per_week: 0 };
  const perDay = done / elapsed;
  const days = Math.ceil((target - done) / perDay);
  if (days > 3 * 365) return { eta: null, reason: 'far', per_week: round1(perDay * 7) };
  return { eta: addDays(nowYmd, days), reason: null, per_week: round1(perDay * 7) };
}

function progressPct(start, current, target) {
  if (current === null || start === null) return null;
  if (target === start) return current === target ? 100 : 0;
  const pct = ((current - start) / (target - start)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

const reached = (kind, start, current, target) => {
  if (current === null) return false;
  if (kind === 'weight') return (start !== null && start > target) ? current <= target : current >= target;
  return current >= target;
};

/** Everything the app shows for one goal. */
async function evaluate(goal, clientId, orgId, nowYmd) {
  const kind = goal.kind;
  const target = Number(goal.target_value);
  const start = goal.start_value === null ? null : Number(goal.start_value);
  const createdYmd = ymd(goal.created_at);
  let current = null;
  let projection;
  let series = [];

  if (kind === 'weight') {
    series = await weightSeries(clientId, orgId);
    current = series.length ? series[series.length - 1].value : null;
    projection = projectTrend(series, target, nowYmd);
  } else if (kind === 'lift') {
    series = await liftSeries(clientId, orgId, goal.exercise_name);
    current = series.length ? Math.max(...series.map((p) => p.value)) : null;
    // A lift goal tracks the running best, so the trend is fitted to that.
    let best = -Infinity;
    const running = series.map((p) => { best = Math.max(best, p.value); return { date: p.date, value: best }; });
    projection = projectTrend(running, target, nowYmd, { windowDays: 120, minPoints: 3, minSpanDays: 14 });
  } else {
    const days = await trainingDaysSince(clientId, orgId, createdYmd);
    current = days.length;
    projection = projectSessions(current, target, createdYmd, nowYmd);
  }

  // The first reading after the goal was set stands in for a missing start.
  const effectiveStart = start ?? (kind === 'sessions' ? 0 : (series.find((p) => p.date >= createdYmd)?.value ?? null));
  const done = reached(kind, effectiveStart, current, target);

  let status = null;
  if (!done && projection.eta && goal.target_date) {
    status = projection.eta <= ymd(goal.target_date) ? 'on_track' : 'behind';
  }

  return {
    id: goal.id,
    kind,
    exercise_name: goal.exercise_name ?? null,
    start_value: effectiveStart,
    target_value: target,
    current_value: current === null ? null : round1(current),
    target_date: goal.target_date ? ymd(goal.target_date) : null,
    created_at: goal.created_at,
    achieved_at: goal.achieved_at ?? null,
    reached: done,
    progress_pct: done ? 100 : progressPct(effectiveStart, current, target),
    projection: done ? null : projection,
    status,
  };
}

// ── Reads and writes ───────────────────────────────────────────────────────

/** The trainer's active weight target, if they set one — shown read-only. */
async function studioGoal(clientId, orgId, nowYmd) {
  const { rows } = await pool.query(
    `SELECT id, goal_type, priority_goal, target_weight, target_date, starting_weight, created_at
       FROM pt_goals
      WHERE client_id = $1 AND organization_id = $2 AND is_active AND target_weight IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [clientId, orgId],
  );
  const g = rows[0];
  if (!g) return null;
  const evaluated = await evaluate({
    id: g.id, kind: 'weight', target_value: g.target_weight, start_value: g.starting_weight,
    target_date: g.target_date, created_at: g.created_at, achieved_at: null,
  }, clientId, orgId, nowYmd);
  return { ...evaluated, label: g.priority_goal || g.goal_type || null };
}

async function myGoals(clientId, orgId) {
  const nowYmd = today();
  const { rows } = await pool.query(
    `SELECT id, kind, exercise_name, start_value, target_value, target_date, achieved_at, created_at
       FROM member_goals
      WHERE client_id = $1 AND organization_id = $2 AND archived_at IS NULL
      ORDER BY achieved_at IS NOT NULL, created_at DESC
      LIMIT 20`,
    [clientId, orgId],
  );
  const goals = [];
  for (const g of rows) {
    const e = await evaluate(g, clientId, orgId, nowYmd);
    if (e.reached && !g.achieved_at) {
      e.achieved_at = await markAchieved(g, clientId, orgId);
      e.just_achieved = Boolean(e.achieved_at);
    }
    goals.push(e);
  }
  return { studio: await studioGoal(clientId, orgId, nowYmd), goals };
}

const goalLabel = (g) => (g.kind === 'weight' ? `reach ${Number(g.target_value)} kg`
  : g.kind === 'lift' ? `${g.exercise_name} ${Number(g.target_value)} kg`
    : `${Number(g.target_value)} sessions`);

/** Stamp the goal reached (once) and tell the trainer. Returns the timestamp. */
async function markAchieved(g, clientId, orgId) {
  const { rows } = await pool.query(
    `UPDATE member_goals SET achieved_at = NOW()
      WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND achieved_at IS NULL
      RETURNING achieved_at`,
    [g.id, clientId, orgId],
  );
  if (!rows[0]) return null;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT u.id, 'member_goal', COALESCE(c.name, 'A member') || ' reached a goal', $3,
              '/pt-os/clients/' || c.id
         FROM pt_clients c
         JOIN users u ON u.organization_id = c.organization_id AND u.role = 'trainer'
                     AND u.is_active = TRUE AND u.deleted_at IS NULL
        WHERE c.id = $1 AND c.organization_id = $2`,
      [clientId, orgId, `Goal: ${goalLabel(g)}.`],
    );
  } catch (err) {
    logger.warn({ err: err.message, clientId }, 'member goals: trainer notification failed');
  }
  return rows[0].achieved_at;
}

function normaliseGoal(body = {}, nowYmd) {
  const kind = String(body.kind || '');
  if (!KINDS.includes(kind)) throw new GoalInputError('Choose a goal type');

  const target = Number(body.target_value);
  const [min, max] = LIMITS[kind];
  if (!Number.isFinite(target) || target < min || target > max) {
    throw new GoalInputError(`Target must be between ${min} and ${max}`);
  }
  if (kind === 'sessions' && !Number.isInteger(target)) throw new GoalInputError('Sessions must be a whole number');

  let exercise = null;
  if (kind === 'lift') {
    exercise = String(body.exercise_name || '').trim().slice(0, 120);
    if (!exercise) throw new GoalInputError('Choose the exercise');
  }

  let targetDate = null;
  if (body.target_date) {
    targetDate = String(body.target_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || Number.isNaN(Date.parse(targetDate))) {
      throw new GoalInputError('Target date is not a date');
    }
    if (targetDate <= nowYmd) throw new GoalInputError('Target date must be in the future');
    if (targetDate > addDays(nowYmd, 3 * 365)) throw new GoalInputError('Target date must be within three years');
  }

  return { kind, target: Math.round(target * 10) / 10, exercise, targetDate };
}

async function createMyGoal(clientId, orgId, userId, body) {
  const nowYmd = today();
  const g = normaliseGoal(body, nowYmd);

  const { rows: count } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM member_goals
      WHERE client_id = $1 AND organization_id = $2 AND archived_at IS NULL AND achieved_at IS NULL`,
    [clientId, orgId],
  );
  if (count[0].n >= MAX_ACTIVE) {
    throw new GoalInputError(`You have ${MAX_ACTIVE} goals in progress — finish or remove one first.`, 409);
  }

  // Where they are starting from, so "how far you've come" means something.
  let start = null;
  if (g.kind === 'weight') {
    const s = await weightSeries(clientId, orgId);
    start = s.length ? s[s.length - 1].value : null;
    if (start !== null && Math.abs(start - g.target) < 0.1) throw new GoalInputError('That is your weight already — pick a new target.');
  } else if (g.kind === 'lift') {
    const s = await liftSeries(clientId, orgId, g.exercise);
    start = s.length ? Math.max(...s.map((p) => p.value)) : null;
    if (start !== null && start >= g.target) throw new GoalInputError(`You have already lifted ${start} kg — aim higher.`);
  } else {
    start = 0;
  }

  const { rows } = await pool.query(
    `INSERT INTO member_goals (organization_id, client_id, kind, exercise_name, start_value, target_value, target_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, kind, exercise_name, start_value, target_value, target_date, achieved_at, created_at`,
    [orgId, clientId, g.kind, g.exercise, start, g.target, g.targetDate, userId],
  );
  return evaluate(rows[0], clientId, orgId, nowYmd);
}

/** Remove a goal from the list. Kept in the table: reaching one is history. */
async function archiveMyGoal(clientId, orgId, goalId) {
  const { rowCount } = await pool.query(
    `UPDATE member_goals SET archived_at = NOW()
      WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND archived_at IS NULL`,
    [String(goalId), clientId, orgId],
  );
  return rowCount > 0;
}

module.exports = {
  GoalInputError,
  myGoals,
  createMyGoal,
  archiveMyGoal,
  // Shared with the monthly recap, and exported for tests.
  weightSeries,
  projectTrend,
  projectSessions,
  progressPct,
  normaliseGoal,
  fitLine,
};

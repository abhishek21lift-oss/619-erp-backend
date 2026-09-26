'use strict';
// The monthly recap: a member's month, told back to them.
//
// Every figure is counted from what was logged — sessions, sets, visits,
// weigh-ins, check-ins. A month with nothing logged says so; nothing is
// estimated to make a thin month look fuller.
//
// ── "Personal best" means beaten, not first ────────────────────────────────
//
// The workout log flags the first set ever logged for an exercise as a PR
// (there is nothing to beat). That is right for the log and wrong for a
// recap: "12 personal bests!" for a member's first month would be noise. The
// recap counts a PR only when the member had logged that exercise on an
// earlier day — a record they actually broke.
//
// Same identity rule as the rest of client-portal: clientId/orgId are the
// session's, never the request's.

const pool = require('../../db/pool');
const { today } = require('../../lib/appTime');
const { TRAINING_HAPPENED } = require('../pt-os/client-context');
const { weightSeries } = require('./member-goals.service');

class RecapInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** [first day, first day of next month) for 'YYYY-MM'. */
function monthRange(month) {
  const m = MONTH_RE.exec(month);
  if (!m) throw new RecapInputError('month must be YYYY-MM');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const start = `${m[1]}-${m[2]}-01`;
  const next = mo === 12 ? `${y + 1}-01-01` : `${m[1]}-${String(mo + 1).padStart(2, '0')}-01`;
  return { start, next };
}

function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Months with any training or visit, newest first (at most a year). */
async function recapMonths(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT to_char(d, 'YYYY-MM') AS month FROM (
       SELECT ws.session_date AS d FROM workout_sessions ws
        WHERE ws.client_id = $1 AND ws.organization_id = $2 AND ${TRAINING_HAPPENED}
       UNION ALL
       SELECT a.date FROM attendance_logs a
        WHERE a.ref_id = $1 AND a.ref_type = 'client' AND a.organization_id = $2
     ) x
     WHERE d IS NOT NULL AND d <= $3
     ORDER BY month DESC
     LIMIT 12`,
    [clientId, orgId, today()],
  );
  return rows.map((r) => r.month);
}

/** Sessions and lifting totals for one month. */
async function monthTotals(clientId, orgId, { start, next }) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM workout_sessions ws
         WHERE ws.client_id = $1 AND ws.organization_id = $2
           AND ws.session_date >= $3 AND ws.session_date < $4 AND ${TRAINING_HAPPENED}) AS sessions,
       (SELECT COUNT(DISTINCT ws.session_date)::int FROM workout_sessions ws
         WHERE ws.client_id = $1 AND ws.organization_id = $2
           AND ws.session_date >= $3 AND ws.session_date < $4 AND ${TRAINING_HAPPENED}) AS training_days,
       (SELECT COUNT(DISTINCT date_trunc('week', ws.session_date))::int FROM workout_sessions ws
         WHERE ws.client_id = $1 AND ws.organization_id = $2
           AND ws.session_date >= $3 AND ws.session_date < $4 AND ${TRAINING_HAPPENED}) AS active_weeks,
       (SELECT COUNT(*)::int FROM workout_sessions ws
         WHERE ws.client_id = $1 AND ws.organization_id = $2 AND ws.source = 'member'
           AND ws.session_date >= $3 AND ws.session_date < $4) AS self_logged,
       (SELECT COUNT(*)::int FROM attendance_logs a
         WHERE a.ref_id = $1 AND a.ref_type = 'client' AND a.organization_id = $2
           AND a.date >= $3 AND a.date < $4) AS visits,
       (SELECT COUNT(*)::int FROM weekly_checkins w
         WHERE w.client_id = $1 AND w.organization_id = $2
           AND w.week_start_date >= $3 AND w.week_start_date < $4) AS checkins,
       COUNT(s.id)::int AS sets,
       COALESCE(SUM(s.reps), 0)::int AS reps,
       COALESCE(SUM(s.weight_kg * s.reps), 0)::float AS volume_kg,
       COALESCE(SUM(s.duration_seconds), 0)::int AS cardio_seconds
     FROM workout_sessions ws
     JOIN workout_session_exercises e ON e.session_id = ws.id
     JOIN workout_sets s ON s.session_exercise_id = e.id AND s.completed IS NOT FALSE
    WHERE ws.client_id = $1 AND ws.organization_id = $2
      AND ws.session_date >= $3 AND ws.session_date < $4`,
    [clientId, orgId, start, next],
  );
  const r = rows[0];
  return {
    sessions: r.sessions,
    training_days: r.training_days,
    active_weeks: r.active_weeks,
    self_logged: r.self_logged,
    visits: r.visits,
    checkins: r.checkins,
    sets: r.sets,
    reps: r.reps,
    volume_kg: Math.round(Number(r.volume_kg) || 0),
    cardio_minutes: Math.round((r.cardio_seconds || 0) / 60),
  };
}

async function monthHighlights(clientId, orgId, { start, next }) {
  const [top, favourite, prs, days] = await Promise.all([
    // Heaviest completed set of the month.
    pool.query(
      `SELECT e.exercise_name AS exercise, s.weight_kg::float AS weight_kg, s.reps, ws.session_date AS date
         FROM workout_sets s
         JOIN workout_session_exercises e ON e.id = s.session_exercise_id
         JOIN workout_sessions ws ON ws.id = e.session_id
        WHERE ws.client_id = $1 AND ws.organization_id = $2
          AND ws.session_date >= $3 AND ws.session_date < $4
          AND s.weight_kg > 0 AND s.completed IS NOT FALSE
        ORDER BY s.weight_kg DESC, s.reps DESC NULLS LAST, ws.session_date
        LIMIT 1`,
      [clientId, orgId, start, next],
    ),
    // The exercise they did most — by sets.
    pool.query(
      `SELECT MIN(e.exercise_name) AS exercise, COUNT(*)::int AS sets
         FROM workout_sets s
         JOIN workout_session_exercises e ON e.id = s.session_exercise_id
         JOIN workout_sessions ws ON ws.id = e.session_id
        WHERE ws.client_id = $1 AND ws.organization_id = $2
          AND ws.session_date >= $3 AND ws.session_date < $4
          AND s.completed IS NOT FALSE AND e.exercise_name IS NOT NULL
        GROUP BY lower(btrim(e.exercise_name))
        ORDER BY COUNT(*) DESC, MIN(e.exercise_name)
        LIMIT 1`,
      [clientId, orgId, start, next],
    ),
    // Records broken: a PR set on an exercise already logged on an earlier day.
    // The best one per exercise, heaviest first.
    pool.query(
      `SELECT DISTINCT ON (lower(btrim(e.exercise_name)))
              e.exercise_name AS exercise, s.weight_kg::float AS weight_kg, s.reps, ws.session_date AS date,
              CASE WHEN s.is_pr_weight THEN 'weight' WHEN s.is_pr_reps THEN 'reps' ELSE 'volume' END AS kind
         FROM workout_sets s
         JOIN workout_session_exercises e ON e.id = s.session_exercise_id
         JOIN workout_sessions ws ON ws.id = e.session_id
        WHERE ws.client_id = $1 AND ws.organization_id = $2
          AND ws.session_date >= $3 AND ws.session_date < $4
          AND (s.is_pr_weight OR s.is_pr_reps OR s.is_pr_volume)
          AND EXISTS (
            SELECT 1
              FROM workout_sets ps
              JOIN workout_session_exercises pe ON pe.id = ps.session_exercise_id
              JOIN workout_sessions pws ON pws.id = pe.session_id
             WHERE pws.client_id = ws.client_id
               AND lower(btrim(pe.exercise_name)) = lower(btrim(e.exercise_name))
               AND pws.session_date < ws.session_date
               AND ps.completed IS NOT FALSE)
        ORDER BY lower(btrim(e.exercise_name)), s.weight_kg DESC NULLS LAST, s.reps DESC NULLS LAST`,
      [clientId, orgId, start, next],
    ),
    // Which weekdays they trained on (1 = Monday … 7 = Sunday).
    pool.query(
      `SELECT EXTRACT(ISODOW FROM ws.session_date)::int AS dow, COUNT(DISTINCT ws.session_date)::int AS n
         FROM workout_sessions ws
        WHERE ws.client_id = $1 AND ws.organization_id = $2
          AND ws.session_date >= $3 AND ws.session_date < $4 AND ${TRAINING_HAPPENED}
        GROUP BY 1`,
      [clientId, orgId, start, next],
    ),
  ]);

  const records = prs.rows
    .map((r) => ({ exercise: r.exercise, weight_kg: r.weight_kg, reps: r.reps, date: r.date, kind: r.kind }))
    .sort((a, b) => (b.weight_kg ?? 0) - (a.weight_kg ?? 0));

  const weekdays = Array(7).fill(0);
  for (const r of days.rows) weekdays[r.dow - 1] = r.n;

  return {
    top_lift: top.rows[0] ?? null,
    favourite: favourite.rows[0] ?? null,
    records,
    weekdays,
  };
}

/** First and last weigh-in inside the month, if there were two. */
async function monthWeight(clientId, orgId, { start, next }) {
  const inMonth = (await weightSeries(clientId, orgId)).filter((p) => p.date >= start && p.date < next);
  if (inMonth.length === 0) return null;
  const first = inMonth[0];
  const last = inMonth[inMonth.length - 1];
  return {
    readings: inMonth.length,
    start_kg: first.value,
    end_kg: last.value,
    change_kg: inMonth.length > 1 ? Math.round((last.value - first.value) * 10) / 10 : null,
  };
}

/** Who is being congratulated, and by which studio (for the share card). */
async function identity(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT c.name, o.name AS studio_name, o.logo_url AS studio_logo
       FROM pt_clients c
       LEFT JOIN organizations o ON o.id = c.organization_id
      WHERE c.id = $1 AND c.organization_id = $2`,
    [clientId, orgId],
  );
  const r = rows[0] || {};
  return {
    first_name: r.name ? String(r.name).trim().split(/\s+/)[0] : null,
    studio_name: r.studio_name ?? null,
    studio_logo: r.studio_logo ?? null,
  };
}

/**
 * One month's recap. `month` defaults to the latest month with activity, so
 * the app can open "your recap" without knowing which months exist.
 */
async function myRecap(clientId, orgId, month) {
  const months = await recapMonths(clientId, orgId);
  const current = today().slice(0, 7);
  const chosen = month ? String(month) : (months[0] ?? current);
  const range = monthRange(chosen);
  if (chosen > current) throw new RecapInputError('That month has not happened yet');

  const prevRange = monthRange(previousMonth(chosen));
  const [totals, previous, highlights, weight, who] = await Promise.all([
    monthTotals(clientId, orgId, range),
    monthTotals(clientId, orgId, prevRange),
    monthHighlights(clientId, orgId, range),
    monthWeight(clientId, orgId, range),
    identity(clientId, orgId),
  ]);

  return {
    month: chosen,
    months,
    in_progress: chosen === current,
    ...who,
    totals,
    previous: { sessions: previous.sessions, volume_kg: previous.volume_kg, training_days: previous.training_days },
    ...highlights,
    weight,
  };
}

module.exports = { RecapInputError, myRecap, recapMonths, monthRange, previousMonth };

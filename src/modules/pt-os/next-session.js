'use strict';

/**
 * The exact workout this client does next.
 *
 * ── What was missing ───────────────────────────────────────────────────────
 *
 * The generator learned which WEEK a client was in, which was enough to stop
 * it writing a second week-1 block over a client three weeks into their
 * first. It was not enough to answer the question a trainer actually has:
 * what is this person doing on Wednesday.
 *
 * That answer already existed, in one place — GET /workout-log/sessions/:id
 * resolves "planned for today" from the assignment, the weekday and
 * progression.resolveWeek. But it needs a session row to exist first. Before
 * anyone has created Wednesday's session there is nothing to ask, and the
 * generator, the client's profile and the adaptation logic all had no way to
 * name the next workout at all.
 *
 * So this resolves it from the programme rather than from a session row, and
 * it resolves it THROUGH resolveWeek — the same function the session detail
 * uses — so the prescription this reports and the prescription the trainer is
 * shown when they open the session cannot disagree. A second implementation
 * of "what does week 6 of this plan say" is exactly the kind of second truth
 * the context work exists to remove.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * It does not create anything, it does not decide anything, and it refuses
 * rather than guesses. Every state it cannot resolve is named — no programme,
 * a block that has run out, a plan with no days in it, a client who has
 * finished the week — because "no next session" and "we could not work out
 * the next session" are different facts and a screen that renders them the
 * same teaches a trainer to ignore both.
 */

const { weekOf, resolveWeek, MAX_WEEKS } = require('./progression');

/** Weekday names by day_of_week (1-7), matching workout-log.routes.js. */
const WEEKDAYS = Object.freeze([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]);

/** Why a next session could not be named. One per state, never a bare null. */
const UNRESOLVED = Object.freeze({
  NO_PROGRAMME: 'no_active_programme',
  EXPIRED: 'programme_expired',
  NO_DAYS: 'plan_prescribes_no_days',
  BLOCK_COMPLETE: 'block_complete',
});

const isoDay = (v) => {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
};

/** `days` after a YYYY-MM-DD, as a YYYY-MM-DD. */
function addDays(day, days) {
  const t = new Date(`${String(day).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return null;
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** The day_of_week (1-7) a weekday name refers to, or null. */
function dayNumberOf(name) {
  const i = WEEKDAYS.indexOf(String(name || '').trim());
  return i >= 0 ? i + 1 : null;
}

/**
 * The distinct days the plan prescribes, ascending.
 *
 * Across every week's rows, not just week 1: a trainer who adds a fourth day
 * in week 5 has changed the shape of the programme, and a resolver that only
 * looked at week 1 would keep sending the client home on Thursdays.
 */
function planDaysOf(rows = []) {
  const days = new Set();
  for (const r of rows) {
    const d = Math.floor(Number(r?.day_of_week));
    if (Number.isFinite(d) && d >= 1 && d <= 7) days.add(d);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Which programme day a completed session covered.
 *
 * `workout_day` is the weekday name the log stores. Sessions without one fall
 * back to the calendar weekday of the date they were logged on — a session
 * performed on a Wednesday covers the programme's Wednesday whether or not
 * anybody typed the word.
 */
function coveredDayOf(session) {
  const named = dayNumberOf(session?.workout_day);
  if (named) return named;
  const day = isoDay(session?.session_date);
  if (!day) return null;
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // getUTCDay() is 0=Sunday; the plan's day_of_week is 1=Monday.
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/**
 * The next workout in the programme the client is on.
 *
 * @param {object}   input
 * @param {object}   input.assignment  the CHOSEN active assignment — see
 *        assignments.js. Must carry start_date, plan_id and the plan's
 *        progression columns.
 * @param {object[]} input.planRows    every workout_exercises row for that
 *        plan, all days and all weeks.
 * @param {object[]} input.sessions    workout_sessions for this client, with
 *        status, session_date, workout_day and workout_assignment_id.
 * @param {string}   input.today       the studio's today, YYYY-MM-DD.
 * @param {boolean=} input.expired     whether the block has run out, as
 *        programState already decided it. Passed rather than recomputed so
 *        there is one answer to that question too.
 */
function nextSession({ assignment, planRows = [], sessions = [], today, expired = false } = {}) {
  if (!assignment) return { resolvable: false, reason: UNRESOLVED.NO_PROGRAMME };
  if (expired) return { resolvable: false, reason: UNRESOLVED.EXPIRED };

  const startedOn = isoDay(assignment.start_date);
  const days = planDaysOf(planRows);
  if (!days.length) {
    return {
      resolvable: false,
      reason: UNRESOLVED.NO_DAYS,
      plan_id: assignment.plan_id ?? assignment.workout_plan_id ?? null,
      plan_name: assignment.plan_name ?? null,
    };
  }

  const durationWeeks = Number(assignment.duration_weeks) || null;
  const week = startedOn && today ? weekOf(startedOn, today) : 1;

  // ── Which of this week's sessions are already done ──────────────────────
  //
  // A PROGRAMME week, not a calendar week: week 3 of a plan that started on a
  // Thursday runs Thursday to Wednesday. weekOf() counts in those blocks, so
  // counting completions in Monday-to-Sunday blocks instead would credit a
  // session to the wrong week for five plans out of seven.
  const weekStart = startedOn ? addDays(startedOn, (week - 1) * 7) : null;
  const weekEnd = weekStart ? addDays(weekStart, 6) : null;

  const doneThisWeek = new Set();
  for (const s of sessions) {
    if (s?.status !== 'completed') continue;
    // Attributed sessions only, when the log holds an attribution. A session
    // logged against a DIFFERENT plan is not this plan's Wednesday, and
    // counting it would tell the trainer the client had already trained.
    if (s.workout_assignment_id && assignment.id
      && String(s.workout_assignment_id) !== String(assignment.id)) continue;
    const on = isoDay(s.session_date);
    if (!on || !weekStart || on < weekStart || on > weekEnd) continue;
    const d = coveredDayOf(s);
    if (d) doneThisWeek.add(d);
  }

  // The plan's own day order decides what comes next: the first prescribed day
  // this week that has not been trained. Not "the day nearest today" — a
  // client who missed Monday and opens this on Wednesday is owed Monday's
  // session, and skipping to Wednesday's would quietly drop a workout out of
  // the block.
  let targetWeek = week;
  let targetDay = days.find((d) => !doneThisWeek.has(d)) ?? null;
  let rollover = false;

  if (targetDay === null) {
    // Every prescribed day of this week is done. The next one is the first day
    // of next week — unless there is no next week.
    targetWeek = week + 1;
    rollover = true;
    if ((durationWeeks && targetWeek > durationWeeks) || targetWeek > MAX_WEEKS) {
      return {
        resolvable: false,
        reason: UNRESOLVED.BLOCK_COMPLETE,
        plan_id: assignment.plan_id ?? assignment.workout_plan_id ?? null,
        plan_name: assignment.plan_name ?? null,
        week,
        duration_weeks: durationWeeks,
      };
    }
    [targetDay] = days;
  }

  // ── The prescription itself ─────────────────────────────────────────────
  //
  // Through resolveWeek, so an edited week wins over the progression rule
  // exactly as it does in the session log, and `source` says which of the two
  // the trainer is looking at: a derived number is the rule's suggestion, a
  // written one is their own instruction.
  const dayRows = planRows.filter((r) => Math.floor(Number(r.day_of_week)) === targetDay);
  const resolved = resolveWeek(dayRows, assignment, targetWeek);

  return {
    resolvable: true,
    reason: null,
    assignment_id: assignment.id ?? null,
    plan_id: assignment.plan_id ?? assignment.workout_plan_id ?? null,
    plan_name: assignment.plan_name ?? null,
    week: targetWeek,
    duration_weeks: durationWeeks,
    day_of_week: targetDay,
    day: WEEKDAYS[targetDay - 1],
    // 'override' means a trainer wrote this week by hand; 'derived' means it
    // is week 1 plus the progression rule.
    source: resolved.source,
    anchor_week: resolved.anchor_week,
    // True when this week's prescribed days are all done and the next session
    // opens the following week. Without it a screen cannot tell "your next
    // session is Monday" from "you have finished this week, next is Monday".
    starts_next_week: rollover,
    planned_days: days.map((d) => WEEKDAYS[d - 1]),
    completed_days_this_week: [...doneThisWeek].sort((a, b) => a - b).map((d) => WEEKDAYS[d - 1]),
    week_starts_on: weekStart,
    exercises: resolved.exercises.map((e) => ({
      exercise_id: e.exercise_id ?? null,
      name: e.name ?? null,
      sort_order: e.sort_order ?? null,
      sets: e.sets ?? null,
      reps: e.reps ?? null,
      target_weight: e.target_weight ?? null,
      rpe: e.rpe ?? null,
      rest_seconds: e.rest_seconds ?? null,
      tempo: e.tempo ?? null,
      progression_steps: e.progression_steps ?? 0,
    })),
  };
}

/**
 * The next session, as the model is allowed to read it.
 *
 * Printed as a prescription rather than as prose, because the adaptation
 * instruction that follows it refers to these numbers and a model that has to
 * infer them from a sentence will round them.
 */
function describeNextSession(next) {
  if (!next) return '';
  if (!next.resolvable) {
    const WHY = {
      [UNRESOLVED.NO_PROGRAMME]: 'This client is not on a programme, so there is no next session to continue from.',
      [UNRESOLVED.EXPIRED]: 'The client\'s last programme has run out. There is no next session in it — they need the next block.',
      [UNRESOLVED.NO_DAYS]: 'The assigned plan prescribes no training days, so its next session cannot be resolved. Do not guess what it would have said.',
      [UNRESOLVED.BLOCK_COMPLETE]: 'The client has completed every prescribed session of this block. There is no next session in it.',
    };
    return ['THE NEXT SESSION IN THE CURRENT PROGRAMME:', `- ${WHY[next.reason] ?? 'Could not be resolved.'}`].join('\n');
  }

  const L = ['THE NEXT SESSION IN THE CURRENT PROGRAMME:'];
  L.push(`- ${next.plan_name || 'The current plan'}, week ${next.week}`
    + (next.duration_weeks ? ` of ${next.duration_weeks}` : '')
    + `, ${next.day}.`
    + (next.starts_next_week ? ' Every prescribed day of the current week is already done, so this opens the following week.' : ''));
  L.push(`- Prescribed days: ${next.planned_days.join(', ')}.`
    + (next.completed_days_this_week.length
      ? ` Completed this week: ${next.completed_days_this_week.join(', ')}.`
      : ' None completed this week yet.'));
  L.push(next.source === 'override'
    ? '- This week was written by the trainer by hand. Its numbers are an instruction, not a suggestion.'
    : `- These numbers are week ${next.anchor_week} plus the plan's progression rule.`);
  if (!next.exercises.length) {
    L.push('- The plan prescribes no exercises for that day.');
    return L.join('\n');
  }
  for (const e of next.exercises) {
    L.push(`  · ${e.name || 'Unnamed exercise'}`
      + (e.sets !== null ? `: ${e.sets} sets` : ':')
      + (e.reps !== null ? ` x ${e.reps}` : '')
      + (e.target_weight !== null ? ` @ ${e.target_weight} kg` : '')
      + (e.rpe !== null ? `, RPE ${e.rpe}` : '')
      + (e.rest_seconds !== null ? `, ${e.rest_seconds}s rest` : ''));
  }
  return L.join('\n');
}

module.exports = {
  nextSession, describeNextSession, UNRESOLVED, WEEKDAYS,
  // Exported for the tests that pin the parts rather than the whole.
  planDaysOf, coveredDayOf, dayNumberOf, addDays,
};

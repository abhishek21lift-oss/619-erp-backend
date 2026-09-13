'use strict';
// What the programme we proposed actually did, once the client trained it.
//
// ── The half of the loop that was missing ──────────────────────────────────
//
// Stage 5 taught the engine what the TRAINER does with a proposal: what they
// keep, what they remove, how often they save one at all. That is a real
// signal and it is only half a loop. It closes at the moment the trainer
// clicks save, and everything that matters happens after that.
//
// So the engine could not tell these two apart:
//
//   · a plan the trainer accepted and the client trained for six weeks,
//     adding 7.5 kg to their squat;
//   · a plan the trainer accepted and the client never trained once.
//
// Both read as "accepted" and both fed the next generation as a success. That
// is the difference between a system that learns and a system that counts
// clicks, and it is the property the brief called for: every completed session
// and outcome should be able to improve the next programming decision.
//
// ── What this file is, and is not ──────────────────────────────────────────
//
// It is pure arithmetic over rows that have already been fetched — no pool, no
// SQL, no clock of its own. Every threshold below is named and stated, and
// every verdict carries the numbers it was reached from, because a verdict a
// trainer cannot check is a verdict they cannot overrule.
//
// It DECIDES NOTHING. Nothing here writes, nothing here changes a plan, and
// nothing here is fed to the safety screen. An outcome is evidence offered to
// the next generation and to the trainer; the trainer remains the gate.
//
// ── Attribution, and its honest limit ──────────────────────────────────────
//
// A logged session attributes to a plan through workout_sessions
// .workout_assignment_id. That link is exact when it is there, and there is no
// second-best: matching on workout_sessions.program_name — a free-text field
// holding 25 distinct strings across 84 rows in production — would let one
// client's "Upper/Lower" absorb another's, and a wrong outcome is worse than a
// missing one because it teaches the engine the opposite of the truth.
//
// So a plan with no assignment is reported as `unmeasurable` with the reason
// said out loud, never as "no progress". Measured before this was written: of
// 34 clients, 29 had no active assignment at all and four had between four and
// seven, so exactly one client on the roster had the single active assignment
// that the session log auto-links to. Attribution is thin here, and this file
// says so rather than papering over it.

const { exerciseTrend, MIN_SESSIONS_FOR_TREND } = require('./training-history');
const { normaliseName } = require('./plan-critic');

/**
 * Days a plan must have been live before its outcome means anything.
 *
 * Fourteen. A client training three times a week has had six sessions by then,
 * which is the first point at which "they are not training this" is a finding
 * about the plan rather than about the fortnight it landed in.
 */
const MIN_DAYS_FOR_OUTCOME = 14;

/** Verdicts, and the order the rules below reach them in. */
const VERDICTS = Object.freeze({
  UNMEASURABLE: 'unmeasurable',
  TOO_EARLY: 'too_early',
  NOT_TAKEN_UP: 'not_taken_up',
  NO_TREND_YET: 'no_trend_yet',
  REGRESSING: 'regressing',
  PROGRESSING: 'progressing',
  FLAT: 'flat',
});

const day = (v) => {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
};

function daysBetween(from, to) {
  const a = new Date(`${day(from)}T00:00:00Z`).getTime();
  const b = new Date(`${day(to)}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * What one accepted proposal produced.
 *
 * @param {object}   input
 * @param {object}   input.generation  the accepted row: id, accepted_at,
 *                                     assignment_id, sessions_per_week,
 *                                     duration_weeks, plan_exercise_names
 * @param {Array=}   input.sessions    sessions against that assignment, from
 *                                     the acceptance date onward
 * @param {Array=}   input.sets        sets logged in those sessions
 * @param {string}   input.today       studio's today, YYYY-MM-DD
 */
function outcomeOf({ generation, sessions = [], sets = [], today } = {}) {
  const g = generation || {};
  const acceptedOn = day(g.accepted_at);
  const daysLive = acceptedOn && today ? daysBetween(acceptedOn, today) : null;
  const weeksLive = daysLive === null ? null : Math.floor(daysLive / 7);

  const unmeasured = [];

  // ── Did the client train it? ────────────────────────────────────────────
  const completed = sessions.filter((s) => s?.status === 'completed').length;
  const started = sessions.length;

  // Expected sessions is capped at the block's own length: a six-week plan
  // still live at week ten is not eight weeks behind, it is finished.
  const perWeek = int(g.sessions_per_week);
  const blockWeeks = int(g.duration_weeks);
  const weeksCounted = weeksLive === null ? null
    : blockWeeks ? Math.min(weeksLive, blockWeeks) : weeksLive;
  const expected = perWeek && weeksCounted ? perWeek * weeksCounted : null;
  if (!perWeek) unmeasured.push({ what: 'adherence', reason: 'the plan names no weekly frequency' });

  const adherencePct = expected ? Math.round((completed / expected) * 100) : null;

  // ── Did the lifts it prescribed move? ───────────────────────────────────
  //
  // Only the plan's OWN exercises. A session logged against this assignment
  // may hold anything the trainer added on the day, and crediting the plan
  // with a lift it never prescribed would be flattering it with somebody
  // else's work.
  const prescribed = new Set(
    (g.plan_exercise_names || []).map(normaliseName).filter(Boolean),
  );

  const byLift = new Map();
  let offPlanSets = 0;
  for (const s of sets) {
    const key = normaliseName(s?.exercise_name);
    if (!key) continue;
    if (!prescribed.has(key)) { offPlanSets += 1; continue; }
    if (!byLift.has(key)) byLift.set(key, { name: s.exercise_name, rows: [] });
    byLift.get(key).rows.push(s);
  }

  const lifts = [...byLift.values()]
    .map(({ name, rows }) => {
      const t = exerciseTrend(rows);
      return {
        exercise: name,
        sessions: t.sessions,
        trend: t.trend,
        change_pct: t.change_pct,
        latest_e1rm_kg: t.latest_e1rm_kg,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || a.exercise.localeCompare(b.exercise));

  const named = (trend) => lifts.filter((l) => l.trend === trend).map((l) => l.exercise);
  const progressing = named('progressing');
  const regressing = named('regressing');
  const plateaued = named('plateaued');
  const withTrend = progressing.length + regressing.length + plateaued.length;

  if (lifts.length && !withTrend) {
    unmeasured.push({
      what: 'progression',
      reason: `no prescribed lift has ${MIN_SESSIONS_FOR_TREND} logged sessions yet`,
    });
  }

  // ── The verdict ─────────────────────────────────────────────────────────
  //
  // Ordered so that the cheapest, most certain answer wins. Nothing below
  // reaches a progression verdict without a lift that actually has a trend.
  let verdict;
  let because;

  if (!g.assignment_id) {
    verdict = VERDICTS.UNMEASURABLE;
    because = 'this plan was never assigned, so no logged session points at it';
    unmeasured.push({ what: 'everything', reason: 'the plan has no assignment to attribute sessions to' });
  } else if (daysLive === null) {
    verdict = VERDICTS.UNMEASURABLE;
    because = 'the acceptance date is missing, so nothing can be measured from it';
    unmeasured.push({ what: 'everything', reason: 'no acceptance date on the proposal' });
  } else if (daysLive < MIN_DAYS_FOR_OUTCOME) {
    verdict = VERDICTS.TOO_EARLY;
    because = `accepted ${daysLive} day${daysLive === 1 ? '' : 's'} ago;`
      + ` ${MIN_DAYS_FOR_OUTCOME} is the earliest this says anything`;
  } else if (completed === 0) {
    // The most valuable verdict this file produces, and the one nothing in the
    // system could reach before it existed.
    verdict = VERDICTS.NOT_TAKEN_UP;
    because = started
      ? `${started} session${started === 1 ? '' : 's'} started and none completed in ${daysLive} days`
      : `no session logged against it in ${daysLive} days`;
  } else if (!withTrend) {
    verdict = VERDICTS.NO_TREND_YET;
    because = `${completed} session${completed === 1 ? '' : 's'} completed`
      + `${adherencePct === null ? '' : ` (${adherencePct}% of the ${expected} the plan asks for)`}`
      + `, but no prescribed lift has ${MIN_SESSIONS_FOR_TREND} sessions yet`;
  } else if (regressing.length > progressing.length) {
    verdict = VERDICTS.REGRESSING;
    because = `going backwards on ${regressing.join(', ')} over ${completed} completed sessions`;
  } else if (progressing.length) {
    verdict = VERDICTS.PROGRESSING;
    because = `up on ${progressing.join(', ')} over ${completed} completed sessions`;
  } else {
    verdict = VERDICTS.FLAT;
    because = `${withTrend} prescribed lift${withTrend === 1 ? '' : 's'} measured and none moved`
      + ` over ${completed} completed sessions`;
  }

  return {
    generation_id: g.id ?? null,
    plan_id: g.accepted_plan_id ?? null,
    accepted_on: acceptedOn,
    days_live: daysLive,
    weeks_live: weeksLive,
    attributable: Boolean(g.assignment_id),
    sessions_started: started,
    sessions_completed: completed,
    sessions_expected: expected,
    adherence_pct: adherencePct,
    lifts,
    progressing,
    regressing,
    plateaued,
    // Sets logged against this plan for something it never prescribed. Not a
    // fault — a trainer adapts on the day — but a plan whose sessions are
    // mostly off-plan is one the outcome below describes only loosely.
    off_plan_sets: offPlanSets,
    verdict,
    because,
    unmeasured,
  };
}

/**
 * Every accepted proposal's outcome, as one record the next generation can read.
 *
 * `rows` are outcomeOf() outputs, newest first. The counts are what they say:
 * a verdict is counted once, and `decisive` is the most recent outcome that
 * actually measured something — the one worth putting in front of the model.
 */
function summariseOutcomes(rows = []) {
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  const measured = rows.filter(
    (r) => r.verdict !== VERDICTS.UNMEASURABLE && r.verdict !== VERDICTS.TOO_EARLY,
  );

  return {
    accepted: rows.length,
    // Proposals a trainer saved and nothing can say anything about, because
    // the plan was never assigned. Counted separately and loudly: on this
    // studio's data it is the expected case, and a summary that folded it into
    // "no result" would read as a verdict about the training.
    unmeasurable: counts[VERDICTS.UNMEASURABLE] || 0,
    too_early: counts[VERDICTS.TOO_EARLY] || 0,
    not_taken_up: counts[VERDICTS.NOT_TAKEN_UP] || 0,
    no_trend_yet: counts[VERDICTS.NO_TREND_YET] || 0,
    progressing: counts[VERDICTS.PROGRESSING] || 0,
    flat: counts[VERDICTS.FLAT] || 0,
    regressing: counts[VERDICTS.REGRESSING] || 0,
    measured: measured.length,
    decisive: measured[0] || null,
    has_outcomes: measured.length > 0,
  };
}

/**
 * The outcomes, as lines the generator can read.
 *
 * Written as evidence about the LAST programme, never as an instruction about
 * the next one — the model is told what happened and left to reason, because a
 * line that says "so do X" is a rule, and rules in this engine are
 * deterministic and live in programming-rules.js.
 */
function describeOutcomes(summary) {
  if (!summary || !summary.accepted) return '';
  const L = ['WHAT HAPPENED TO THE PROGRAMMES THIS CLIENT WAS ACTUALLY GIVEN:'];

  if (!summary.has_outcomes) {
    // Said plainly rather than omitted. "No outcome section" and "we have
    // given this client programmes and can measure none of them" are
    // different facts, and only one of them should change how the model writes.
    L.push(`- ${summary.accepted} proposal${summary.accepted === 1 ? ' was' : 's were'} saved,`
      + ` and none can be assessed yet`
      + `${summary.unmeasurable ? ` (${summary.unmeasurable} never assigned, so no session points at them)` : ''}`
      + `${summary.too_early ? ` (${summary.too_early} too recent)` : ''}.`);
    L.push('- Treat this client as having no programme history. Do not infer that'
      + ' previous plans worked or failed.');
    return L.join('\n');
  }

  const d = summary.decisive;
  if (d.verdict === VERDICTS.NOT_TAKEN_UP) {
    L.push(`- The last programme they were given was NOT TRAINED: ${d.because}.`);
    L.push('- A plan the client does not do is not a plan. Weigh how demanding'
      + ' this one is — days per week, session length, equipment — against that.');
  } else if (d.verdict === VERDICTS.REGRESSING) {
    L.push(`- The last measurable programme went BACKWARDS: ${d.because}.`);
  } else if (d.verdict === VERDICTS.PROGRESSING) {
    L.push(`- The last measurable programme WORKED: ${d.because}.`);
    L.push('- What worked is evidence, not a template. Keep what the data supports.');
  } else if (d.verdict === VERDICTS.FLAT) {
    L.push(`- The last measurable programme produced NO CHANGE: ${d.because}.`);
  } else {
    L.push(`- The last programme is being trained but has no trend yet: ${d.because}.`);
  }

  if (d.adherence_pct !== null) {
    L.push(`- Adherence to it: ${d.sessions_completed} of ${d.sessions_expected}`
      + ` prescribed sessions (${d.adherence_pct}%).`);
  }
  if (d.off_plan_sets) {
    L.push(`- ${d.off_plan_sets} logged sets were for exercises that plan did not`
      + ' prescribe, so the trainer was adapting it on the day.');
  }
  if (summary.not_taken_up > 1) {
    L.push(`- ${summary.not_taken_up} of this client's saved programmes were never trained at all.`);
  }

  L.push(`- Based on ${summary.measured} measurable programme${summary.measured === 1 ? '' : 's'}`
    + ` out of ${summary.accepted} saved. This is history, not a rule: the safety`
    + ' screen and the client\'s current data still decide what is allowed.');

  return L.join('\n');
}

module.exports = {
  outcomeOf,
  summariseOutcomes,
  describeOutcomes,
  VERDICTS,
  MIN_DAYS_FOR_OUTCOME,
};

// What the client has actually DONE, turned into evidence a programme can be
// argued from.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Every set this studio has ever logged is in workout_sets — weight, reps,
// RPE, RIR, whether it was completed, whether it was a PR. 520 of them, across
// 129 sessions. Two things read that table today: the PR badge on a set row,
// and the workout-log screen that shows you the session you are already
// looking at.
//
// Nothing reads it to answer the only question programming actually asks:
// what happened last time, and what should change because of it. So the AI
// workout generator — the feature whose whole job is that question — was
// writing programmes from a client's age, goal and equipment, with no idea
// whether they had squatted 60kg or 160kg last week, or turned up at all.
//
// This file is the missing half. It is pure arithmetic over rows the caller
// fetched: no database, no model, no opinions that cannot be checked. The SQL
// lives with the repository, exactly as progression.js and recovery.js split.
//
// ── The discipline it inherits ─────────────────────────────────────────────
//
// recovery.js refuses to return a score from fewer than two answers, because
// one opinion is a mood. The same rule runs through here, and it matters more:
// a programming engine that says "plateaued, deload" off two sessions will be
// confidently wrong at a client's expense, and a trainer reading a tidy number
// has no way to tell it apart from a real one.
//
// So every claim below carries the sample it was computed from, every
// threshold is a stated constant rather than a magic number inside a formula,
// and anything under its minimum returns null — never a default, never a zero
// standing in for "we do not know".

/** A lift needs this many separate sessions before its direction is a trend. */
const MIN_SESSIONS_FOR_TREND = 3;

/** …and a week needs this many logged sets before its volume means anything. */
const MIN_SETS_FOR_WEEK = 3;

/**
 * Reps above which a one-rep-max estimate stops being an estimate.
 *
 * Epley and its siblings are fitted to low-rep work. At 20 reps the formula
 * will still return a number, and that number is fiction — it says a 20-rep
 * set of 40kg is a 93kg single, which no coach believes. Sets above this are
 * excluded from strength trends and counted only as volume.
 */
const MAX_REPS_FOR_E1RM = 12;

/**
 * How much an estimated 1RM must move to count as a change.
 *
 * Session-to-session e1RM wobbles with sleep, bar speed, how honest the RIR
 * was and whether the plates were accurate. 2.5% is roughly the smallest step
 * a trainer could act on, and it is also about one plate jump on most lifts.
 */
const MEANINGFUL_E1RM_PCT = 2.5;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Clamp a 1–10 self-report; anything off the scale is treated as absent. */
const scale10 = (v) => {
  const n = num(v);
  return n !== null && n >= 1 && n <= 10 ? n : null;
};

const isoDay = (d) => (d ? String(d).slice(0, 10) : null);

/**
 * Estimated one-rep max, Epley.
 *
 *   e1RM = w × (1 + reps/30)
 *
 * Returned as a number or null — never a guess. A bodyweight set (no load) has
 * no e1RM and says so, rather than reporting zero and dragging every average
 * it touches toward the floor.
 */
function estimate1RM(weightKg, reps) {
  const w = num(weightKg);
  const r = num(reps);
  if (w === null || r === null) return null;
  if (w <= 0 || r <= 0 || r > MAX_REPS_FOR_E1RM) return null;
  return Math.round(w * (1 + r / 30) * 10) / 10;
}

/** Load moved by one set. Bodyweight sets contribute reps but no tonnage. */
function setVolume(set) {
  const w = num(set?.weight_kg);
  const r = num(set?.reps);
  if (r === null || r <= 0) return 0;
  return w !== null && w > 0 ? w * r : 0;
}

/**
 * The ISO week a date belongs to, as `YYYY-Www`.
 *
 * Weeks rather than raw dates because that is the unit training is planned in,
 * and because a client who trains Monday one week and Tuesday the next has not
 * changed anything that matters.
 */
function isoWeek(dateStr) {
  const d = new Date(`${isoDay(dateStr)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Thursday of this week decides the year — the ISO rule.
  const target = new Date(d);
  target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7),
  );
  const week = 1 + Math.round((target - firstThursday) / (7 * 86400000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * One exercise's history, newest session first.
 *
 * `rows` are completed sets for a single exercise, each carrying a
 * session_date. The result reports the best estimated 1RM per session — the
 * top set, not the average, because the top set is what the next prescription
 * is written against.
 *
 * `trend` is null below MIN_SESSIONS_FOR_TREND. That is the honest answer for
 * a lift somebody has done twice, and it is the answer a "progressing /
 * plateaued" verdict would otherwise paper over.
 */
function exerciseTrend(rows = []) {
  const bySession = new Map();
  let totalSets = 0;
  let totalVolume = 0;
  let repsOnly = 0;

  for (const r of rows) {
    const day = isoDay(r.session_date);
    if (!day) continue;
    totalSets += 1;
    totalVolume += setVolume(r);
    const e = estimate1RM(r.weight_kg, r.reps);
    if (e === null) { repsOnly += 1; continue; }
    const prev = bySession.get(day);
    if (prev === undefined || e > prev) bySession.set(day, e);
  }

  const points = [...bySession.entries()]
    .map(([date, e1rm]) => ({ date, e1rm }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const best = points.length ? Math.max(...points.map((p) => p.e1rm)) : null;
  const latest = points.length ? points[points.length - 1] : null;

  let trend = null;
  let changePct = null;
  if (points.length >= MIN_SESSIONS_FOR_TREND) {
    // First versus last of the window, not a regression line: a trainer can
    // check this by looking at two numbers, and a slope they cannot verify is
    // a slope they cannot argue with.
    const first = points[0].e1rm;
    const last = points[points.length - 1].e1rm;
    changePct = first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : null;
    if (changePct === null) trend = null;
    else if (changePct >= MEANINGFUL_E1RM_PCT) trend = 'progressing';
    else if (changePct <= -MEANINGFUL_E1RM_PCT) trend = 'regressing';
    else trend = 'plateaued';
  }

  return {
    sessions: points.length,
    sets: totalSets,
    // Sets with reps but no load — bodyweight, machines a studio does not
    // weight, cardio logged as reps. Reported so "no strength trend" can be
    // told apart from "no data".
    sets_without_load: repsOnly,
    total_volume_kg: Math.round(totalVolume),
    best_e1rm_kg: best,
    latest_e1rm_kg: latest?.e1rm ?? null,
    last_performed: latest?.date ?? null,
    change_pct: changePct,
    trend,
    points,
  };
}

/**
 * Weekly training volume, oldest week first.
 *
 * Tonnage AND hard set count, because they answer different questions: a week
 * can lose tonnage while adding sets (lighter, higher-rep work) and that is
 * not a drop in training stress. A week under MIN_SETS_FOR_WEEK is reported
 * with its counts but flagged `sparse`, so a single make-up session cannot
 * read as a training week.
 */
function weeklyVolume(rows = []) {
  const byWeek = new Map();
  for (const r of rows) {
    const wk = isoWeek(r.session_date);
    if (!wk) continue;
    const cur = byWeek.get(wk) || { week: wk, sets: 0, volume_kg: 0, sessions: new Set(), rpe: [] };
    cur.sets += 1;
    cur.volume_kg += setVolume(r);
    cur.sessions.add(isoDay(r.session_date));
    const rpe = scale10(r.rpe);
    if (rpe !== null) cur.rpe.push(rpe);
    byWeek.set(wk, cur);
  }
  return [...byWeek.values()]
    .map((w) => ({
      week: w.week,
      sets: w.sets,
      sessions: w.sessions.size,
      volume_kg: Math.round(w.volume_kg),
      mean_rpe: w.rpe.length ? Math.round((w.rpe.reduce((a, b) => a + b, 0) / w.rpe.length) * 10) / 10 : null,
      sparse: w.sets < MIN_SETS_FOR_WEEK,
    }))
    .sort((a, b) => (a.week < b.week ? -1 : 1));
}

/**
 * Did the work that was prescribed actually happen?
 *
 * The closed loop's other half. `prescribed` and `completed` are session
 * counts over the same window, taken from the assignment and from
 * workout_sessions respectively.
 *
 * Returns null rather than 0% when nothing was prescribed: a client with no
 * programme has not failed to adhere to it, and 0% on that card would be a
 * trainer's problem reported as a client's.
 */
function adherence({ prescribed, completed, missed } = {}) {
  const p = num(prescribed);
  const c = num(completed);
  if (p === null || p <= 0) {
    return { pct: null, prescribed: p ?? null, completed: c ?? null, missed: num(missed) };
  }
  const done = Math.max(0, c ?? 0);
  return {
    pct: Math.round(Math.min(done / p, 1) * 100),
    prescribed: p,
    completed: done,
    missed: num(missed) ?? Math.max(0, p - done),
  };
}

/**
 * Is effort climbing while output is not?
 *
 * The signature of accumulated fatigue: same or less weight on the bar, higher
 * RPE to move it. Neither half is meaningful alone — a rising RPE on rising
 * loads is just a client getting closer to their limit, which is the point of
 * a training block.
 *
 * Needs MIN_SESSIONS_FOR_TREND scored weeks on both sides, and says so.
 */
function fatigueSignal(weeks = []) {
  const scored = weeks.filter((w) => w.mean_rpe !== null && !w.sparse);
  if (scored.length < MIN_SESSIONS_FOR_TREND) {
    // ── Why this is the normal case, not the edge case ────────────────────
    //
    // This signal is built on RPE, and production holds an RPE value on 4 of
    // 520 sets. The workout log has the field; trainers do not fill it in.
    //
    // So the honest answer here is null almost always, and the reason says
    // which of the two situations it is — no weeks at all, or weeks with no
    // effort scores in them. A default of "none" would read as "checked, and
    // this client is fresh", which is a claim nobody made. The layer above
    // must be able to tell the difference, because "we cannot see fatigue"
    // and "there is no fatigue" lead to opposite programming decisions.
    const dense = weeks.filter((w) => !w.sparse);
    return {
      flag: null,
      weeks_compared: scored.length,
      reason: dense.length < MIN_SESSIONS_FOR_TREND
        ? 'not enough training weeks logged'
        : 'no RPE recorded — effort is not being captured',
      rpe_coverage_weeks: scored.length,
      observed_weeks: dense.length,
    };
  }
  const half = Math.floor(scored.length / 2);
  const early = scored.slice(0, half);
  const late = scored.slice(-half);
  const mean = (xs, k) => xs.reduce((s, x) => s + x[k], 0) / xs.length;

  const rpeDelta = Math.round((mean(late, 'mean_rpe') - mean(early, 'mean_rpe')) * 10) / 10;
  const volEarly = mean(early, 'volume_kg');
  const volLate = mean(late, 'volume_kg');
  const volDeltaPct = volEarly > 0 ? Math.round(((volLate - volEarly) / volEarly) * 1000) / 10 : null;

  // Effort up by a full RPE point while tonnage is flat or falling.
  const flag = rpeDelta >= 1 && (volDeltaPct === null || volDeltaPct <= 0) ? 'accumulating' : 'none';
  return { flag, weeks_compared: scored.length, rpe_delta: rpeDelta, volume_delta_pct: volDeltaPct };
}

/**
 * The whole picture, from rows the caller fetched.
 *
 * `sets` are completed sets joined to their exercise name and session date.
 * `assignment` supplies the prescribed session count for the window.
 *
 * Every section reports its own sample size. A caller — or a model being
 * handed this as context — can therefore tell "this client is plateaued on
 * bench" from "this client has benched twice", which is the distinction that
 * makes the difference between a programme and a guess.
 */
function buildTrainingHistory({ sets = [], assignment = null, windowWeeks = 12 } = {}) {
  // ── The split that everything below depends on ──────────────────────────
  //
  // workout_sets holds BOTH halves of the loop. A row written when the
  // trainer laid the session out is the prescription; the same row with
  // `completed` true and a load on it is what happened. Production today:
  // 408 completed, 112 not.
  //
  // Counting them together is not a rounding error, it is a different client.
  // It would credit a client with tonnage they never lifted and PRs on bars
  // they never touched, and then a programme would progress them from it. So
  // performance is computed from completed sets ONLY, and the rest are the
  // evidence for what was skipped.
  const done = sets.filter((s) => s.completed === true);
  const skipped = sets.filter((s) => s.completed !== true);

  const byExercise = new Map();
  for (const s of done) {
    const name = (s.exercise_name || '').trim();
    if (!name) continue;
    if (!byExercise.has(name)) byExercise.set(name, []);
    byExercise.get(name).push(s);
  }

  const exercises = [...byExercise.entries()]
    .map(([name, rows]) => ({ exercise: name, ...exerciseTrend(rows) }))
    .sort((a, b) => (b.sessions - a.sessions) || (b.total_volume_kg - a.total_volume_kg));

  const weeks = weeklyVolume(done);
  const fatigue = fatigueSignal(weeks);

  const trended = exercises.filter((e) => e.trend !== null);
  const plateaued = trended.filter((e) => e.trend === 'plateaued');
  const regressing = trended.filter((e) => e.trend === 'regressing');

  return {
    window_weeks: windowWeeks,
    // The flag that governs everything downstream. With no logged sets there
    // is no history, and a programme written against this must say so rather
    // than quietly behave as though the client is a beginner — they may have
    // trained for ten years somewhere that did not log it.
    has_history: done.length > 0,
    totals: {
      sets: done.length,
      // Prescribed-but-not-done, at set granularity. The session-level version
      // is `adherence` below; this is the finer answer to "which work is the
      // client actually skipping", which is a programming decision — an
      // accessory nobody ever finishes should stop being prescribed.
      sets_not_completed: skipped.length,
      sessions: new Set(done.map((s) => isoDay(s.session_date)).filter(Boolean)).size,
      volume_kg: Math.round(done.reduce((sum, s) => sum + setVolume(s), 0)),
      exercises: exercises.length,
    },
    // The exercises most often left unfinished, commonest first. Only named
    // where it happened more than once — one skipped set is a phone call, not
    // a pattern.
    skipped_exercises: [...skipped.reduce((m, s) => {
      const n = (s.exercise_name || '').trim();
      if (n) m.set(n, (m.get(n) || 0) + 1);
      return m;
    }, new Map())]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .map(([exercise, count]) => ({ exercise, count })),
    exercises,
    weeks,
    fatigue,
    adherence: adherence(assignment || {}),
    // Named separately from `exercises` because these are the two lists a
    // programming decision is actually made from, and making a caller filter
    // for them invites each caller to pick its own threshold.
    plateaued: plateaued.map((e) => e.exercise),
    regressing: regressing.map((e) => e.exercise),
    // What can honestly be claimed at all, so the layer above does not have to
    // re-derive it from sample sizes it would have to go looking for.
    confidence: {
      exercises_with_trend: trended.length,
      weeks_observed: weeks.filter((w) => !w.sparse).length,
      enough_for_progression_calls: trended.length > 0,
    },
  };
}

module.exports = {
  buildTrainingHistory,
  exerciseTrend,
  weeklyVolume,
  adherence,
  fatigueSignal,
  estimate1RM,
  isoWeek,
  MIN_SESSIONS_FOR_TREND,
  MIN_SETS_FOR_WEEK,
  MAX_REPS_FOR_E1RM,
  MEANINGFUL_E1RM_PCT,
};

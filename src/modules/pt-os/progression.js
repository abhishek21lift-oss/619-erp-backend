// Resolving what a programme prescribes in a given week.
//
// A programme stores as few weeks as it can get away with. Week N's
// prescription is the nearest earlier ANCHOR week's, with the progression rule
// applied across the gap — so a twelve-week block a trainer never touches is
// four rows rather than forty-eight day-plans. See migration 137 for why.
//
// An anchor is a week that has real rows of its own: week 1 always, plus any
// week a trainer has edited. Editing week 4 writes week-4 rows, which makes 4
// an anchor: weeks 1-3 keep deriving from week 1 and are untouched by that
// edit, and weeks 5+ now derive from week 4. That is the whole model — an edit
// moves the weeks after it, never the weeks before it.
//
// Pure functions, no database: the SQL that fetches rows lives with the routes,
// and everything here is arithmetic that can be tested directly.

/** Weeks a plan may run for. Guards against a bad duration turning into a loop. */
const MAX_WEEKS = 104;

/**
 * Which week of a programme a date falls in.
 *
 * Week 1 is the start date's week. Anything before the start is week 1 too —
 * a session logged early is not week zero or week minus one, it is the first
 * week's workout done ahead of time.
 *
 * @returns {number} 1-based week, clamped to [1, MAX_WEEKS]
 */
function weekOf(startDate, onDate) {
  const start = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  const on = new Date(`${String(onDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(on.getTime())) return 1;
  const days = Math.floor((on - start) / 86400000);
  if (days < 0) return 1;
  return Math.min(MAX_WEEKS, Math.floor(days / 7) + 1);
}

/**
 * How many times the rule has fired by a given week.
 *
 * Week 1 is the baseline — the numbers the trainer typed — so it is always
 * zero steps in. With progression_every_weeks = 2, weeks 1-2 are baseline,
 * weeks 3-4 are one step, and so on.
 */
function stepsFor(week, everyWeeks) {
  const every = Math.max(1, Number(everyWeeks) || 1);
  const w = Math.max(1, Math.floor(Number(week) || 1));
  return Math.floor((w - 1) / every);
}

/**
 * Apply a plan's progression rule to one prescribed exercise.
 *
 * Returns a NEW object; the caller's week-1 row is never mutated, because the
 * same row is resolved once per week when a preview is built.
 *
 * Rules only ever add to a value that exists. Progressing a null target_weight
 * would invent a prescription the trainer never gave — "add 2.5kg" to an
 * exercise with no weight set means nothing, and 2.5kg would be a fabrication.
 */
function applyProgression(exercise, plan, week, fromWeek = 1) {
  const type = plan?.progression_type || 'none';
  const amount = Number(plan?.progression_amount);
  // Steps SINCE THE ANCHOR, not since week 1 — but counted on week 1's clock.
  //
  // The difference matters whenever the rule fires every N>1 weeks. With
  // "+2.5kg every 2 weeks" the schedule is baseline, baseline, +1, +1, +2 …
  // Counting from the anchor as if it were a fresh week 1 would restart that
  // cadence at week 4 and shift every later week by a week. Subtracting the
  // anchor's own step count keeps the rule's phase and still makes the anchor
  // itself the new zero.
  const steps = stepsFor(week, plan?.progression_every_weeks)
    - stepsFor(fromWeek, plan?.progression_every_weeks);

  const out = { ...exercise, week_number: week, progression_steps: steps };
  if (type === 'none' || !Number.isFinite(amount) || steps <= 0) return out;

  const delta = amount * steps;

  if (type === 'weight') {
    if (exercise.target_weight == null) return out;
    // Round to 0.25 kg: the arithmetic produces 62.50000000000001 and a
    // trainer reads a prescription, not a float.
    out.target_weight = Math.round((Number(exercise.target_weight) + delta) * 4) / 4;
  } else if (type === 'reps') {
    if (exercise.reps == null) return out;
    // Reps are whole. Rounding rather than flooring keeps +0.5/week honest
    // over two weeks instead of losing it every time.
    out.reps = Math.max(1, Math.round(Number(exercise.reps) + delta));
  } else if (type === 'rpe') {
    if (exercise.rpe == null) return out;
    // RPE is a 1-10 scale; past 10 there is nothing left to give, so it caps
    // rather than reporting an 11 that cannot be performed.
    out.rpe = Math.min(10, Math.round((Number(exercise.rpe) + delta) * 10) / 10);
  }

  return out;
}

/** The week_number a row belongs to, defaulting to 1 the way the column does. */
function weekOfRow(row) {
  const n = Math.floor(Number(row?.week_number));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Which week the prescription for `week` is built from.
 *
 * The nearest week at or before it that has real rows — week 1 at worst,
 * because week 1 always has rows. Anything later is invisible from here: a
 * deload written for week 8 must not reach back and change week 6.
 */
function anchorWeekFor(rows, week) {
  const w = Math.max(1, Math.floor(Number(week) || 1));
  let anchor = 1;
  for (const row of rows) {
    const rw = weekOfRow(row);
    if (rw <= w && rw > anchor) anchor = rw;
  }
  return anchor;
}

/**
 * The prescription for one week of a plan.
 *
 * `rows` is every workout_exercises row for the plan and day, across weeks.
 *
 * The requested week's own rows win outright — that is what a trainer wrote
 * when they edited that week. Otherwise the nearest EARLIER anchor's rows are
 * progressed forward across the gap, so an edit in week 4 carries into weeks
 * 5+ and leaves weeks 1-3 exactly as they were.
 *
 * @returns {{ exercises: object[], source: 'override'|'derived', anchor_week: number }}
 */
function resolveWeek(rows, plan, week) {
  const w = Math.max(1, Math.floor(Number(week) || 1));
  const anchor = anchorWeekFor(rows, w);
  const base = rows.filter((r) => weekOfRow(r) === anchor);

  // The week IS the anchor: these rows are the prescription, not a starting
  // point for one. Week 1 is the exception only in what it is called — its
  // numbers are equally literal, and progressing them by zero steps is the
  // same thing.
  if (anchor === w) {
    const source = w === 1 ? 'derived' : 'override';
    return {
      exercises: base.map((r) => ({ ...r, progression_steps: 0 })),
      source,
      anchor_week: anchor,
    };
  }

  return {
    exercises: base.map((r) => applyProgression(r, plan, w, anchor)),
    source: 'derived',
    anchor_week: anchor,
  };
}

/**
 * A week-by-week preview of one exercise, for the builder.
 *
 * The point of showing this is that a rule is abstract until you see where it
 * lands: "+2.5 kg/week" over 12 weeks is 60 → 87.5, which a trainer may well
 * decide is too much. Cheaper to see it than to discover it in week 9.
 */
function previewWeeks(exercise, plan, durationWeeks, dayRows = null) {
  const weeks = Math.min(MAX_WEEKS, Math.max(1, Number(durationWeeks) || 1));
  return Array.from({ length: weeks }, (_, i) => {
    // With `dayRows`, the preview runs the real resolver, so a week the
    // trainer has edited shows what it actually says rather than where the
    // rule would have landed had they left it alone. Without them it is the
    // rule's own trajectory, which is all the caller has to go on.
    const resolved = dayRows
      ? counterpartOf(resolveWeek(dayRows, plan, i + 1).exercises, exercise)
      : applyProgression(exercise, plan, i + 1);
    return {
      week: i + 1,
      target_weight: resolved?.target_weight ?? null,
      reps: resolved?.reps ?? null,
      rpe: resolved?.rpe ?? null,
    };
  });
}

/**
 * The same exercise, as a later week sees it.
 *
 * Position within the day is the identity: a materialised week copies
 * sort_order across, so slot 2 in week 6 is slot 2 in week 1 progressed. The
 * exercise_id is the fallback for a week whose order a trainer has since
 * changed, and null is the honest answer for one they removed from that week
 * entirely — better a blank than another exercise's numbers under this name.
 */
function counterpartOf(rows, exercise) {
  return rows.find((r) => Number(r.sort_order) === Number(exercise.sort_order))
    || rows.find((r) => r.exercise_id && r.exercise_id === exercise.exercise_id)
    || null;
}

module.exports = {
  weekOf, stepsFor, applyProgression, resolveWeek, anchorWeekFor, previewWeeks, MAX_WEEKS,
};

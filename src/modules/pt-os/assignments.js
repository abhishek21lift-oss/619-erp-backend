'use strict';

/**
 * Which programme a client is on, decided once and the same way everywhere.
 *
 * ── The problem this closes ────────────────────────────────────────────────
 *
 * `workout_assignments` is UNIQUE on (workout_plan_id, client_id, status), so
 * a client may hold several rows with status 'active' at once — one per plan.
 * Measured on this studio's data when the outcomes module was written: of 34
 * clients, four had between FOUR and SEVEN active assignments each.
 *
 * Three places read "the client's active assignment" and each wrote its own
 * ORDER BY:
 *
 *   · routes/ai.js               ORDER BY wa.created_at DESC LIMIT 3
 *   · client-context.js          ORDER BY wa.start_date DESC LIMIT 1
 *   · plan-outcomes' callers     by acceptance, through the generation row
 *
 * For a client with two assignments started on the same day those answer
 * different questions, and both answer them non-deterministically: `start_date`
 * is a DATE, so two assignments starting the same Monday are tied, and
 * PostgreSQL is free to return either first. The generator could therefore
 * report week 3 of one plan while the session log showed the trainer week 1 of
 * the other, with nothing anywhere saying a choice had been made.
 *
 * ── What this module does about it ─────────────────────────────────────────
 *
 * One ordering, exported as SQL text so no reader can drift from it, and one
 * pure selector that does not silently resolve ambiguity: it names the losers.
 *
 * The tie-break chain is total. `start_date` decides; `created_at` breaks a
 * same-day tie with the row that was written last; `id` breaks the remaining
 * case, which is two rows written in the same transaction. A total order means
 * two readers asking the same question of the same rows always get the same
 * answer — which is the entire property that was missing.
 *
 * Determinism is NOT the same as correctness, and this module does not pretend
 * otherwise. Picking the most recently started plan is a rule, not a judgement
 * about which programme the client is really doing. So when there is more than
 * one, `ambiguous` is true, every other candidate is carried, and the callers
 * put that in front of the trainer rather than papering over it.
 */

/**
 * The one ORDER BY. Interpolated, never parameterised — it is a fixed literal
 * with no caller input in it, and the convention test pins that.
 *
 * `wa` is the alias every reader already uses for workout_assignments.
 */
const ACTIVE_ASSIGNMENT_ORDER = activeAssignmentOrder('wa');

/**
 * The same chain, for a statement that aliases the table something else.
 *
 * Two readers legitimately order by something FIRST — the Today roster and the
 * session slot both prefer the assignment that actually prescribes the day in
 * question, which is a better question than recency and was measured against
 * production when it was written: 26 of 55 programmed client-days resolved to
 * the wrong assignment without it.
 *
 * What those readers were still missing is a TOTAL order underneath that
 * preference. `a.start_date DESC` alone leaves two same-day assignments tied,
 * so the day-matching fix made the common case right and left the tie exactly
 * as undecided as before. Appending this closes it without touching the key
 * that matters.
 */
function activeAssignmentOrder(alias = 'wa') {
  const a = String(alias).replace(/[^A-Za-z0-9_]/g, '');
  if (!a) throw new Error('activeAssignmentOrder needs a table alias');
  return `${a}.start_date DESC NULLS LAST, ${a}.created_at DESC NULLS LAST, ${a}.id DESC`;
}

/**
 * Choose from rows the caller fetched in ACTIVE_ASSIGNMENT_ORDER.
 *
 * Re-sorts rather than trusting the caller's SQL, so a reader that forgets the
 * ORDER BY still gets the same answer as one that remembers. The SQL ordering
 * stays because it is what makes a LIMIT correct; this is what makes the
 * choice correct.
 *
 * @param {object[]} rows active assignments for ONE client
 * @returns {{ chosen: object|null, others: object[], ambiguous: boolean, count: number }}
 */
function selectActiveAssignment(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const ordered = [...list].sort(compareAssignments);
  const chosen = ordered[0] ?? null;
  const others = ordered.slice(1);
  return {
    chosen,
    others,
    // One assignment is not ambiguous. Zero is not ambiguous either — it is a
    // client with no programme, which is a different and perfectly ordinary
    // state that must not be reported as a data problem.
    ambiguous: ordered.length > 1,
    count: ordered.length,
  };
}

/** ACTIVE_ASSIGNMENT_ORDER, in JavaScript. Newest first. */
function compareAssignments(a, b) {
  return cmpDesc(dayOf(a?.start_date), dayOf(b?.start_date))
    || cmpDesc(timeOf(a?.created_at), timeOf(b?.created_at))
    || cmpDesc(a?.id ?? null, b?.id ?? null);
}

/**
 * Descending compare that sorts nulls LAST, matching NULLS LAST in the SQL.
 *
 * Written out rather than done with a ternary because the two halves disagree:
 * descending puts the larger value first, but a null has to go to the back
 * regardless of direction, and getting that backwards would make the JS and
 * the SQL pick different rows for a client whose assignment has no start date.
 */
function cmpDesc(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a > b ? -1 : 1;
}

/**
 * A DATE column as 'YYYY-MM-DD'.
 *
 * node-postgres parses DATE into a JS Date and leaves TEXT as a string, and
 * comparing a Date to a string with `>` compares "Mon Aug 24 2026…" to
 * "2026-08-24" — which is false in both directions, so the comparator would
 * report every pair as equal and the tie-break would never run. Same
 * conversion as isoDay() in client-context.js, for the same driver reason.
 */
function dayOf(v) {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
}

/** A TIMESTAMPTZ as milliseconds, or null. */
function timeOf(v) {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * What the trainer is told when more than one programme claims to be active.
 *
 * Returned as structure rather than a sentence so the API and the screen say
 * the same thing; the wording lives with the UI.
 */
function ambiguityOf(selection) {
  if (!selection?.ambiguous) return null;
  return {
    active_count: selection.count,
    chosen: describe(selection.chosen),
    not_chosen: selection.others.map(describe),
    rule: 'most recently started, then most recently created',
  };
}

function describe(a) {
  if (!a) return null;
  return {
    assignment_id: a.id ?? null,
    plan_id: a.plan_id ?? a.workout_plan_id ?? null,
    plan_name: a.plan_name ?? null,
    start_date: dayOf(a.start_date),
  };
}

module.exports = {
  ACTIVE_ASSIGNMENT_ORDER,
  activeAssignmentOrder,
  selectActiveAssignment,
  compareAssignments,
  ambiguityOf,
  // Exported for the tests that pin the ordering primitives rather than the
  // selection built from them.
  cmpDesc, dayOf, timeOf,
};

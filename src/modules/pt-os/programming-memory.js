'use strict';
// What we proposed, what the trainer did with it, and what that teaches.
//
// ── The loop this closes ───────────────────────────────────────────────────
//
// Stages 1-4 built a programme from a client's own data and checked it against
// rules. Every generation still started from nothing. The engine could see
// what the CLIENT had done and never what the TRAINER had done about it —
// so a studio could reject the same suggestion twenty times and get it again
// on the twenty-first.
//
// Measured before this was written: 95 workout generations in production, 9
// live plans. Whatever happened to the other 86 is the most informative
// feedback this studio has produced, and until migration 199 none of it was
// stored anywhere.
//
// ── What counts as a signal, and what does not ─────────────────────────────
//
// A trainer removing an exercise from a proposal is evidence. One removal is
// not: they may have been short of a rack that day, or swapped it for a
// variation they prefer to coach, or simply reordered the session. So the
// same discipline as everywhere else in this engine — nothing is reported as
// a pattern below a stated minimum, and the count is always carried with the
// claim so a trainer can see how thin it is.
//
// ── What this refuses to do ────────────────────────────────────────────────
//
// It does not change what the rules allow. A trainer who removes a safe
// exercise three times has told us their preference; a trainer who keeps a
// blocked one has not made it safe. Memory feeds the MODEL's selection, never
// the safety screen — those stay deterministic, and an override here can only
// narrow what is suggested, never widen what is permitted.

const pool = require('../../db/pool');
const { planExercises, normaliseName } = require('./plan-critic');

/** Times a trainer must do the same thing before it reads as a preference. */
const MIN_REPEATS_FOR_PATTERN = 2;

/** Proposals looked at when building the memory. Beyond this it is archaeology. */
const MEMORY_WINDOW = 10;

/**
 * Record a proposal, at the moment it is made.
 *
 * Written whether or not the trainer ever looks at it, because the proposals
 * nobody accepts are the ones with something to say. Best-effort at the call
 * site: a generation that succeeded must not fail because its bookkeeping did.
 */
async function recordGeneration({
  id, orgId, clientId, createdBy, requestId, model,
  revised = false, qualityScore = null, plan, screen = null, audit = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO ai_workout_generations
       (id, organization_id, client_id, created_by, request_id, model,
        revised, quality_score, proposed_plan, screen, audit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [id, orgId || null, clientId, createdBy || null, requestId || null, model || null,
      Boolean(revised), Number.isFinite(qualityScore) ? qualityScore : null,
      JSON.stringify(plan ?? {}),
      screen ? JSON.stringify(screen) : null,
      audit ? JSON.stringify(audit) : null],
  );
  return rows[0]?.id ?? null;
}

/**
 * Link a proposal to the plan a trainer saved from it.
 *
 * Org-scoped in the statement itself rather than by a prior read: this is a
 * write, and a write that trusts its caller to have checked is one bad caller
 * away from letting one studio stamp another studio's row.
 */
async function markAccepted(generationId, planId, orgId) {
  const { rowCount } = await pool.query(
    `UPDATE ai_workout_generations
        SET accepted_plan_id = $2, accepted_at = NOW()
      WHERE id = $1
        AND ($3::uuid IS NULL OR organization_id = $3)
        AND accepted_plan_id IS NULL`,
    [generationId, planId, orgId || null],
  );
  return rowCount;
}

/**
 * This client's recent proposals, with the exercises of any plan accepted from
 * them.
 *
 * One query rather than one per proposal: the accepted exercise names come
 * back aggregated, so a client with ten proposals costs one round trip.
 * Exercise NAMES rather than ids, because the proposal only ever had names and
 * the comparison has to happen in the same vocabulary.
 */
async function recentGenerations(clientId, orgId, { limit = MEMORY_WINDOW } = {}) {
  const { rows } = await pool.query(
    `SELECT g.id, g.created_at, g.quality_score, g.revised,
            g.proposed_plan, g.accepted_plan_id, g.accepted_at,
            COALESCE(
              (SELECT array_agg(e.name)
                 FROM workout_exercises we
                 JOIN exercises e ON e.id = we.exercise_id
                WHERE we.workout_plan_id = g.accepted_plan_id),
              ARRAY[]::text[]
            ) AS accepted_exercises
       FROM ai_workout_generations g
      WHERE g.client_id = $1
        AND ($2::uuid IS NULL OR g.organization_id = $2)
      ORDER BY g.created_at DESC
      LIMIT $3`,
    [clientId, orgId || null, Math.max(1, Math.min(50, limit))],
  );
  return rows;
}

/**
 * What changed between a proposal and the plan saved from it.
 *
 * Compared on normalised names, the same folding plan-critic.js uses, so
 * "Bench Press" and "bench press" are one exercise and nothing fuzzier is
 * attempted. `kept` is the overlap, `dropped` is what the trainer took out,
 * `added` is what they put in instead.
 *
 * An accepted plan with no exercises yields nothing at all rather than
 * reporting every proposed exercise as dropped — a plan saved and not yet
 * populated is a trainer mid-edit, not a trainer rejecting everything.
 */
function diffPlans(proposedNames = [], acceptedNames = []) {
  const proposed = new Map();
  for (const n of proposedNames) {
    const k = normaliseName(n);
    if (k && !proposed.has(k)) proposed.set(k, n);
  }
  const accepted = new Map();
  for (const n of acceptedNames) {
    const k = normaliseName(n);
    if (k && !accepted.has(k)) accepted.set(k, n);
  }

  if (!accepted.size) return { kept: [], dropped: [], added: [], comparable: false };

  const kept = [];
  const dropped = [];
  for (const [k, name] of proposed) (accepted.has(k) ? kept : dropped).push(name);
  const added = [...accepted].filter(([k]) => !proposed.has(k)).map(([, name]) => name);

  return { kept, dropped, added, comparable: true };
}

/**
 * The trainer's own history with this client, as evidence.
 *
 * `rows` are recentGenerations() output. Returns the acceptance record and the
 * exercises this trainer has repeatedly removed from, or added to, what was
 * suggested — each with the count it was seen, and nothing below
 * MIN_REPEATS_FOR_PATTERN named as a pattern at all.
 */
function buildMemory(rows = []) {
  const proposals = rows.length;
  const accepted = rows.filter((r) => r.accepted_plan_id).length;

  const droppedCounts = new Map();
  const addedCounts = new Map();
  let compared = 0;

  for (const row of rows) {
    if (!row.accepted_plan_id) continue;
    const proposedNames = planExercises(row.proposed_plan).map((e) => e.name);
    const diff = diffPlans(proposedNames, row.accepted_exercises || []);
    if (!diff.comparable) continue;
    compared += 1;
    for (const n of diff.dropped) droppedCounts.set(n, (droppedCounts.get(n) || 0) + 1);
    for (const n of diff.added) addedCounts.set(n, (addedCounts.get(n) || 0) + 1);
  }

  const pattern = (m) => [...m.entries()]
    .filter(([, n]) => n >= MIN_REPEATS_FOR_PATTERN)
    .sort((a, b) => b[1] - a[1])
    .map(([exercise, count]) => ({ exercise, count }));

  return {
    proposals,
    accepted,
    // Null rather than 0% with nothing to divide: a client nobody has ever
    // generated for has not had their proposals rejected.
    acceptance_pct: proposals ? Math.round((accepted / proposals) * 100) : null,
    // How many accepted proposals could actually be compared. An accepted plan
    // whose exercises never joined the library compares against nothing.
    compared,
    usually_removed: pattern(droppedCounts),
    usually_added: pattern(addedCounts),
    // Everything seen once, kept separate from the patterns so the layer above
    // cannot quietly promote a single removal into a preference.
    seen_once: {
      removed: [...droppedCounts].filter(([, n]) => n < MIN_REPEATS_FOR_PATTERN).map(([e]) => e),
      added: [...addedCounts].filter(([, n]) => n < MIN_REPEATS_FOR_PATTERN).map(([e]) => e),
    },
    has_memory: compared > 0,
  };
}

/**
 * The memory, as a line the generator can read.
 *
 * Written as the trainer's preference, not as a rule, and explicitly subject
 * to the safety screen — because a model told "the trainer likes X" next to
 * "X is excluded" must not resolve that in X's favour.
 */
function describeMemory(memory) {
  if (!memory || !memory.proposals) return '';
  const L = ['WHAT THIS TRAINER DID WITH YOUR LAST SUGGESTIONS:'];

  L.push(`- ${memory.accepted} of ${memory.proposals} recent proposals were saved as a plan`
    + `${memory.acceptance_pct !== null ? ` (${memory.acceptance_pct}%)` : ''}.`);

  if (!memory.has_memory) {
    L.push('- No accepted proposal could be compared, so there is no preference to learn from yet.'
      + ' Do not infer one.');
    return L.join('\n');
  }

  if (memory.usually_removed.length) {
    L.push(`- Repeatedly REMOVED from your proposals: ${memory.usually_removed
      .map((d) => `${d.exercise} (${d.count}x)`).join(', ')}.`
      + ' Prefer something else unless the client data specifically calls for it.');
  }
  if (memory.usually_added.length) {
    L.push(`- Repeatedly ADDED by the trainer: ${memory.usually_added
      .map((d) => `${d.exercise} (${d.count}x)`).join(', ')}.`
      + ' Consider including these.');
  }
  if (!memory.usually_removed.length && !memory.usually_added.length) {
    L.push('- No exercise has been changed more than once, so nothing here is a pattern yet.');
  }

  // The sentence that stops memory from becoming a safety override.
  L.push('- These are the trainer\'s preferences, not permissions. An exercise the'
    + ' safety screen excluded stays excluded however often it has been added before.');

  return L.join('\n');
}

module.exports = {
  recordGeneration,
  markAccepted,
  recentGenerations,
  diffPlans,
  buildMemory,
  describeMemory,
  MIN_REPEATS_FOR_PATTERN,
  MEMORY_WINDOW,
};

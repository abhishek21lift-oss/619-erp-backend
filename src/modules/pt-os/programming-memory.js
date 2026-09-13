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

const { randomUUID } = require('crypto');
const pool = require('../../db/pool');
const { planExercises, normaliseName } = require('./plan-critic');
const { materialise } = require('./plan-materialise');
const { resolveExerciseNames } = require('./client-context');
const { outcomeOf, summariseOutcomes } = require('./plan-outcomes');

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

/**
 * Save a proposal as a real programme, and link the two.
 *
 * ── Why the plan comes from the ledger, not the request ───────────────────
 *
 * The obvious API would take the generated plan in the request body. This
 * takes only an id and reads the plan back from ai_workout_generations, and
 * that is the whole security model of the endpoint:
 *
 *   · What gets saved is exactly what was generated, screened and audited.
 *     A body-shaped API would let a caller post any plan at all and have it
 *     filed as an accepted AI proposal — including exercises the safety screen
 *     had excluded, with the screen's own record attached saying they were not.
 *   · The accept link cannot be wrong, because there is nothing to correlate.
 *
 * ── Everything, or nothing ────────────────────────────────────────────────
 *
 * Plan, exercises and the accept stamp are one transaction. A half-saved
 * programme is worse than a failed save: the trainer sees a plan in their list
 * with three of nine exercises and no way to tell which six are missing.
 *
 * The exception is exercises that do not resolve to the library, which are
 * expected rather than exceptional — about one name in eight, measured — and
 * are reported by name and day instead of failing the save.
 */
async function acceptGeneration({ generationId, orgId, userId, name = null } = {}) {
  if (!generationId) return { ok: false, reason: 'no_generation' };

  const { rows } = await pool.query(
    `SELECT id, client_id, proposed_plan, accepted_plan_id
       FROM ai_workout_generations
      WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
    [generationId, orgId || null],
  );
  const generation = rows[0];
  // Not this studio's, or never existed. One answer for both, so the endpoint
  // cannot be used to probe which generation ids exist.
  if (!generation) return { ok: false, reason: 'not_found' };
  if (generation.accepted_plan_id) {
    return { ok: false, reason: 'already_accepted', plan_id: generation.accepted_plan_id };
  }

  const proposed = generation.proposed_plan || {};
  const resolver = await resolveExerciseNames(
    planExercises(proposed).map((e) => e.name),
    { orgId, userId },
  );
  const built = materialise(proposed, resolver);

  if (!built.exercises.length) {
    // Saving an empty plan and calling the proposal accepted would poison the
    // memory: it would compare a full proposal against nothing and read every
    // exercise as one the trainer removed.
    return { ok: false, reason: 'nothing_resolved', unresolved: built.unresolved };
  }

  const planId = randomUUID();
  const assignmentId = randomUUID();
  let wasAssigned = false;
  let otherActive = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO workout_plans
         (id, name, description, goal, difficulty, duration_weeks, sessions_per_week,
          is_template, is_active, created_by, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, true, $8, $9)`,
      [planId, name || built.plan.name, proposed.description || null,
        built.plan.goal, built.plan.difficulty,
        built.plan.duration_weeks, built.plan.sessions_per_week,
        userId || null, orgId || null],
    );

    for (const ex of built.exercises) {
      await client.query(
        `INSERT INTO workout_exercises
           (id, workout_plan_id, exercise_id, day_of_week, week_number, sort_order,
            sets, reps, rest_seconds, notes, tempo, rpe, config)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [randomUUID(), planId, ex.exercise_id, ex.day_of_week, ex.week_number, ex.sort_order,
          ex.sets ?? 3, ex.reps ?? 10, ex.rest_seconds ?? 60, ex.notes,
          ex.tempo, ex.rpe, ex.config ? JSON.stringify(ex.config) : null],
      );
    }

    // ── Give it to the client ───────────────────────────────────────────
    //
    // Until this existed, accepting a proposal wrote a workout_plans row and
    // stopped. That plan was not assigned to anybody, which meant three things
    // nobody had noticed:
    //
    //   · it never appeared on Today, which lists clients by ACTIVE ASSIGNMENT
    //     whose plan prescribes the weekday — so the programme the AI wrote
    //     could not be started from the screen a trainer actually uses;
    //   · workout_sessions.workout_assignment_id could never point at it, so
    //     no logged session could ever be attributed back to the proposal;
    //   · therefore no outcome could ever be measured, and the closed loop
    //     this engine is for was structurally impossible rather than merely
    //     unbuilt. See plan-outcomes.js.
    //
    // Same transaction as the plan and the stamp: a plan that exists with no
    // assignment is exactly the state described above, and half-committing it
    // would recreate the bug one row at a time.
    //
    // It ADDS an assignment and retires nothing. Silently completing whatever
    // the client is already on would be the system overwriting a programme a
    // trainer chose, which this engine does not do — so the count of what else
    // is active comes back in the result for the trainer to act on instead.
    let assigned = false;
    if (orgId) {
      await client.query(
        `INSERT INTO workout_assignments
           (id, workout_plan_id, client_id, trainer_id, start_date, status, organization_id)
         VALUES ($1, $2, $3, (SELECT trainer_id FROM pt_clients WHERE id = $3),
                 CURRENT_DATE, 'active', $4)`,
        [assignmentId, planId, generation.client_id, orgId],
      );
      assigned = true;
    }

    // How many OTHER programmes this client is already on. It decides whether
    // a logged session can auto-link to one plan at all: the session log links
    // automatically only when there is exactly one active assignment, and
    // measured on production 29 of 34 clients had none and four had between
    // four and seven. A trainer who is about to create the second needs to be
    // told, because from then on attribution is theirs to make by hand.
    const { rows: others } = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM workout_assignments
        WHERE client_id = $1 AND status = 'active' AND id <> $2`,
      [generation.client_id, assignmentId],
    );
    otherActive = others[0]?.n ?? 0;
    wasAssigned = assigned;

    // The accept stamp rides the SAME transaction. Marking it outside would
    // leave a plan that exists with a proposal that still reads as rejected,
    // which is the one state the memory cannot recover from.
    const { rowCount } = await client.query(
      `UPDATE ai_workout_generations
          SET accepted_plan_id = $2, accepted_at = NOW()
        WHERE id = $1 AND accepted_plan_id IS NULL`,
      [generationId, planId],
    );
    if (!rowCount) {
      // Another request accepted it while this one was building. Theirs wins.
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_accepted' };
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    ok: true,
    plan_id: planId,
    client_id: generation.client_id,
    name: name || built.plan.name,
    saved: built.counts.saved,
    unresolved: built.unresolved,
    unknown_days: built.unknown_days,
    // Whether the programme is actually live for this client, and what else
    // is. Reported rather than assumed: a save that produced a plan nobody is
    // assigned to is the failure this endpoint used to have silently.
    assignment_id: wasAssigned ? assignmentId : null,
    assigned: wasAssigned,
    other_active_assignments: otherActive,
  };
}


/**
 * What became of the proposals this client actually kept.
 *
 * The read behind plan-outcomes.js. One query for the accepted proposals and
 * the plan each became, one for the sessions logged against them, one for the
 * sets in those sessions — three round trips for the whole history rather than
 * three per proposal, because this runs on the path that generates a programme
 * and a trainer is waiting on it.
 *
 * Only sessions ON OR AFTER the acceptance date count. A client's earlier
 * training is not evidence about a plan that did not exist yet, and counting
 * it would credit every new proposal with the work that preceded it.
 */
async function planOutcomes(clientId, orgId, { today, limit = MEMORY_WINDOW } = {}) {
  if (!clientId) return summariseOutcomes([]);

  const { rows: accepted } = await pool.query(
    `SELECT g.id, g.accepted_at, g.accepted_plan_id,
            p.sessions_per_week, p.duration_weeks,
            a.id AS assignment_id,
            COALESCE(
              (SELECT array_agg(e.name)
                 FROM workout_exercises we
                 JOIN exercises e ON e.id = we.exercise_id
                WHERE we.workout_plan_id = g.accepted_plan_id),
              ARRAY[]::text[]
            ) AS plan_exercise_names
       FROM ai_workout_generations g
       JOIN workout_plans p ON p.id = g.accepted_plan_id
       -- LEFT, deliberately. A proposal accepted before acceptGeneration
       -- started creating assignments has no row here, and it must come back
       -- as unmeasurable rather than vanish from the history.
       LEFT JOIN workout_assignments a
              ON a.workout_plan_id = g.accepted_plan_id
             AND a.client_id = g.client_id
      WHERE g.client_id = $1
        AND g.accepted_plan_id IS NOT NULL
        AND ($2::uuid IS NULL OR g.organization_id = $2)
      ORDER BY g.accepted_at DESC
      LIMIT $3`,
    [clientId, orgId || null, Math.max(1, Math.min(50, limit))],
  );
  if (!accepted.length) return summariseOutcomes([]);

  const assignmentIds = accepted.map((r) => r.assignment_id).filter(Boolean);
  let sessions = [];
  let sets = [];

  if (assignmentIds.length) {
    ({ rows: sessions } = await pool.query(
      `SELECT ws.id, ws.workout_assignment_id, ws.session_date, ws.status
         FROM workout_sessions ws
        WHERE ws.workout_assignment_id = ANY($1::text[])
        ORDER BY ws.session_date`,
      [assignmentIds],
    ));

    if (sessions.length) {
      ({ rows: sets } = await pool.query(
        `SELECT ws.workout_assignment_id, ws.session_date,
                wse.exercise_name, s.weight_kg, s.reps, s.rpe, s.rir, s.completed
           FROM workout_sets s
           JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
           JOIN workout_sessions ws ON ws.id = wse.session_id
          WHERE ws.workout_assignment_id = ANY($1::text[])
          ORDER BY ws.session_date`,
        [assignmentIds],
      ));
    }
  }

  const asOf = today || new Date().toISOString().slice(0, 10);
  const onOrAfter = (rowDate, acceptedAt) => {
    const d = rowDate ? String(rowDate).slice(0, 10) : null;
    const a = acceptedAt ? String(acceptedAt).slice(0, 10) : null;
    return Boolean(d && a && d >= a);
  };

  const rows = accepted.map((generation) => outcomeOf({
    generation,
    sessions: sessions.filter((x) => x.workout_assignment_id === generation.assignment_id
      && onOrAfter(x.session_date, generation.accepted_at)),
    sets: sets.filter((x) => x.workout_assignment_id === generation.assignment_id
      && onOrAfter(x.session_date, generation.accepted_at)),
    today: asOf,
  }));

  return summariseOutcomes(rows);
}

module.exports = {
  acceptGeneration,
  planOutcomes,
  recordGeneration,
  markAccepted,
  recentGenerations,
  diffPlans,
  buildMemory,
  describeMemory,
  MIN_REPEATS_FOR_PATTERN,
  MEMORY_WINDOW,
};

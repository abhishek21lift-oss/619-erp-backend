'use strict';
// One client, assembled once, for everything that needs to know about them.
//
// ── The problem this closes ────────────────────────────────────────────────
//
// There were two client-context paths, built at different times for different
// screens, and neither knew what the other could see.
//
// `pt-os.routes.js` assembles the brief: PAR-Q, posture, mobility, lifestyle,
// goals, assessments. It is what the profile screen and the coaching card
// read, and it is thorough.
//
// `routes/ai.js` assembles a different context for the plan generators. It
// reads the fitness profile, goals, assessments, check-ins, lifestyle,
// nutrition and assignments — and it does NOT read pt_parq_forms,
// pt_posture_assessments, pt_mobility_performance_assessments, or a single
// logged set.
//
// So the feature whose entire job is deciding what a client should do next was
// the one feature that could not see whether they had been cleared to train,
// whether a joint had come back painful, or what they lifted last week. It
// took injuries from `pt_clients.injuries` — a column that is empty for all 34
// clients in production — and told the model "Injuries: none" for every client
// it has ever written a programme for.
//
// This module is the single answer to "what do we know about this client".
// It owns the queries, and it composes the pure builders that were already
// here: buildBrief, buildRecovery, buildTrainingHistory, and the stage-2
// rules. Nothing here re-implements any of them.
//
// ── Tenant isolation ───────────────────────────────────────────────────────
//
// The pt_clients lookup is org-scoped and awaited FIRST, alone. A client_id
// belonging to another studio yields no row and this returns null before one
// child query has run — so a cross-tenant probe cannot even be timed against
// the child tables. Every child query is keyed by that now-verified client_id.
// This is the ordering both existing paths already use; it is preserved rather
// than re-invented, because it is the property that makes them safe.
//
// ── What it will not do ────────────────────────────────────────────────────
//
// It does not decide anything. It gathers, composes, and hands back an object
// that says — everywhere — how much of itself is actually known. The gate, the
// constraints and the volume calls are stage 2's; the interpretation is the
// model's; the approval is the trainer's.

const pool = require('../../db/pool');
const { buildBrief } = require('./training-brief');
const { buildRecovery } = require('./recovery');
const { buildTrainingHistory, isoWeek } = require('./training-history');
const { evaluate, equipmentFrom, weeklyMuscleGroups, screenExercise } = require('./programming-rules');
const { normaliseName } = require('./plan-critic');
const { volumeLandmarks, deloadTriggers } = require('./programming-rules');
const { detectSignals, summariseRoster } = require('./training-signals');

/** How far back the training history looks, in weeks. */
const DEFAULT_WINDOW_WEEKS = 12;

/**
 * Cap on the sets pulled for one client.
 *
 * Production's busiest client has 76 completed sets across the whole window,
 * so this is roughly twenty times the real maximum. It exists so that a client
 * whose log is later imported in bulk cannot turn one generation request into
 * an unbounded read.
 */
const MAX_SETS = 2000;

/**
 * Every row we hold about one client, and what it adds up to.
 *
 * @param {string} clientId
 * @param {string|null} orgId  From the authenticated session. Null only for a
 *        platform super admin, where the client lookup is unscoped by design
 *        and matches what both existing loaders already do.
 * @param {object=} opts
 * @param {number=} opts.windowWeeks
 * @param {string=} opts.equipmentText Free text from the request body; the
 *        database holds no equipment column, so this is the only source.
 * @param {object[]=} opts.exercises   Library rows to screen, already
 *        retrieved through the library's own tenancy predicate.
 * @returns {Promise<object|null>} null when the client is not this org's.
 */
async function loadDigitalTwin(clientId, orgId, {
  windowWeeks = DEFAULT_WINDOW_WEEKS, equipmentText = null, exercises = [],
} = {}) {
  const { rows: clientRows } = await pool.query(
    `SELECT id, name, gender, dob, goal, injuries, notes, workout_experience_level,
            health_conditions, organization_id
       FROM pt_clients
      WHERE id = $1 AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR organization_id = $2)`,
    [clientId, orgId],
  );
  const client = clientRows[0];
  if (!client) return null;

  const weeks = Math.max(1, Math.min(104, Number(windowWeeks) || DEFAULT_WINDOW_WEEKS));
  const one = (sql, params = [clientId]) => pool.query(sql, params).then((r) => r.rows[0] ?? null);
  const many = (sql, params = [clientId]) => pool.query(sql, params).then((r) => r.rows);

  const [parq, assessment, posture, mobility, lifestyle, goal, assignment, sessions, sets, checkins] =
    await Promise.all([
      one(`SELECT * FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_posture_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_mobility_performance_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1
            ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
      one(`SELECT * FROM pt_goals WHERE client_id = $1 AND is_active = true
            ORDER BY created_at DESC LIMIT 1`),
      one(`SELECT wa.start_date, wa.progress_pct, wp.id AS plan_id, wp.name AS plan_name,
                  wp.duration_weeks,
                  (SELECT COUNT(DISTINCT we.day_of_week) FROM workout_exercises we
                    WHERE we.workout_plan_id = wp.id AND we.week_number = 1)::int AS planned_days_count
             FROM workout_assignments wa
             JOIN workout_plans wp ON wp.id = wa.workout_plan_id
            WHERE wa.client_id = $1 AND wa.status = 'active'
            ORDER BY wa.start_date DESC LIMIT 1`),
      many(
        `SELECT status, session_date FROM workout_sessions
          WHERE client_id = $1 AND session_date >= CURRENT_DATE - ($2 * INTERVAL '1 week')`,
        [clientId, weeks],
      ),
      // The half of the loop nothing outside the workout log has ever read.
      // muscle_group rides along so weekly volume needs no second query; it is
      // null for a set whose exercise was typed free-hand, which is 29 of
      // production's 408 completed sets and is reported, not dropped.
      many(
        `SELECT wse.exercise_name, s.weight_kg, s.reps, s.rpe, s.rir, s.completed,
                ws.session_date, e.muscle_group
           FROM workout_sets s
           JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
           JOIN workout_sessions ws ON ws.id = wse.session_id
           LEFT JOIN exercises e ON e.id = wse.exercise_id
          WHERE ws.client_id = $1
            AND ws.session_date >= CURRENT_DATE - ($2 * INTERVAL '1 week')
          ORDER BY ws.session_date DESC
          LIMIT ${MAX_SETS}`,
        [clientId, weeks],
      ),
      many(`SELECT week_start_date, mood, sleep_hours, water_glasses,
                   stress_level, energy_level, soreness_level
              FROM weekly_checkins WHERE client_id = $1
             ORDER BY week_start_date DESC LIMIT 12`),
    ]);

  const brief = buildBrief({
    client, parq, assessment, posture, mobility, lifestyle, goal, assignment,
    recentSessions: sessions,
  });
  const recovery = buildRecovery(checkins);
  const history = buildTrainingHistory({
    sets,
    assignment: adherenceInputs(assignment, sessions, weeks),
    windowWeeks: weeks,
  });
  const rules = evaluate({
    parq, mobility, posture, lifestyle, client,
    equipment: equipmentFrom(equipmentText),
    exercises,
    history,
    recovery,
    weeklyGroups: weeklyMuscleGroups(sets, isoWeek),
  });

  return { client, brief, recovery, history, rules, window_weeks: weeks };
}

/**
 * Sessions prescribed and performed over the window.
 *
 * Prescribed is the plan's own days-per-week across the weeks that have
 * actually elapsed since it started — never across the whole window, because a
 * plan that began last Tuesday has not prescribed twelve weeks of anything and
 * scoring it as though it had would invent a missed-session problem.
 *
 * Returns an empty object with no active plan, which is not the same as zero:
 * 24 of the 29 production clients who have logged a session have no active
 * assignment, and adherence() answers null for them rather than reporting a
 * trainer's un-assigned plan as a client's failure to turn up.
 */
function adherenceInputs(assignment, sessions = [], windowWeeks = DEFAULT_WINDOW_WEEKS) {
  const perWeek = Number(assignment?.planned_days_count);
  if (!assignment || !Number.isFinite(perWeek) || perWeek <= 0) return {};

  // COMPLETE weeks only. A plan three days old has not yet prescribed its
  // first week, and rounding up would charge the client for sessions that are
  // not due until Friday — an invented missed-session problem, on the exact
  // metric a trainer uses to decide whether somebody is turning up.
  //
  // The cost of flooring is that adherence is unanswerable for the first week
  // of a plan, which adherence() already reports as null rather than 0%.
  const started = assignment.start_date ? new Date(assignment.start_date) : null;
  const elapsed = started && !Number.isNaN(started.getTime())
    ? Math.floor((Date.now() - started.getTime()) / (7 * 86400000))
    : windowWeeks;

  const planWeeks = Number(assignment.duration_weeks);
  const weeks = Math.max(0, Math.min(
    windowWeeks,
    elapsed,
    Number.isFinite(planWeeks) && planWeeks > 0 ? planWeeks : Infinity,
  ));

  return {
    prescribed: Math.round(weeks * perWeek),
    completed: sessions.filter((s) => s.status === 'completed').length,
  };
}

/**
 * The twin as text a model can read.
 *
 * Pure, so the thing the AI is actually told can be asserted in a test without
 * a database or an API key — the prompt is the part that decides the output,
 * and a prompt nobody can see is a prompt nobody can check.
 *
 * The ordering is deliberate. The gate and the constraints come FIRST, before
 * any facts about the client's goals, because a model that reads "wants to
 * bench 100kg" before it reads "shoulder pain, do not load" has already begun
 * writing the wrong programme.
 */
function describeTwin(twin) {
  if (!twin) return '';
  const L = [];
  const { rules, history, recovery, brief } = twin;

  L.push('SAFETY SCREEN (decided by rule, not by you — do not overrule it):');
  L.push(`- Medical clearance: ${rules.gate.status}`
    + (rules.gate.assessed_on ? ` (PAR-Q ${rules.gate.assessed_on})` : ' — no PAR-Q on file'));

  const located = rules.constraints.filter((c) => c.region);
  if (located.length) {
    L.push('- Limitations found:');
    for (const c of located) {
      L.push(`  · ${c.label}: ${c.verdict.toUpperCase()} — ${c.evidence} (${c.source}). ${c.note}`);
    }
  } else if (rules.coverage.screened) {
    L.push('- Limitations found: none. This client HAS been screened'
      + ` (${rules.coverage.sources_present.join(', ')}).`);
  } else {
    // The distinction the whole module exists for. Without this line a model
    // reads an empty limitation list as a healthy client.
    L.push('- NOBODY HAS SCREENED THIS CLIENT. No PAR-Q, posture or mobility'
      + ' assessment is on file. An empty limitation list here means nothing was'
      + ' looked at, NOT that nothing is wrong. Say so in your plan.');
  }

  for (const u of rules.unlocated) {
    L.push(`  · ${u.evidence} reported — ${u.note}`);
  }
  for (const r of rules.referrals) {
    L.push(`  · REFER: ${r.note}`);
  }

  if (rules.library.counts.blocked || rules.library.counts.caution) {
    L.push('', 'EXERCISE SCREEN:');
    L.push(`- ${rules.library.counts.allowed} of the retrieved exercises are allowed`
      + `, ${rules.library.counts.caution} need care, ${rules.library.counts.blocked} are excluded.`);
    for (const ex of rules.library.blocked.slice(0, 20)) {
      L.push(`  · EXCLUDED ${ex.name}: ${ex.reasons.map((r) => r.because).join('; ')}`);
    }
    for (const ex of rules.library.caution.slice(0, 20)) {
      L.push(`  · CARE ${ex.name}: ${ex.reasons.map((r) => r.because).join('; ')}`);
    }
  }

  L.push('', 'WHAT THIS CLIENT HAS ACTUALLY DONE:');
  if (!history.has_history) {
    L.push('- No sets have ever been logged for this client. They may still be'
      + ' experienced — this studio simply has no record of it, so do not'
      + ' describe them as a beginner unless something else says so.');
  } else {
    L.push(`- ${history.totals.sets} completed sets across ${history.totals.sessions} sessions`
      + ` in ${history.window_weeks} weeks, ${history.totals.volume_kg} kg total.`);
    for (const e of history.exercises.slice(0, 12)) {
      L.push(`  · ${e.exercise}: ${e.sessions} sessions`
        + (e.latest_e1rm_kg !== null ? `, last e1RM ${e.latest_e1rm_kg} kg` : '')
        + (e.best_e1rm_kg !== null ? `, best ${e.best_e1rm_kg} kg` : '')
        + (e.trend ? `, ${e.trend} (${e.change_pct}%)` : ', no trend yet — too few sessions'));
    }
    if (history.skipped_exercises.length) {
      L.push(`- Repeatedly left unfinished: ${history.skipped_exercises
        .map((s) => `${s.exercise} (${s.count}x)`).join(', ')}.`
        + ' An exercise nobody ever finishes should stop being prescribed.');
    }
    if (!history.confidence.enough_for_progression_calls) {
      L.push('- NO lift has enough sessions logged for a trend. Do not claim this'
        + ' client is progressing, plateaued or regressing on anything.');
    }
  }

  if (history.adherence.pct !== null) {
    L.push(`- Attendance: ${history.adherence.completed} of ${history.adherence.prescribed}`
      + ` prescribed sessions (${history.adherence.pct}%).`);
  } else {
    L.push('- Attendance cannot be computed: no active plan prescribes a session count.');
  }

  L.push('', 'VOLUME AND RECOVERY:');
  if (rules.volume.weeks_observed) {
    for (const g of rules.volume.groups) {
      if (!g.landmark) continue;
      L.push(`- ${g.group}: ${g.latest_sets} sets last week`
        + ` (${g.landmark.mev}-${g.landmark.mav} is the working range) — ${g.status}`);
    }
    if (rules.volume.unattributable_sets) {
      L.push(`- ${rules.volume.unattributable_sets} sets could not be attributed to a muscle`
        + ' group, so these counts are a floor, not a total.');
    }
  } else {
    L.push('- No attributable weekly volume.');
  }

  L.push(`- Deload: ${rules.deload.deload_indicated ? 'INDICATED' : 'not indicated'}`
    + ` (${rules.deload.evaluated} of ${rules.deload.of} triggers could be evaluated).`);
  for (const t of rules.deload.triggers) L.push(`  · ${t.trigger}: ${t.evidence}`);
  for (const u of rules.deload.unobservable) L.push(`  · ${u.trigger}: cannot tell — ${u.reason}`);

  if (recovery.present && recovery.score !== null) {
    L.push(`- Self-reported readiness ${recovery.score}/100 (${recovery.band}), ${recovery.inputs}`
      + ` of ${recovery.max_inputs} questions answered, trend ${recovery.trend ?? 'unknown'}.`);
  }

  if (brief.missing.length) {
    L.push('', `NOT ASSESSED — you may recommend measuring these, but must not describe them: ${brief.missing.join(', ')}.`);
  }

  return L.join('\n');
}

/**
 * The limitations line for a prompt, from what was actually assessed.
 *
 * The generator's only injury input was free text: `pt_clients.injuries`, or
 * `client_fitness_profiles.injuries` ahead of it. Both are empty in production
 * — the profiles table has no rows at all — so every client it has ever
 * written for was described as having no injuries.
 *
 * This ADDS the screen rather than replacing that text. `typed` is whatever
 * the caller's own precedence chain resolved, and it is carried verbatim
 * alongside the assessed findings: a trainer who typed into either column
 * meant it, and those columns can say things no assessment form asks about.
 */
function limitationsLine(twin, typed = null) {
  if (!twin) return 'unknown';
  const located = twin.rules.constraints.filter((c) => c.region);
  const parts = located.map((c) => `${c.label} (${c.verdict}, from ${c.source})`);
  for (const u of twin.rules.unlocated) parts.push(u.evidence.replace(/_/g, ' '));

  // The client record's own column, then whatever the caller resolved. Both,
  // because they are different columns and either may be the only one filled.
  for (const text of [twin.brief.sections.limitations?.injuries, typed]) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (t && t.toLowerCase() !== 'none' && !parts.includes(t)) parts.push(t);
  }

  if (parts.length) return parts.join('; ');
  return twin.rules.coverage.screened
    ? 'none found — the client has been screened and is clear'
    : 'UNKNOWN — nobody has screened this client';
}

/**
 * Screen the exercises a generated plan actually named.
 *
 * The prompt was given a dozen library rows; a model may name anything. So
 * the audit does its own lookup rather than reusing that retrieval — without
 * this, "was a blocked exercise prescribed?" could only be answered for the
 * handful of exercises that happened to be retrieved, and would answer "no"
 * for every other blocked movement in the library.
 *
 * Matching is by NORMALISED NAME ONLY — case, punctuation and whitespace
 * folded, nothing fuzzy. plan-critic.js records the measurement behind that:
 * trigram similarity resolves "Overhead Press" to "Overhead Lat", which would
 * clear a shoulder-loading press through a lat exercise's row for a client
 * with shoulder pain. A name this cannot match is left out of the result and
 * reported by the audit as unverified.
 *
 * Tenancy is the exercise library's own predicate, identical to the one the
 * prompt retrieval uses: built-ins are shared, a studio's custom exercises
 * are visible only to their author inside their own org. Fail-closed — no org
 * or no user returns an empty map, so nothing is cleared by an unscoped read.
 */
async function screenPlanExercises(names = [], { orgId, userId, screen } = {}) {
  const wanted = [...new Set(names.map(normaliseName).filter(Boolean))];
  if (!wanted.length || !orgId || !userId || !screen) return new Map();

  const { rows } = await pool.query(
    `SELECT name, muscle_group, body_part, target_muscle, movement_pattern, equipment, difficulty
       FROM exercises
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND (organization_id IS NULL OR (organization_id = $1::uuid AND created_by = $2))
        AND regexp_replace(lower(btrim(name)), '[^a-z0-9]+', ' ', 'g') = ANY($3::text[])`,
    [orgId, userId, wanted],
  );

  const out = new Map();
  for (const row of rows) {
    const key = normaliseName(row.name);
    const result = screenExercise(row, screen);
    const prior = out.get(key);
    // Four library names normalise onto another (verified: all four pairs
    // share one target_muscle). Where that happens the STRICTER verdict wins,
    // so an ambiguous name can never be cleared by its more permissive twin.
    if (!prior || RANK_OF[result.verdict] > RANK_OF[prior.verdict]) {
      out.set(key, { name: row.name, verdict: result.verdict, reasons: result.reasons });
    }
  }
  return out;
}

/** Verdict ordering, so the stricter of two matches wins. */
const RANK_OF = Object.freeze({ allow: 0, caution: 1, block: 2 });

/**
 * Every client in the studio, and what their data says without being asked.
 *
 * ── Why this is two queries and not thirty-four ───────────────────────────
 *
 * The obvious shape — loop the roster, load each client's twin — is ~10
 * queries per client. For 34 clients that is 340 round trips to answer a
 * question a trainer wants on a dashboard. So the roster and the sets are
 * fetched once each and grouped in memory.
 *
 * The set pull is bounded by the window and by MAX_SWEEP_SETS. Production
 * holds 408 completed sets in total, so the whole studio's history costs one
 * query today; the cap exists so a studio that later imports years of logs
 * degrades into an incomplete sweep rather than an unbounded read.
 *
 * ── Tenancy ───────────────────────────────────────────────────────────────
 *
 * Both queries are org-scoped in their own WHERE clause rather than one being
 * trusted because the other was filtered. `trainerId` narrows further to the
 * clients that trainer owns, which is what a trainer's own dashboard must
 * show — an admin passes none and sees the studio.
 */
async function sweepRoster(orgId, { trainerId = null, windowWeeks = DEFAULT_WINDOW_WEEKS, today } = {}) {
  const weeks = Math.max(1, Math.min(104, Number(windowWeeks) || DEFAULT_WINDOW_WEEKS));

  const { rows: clients } = await pool.query(
    `SELECT c.id, c.name, c.pt_start_date, c.pt_end_date, c.status,
            (SELECT MAX(ws.session_date)
               FROM workout_sessions ws
              WHERE ws.client_id = c.id AND ws.status = 'completed') AS last_session
       FROM pt_clients c
      WHERE c.deleted_at IS NULL
        AND ($1::uuid IS NULL OR c.organization_id = $1)
        AND ($2::text IS NULL OR c.trainer_id = $2)
      ORDER BY c.name`,
    [orgId || null, trainerId || null],
  );
  if (!clients.length) return summariseRoster([]);

  const { rows: sets } = await pool.query(
    `SELECT ws.client_id, wse.exercise_name, s.weight_kg, s.reps, s.rpe, s.rir,
            s.completed, ws.session_date, e.muscle_group
       FROM workout_sets s
       JOIN workout_session_exercises wse ON wse.id = s.session_exercise_id
       JOIN workout_sessions ws ON ws.id = wse.session_id
       JOIN pt_clients c ON c.id = ws.client_id
       LEFT JOIN exercises e ON e.id = wse.exercise_id
      WHERE c.deleted_at IS NULL
        AND ($1::uuid IS NULL OR c.organization_id = $1)
        AND ($2::text IS NULL OR c.trainer_id = $2)
        AND ws.session_date >= CURRENT_DATE - ($3 * INTERVAL '1 week')
      ORDER BY ws.session_date DESC
      LIMIT ${MAX_SWEEP_SETS}`,
    [orgId || null, trainerId || null, weeks],
  );

  const byClient = new Map();
  for (const row of sets) {
    if (!byClient.has(row.client_id)) byClient.set(row.client_id, []);
    byClient.get(row.client_id).push(row);
  }

  const asOf = today || new Date().toISOString().slice(0, 10);
  const rows = clients.map((client) => {
    const clientSets = byClient.get(client.id) || [];
    // No assignment is passed, so adherence answers null rather than scoring
    // a client against a plan that does not exist. 24 of the 29 clients with
    // logged sessions are in exactly that state.
    const history = buildTrainingHistory({ sets: clientSets, windowWeeks: weeks });
    const volume = volumeLandmarks(weeklyMuscleGroups(clientSets, isoWeek));
    return detectSignals({
      client,
      today: asOf,
      lastSession: client.last_session ? String(client.last_session).slice(0, 10) : null,
      history,
      volume,
      deload: deloadTriggers({ history, volume }),
    });
  });

  return summariseRoster(rows);
}

/** Cap on one sweep's set pull. Production's whole studio is 408. */
const MAX_SWEEP_SETS = 20000;

module.exports = {
  loadDigitalTwin,
  screenPlanExercises,
  sweepRoster,
  describeTwin,
  limitationsLine,
  adherenceInputs,
  DEFAULT_WINDOW_WEEKS,
  MAX_SETS,
};

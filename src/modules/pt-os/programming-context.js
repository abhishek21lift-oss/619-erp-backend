'use strict';

/**
 * One client, loaded once, for everything that programmes for them.
 *
 * ── The duplication this removes ───────────────────────────────────────────
 *
 * client-context.js opens by describing two context paths that did not know
 * about each other, and it closed that gap by building a third. It did not
 * remove either of the first two. So `POST /api/ai/workout/generate` ran BOTH:
 *
 *   · loadAuthoritativeClient() — the client record, fitness profile, goals,
 *     latest assessment, latest check-in, lifestyle, nutrition, assignments
 *     and the studio's equipment, for the facts resolver;
 *   · loadDigitalTwin()        — the PAR-Q, posture, mobility, goal,
 *     assignment, sessions, sets, check-ins and volume landmarks, for the
 *     safety screen.
 *
 * Two org-scoped pt_clients authorizations for one request. Five tables read
 * twice — pt_assessments, weekly_checkins, pt_lifestyle_assessments, pt_goals
 * and workout_assignments — and read DIFFERENTLY each time: the facts resolver
 * took the newest assessment by `created_at`, the brief took the newest by
 * `assessment_date`, and for a client whose assessments were back-dated those
 * are two different rows. One of them decided the weight in the prompt; the
 * other decided the weight in the body section beneath it.
 *
 * This module is the one loader. It owns the authorization, it owns the query
 * set, and it composes every pure builder that already existed — buildBrief,
 * buildRecovery, buildTrainingHistory, evaluate, resolveClientFacts,
 * programState, nextSession, adaptationDecisions. It re-implements none of
 * them. `loadDigitalTwin` is gone; what it returned is the `twin` field here.
 *
 * ── Where the duplication deliberately remains ─────────────────────────────
 *
 * loadAuthoritativeClient() still exists in routes/ai.js and still serves the
 * AI coach chat and the DIET generator. Those read the same client record and
 * a different half of it — diet preferences, allergies, budget, meal frequency
 * — and folding a nutrition-plan loader into a module named for programming
 * would be a worse structure, not a better one. What matters is that exactly
 * one path assembles the context a WORKOUT is written from, and after this
 * change exactly one does.
 *
 * ── Tenant isolation ───────────────────────────────────────────────────────
 *
 * The pt_clients lookup is org-scoped and awaited FIRST, alone. A client_id
 * belonging to another studio yields no row and this returns null before one
 * child query — retrieval included — has run, so a cross-tenant probe cannot
 * even be timed against the child tables. This is the ordering both retired
 * paths already used; it is preserved rather than re-invented, because it is
 * the property that made them safe.
 */

const pool = require('../../db/pool');
const { buildBrief } = require('./training-brief');
const { buildRecovery } = require('./recovery');
const { buildTrainingHistory, isoWeek } = require('./training-history');
const { evaluate, equipmentFrom, weeklyMuscleSets } = require('./programming-rules');
const { resolveClientFacts } = require('./client-facts');
const { selectActiveAssignment, ambiguityOf, ACTIVE_ASSIGNMENT_ORDER } = require('./assignments');
const { nextSession } = require('./next-session');
const { adaptationDecisions } = require('./adaptation');
const {
  programState, resolveLandmarks, adherenceInputs, DEFAULT_WINDOW_WEEKS, MAX_SETS,
} = require('./client-context');
const { today: studioToday } = require('../../lib/appTime');

/**
 * Everything this studio knows about one client, and what it adds up to.
 *
 * @param {string} clientId
 * @param {string|null} orgId  From the authenticated session. Null only for a
 *        platform super admin, where the client lookup is unscoped by design
 *        and matches what both retired loaders did.
 * @param {object=} opts
 * @param {number=} opts.windowWeeks
 * @param {object=} opts.stated       What the trainer typed for THIS request.
 *        Consulted only where the database holds nothing — see client-facts.
 * @param {function=} opts.retrieve   Optional async () => ({ ragChunks,
 *        exercises }). Runs INSIDE the same Promise.all as the child queries,
 *        i.e. strictly AFTER the parent check has passed, so a cross-tenant or
 *        missing client never triggers a retrieval. Must fail closed itself.
 * @param {string=} opts.today
 * @returns {Promise<object|null>} null when the client is not this org's.
 */
async function loadProgrammingContext(clientId, orgId, {
  windowWeeks = DEFAULT_WINDOW_WEEKS, stated = {}, retrieve = null, today = studioToday(),
} = {}) {
  const { rows: clientRows } = await pool.query(
    `SELECT * FROM pt_clients
      WHERE id = $1 AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR organization_id = $2)`,
    [clientId, orgId],
  );
  const client = clientRows[0];
  if (!client) return null;

  const weeks = Math.max(1, Math.min(104, Number(windowWeeks) || DEFAULT_WINDOW_WEEKS));
  const one = (sql, params = [clientId]) => pool.query(sql, params).then((r) => r.rows[0] ?? null);
  const many = (sql, params = [clientId]) => pool.query(sql, params).then((r) => r.rows);

  const [
    profile, parq, assessment, posture, mobility, lifestyle, nutrition, goals,
    assignments, sessions, sets, checkins, equipment, landmarks, retrieved,
  ] = await Promise.all([
    one(`SELECT goal, goal_other, height_cm, body_fat_pct, health_conditions, injuries,
                fitness_level, sleep_hours, stress_level, diet_preference
           FROM client_fitness_profiles WHERE client_id = $1 LIMIT 1`),
    one(`SELECT * FROM pt_parq_forms WHERE client_id = $1 AND deleted_at IS NULL
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    // ── One "latest assessment", by assessment DATE ───────────────────────
    //
    // The facts resolver used to read this ordered by created_at and the brief
    // by assessment_date. For a studio that back-dates a measurement — which
    // is what the assessment_date column is FOR — those are different rows,
    // and the prompt could state one weight in its facts block and another in
    // its body section. The assessment's own date wins: it is when the client
    // was measured, which is the question "latest assessment" asks.
    one(`SELECT * FROM pt_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_posture_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_mobility_performance_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    one(`SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    // Read for the programme, not only for a meal plan. See the nutrition
    // section in training-brief.js for which four of its fields change what a
    // client can be asked to train and why the rest stay out.
    one(`SELECT * FROM pt_nutrition_assessments WHERE client_id = $1
          ORDER BY assessment_date DESC NULLS LAST, created_at DESC LIMIT 1`),
    many(`SELECT * FROM pt_goals WHERE client_id = $1 AND is_active = true
           ORDER BY created_at DESC LIMIT 3`),
    // ── EVERY active assignment, not the first one a LIMIT happened to hit ─
    //
    // workout_assignments is UNIQUE on (plan, client, status), so a client may
    // hold several active rows at once and four of this studio's clients do.
    // They all come back; assignments.js picks one by a total order and names
    // the others, so an ambiguous state is reported to the trainer instead of
    // being resolved invisibly by whichever row the planner returned first.
    many(
      `SELECT wa.id, wa.start_date, wa.end_date, wa.status, wa.progress_pct, wa.created_at,
              wp.id AS plan_id, wp.name AS plan_name, wp.duration_weeks,
              wp.progression_type, wp.progression_amount, wp.progression_every_weeks,
              (SELECT COUNT(DISTINCT we.day_of_week) FROM workout_exercises we
                WHERE we.workout_plan_id = wp.id AND we.week_number = 1)::int AS planned_days_count
         FROM workout_assignments wa
         JOIN workout_plans wp ON wp.id = wa.workout_plan_id
        WHERE wa.client_id = $1 AND wa.status = 'active'
        ORDER BY ${ACTIVE_ASSIGNMENT_ORDER}`,
    ),
    many(
      `SELECT id, status, session_date, workout_day, workout_assignment_id
         FROM workout_sessions
        WHERE client_id = $1 AND session_date >= CURRENT_DATE - ($2 * INTERVAL '1 week')`,
      [clientId, weeks],
    ),
    // target_muscle rides along so weekly volume needs no second query — the
    // same key muscle_volume_landmarks and the analytics screen use. Null for
    // a set whose exercise was typed free-hand, which is 29 of production's
    // 408 completed sets, and reported rather than dropped.
    many(
      `SELECT wse.exercise_name, s.weight_kg, s.reps, s.rpe, s.rir, s.completed,
              ws.session_date, e.target_muscle
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
    many(`SELECT week_start_date, weight, mood, sleep_hours, water_glasses,
                 stress_level, energy_level, soreness_level, created_at
            FROM weekly_checkins WHERE client_id = $1
           ORDER BY week_start_date DESC NULLS LAST, created_at DESC LIMIT 12`),
    // The studio's equipment. No column on pt_clients records what a client
    // can train with, and training_mode is Offline/Online/Hybrid — WHERE they
    // train, not what with. Org-scoped in the statement: a platform-wide
    // caller matches no row and gets nothing, which is the correct answer,
    // because there is no one studio whose equipment to report.
    one(`SELECT value FROM system_settings
          WHERE organization_id = $1 AND key = 'studio_equipment' LIMIT 1`, [orgId]),
    resolveLandmarks(orgId),
    retrieve ? retrieve() : Promise.resolve({ ragChunks: [], exercises: [] }),
  ]);

  const ragChunks = retrieved?.ragChunks ?? [];
  const exercises = retrieved?.exercises ?? [];

  // ── Which programme, decided once ───────────────────────────────────────
  const selection = selectActiveAssignment(assignments);
  const assignment = selection.chosen;

  // The brief comes FIRST, because it is what decides which assessments are
  // stale, and a fact carries the age of the assessment it came from.
  const brief = buildBrief({
    client, parq, assessment, posture, mobility, lifestyle, nutrition,
    goal: goals[0] ?? null, assignment, recentSessions: sessions,
  });

  // ── The facts the prompt may state ──────────────────────────────────────
  //
  // Fed the SAME rows everything else here is built from. This is the
  // difference the module exists for: the facts resolver and the brief can no
  // longer disagree about which assessment is the latest one, because there is
  // only one latest assessment now — and a weight resolved from an assessment
  // the brief called stale is now labelled stale on the line that states it.
  const { facts, data_quality: dataQuality } = resolveClientFacts({
    client,
    profile,
    goals,
    latestAssessment: assessment,
    latestCheckin: checkins[0] ?? null,
    lifestyle,
    workoutAssignments: assignment ? [assignment] : [],
    studioEquipment: equipment?.value ?? null,
  }, stated, { stale: brief.stale });
  const recovery = buildRecovery(checkins);
  const history = buildTrainingHistory({
    sets,
    assignment: adherenceInputs(assignment, sessions, weeks),
    windowWeeks: weeks,
  });
  const rules = evaluate({
    parq, mobility, posture, lifestyle, client,
    // The trainer's stated equipment can only NARROW what the screen allows;
    // client-facts.js is where that precedence is decided and justified.
    equipment: equipmentFrom(facts.equipment?.value ?? null),
    exercises,
    history,
    recovery,
    weeklySets: weeklyMuscleSets(sets, isoWeek),
    landmarks,
  });

  const program = programState(assignment, sessions, today);

  // ── The exact next workout, and what to do with each lift in it ─────────
  //
  // A second round-trip rather than a fifteenth entry in the Promise.all
  // above, because it is keyed by the plan we have only just chosen. Skipped
  // entirely when there is no live programme, which is 29 of 34 clients — the
  // common path costs nothing.
  let planRows = [];
  if (assignment && !program.expired) {
    planRows = await many(
      `SELECT we.exercise_id, e.name, we.week_number, we.day_of_week, we.sets, we.reps,
              we.rest_seconds, we.sort_order, we.notes, we.target_weight, we.tempo, we.rpe
         FROM workout_exercises we
         LEFT JOIN exercises e ON e.id = we.exercise_id
        WHERE we.workout_plan_id = $1
        ORDER BY we.week_number, we.day_of_week, we.sort_order`,
      [assignment.plan_id],
    );
  }

  const next = nextSession({
    assignment, planRows, sessions, today, expired: program.expired,
  });
  const adaptation = adaptationDecisions({
    prescribed: next.resolvable ? next.exercises : [],
    sets,
  });

  return {
    client,
    facts,
    data_quality: dataQuality,

    // What loadDigitalTwin used to return, unchanged in shape so the screen,
    // the prompt and the audit read exactly what they read before.
    twin: {
      client, brief, recovery, history, rules, program, window_weeks: weeks,
    },

    program,
    // Null unless more than one assignment claims to be active. Never a
    // silent resolution: see assignments.js.
    assignment_ambiguity: ambiguityOf(selection),
    active_assignment: assignment,
    next_session: next,
    adaptation,
    // Every movement the live block prescribes, across all days and weeks.
    // The audit's adaptation-retention rule measures against this; an empty
    // list is a client with no live plan, and the rule does not fire.
    plan_exercise_names: [...new Set(planRows.map((r) => r.name).filter(Boolean))],

    // The rows the caller still needs in its own right: the diet-side
    // assessment for the fuelling block, the free-text columns the workout
    // extras resolve from, and the retrieval.
    record: {
      profile, goals, lifestyle, nutrition,
      latestAssessment: assessment,
      latestCheckin: checkins[0] ?? null,
      workoutAssignments: assignments,
      studioEquipment: equipment?.value ?? null,
    },
    ragChunks,
    exercises,
    window_weeks: weeks,
  };
}

module.exports = { loadProgrammingContext };

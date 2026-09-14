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
const { buildTrainingHistory, isoWeek } = require('./training-history');
const { screenExercise, weeklyMuscleSets } = require('./programming-rules');
const { normaliseName } = require('./plan-critic');
const { volumeLandmarks, deloadTriggers } = require('./programming-rules');
const { detectSignals, summariseRoster } = require('./training-signals');
const { weekOf } = require('./progression');
const { today: studioToday } = require('../../lib/appTime');

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
 * A date column as 'YYYY-MM-DD', whatever the driver handed us.
 *
 * node-postgres parses DATE into a JS Date and leaves TEXT as a string, and
 * this table has been both over its life. Mirrors dateOf() in
 * training-brief.js rather than inventing a second convention.
 */
function isoDay(v) {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
}

/**
 * Where this client currently IS inside their programme.
 *
 * ── Why the generator needs this ───────────────────────────────────────────
 *
 * Without it, a trainer pressing Generate for someone three weeks into a
 * twelve-week block got a brand new twelve-week block. Not an adaptation, not
 * a progression — a second programme, written as though the first did not
 * exist, and saved alongside it as a second active assignment. The engine knew
 * an assignment existed (it named it in the prompt as "currently assigned
 * plan") and knew nothing about where inside it the client had got to.
 *
 * Everything here is derived from rows already loaded for other reasons, and
 * the week comes from progression.js's own weekOf() — the same function that
 * decides which week's prescription a session shows — so the number the
 * generator reads is the number the session engine uses. Two answers to "what
 * week is this client on" is exactly the kind of second truth this module
 * exists to prevent.
 *
 * `expired` is its own state rather than folded into "no programme": a block
 * that ran out last week is a client who needs the NEXT one, which is a
 * different conversation from a client who never had one.
 */
function programState(assignment, sessions = [], today = studioToday()) {
  if (!assignment) return { active: false };

  // ── A pg DATE is a Date, not a string ────────────────────────────────────
  //
  // This was `String(assignment.start_date).slice(0, 10)`, which is right for
  // the 'YYYY-MM-DD' a test fixture supplies and wrong for what the driver
  // actually returns: node-postgres parses a DATE column into a JS Date, and
  // String() on that gives "Mon Aug 24 2026 00:00:00 GMT+0530 ...". Sliced to
  // ten characters that is "Mon Aug 24" — which weekOf cannot parse, so it
  // returned its no-answer fallback of week 1.
  //
  // A client three weeks into a block was therefore reported as being in week
  // 1 of it, and the adapt prompt would have told the model to continue from a
  // week the client finished a fortnight ago. Every unit test passed, because
  // every unit test handed it a string.
  const started = isoDay(assignment.start_date);
  const durationWeeks = Number(assignment.duration_weeks) || null;
  const currentWeek = started ? weekOf(started, today) : null;
  const expired = Boolean(durationWeeks && currentWeek && currentWeek > durationWeeks);

  return {
    active: true,
    plan_id: assignment.plan_id ?? null,
    plan_name: assignment.plan_name ?? null,
    started_on: started,
    duration_weeks: durationWeeks,
    current_week: currentWeek,
    // Null rather than a negative number when the block has no stated length:
    // "unknown" and "none left" are different answers.
    weeks_remaining: durationWeeks && currentWeek ? Math.max(0, durationWeeks - currentWeek) : null,
    planned_days_per_week: Number(assignment.planned_days_count) || null,
    // Completed sessions inside the history window, not since the plan began —
    // named as such so nobody reads it as a lifetime total.
    sessions_completed_in_window: sessions.filter((x) => x?.status === 'completed').length,
    progress_pct: assignment.progress_pct ?? null,
    expired,
  };
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
    for (const m of rules.volume.muscles) {
      // A muscle the studio has set no range for is reported with its count
      // and no verdict — the same refusal the analytics screen makes.
      if (m.status === null) continue;
      L.push(`- ${m.muscle}: ${m.latest_sets} sets last week`
        + ` (this studio's range is ${m.mev_sets}-${m.mrv_sets}) — ${m.status}`);
    }
    if (rules.volume.unranged.length) {
      L.push(`- Trained but against no range set by this studio: ${rules.volume.unranged.join(', ')}.`
        + ' Do not judge those as high or low.');
    }
    if (rules.volume.unattributable_sets) {
      L.push(`- ${rules.volume.unattributable_sets} sets could not be attributed to a muscle,`
        + ' so these counts are a floor, not a total.');
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

  // ── Fuelling and recovery inputs the nutrition assessment holds ─────────
  //
  // These are in a WORKOUT prompt because they change what a person can be
  // asked to do, not because the model should write a meal plan — and the
  // last line says so, because a model handed food data will otherwise
  // helpfully prescribe some.
  const nut = brief.sections.nutrition;
  if (nut?.present) {
    const N = [];
    if (nut.medical_conditions.length) N.push(`- Medical conditions recorded on the nutrition assessment: ${nut.medical_conditions.join(', ')}.`);
    if (nut.medical_notes) N.push(`- Nutrition assessment medical notes: ${nut.medical_notes}`);
    if (nut.meals_per_day !== null) N.push(`- Eats ${nut.meals_per_day} meals a day.`);
    if (nut.water_intake_liters !== null) N.push(`- Drinks about ${nut.water_intake_liters} litres of fluid a day.`);
    if (nut.late_night_eating === true) N.push('- Eats late at night, which is a sleep-quality and therefore a recovery input.');
    if (nut.digestive_issues.length) N.push(`- Digestive issues reported: ${nut.digestive_issues.join(', ')}.`);
    if (nut.allergies.length) N.push(`- Food allergies: ${nut.allergies.join(', ')}.`);
    if (N.length) {
      L.push('', 'FUELLING AND RECOVERY (from the nutrition assessment):', ...N);
      L.push('Weigh these as recovery capacity and as constraints on session demand. Do NOT write a diet, a calorie target, a macro split or a meal plan — that is a separate assessment and a separate plan.');
    }
  } else {
    L.push('', 'No nutrition assessment is on file, so nothing is known about this client\'s fuelling, hydration or food-related medical history. Do not assume it is adequate.');
  }

  if (brief.missing.length) {
    L.push('', `NOT ASSESSED — you may recommend measuring these, but must not describe them: ${brief.missing.join(', ')}.`);
  }

  // ── Age is a fact about the evidence ─────────────────────────────────────
  //
  // A screen the studio took two years ago fed this prompt with exactly the
  // authority of one taken last week, and the more dangerous half is the
  // silence: an ABSENT finding in a stale screen reads as "nothing wrong
  // there", when it means "nothing was wrong there, two years ago, before
  // whatever they have not mentioned since".
  //
  // Said rather than acted on. Dropping a stale screen would throw away the
  // only evidence the studio has; trusting it silently is what this replaces.
  if (brief.stale?.length) {
    L.push('', 'STALE — on file but old. Treat these as weaker evidence, and say in the plan that they are worth repeating. An absence of findings in a stale screen is NOT evidence that nothing is wrong now:');
    for (const st of brief.stale) {
      L.push(`- ${st.section}: last assessed ${st.as_of} (${st.age_days} days ago; treated as current for up to ${st.stale_after_days}).`);
    }
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
async function lookupExercisesByName(names = [], { orgId, userId } = {}) {
  const wanted = [...new Set(names.map(normaliseName).filter(Boolean))];
  if (!wanted.length || !orgId || !userId) return [];

  const { rows } = await pool.query(
    `SELECT id, name, muscle_group, body_part, target_muscle, movement_pattern, equipment, difficulty
       FROM exercises
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND (organization_id IS NULL OR (organization_id = $1::uuid AND created_by = $2))
        AND regexp_replace(lower(btrim(name)), '[^a-z0-9]+', ' ', 'g') = ANY($3::text[])`,
    [orgId, userId, wanted],
  );
  return rows;
}

/**
 * Normalised name → the library row to file it under.
 *
 * The same lookup the screen uses, returning the id rather than a verdict:
 * saving a generated plan needs an exercise_id, which is NOT NULL with a
 * foreign key, and a name that does not resolve cannot be stored at all.
 *
 * Where two library rows normalise onto one name — four pairs do, every one
 * sharing a target_muscle — the FIRST is kept and the choice is arbitrary by
 * admission. That is safe here in a way it is not for screening: both rows are
 * the same exercise, so filing under either is correct, whereas clearing a
 * safety verdict from the more permissive twin would not be.
 */
async function resolveExerciseNames(names = [], { orgId, userId } = {}) {
  const out = new Map();
  for (const row of await lookupExercisesByName(names, { orgId, userId })) {
    const key = normaliseName(row.name);
    if (!out.has(key)) out.set(key, { id: row.id, name: row.name });
  }
  return out;
}

async function screenPlanExercises(names = [], { orgId, userId, screen } = {}) {
  if (!screen) return new Map();
  const rows = await lookupExercisesByName(names, { orgId, userId });

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

/**
 * The studio's weekly set ranges per muscle, or the platform defaults.
 *
 * The same resolution workout-log.routes.js has always used for the analytics
 * screen: DISTINCT ON with the NULL organization sorted last, which expresses
 * "mine, else the shared one" in a single pass.
 *
 * Shared rather than re-derived because the programming engine and the
 * analytics screen must agree. The first version of programming-rules.js
 * hardcoded its own coarser ranges, so a studio that edited its landmarks in
 * the UI saw them honoured on one screen and ignored by the engine.
 *
 * Muscles with no row come back absent, and volumeLandmarks reports them as
 * unranged rather than judging them — six of the library's eighteen target
 * muscles are in that position today.
 */
async function resolveLandmarks(orgId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (target_muscle) target_muscle, mev_sets, mrv_sets
       FROM muscle_volume_landmarks
      WHERE organization_id IS NULL OR ($1::uuid IS NOT NULL AND organization_id = $1)
      ORDER BY target_muscle, organization_id NULLS LAST`,
    [orgId || null],
  );
  // The table stores muscle names lowercase ("middle back"); the library
  // spells them "Middle Back". Keyed on the library's spelling, because that
  // is what the set rows carry.
  const out = new Map();
  for (const r of rows) {
    out.set(titleCaseMuscle(r.target_muscle), { mev_sets: r.mev_sets, mrv_sets: r.mrv_sets });
  }
  return out;
}

/** "middle back" → "Middle Back", matching exercises.target_muscle. */
function titleCaseMuscle(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
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
              WHERE ws.client_id = c.id
                AND ${TRAINING_HAPPENED}) AS last_session
       FROM pt_clients c
      WHERE c.deleted_at IS NULL
        AND ($1::uuid IS NULL OR c.organization_id = $1)
        AND ($2::text IS NULL OR c.trainer_id = $2)
      ORDER BY c.name`,
    [orgId || null, trainerId || null],
  );
  if (!clients.length) return summariseRoster([]);

  const [{ rows: sets }, landmarks] = await Promise.all([
    pool.query(
      `SELECT ws.client_id, wse.exercise_name, s.weight_kg, s.reps, s.rpe, s.rir,
              s.completed, ws.session_date, e.target_muscle
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
    ),
    // Resolved once for the whole sweep: the ranges are the studio's, not the
    // client's, so resolving inside the loop would be one query per client.
    resolveLandmarks(orgId),
  ]);

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
    const volume = volumeLandmarks(weeklyMuscleSets(clientSets, isoWeek), landmarks);
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

/**
 * When did this client last actually train?
 *
 * ── Why this is not `status = 'completed'` ─────────────────────────────────
 *
 * It was, and that produced a wrong answer on the trainer's screen. Measured
 * on production the day this changed: 22 sessions sat in `in_progress` with
 * sets logged against them, and one client — who had trained the previous day
 * — was being reported as 41 days silent, which on a GONE_DAYS threshold of 21
 * renders as "Paying, and stopped coming. Contact them this week." Two more
 * clients had logged sets and no completed session at all, so they read as
 * "Paid but has never trained".
 *
 * The root cause is a conflation. `workout_sessions.status` is a UI WORKFLOW
 * state — did the trainer tap Finish — and the schema lets it be set with no
 * evidence at all (17 of 54 completed sessions in production hold zero sets).
 * Whether the client TRAINED is a different question, and a logged set answers
 * it unambiguously: somebody stood in the gym and put a number in.
 *
 * So a session counts as training when the trainer marked it complete OR it
 * carries at least one logged set. Both are evidence that the client was
 * there; neither alone is sufficient, because trainers do both.
 *
 * ── Deliberately narrow ────────────────────────────────────────────────────
 *
 * Exported as one string so this definition has exactly one home, but it is
 * applied ONLY where the question is "was the client here". It is not swapped
 * into `recomputeAssignmentProgress` or the public stats counters: those count
 * completed sessions against a prescription, and widening them silently would
 * change what a studio's progress bar and public numbers mean. Those are
 * separate decisions and they need their own evidence.
 */
const TRAINING_HAPPENED = `(
  ws.status = 'completed'
  OR EXISTS (
    SELECT 1
      FROM workout_session_exercises wse
      JOIN workout_sets s ON s.session_exercise_id = wse.id
     WHERE wse.session_id = ws.id
  )
)`;

/** Cap on one sweep's set pull. Production's whole studio is 408. */
const MAX_SWEEP_SETS = 20000;

module.exports = {
  programState,
  TRAINING_HAPPENED,
  resolveLandmarks,
  screenPlanExercises,
  resolveExerciseNames,
  sweepRoster,
  describeTwin,
  limitationsLine,
  adherenceInputs,
  DEFAULT_WINDOW_WEEKS,
  MAX_SETS,
};

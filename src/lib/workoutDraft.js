'use strict';

// Siri Phase 5 — building a workout draft, and the safety work around it.
//
// Split out of routes/voice.js because none of this is HTTP: it is the
// reading of a client's situation, the filtering of a library against their
// injuries, and the assembly of a plan. The route decides who may ask; this
// decides what a safe answer looks like.
//
// ── The rule that shapes everything here ─────────────────────────────────
//
// A model may CHOOSE exercises. It may never NAME one into the plan. Every
// exercise that reaches the draft is a row this module read out of the live
// `exercises` table by id, after checking it is active, visible to this
// studio, and not contraindicated for this client. An AI that hallucinates
// "Barbell Neck Crank" produces an id that resolves to nothing and is dropped
// — it cannot invent an exercise into somebody's programme, because the only
// exercises that exist are the ones the library already had.

const pool = require('../db/pool');
const { randomUUID } = require('crypto');
const logger = require('./logger');

/** Plan size. A voice command should not be able to ask for 40 sessions. */
const MIN_DAYS = 1;
const MAX_DAYS = 6;
const DEFAULT_DAYS = 4;
const PER_DAY = 5;

/**
 * Everything the generator is allowed to know about the client.
 *
 * Deliberately narrow: a name, what they are training for, what they can do,
 * and what would hurt them. No contact details, no payments, no notes — none
 * of which improve a programme and all of which would end up in a draft row
 * and an audit log.
 */
async function loadClientContext(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.goal, c.health_conditions, c.injuries,
            c.workout_experience_level, c.preferred_training_days,
            wa.plan_name, wa.plan_goal, wa.plan_difficulty, wa.plan_id
       FROM pt_clients c
       LEFT JOIN LATERAL (
         SELECT wp.id AS plan_id, wp.name AS plan_name, wp.goal AS plan_goal,
                wp.difficulty AS plan_difficulty
           FROM workout_assignments a
           JOIN workout_plans wp ON wp.id = a.workout_plan_id
          WHERE a.client_id = c.id AND a.status = 'active'
          ORDER BY a.start_date DESC
          LIMIT 1
       ) wa ON TRUE
      WHERE c.id = $1 AND c.deleted_at IS NULL AND c.organization_id = $2`,
    [clientId, orgId]
  );
  return rows[0] || null;
}

/**
 * How many sessions this client has actually logged, and when they last did.
 *
 * Used to pick difficulty, and to say so out loud. "Based on his current
 * programme" is only honest if the programme was read; a draft built from
 * nothing should say it was built from nothing.
 */
async function loadHistory(clientId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS sessions,
            MAX(session_date)::TEXT AS last_session
       FROM workout_sessions
      WHERE client_id = $1 AND status = 'completed'`,
    [clientId]
  );
  return rows[0] || { sessions: 0, last_session: null };
}

/**
 * The client's contraindication terms, as lowercase tokens.
 *
 * `health_conditions` and `injuries` are free text — "lower back pain, knee
 * surgery 2024" — because that is what the enrolment form collects. Splitting
 * on punctuation and comparing tokens is cruder than a coded vocabulary and is
 * what the data supports; the failure it is tuned against is the one that
 * matters, which is missing a restriction rather than over-excluding an
 * exercise. An exercise wrongly withheld is a slightly worse programme. An
 * exercise wrongly included is a person's back.
 */
function restrictionTerms(client) {
  const raw = [client.health_conditions, client.injuries]
    .filter(Boolean)
    .join(', ')
    .toLowerCase();

  return [...new Set(
    raw.split(/[,;/|\n.]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3)
  )];
}

/**
 * Does this exercise conflict with anything the client has on file?
 *
 * Matches in BOTH directions: a client term appearing in a contraindication
 * ("knee" in "knee injury"), and a contraindication appearing in a client term
 * ("knee injury" in "previous knee injury, cleared"). One-directional matching
 * missed the second shape, which is the one enrolment forms actually produce.
 */
function conflictFor(exercise, terms) {
  const contra = (exercise.contraindications || []).map((c) => String(c).toLowerCase());
  for (const c of contra) {
    for (const t of terms) {
      if (c.includes(t) || t.includes(c)) {
        return { contraindication: c, matched: t };
      }
    }
  }
  return null;
}

/**
 * Candidate exercises: the live library, as this studio may see it.
 *
 * `organization_id IS NULL` is the shared built-in library; a studio's own
 * customs are its rows. `visibility = 'private'` is excluded even inside the
 * owning studio — a private exercise is one somebody chose not to publish, and
 * a voice command is not the place it should first resurface.
 */
async function loadCandidates(orgId) {
  const { rows } = await pool.query(
    `SELECT id, name, muscle_group, difficulty, contraindications,
            sets_default, reps_default, rest_seconds
       FROM exercises
      WHERE is_active = TRUE
        AND deleted_at IS NULL
        AND archived_at IS NULL
        AND visibility IN ('public','organization')
        AND (organization_id IS NULL OR organization_id = $1)
      ORDER BY muscle_group, name`,
    [orgId]
  );
  return rows;
}

/** Muscle groups in the order a week is usually split. */
const SPLIT = ['Legs', 'Chest', 'Back', 'Shoulders', 'Arms', 'Core'];

/**
 * Pick exercises for `days` sessions, one muscle group per day.
 *
 * Deterministic: same library, same client, same plan. That is the point of it
 * being the fallback — when the model is unconfigured, over quota, or down,
 * the trainer still gets a defensible programme rather than an error. It is
 * the same posture coach-ai.js takes, for the same reason: a feature that
 * disappears when an API does teaches people not to rely on it.
 */
function selectDeterministic(candidates, days, difficulty) {
  const byGroup = new Map();
  for (const ex of candidates) {
    const g = ex.muscle_group || 'Full Body';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(ex);
  }

  // Prefer the client's level, but never return an empty day because the
  // library has nothing at that level — a harder or easier exercise a trainer
  // can adjust beats a blank session.
  const rank = (ex) => (ex.difficulty === difficulty ? 0 : 1);

  const chosen = [];
  for (let day = 1; day <= days; day++) {
    const group = SPLIT[(day - 1) % SPLIT.length];
    const pool_ = (byGroup.get(group) || []).slice().sort((a, b) => rank(a) - rank(b));
    const forDay = pool_.slice(0, PER_DAY);
    forDay.forEach((ex, i) => chosen.push({ exercise: ex, day_of_week: day, sort_order: i }));
  }
  return chosen;
}

/**
 * Turn whatever the model returned into exercise rows — by ID LOOKUP ONLY.
 *
 * The model is given a list of real ids and asked to choose among them. Any id
 * it returns that is not in `allowed` is discarded silently: that is a
 * hallucination, and the correct handling of a hallucinated exercise is that
 * it never existed. Nothing here trusts a name, a description, or a set count
 * from the model into the database.
 */
function resolveModelChoice(raw, allowed, days) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.days)) return null;

  const byId = new Map(allowed.map((e) => [e.id, e]));
  const chosen = [];

  parsed.days.slice(0, days).forEach((day, dayIdx) => {
    const ids = Array.isArray(day?.exercise_ids) ? day.exercise_ids : [];
    ids.slice(0, PER_DAY).forEach((id, i) => {
      const ex = byId.get(String(id));
      if (ex) chosen.push({ exercise: ex, day_of_week: dayIdx + 1, sort_order: i });
    });
  });

  // A model that returned nothing usable is a model that did not answer. Fall
  // back rather than saving a two-exercise week because a parse half-worked.
  return chosen.length >= days ? chosen : null;
}

const SYSTEM_PROMPT = [
  'You are a strength coach selecting exercises for a personal training plan.',
  'You will be given a numbered list of exercises that already exist in this',
  'gym\'s library. Choose ONLY from that list, and refer to each exercise by',
  'its exact id.',
  '',
  'Reply with JSON only, in this shape:',
  '{"days":[{"focus":"Legs","exercise_ids":["<id>","<id>"]}]}',
  '',
  'Every id must come from the provided list. Do not invent exercises, do not',
  'rename them, and do not add fields.',
].join('\n');

/**
 * Build the draft.
 *
 * The AI path and the deterministic path converge on the SAME structure and
 * both go through the same contraindication filter — the filter runs on the
 * candidate list BEFORE either selector sees it, so a contraindicated exercise
 * is never among the options in the first place. Filtering after selection
 * would leave the model free to pick one and rely on a later pass to catch it.
 */
async function buildDraft({ client, history, orgId, days, chat }) {
  const terms = restrictionTerms(client);
  const all = await loadCandidates(orgId);

  const safe = [];
  const excluded = [];
  for (const ex of all) {
    const conflict = conflictFor(ex, terms);
    if (conflict) {
      excluded.push({ exercise_id: ex.id, name: ex.name, ...conflict });
    } else {
      safe.push(ex);
    }
  }

  if (!safe.length) {
    return { error: 'NO_SAFE_EXERCISES', excluded, terms };
  }

  const difficulty = difficultyFor(client, history);

  let chosen = null;
  let source = 'derived';

  if (typeof chat === 'function') {
    try {
      const res = await chat({
        intent: 'coaching',
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: promptFor(client, history, days, difficulty, safe) },
        ],
      });
      chosen = resolveModelChoice(res?.content, safe, days);
      if (chosen) source = 'ai';
    } catch (err) {
      // Unconfigured key, timeout, every model down. The deterministic
      // selection below is still a correct programme.
      logger.warn({ err: err.message }, 'voice draft: model selection failed');
    }
  }

  if (!chosen) chosen = selectDeterministic(safe, days, difficulty);

  if (!chosen.length) {
    return { error: 'GENERATION_FAILED', excluded, terms };
  }

  return {
    source,
    excluded,
    terms,
    plan: {
      name: `${client.name.split(/\s+/)[0]}'s ${days}-day plan`,
      goal: normaliseGoal(client.plan_goal || client.goal),
      difficulty,
      duration_weeks: 4,
      sessions_per_week: days,
      based_on_plan_id: client.plan_id || null,
      based_on_plan_name: client.plan_name || null,
    },
    exercises: chosen.map((c) => ({
      exercise_id: c.exercise.id,
      name: c.exercise.name,
      muscle_group: c.exercise.muscle_group,
      day_of_week: c.day_of_week,
      sort_order: c.sort_order,
      sets: c.exercise.sets_default || 3,
      reps: c.exercise.reps_default || 12,
      rest_seconds: c.exercise.rest_seconds || 60,
    })),
  };
}

/**
 * `workout_plans.goal` is a CHECK column; `pt_clients.goal` is free text.
 *
 * The enrolment form writes whatever the client said — "lose belly fat",
 * "get stronger", "" — and inserting that straight into the plan violates the
 * constraint and fails the whole save at COMMIT, after the draft has already
 * been claimed. Mapped here so an unrecognised goal becomes the neutral
 * default rather than an error at the last possible moment.
 */
const PLAN_GOALS = ['weight_loss', 'muscle_gain', 'endurance', 'general_fitness', 'recovery'];

function normaliseGoal(raw) {
  const g = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (PLAN_GOALS.includes(g)) return g;

  // The phrasings the enrolment form actually collects.
  if (/(weight|fat|slim|lose)/.test(g)) return 'weight_loss';
  if (/(muscle|bulk|mass|strength|stronger)/.test(g)) return 'muscle_gain';
  if (/(endur|stamina|cardio|run)/.test(g)) return 'endurance';
  if (/(rehab|recover|injur|physio)/.test(g)) return 'recovery';
  return 'general_fitness';
}

/**
 * Difficulty from what the client has actually done, not from what they say.
 *
 * The active plan's own difficulty wins when there is one — a trainer already
 * made that judgement and a voice command should not quietly overrule it.
 */
function difficultyFor(client, history) {
  if (client.plan_difficulty) return client.plan_difficulty;
  const done = Number(history?.sessions) || 0;
  if (done >= 40) return 'advanced';
  if (done >= 10) return 'intermediate';
  return 'beginner';
}

function promptFor(client, history, days, difficulty, safe) {
  const lines = [
    `Client goal: ${client.plan_goal || client.goal || 'general fitness'}`,
    `Level: ${difficulty}`,
    `Completed sessions on record: ${Number(history?.sessions) || 0}`,
    client.plan_name ? `Current programme: ${client.plan_name}` : 'No current programme on record',
    `Sessions to plan: ${days}`,
    '',
    'Available exercises (id — name — muscle group):',
    // Capped: the whole library would dominate the context window, and the
    // selection is per muscle group anyway.
    ...safe.slice(0, 120).map((e) => `${e.id} — ${e.name} — ${e.muscle_group || 'Full Body'}`),
  ];
  // Restrictions are NOT sent to the model. The contraindicated exercises are
  // already gone from the list above, so there is nothing for it to reason
  // about — and a client's medical text is not something to hand to a
  // third-party API when excluding the exercises server-side achieves the
  // same result.
  return lines.join('\n');
}

/** Bounds the requested plan size, whatever was asked for. */
function clampDays(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(n)));
}

module.exports = {
  loadClientContext, loadHistory, loadCandidates, buildDraft,
  restrictionTerms, conflictFor, selectDeterministic, resolveModelChoice,
  difficultyFor, clampDays, normaliseGoal, randomUUID, PLAN_GOALS,
  MIN_DAYS, MAX_DAYS, DEFAULT_DAYS, PER_DAY, SPLIT, SYSTEM_PROMPT,
};

'use strict';

/**
 * The client facts a workout generation is allowed to assert.
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 *
 * The generator printed a block headed "CLIENT AUTHORITATIVE DATA" and the
 * browser filled part of it in. The Client Profile card sent height 175,
 * weight 75, gender male, experience beginner and four training days for
 * every client whose record did not hold those values, with a comment saying
 * so out loud: "the request fills those with the same defaults the AI coach
 * uses elsewhere".
 *
 * A default is a guess. Printed under that heading it stops being a guess and
 * becomes a fact about a person, and the model then programmes around it — a
 * 175cm, 75kg, male beginner who trains four days a week. For a client whose
 * record is thin, every one of those is fiction, and the trainer reading the
 * plan cannot tell which numbers came from their own database and which the
 * page invented on the way out.
 *
 * So: one resolver, three categories, and no fourth.
 *
 *   RECORDED           the database holds it — the column is named
 *   STATED             the trainer typed it for THIS generation, knowing it
 *                      is not on file, and it is labelled as their statement
 *   MISSING            nobody knows, and the prompt says NOT RECORDED
 *
 * There is deliberately no "assumed". A fact this module cannot source is
 * missing, and missing travels all the way to the trainer's screen and into
 * the generation ledger.
 *
 * ── Blocking versus declarable ─────────────────────────────────────────────
 *
 * Not knowing a client's height does not stop anyone programming for them —
 * no line of this engine reads it, and a trainer who has never measured a
 * client still knows how to prescribe a row. Not knowing their goal, their
 * experience or how often they train does stop it: those three decide
 * exercise selection, volume and the shape of the week, and a programme
 * written without them is a guess wearing a plan's clothes.
 *
 * That split is the whole of BLOCKING below. It is clinical judgement, not a
 * technical limit, which is why it is one list in one place rather than a
 * condition scattered through the route.
 */

const FIELDS = [
  'age', 'gender', 'weight_kg', 'height_cm',
  'goal', 'experience_level', 'training_days', 'equipment',
];

// Without these three a programme cannot be written, only invented.
const BLOCKING = ['goal', 'experience_level', 'training_days'];

/**
 * How many training days `preferred_training_days` names.
 *
 * Stored as the free text the enrolment form joins, e.g. "Mon, Wed, Fri".
 * Counted rather than parsed into weekdays: the count is the only part the
 * generator needs, and a weekday this function failed to recognise would
 * silently lower the frequency rather than fail visibly.
 */
function countDays(text) {
  if (typeof text !== 'string') return null;
  const n = text.split(',').map((s) => s.trim()).filter(Boolean).length;
  return n >= 1 && n <= 7 ? n : null;
}

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Walk candidate sources in precedence order and return the first that has a
 * value, along with the NAME of the column it came from.
 *
 * The name is the point. "Height: 172" tells a trainer nothing about whether
 * the engine read their measurement or someone's guess; "height_cm from
 * client_fitness_profiles.height_cm" tells them exactly where to go and
 * correct it.
 */
function fromSources(candidates, coerce) {
  for (const [source, raw] of candidates) {
    const value = coerce(raw);
    if (value !== null) return { value, source, origin: 'recorded' };
  }
  return null;
}

/**
 * Resolve every fact the workout prompt is allowed to state.
 *
 * `ctx` is what loadAuthoritativeClient returns — the client row plus the
 * fitness profile, goals, latest assessment, latest check-in, lifestyle
 * assessment and active assignments, all read from the database under the
 * caller's tenant.
 *
 * `stated` is what the trainer typed for this one generation. It is consulted
 * ONLY where the database holds nothing, it never overrides a recorded value,
 * and what it supplies is marked `stated` for the rest of its life — in the
 * prompt, in the response, and in the ledger row.
 */
function resolveClientFacts(ctx, stated = {}) {
  const {
    client = {}, profile = null, goals = [], latestAssessment = null,
    latestCheckin = null, lifestyle = null, workoutAssignments = [],
  } = ctx || {};

  const resolved = {
    age: fromSources([
      ['pt_clients.dob', client.dob],
    ], ageFromDob),

    gender: fromSources([
      ['pt_clients.gender', client.gender],
    ], text),

    weight_kg: fromSources([
      ['pt_assessments.weight', latestAssessment?.weight],
      ['pt_clients.weight', client.weight],
      ['weekly_checkins.weight', latestCheckin?.weight],
    ], num),

    height_cm: fromSources([
      ['client_fitness_profiles.height_cm', profile?.height_cm],
      ['pt_clients.height', client.height],
    ], num),

    goal: fromSources([
      ['client_fitness_profiles.goal', profile?.goal],
      ['pt_clients.goal', client.goal],
      ['pt_goals.goal_type', goals[0]?.goal_type],
    ], text),

    experience_level: fromSources([
      ['pt_clients.workout_experience_level', client.workout_experience_level],
      ['client_fitness_profiles.fitness_level', profile?.fitness_level],
      ['pt_lifestyle_assessments.workout_experience_level', lifestyle?.workout_experience_level],
    ], text),

    // sessions_per_week is the typed column the enrolment form writes and the
    // rest of the product already reads. The old resolver looked only at
    // `frequency` — free text, rarely filled — and then took the browser's
    // number, so a client enrolled as training three days a week was
    // programmed for four.
    training_days: fromSources([
      ['pt_clients.sessions_per_week', client.sessions_per_week],
      ['pt_clients.preferred_training_days', countDays(client.preferred_training_days)],
      ['pt_clients.frequency', /^[1-7]$/.test(String(client.frequency ?? '')) ? client.frequency : null],
    ], (v) => {
      const n = num(v);
      return n !== null && n >= 1 && n <= 7 ? n : null;
    }),

    // No authoritative source, and saying so is the honest answer.
    // `training_mode` is Offline / Online / Hybrid — where a client trains,
    // not what they can lift with — so nothing in the schema records their
    // equipment. It stays missing unless a trainer states it.
    equipment: null,
  };

  const facts = {};
  const recorded = [];
  const statedFields = [];
  const missing = [];

  for (const field of FIELDS) {
    const hit = resolved[field];
    if (hit) {
      facts[field] = hit;
      recorded.push({ field, source: hit.source });
      continue;
    }
    const given = field === 'training_days' || field === 'age'
      || field === 'weight_kg' || field === 'height_cm'
      ? num(stated[field])
      : text(stated[field]);
    if (given !== null) {
      facts[field] = { value: given, source: 'trainer', origin: 'stated' };
      statedFields.push({ field });
      continue;
    }
    facts[field] = { value: null, source: null, origin: 'missing' };
    missing.push({ field, blocking: BLOCKING.includes(field) });
  }

  const active = workoutAssignments[0] || null;

  return {
    facts,
    active_assignment: active,
    data_quality: {
      recorded,
      stated: statedFields,
      missing,
      blocking: missing.filter((m) => m.blocking).map((m) => m.field),
      // Of the facts the prompt may state, how many came from the database.
      // Trainer statements deliberately do not count towards it: the number
      // is meant to answer "how much of this does the studio actually know",
      // and a value typed into a box thirty seconds ago is not that.
      completeness_pct: Math.round((recorded.length / FIELDS.length) * 100),
    },
  };
}

/**
 * The facts, as the model is allowed to read them.
 *
 * A missing fact is printed as NOT RECORDED rather than omitted. Omission
 * invites the model to supply a plausible number of its own; a line that says
 * the studio does not hold it, next to an instruction never to infer one, does
 * not.
 */
function describeFacts(facts) {
  const LABEL = {
    age: 'Age', gender: 'Gender', weight_kg: 'Weight (kg)',
    height_cm: 'Height (cm)', goal: 'Goal', experience_level: 'Experience level',
    training_days: 'Training days per week', equipment: 'Available equipment',
  };
  const lines = ['CLIENT FACTS (from the studio\'s records):'];
  for (const field of FIELDS) {
    const f = facts[field];
    if (!f || f.origin === 'missing') {
      lines.push(`- ${LABEL[field]}: NOT RECORDED`);
    } else if (f.origin === 'stated') {
      lines.push(`- ${LABEL[field]}: ${f.value} (stated by the trainer for this session, not on file)`);
    } else {
      lines.push(`- ${LABEL[field]}: ${f.value}`);
    }
  }
  lines.push(
    '',
    'NOT RECORDED means the studio does not hold this value. Do not infer it, do not substitute a typical value, and do not write programming that depends on it. Where a decision would need it, program conservatively and say which value would change your choice.',
  );
  return lines.join('\n');
}

module.exports = {
  FIELDS, BLOCKING, resolveClientFacts, describeFacts,
  // Exported for the tests that pin the parsing rather than the resolution.
  countDays, ageFromDob,
};

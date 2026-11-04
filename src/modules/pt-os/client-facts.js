'use strict';

const { ageFromDob } = require('../../lib/age');
const logger = require('../../lib/logger');
const { classifyGoal } = require('./goal-classification');

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
  'goal', 'experience_level', 'training_days', 'session_minutes', 'equipment',
];

// Without these three a programme cannot be written, only invented.
const BLOCKING = ['goal', 'experience_level', 'training_days'];

/**
 * Columns another module owns, by the fact they duplicate.
 *
 * A fallback read is expected on rows written before the move, but it is still
 * worth seeing: it says the canonical record has no answer for a fact the
 * generator needs, and names the copy that would have to be migrated before
 * the column can be retired.
 */
const LEGACY_SOURCES = {
  height_cm: [['client_fitness_profiles.height_cm', 'Fitness Testing']],
  weight_kg: [['weekly_checkins.weight', 'Fitness Testing']],
  goal: [
    ['client_fitness_profiles.goal', 'Goal'],
    ['pt_clients.goal', 'Goal'],
  ],
  experience_level: [['client_fitness_profiles.fitness_level', 'Client enrolment']],
};

function logLegacyRead(field, owner, source, clientId) {
  logger.info({
    event: 'ownership.deprecated_read',
    field,
    owner,
    source,
    client_id: clientId ?? null,
  }, 'Read a fact from a legacy column because the owner has no answer');
}

/**
 * Fields where a trainer's statement for THIS generation beats the record.
 *
 * The default is the opposite, and deliberately so: a request body must never
 * be able to rewrite a client's age, goal or experience, because that is how
 * the browser used to invent people.
 *
 * Equipment is the one exception, and it is an exception for a safety reason
 * rather than a convenience one. The studio's list says what the gym owns; a
 * trainer typing "dumbbells only today" is saying what is actually available
 * for this session — the rack is booked, the client is training at home, half
 * the floor is being refitted. Preferring the studio's fuller list there would
 * ungate exercises the trainer has just said cannot be done, which is the same
 * failure as the old "full gym" default wearing a better hat.
 *
 * Note the direction: a statement here can only NARROW what is available, so
 * the exception runs towards caution. It is still recorded as `stated`, so
 * nothing downstream mistakes it for the studio's standing inventory.
 */
const STATED_SUPERSEDES = ['equipment', 'session_minutes'];

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

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAY_ALIASES = {
  mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday',
  thu: 'thursday', thur: 'thursday', thurs: 'thursday',
  fri: 'friday', sat: 'saturday', sun: 'sunday',
};

/**
 * The exact weekdays `preferred_training_days` names, or null.
 *
 * "Mon, Wed, Fri" is what the enrolment picker writes. A token this cannot
 * read makes the whole value null rather than quietly dropping a day: the
 * generator must not schedule three days when the trainer picked four.
 */
function preferredDays(value) {
  // Enrolment stores "Mon, Wed, Fri" in a TEXT column; the Goal wizard stores
  // a TEXT[] of full names. Both are the same answer, so normalise the array
  // into the form the rest of this function reads.
  const raw = Array.isArray(value) ? value.join(', ') : value;
  if (typeof raw !== 'string') return null;
  const tokens = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return null;
  const days = [];
  for (const token of tokens) {
    const key = token.replace(/[^a-z]/g, '');
    const day = WEEKDAYS.includes(key) ? key : WEEKDAY_ALIASES[key];
    if (!day || days.includes(day)) return null;
    days.push(day);
  }
  return days.map((d) => d[0].toUpperCase() + d.slice(1)).join(', ');
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Plausible ranges for the numeric facts a trainer may STATE for a generation.
 *
 * The database paths were already bounded — `ageFromDob` refuses anything
 * outside [0, 130) and `countDays` refuses a week with more than seven days in
 * it — but the body path was not. So a typo in the generator form ("750" for a
 * weight, "19" for an age) reached the prompt as
 *
 *     - Weight: 750 (stated by the trainer for this session, not on file)
 *
 * and the model wrote a training programme around it. That is the AI-input
 * hardening rule stated plainly: a value the system would not accept from its
 * own records must not enter the prompt merely because it arrived in a
 * request body.
 *
 * Out of range resolves to `null`, which is the state the engine already has
 * a well-defined answer for — the fact is reported as `missing`, it appears in
 * `data_quality.missing`, and it is flagged blocking where the field is
 * blocking. A gap the trainer can see and fill beats a number nobody checked.
 *
 * The bounds are deliberately wide. They exclude the impossible, not the
 * unusual: a 95-year-old client and a 180kg client are both real, and neither
 * should be turned away by a range check.
 */
const STATED_RANGE = {
  age: [10, 120],
  weight_kg: [20, 400],
  height_cm: [90, 260],
  training_days: [1, 7],
  // pt_clients.session_minutes CHECK (migration 255). The enrolment form
  // offers 30/45/60/75/90; the wider bound is for a trainer typing a session
  // length the form does not list.
  session_minutes: [20, 180],
  // Not one of this module's own FIELDS — the diet generator's, which shares
  // the table so both prompts refuse the same impossible values. "40 meals a
  // day" is a prompt the model will try to satisfy.
  meal_frequency: [1, 12],
};

function numInRange(v, field) {
  const n = num(v);
  if (n === null) return null;
  const range = STATED_RANGE[field];
  if (!range) return n;
  return n >= range[0] && n <= range[1] ? n : null;
}

// The trainer-stated text fields (gender, goal, experience, equipment) are
// answers, not documents. A wall of pasted text is not one, so it reads as
// missing — the same rule an out-of-range number gets.
const STATED_TEXT_MAX = 200;

function text(v, maxLength) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return maxLength && s.length > maxLength ? null : s;
}

/**
 * pt_clients.equipment stores four enum values, not free text (migration 255).
 * The safety screen matches free-text equipment names, and "bands" matches
 * nothing it knows, so map the enum onto the phrase that screen reads. A
 * trainer's own words pass through unchanged.
 */
const EQUIPMENT_LABEL = Object.freeze({
  full_gym: 'full gym',
  dumbbells: 'dumbbells',
  bodyweight: 'bodyweight',
  bands: 'resistance bands',
});

function equipmentText(v) {
  const s = text(v, STATED_TEXT_MAX);
  return s ? (EQUIPMENT_LABEL[s.toLowerCase()] ?? s) : null;
}

/**
 * Walk candidate sources in precedence order, take the first that has a value,
 * and report every OTHER source that disagrees with it.
 *
 * ── Two things at once, deliberately ───────────────────────────────────────
 *
 * The winner carries the NAME of the column it came from. That name is the
 * point: "Height: 172" tells a trainer nothing about whether the engine read
 * their measurement or someone's guess; "from client_fitness_profiles.height_cm"
 * tells them exactly where to go and correct it.
 *
 * The disagreements matter more. This used to `return` on the first hit, so a
 * client whose record says fat loss and whose goal assessment says muscle gain
 * was silently programmed for fat loss — precedence quietly deciding a clinical
 * question, with nothing on any screen saying a decision had been made.
 *
 * Precedence still decides, because SOMETHING has to and a deterministic rule
 * beats a model guessing. What changes is that the choice stops being invisible:
 * the loser is carried on the fact, surfaced to the trainer, told to the model
 * as a disagreement it must not resolve, and frozen in the ledger.
 *
 * Only genuinely different values count. Two sources agreeing is not a
 * conflict, and neither is one of them being empty.
 */
function fromSources(candidates, coerce) {
  let winner = null;
  const conflicts = [];
  for (const [source, raw, at] of candidates) {
    const value = coerce(raw);
    if (value === null) continue;
    const dated = dateOnly(at);
    if (!winner) {
      winner = { value, source, origin: 'recorded', ...(dated ? { at: dated } : {}) };
      continue;
    }
    if (!sameValue(winner.value, value)) {
      conflicts.push({ source, value, ...(dated ? { at: dated } : {}) });
    }
  }
  if (!winner) return null;
  return conflicts.length ? { ...winner, conflicts } : winner;
}

// A fact older than this is still a fact, but the model is told it is old and
// the trainer is told to confirm it. A 13-month-old weight is not today's.
const STALE_AFTER_DAYS = 365;

function dateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function ageInDays(at) {
  const on = dateOnly(at);
  if (!on) return null;
  const days = Math.floor((Date.now() - new Date(`${on}T00:00:00Z`).getTime()) / 86_400_000);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

/** Carry the record's age on the fact, and whether it is past its useful life. */
function withFreshness(fact) {
  if (!fact?.at) return fact;
  const ageDays = ageInDays(fact.at);
  if (ageDays === null) return fact;
  return { ...fact, age_days: ageDays, ...(ageDays > STALE_AFTER_DAYS ? { stale: true } : {}) };
}

/**
 * The first usable timestamp on a row, as YYYY-MM-DD.
 *
 * Content date first, insertion time second — the same rule the SQL loaders
 * order by. A form entered today about a test from six months ago is a
 * six-month-old fact.
 */
function when(row, ...fields) {
  if (!row) return null;
  for (const field of fields) {
    const at = dateOnly(row[field]);
    if (at) return at;
  }
  return null;
}

/**
 * Whether two source values say the same thing.
 *
 * Numbers compare numerically so 3 and "3" agree. Strings compare folded, so
 * "Fat Loss" and "fat_loss" agree — a studio that typed the same goal into two
 * forms with different capitalisation has not contradicted itself, and
 * reporting that as a conflict would train a trainer to ignore the word.
 */
function sameValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  const fold = (v) => String(v).trim().toLowerCase().replace(/[\s_-]+/g, '');
  return fold(a) === fold(b);
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
    latestCheckin = null, lifestyle = null, interview = null,
    workoutAssignments = [], studioEquipment = null, studioEquipmentAt = null,
  } = ctx || {};

  const resolved = {
    age: fromSources([
      ['pt_clients.dob', client.dob],
    ], ageFromDob),

    gender: fromSources([
      ['pt_clients.gender', client.gender],
    ], text),

    weight_kg: fromSources([
      ['pt_assessments.weight', latestAssessment?.weight, when(latestAssessment, 'assessment_date', 'created_at')],
      ['pt_clients.weight', client.weight, when(client, 'updated_at')],
      ['weekly_checkins.weight', latestCheckin?.weight, when(latestCheckin, 'week_start_date', 'created_at')],
    ], num),

    // Fitness Testing owns the live measurement. `pt_clients.height` is the
    // cache the assessment write maintains (D3), and the fitness profile is a
    // legacy copy read only when both have no answer.
    height_cm: fromSources([
      ['pt_assessments.height_cm', latestAssessment?.height_cm, when(latestAssessment, 'assessment_date', 'created_at')],
      ['pt_clients.height', client.height, when(client, 'updated_at')],
      ['client_fitness_profiles.height_cm', profile?.height_cm, when(profile, 'updated_at', 'created_at')],
    ], num),

    // The client's ACTIVE goal first. pt_goals is the dated record a trainer
    // sets and changes as the client progresses (loaded is_active, newest
    // first); the profile and enrolment goals are what was typed when the
    // client joined and are rarely revisited. Programming to the enrolment
    // goal after the trainer has set a new one wrote plans for who the client
    // was at sign-up. The older values are still reported as a disagreement.
    goal: fromSources([
      ['pt_goals.goal_type', goals[0]?.goal_type, when(goals[0], 'updated_at', 'created_at')],
      ['client_fitness_profiles.goal', profile?.goal, when(profile, 'updated_at', 'created_at')],
      ['pt_clients.goal', client.goal, when(client, 'updated_at')],
    ], classifyGoal),

    experience_level: fromSources([
      ['pt_clients.workout_experience_level', client.workout_experience_level, when(client, 'updated_at')],
      ['client_fitness_profiles.fitness_level', profile?.fitness_level, when(profile, 'updated_at', 'created_at')],
      ['pt_lifestyle_assessments.workout_experience_level', lifestyle?.workout_experience_level, when(lifestyle, 'assessment_date', 'created_at')],
    ], text),

    // sessions_per_week is the typed column the enrolment form writes and the
    // rest of the product already reads. The Goal wizard's designed frequency
    // is next: that is the trainer's own programme shape, written after the
    // enrolment form and read by nothing until now. The Client Interview's
    // answer follows — a direct, structured "days a week I can really train"
    // the client gave during onboarding. Counting the preferred weekdays and
    // the free-text frequency follow, both being weaker derivations of the
    // same question. A disagreement is reported rather than silently dropped.
    training_days: fromSources([
      ['pt_clients.sessions_per_week', client.sessions_per_week, when(client, 'updated_at')],
      ['pt_goals.training_days_per_week', goals[0]?.training_days_per_week, when(goals[0], 'updated_at', 'created_at')],
      ['pt_client_interviews.lifestyle_training_days', interview?.lifestyle_training_days, when(interview, 'completed_at', 'updated_at', 'created_at')],
      ['pt_clients.preferred_training_days', countDays(client.preferred_training_days), when(client, 'updated_at')],
      ['pt_clients.frequency', /^[1-7]$/.test(String(client.frequency ?? '')) ? client.frequency : null, when(client, 'updated_at')],
    ], (v) => {
      const n = num(v);
      return n !== null && n >= 1 && n <= 7 ? n : null;
    }),

    // The companion to the count: which days, not just how many. Not part of
    // FIELDS because it is not an independent blocking fact — the count is.
    preferred_days: fromSources([
      ['pt_clients.preferred_training_days', preferredDays(client.preferred_training_days), when(client, 'updated_at')],
      ['pt_goals.preferred_training_days', preferredDays(goals[0]?.preferred_training_days), when(goals[0], 'updated_at', 'created_at')],
    ], text),

    // ── Equipment ────────────────────────────────────────────────────────
    //
    // pt_clients.equipment is the client's own answer, added in migration 255;
    // the studio's org-scoped inventory is the fallback for rows written
    // before it. `training_mode` is Offline / Online / Hybrid — WHERE a client
    // trains, not what they can lift with, so it is not a source.
    //
    // Still missing when neither is recorded, and MISSING is the only honest
    // answer then: the old default claimed "full gym" for every client alive,
    // and because equipment feeds the safety screen through equipmentFrom(),
    // that default was quietly ungating equipment-restricted exercises for
    // clients who may own a resistance band.
    equipment: fromSources([
      ['pt_clients.equipment', equipmentText(client.equipment), when(client, 'updated_at')],
      ['system_settings.studio_equipment', studioEquipment, when({ at: studioEquipmentAt }, 'at')],
    ], text),

    // The planned length of one PT session. The prompt needs it to stop
    // prescribing an 80-minute programme into a 45-minute slot; the
    // deterministic generator uses it to cap the exercise count.
    session_minutes: fromSources([
      ['pt_clients.session_minutes', client.session_minutes, when(client, 'updated_at')],
    ], num),
  };

  for (const [field, sources] of Object.entries(LEGACY_SOURCES)) {
    const winner = resolved[field]?.source;
    const legacy = sources.find(([source]) => source === winner);
    if (legacy) logLegacyRead(field, legacy[1], legacy[0], client?.id);
  }

  const facts = {};
  const recorded = [];
  const statedFields = [];
  const missing = [];
  const stale = [];
  // Facts two authoritative sources disagree about. Precedence decided, and
  // said so — this is the record of what it decided against.
  const conflicting = [];

  for (const field of FIELDS) {
    const supersedable = STATED_SUPERSEDES.includes(field)
      && text(stated[field], STATED_TEXT_MAX) !== null;
    const hit = supersedable ? null : resolved[field];
    if (hit) {
      const fact = withFreshness(hit);
      facts[field] = fact;
      recorded.push({ field, source: fact.source, ...(fact.at ? { at: fact.at } : {}) });
      if (fact.stale) {
        stale.push({ field, source: fact.source, at: fact.at, age_days: fact.age_days });
      }
      if (fact.conflicts) {
        conflicting.push({
          field,
          chosen: { source: fact.source, value: fact.value },
          rejected: fact.conflicts,
        });
      }
      continue;
    }
    const given = Object.prototype.hasOwnProperty.call(STATED_RANGE, field)
      ? numInRange(stated[field], field)
      : text(stated[field], STATED_TEXT_MAX);
    if (given !== null) {
      facts[field] = { value: given, source: 'trainer', origin: 'stated' };
      statedFields.push({ field });
      continue;
    }
    facts[field] = { value: null, source: null, origin: 'missing' };
    missing.push({ field, blocking: BLOCKING.includes(field) });
  }

  // The exact weekdays are read alongside the count but are not themselves a
  // FIELDS entry: a client can have a recorded count and an unreadable picker
  // value, and that must not add a second blocking fact.
  //
  // Only when they agree. A record with sessions_per_week = 3 and five picked
  // weekdays would otherwise produce a prompt that demands three sessions on
  // exactly five days — unsatisfiable, and every revision fails it again.
  const weekdays = resolved.preferred_days;
  const weekdayCount = weekdays?.value ? weekdays.value.split(',').length : 0;
  facts.preferred_days = weekdays && weekdayCount === Number(facts.training_days?.value)
    ? withFreshness(weekdays)
    : { value: null, source: null, origin: 'missing' };

  const active = workoutAssignments[0] || null;

  return {
    facts,
    active_assignment: active,
    data_quality: {
      recorded,
      stated: statedFields,
      missing,
      conflicting,
      // Facts old enough that the model must be told, and the trainer must
      // confirm, before either treats them as current.
      stale,
      as_of: new Date().toISOString().slice(0, 10),
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
    training_days: 'Training days per week', session_minutes: 'Session length (minutes)',
    equipment: 'Available equipment',
  };
  const lines = ['CLIENT FACTS (from the studio\'s records):'];
  const freshness = (f) => {
    if (!f.at) return '';
    const age = f.age_days == null ? '' : `, ${f.age_days} days ago`;
    const stale = f.stale ? ' — STALE; confirm with the client before relying on it' : '';
    return ` [recorded ${f.at}${age}${stale}]`;
  };
  for (const field of FIELDS) {
    const f = facts[field];
    if (!f || f.origin === 'missing') {
      lines.push(`- ${LABEL[field]}: NOT RECORDED`);
    } else if (f.origin === 'stated') {
      lines.push(`- ${LABEL[field]}: ${f.value} (stated by the trainer for this session, not on file)`);
    } else if (f.conflicts) {
      const others = f.conflicts.map((c) => `${c.value} in ${c.source}`).join(', ');
      lines.push(`- ${LABEL[field]}: ${f.value} (from ${f.source}; DISPUTED — ${others})${freshness(f)}`);
    } else {
      lines.push(`- ${LABEL[field]}: ${f.value}${freshness(f)}`);
    }
  }
  const days = facts.preferred_days;
  lines.push(days?.origin === 'recorded'
    ? `- Recorded training weekdays: ${days.value}`
    : '- Recorded training weekdays: NOT RECORDED');
  lines.push(
    '',
    'NOT RECORDED means the studio does not hold this value. Do not infer it, do not substitute a typical value, and do not write programming that depends on it. Where a decision would need it, program conservatively and say which value would change your choice.',
  );
  if (FIELDS.some((f) => facts[f]?.conflicts)) {
    lines.push(
      '',
      'DISPUTED means two of the studio\'s own records disagree. The value shown first is the one the studio\'s precedence rule selected, and it is the one to program to. Do NOT pick a different one, do not average them, and do not decide which record is right — that is the trainer\'s call, not yours. Say in the plan that the disagreement exists and which value you programmed to.',
    );
  }
  if (FIELDS.some((f) => facts[f]?.stale)) {
    lines.push(
      '',
      'STALE means the record is more than a year old. Use it only as a starting point, say in the plan that it may no longer be current, and name the value that should be re-measured before the next block.',
    );
  }
  return lines.join('\n');
}

/**
 * The Client Interview, as the model is allowed to read it.
 *
 * The interview is a conversation, not evidence. Everything in the first block
 * is what the CLIENT said — their own account of their training, work, limits
 * and preferences — and the model must not restate it as a measured fact. The
 * second block is the trainer's summary; it is the trainer's judgement and is
 * labelled separately so the two can never be conflated.
 *
 * Nothing here is a clearance. PAR-Q answers and the medical clearance record
 * remain authoritative, and the closing line says so explicitly — an interview
 * that says "no pain" must never be read as permission to train through one.
 */
const CHALLENGE_LABEL = Object.freeze({
  time: 'time',
  work_schedule: 'work schedule',
  motivation: 'motivation',
  confidence: 'confidence',
  pain_or_injury: 'pain or injury',
  fatigue: 'fatigue',
  family: 'family commitments',
  travel: 'travel',
  nutrition: 'nutrition',
  gym_access: 'gym access',
  cost: 'cost',
  other: 'other',
});
const OCCUPATION_LABEL = Object.freeze({
  desk_job: 'Desk job',
  active_job: 'Active job',
  physical_labor: 'Physical labor',
  student: 'Student',
  homemaker: 'Homemaker',
  driver: 'Driver',
  healthcare: 'Healthcare',
  police: 'Police',
  fitness_professional: 'Fitness professional',
  retired: 'Retired',
  other: 'Other',
});
const SPORTS_LABEL = Object.freeze({
  never: 'Never',
  previously: 'Previously',
  currently: 'Currently',
});
const WORK_TYPE_LABEL = Object.freeze({
  desk: 'Desk-based',
  on_feet: 'On feet',
  physical: 'Physical labour',
  mixed: 'Mixed',
  shifts: 'Shift work',
  field: 'On the road / field',
  other: 'Other',
});
const HOURS_BAND_LABEL = Object.freeze({
  under_4: 'Under 4 hours',
  '4_6': '4–6 hours',
  '6_8': '6–8 hours',
  '8_10': '8–10 hours',
  '10_plus': '10+ hours',
  varies: 'Varies',
});
const ACTIVITY_LABEL = Object.freeze({
  mostly_seated: 'Mostly seated',
  light: 'Lightly active',
  moderately_active: 'Moderately active',
  very_active: 'Very active',
});
const TRAINING_DURATION_LABEL = Object.freeze({
  none: 'None yet',
  under_3_months: 'Under 3 months',
  '3_6_months': '3–6 months',
  '6_12_months': '6–12 months',
  '1_2_years': '1–2 years',
  '2_plus_years': '2+ years',
});
const SPORTS_PLAYED_LABEL = Object.freeze({
  cricket: 'Cricket', football: 'Football', badminton: 'Badminton', tennis: 'Tennis',
  table_tennis: 'Table tennis', basketball: 'Basketball', volleyball: 'Volleyball',
  hockey: 'Hockey', athletics: 'Athletics', swimming: 'Swimming', cycling: 'Cycling',
  running: 'Running', boxing: 'Boxing', martial_arts: 'Martial arts', gymnastics: 'Gymnastics',
  rowing: 'Rowing', golf: 'Golf', squash: 'Squash', dance: 'Dance', other: 'Other',
});
const ACTIVITIES_LABEL = Object.freeze({
  walking: 'Walking', running: 'Running', cycling: 'Cycling', swimming: 'Swimming',
  gym_weights: 'Gym weights', cardio_machines: 'Cardio machines', home_workouts: 'Home workouts',
  yoga: 'Yoga', pilates: 'Pilates', martial_arts: 'Martial arts', dance: 'Dance',
  sports: 'Sports', physical_job: 'Physical job', none: 'None',
});
const PREFERENCES_LABEL = Object.freeze({
  free_weights: 'Free weights', machines: 'Machines', bodyweight: 'Bodyweight', cardio: 'Cardio',
  hiit: 'HIIT', yoga: 'Yoga', pilates: 'Pilates', stretching: 'Stretching', outdoors: 'Outdoors',
  group_classes: 'Group classes', home_workouts: 'Home workouts', sports: 'Sports',
  no_preference: 'No preference',
});
const GOAL_LABEL = Object.freeze({
  fat_loss: 'Fat loss', muscle_gain: 'Muscle gain', body_recomposition: 'Body recomposition',
  strength_gain: 'Strength gain', endurance: 'Endurance', general_fitness: 'General fitness',
  mobility: 'Mobility', athletic_performance: 'Athletic performance', medical_fitness: 'Medical fitness',
  wedding_transformation: 'Wedding transformation', senior_fitness: 'Senior fitness',
});
const MOTIVATION_LABEL = Object.freeze({
  health: 'Health', appearance: 'Appearance', energy: 'Energy', confidence: 'Confidence',
  strength: 'Strength', event: 'Upcoming event', doctor_advice: 'Doctor advice', family: 'Family',
  accountability: 'Accountability', stress: 'Stress', sport: 'Sport', habit: 'Habit',
});
const ATTITUDE_LABEL = Object.freeze({
  motivated: 'Motivated', neutral: 'Neutral', anxious: 'Anxious', resistant: 'Resistant',
});
const LEVEL_LABEL = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High' });
const COMMITMENT_LABEL = Object.freeze({ low: 'Low', moderate: 'Moderate', high: 'High' });
const COACHING_LABEL = Object.freeze({ strict: 'Strict', supportive: 'Supportive', balanced: 'Balanced' });
const TRAINING_LEVEL_LABEL = Object.freeze({ beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' });

/** A stored key list as human labels, dropping anything unrecognised. */
function labelsFrom(value, map) {
  if (!Array.isArray(value) || !value.length) return '';
  return value.map((key) => map[key] || key).join(', ');
}

function describeInterview(interview) {
  const i = interview || {};
  const clientLines = [];
  const add = (label, value, max = 2000) => {
    const v = text(value, max);
    if (v) clientLines.push(`- ${label}: ${v}`);
  };

  add('Previous training experience', i.previous_workout_experience, 40);
  add('Training duration', TRAINING_DURATION_LABEL[i.training_duration] || i.training_duration, 40);
  add("Training history (the client's account)", i.training_history);
  add('Sport participation', SPORTS_LABEL[i.sports_participation] || i.sports_participation, 40);
  add('Sports played', labelsFrom(i.sports_played, SPORTS_PLAYED_LABEL));
  add('Previous physical activities', labelsFrom(i.previous_activities, ACTIVITIES_LABEL));
  add('Exercise preferences', labelsFrom(i.exercise_preferences, PREFERENCES_LABEL));
  add('Occupation', text(i.occupation_title, 120) || OCCUPATION_LABEL[i.occupation_type] || i.occupation_type, 120);
  add('Work type', WORK_TYPE_LABEL[i.work_type] || i.work_type, 60);
  add('Working hours', HOURS_BAND_LABEL[i.work_hours_band] || i.work_hours_band, 40);
  add('Work details', i.job_details);
  add('Other occupation details', i.occupation_other_details, 500);
  add('Sitting hours a day', i.lifestyle_sitting_hours, 10);
  add('Daily activity', ACTIVITY_LABEL[i.daily_activity_level] || i.daily_activity_level, 40);
  if (Array.isArray(i.training_challenges) && i.training_challenges.length) {
    const labels = i.training_challenges.map((k) => CHALLENGE_LABEL[k] || k);
    clientLines.push(`- Training challenges: ${labels.join(', ')}`);
  }
  add('Challenge detail', i.challenge_other, 500);
  if (i.lifestyle_training_days !== null && i.lifestyle_training_days !== undefined && i.lifestyle_training_days !== '') {
    clientLines.push(`- Days a week they can train: ${i.lifestyle_training_days}`);
  }
  add('Availability notes', i.availability, 1000);
  add('Meal regularity', i.lifestyle_meal_regularity, 20);
  add('Fitness goals', labelsFrom(i.fitness_goals, GOAL_LABEL));
  add('Motivation', labelsFrom(i.motivation_factors, MOTIVATION_LABEL));
  add('Motivation notes', i.motivation);
  if (i.programme_readiness !== null && i.programme_readiness !== undefined) {
    clientLines.push(`- Programme readiness (1–10): ${i.programme_readiness}`);
  }
  add('Preferences', i.preferences, 1000);
  add("In the client's words", i.important_client_statements);

  const trainerLines = [];
  const addTrainer = (label, value, max = 120) => {
    const v = text(value, max);
    if (v) trainerLines.push(`- ${label}: ${v}`);
  };
  addTrainer('Client attitude', ATTITUDE_LABEL[i.client_attitude] || i.client_attitude);
  addTrainer('Confidence', LEVEL_LABEL[i.confidence_level] || i.confidence_level);
  addTrainer('Commitment', COMMITMENT_LABEL[i.commitment_level] || i.commitment_level);
  addTrainer('Coaching preference', COACHING_LABEL[i.coaching_preference] || i.coaching_preference);
  addTrainer('Initial training level', TRAINING_LEVEL_LABEL[i.initial_training_level] || i.initial_training_level);

  const trainerNote = text(i.notes);
  if (!clientLines.length && !trainerNote && !trainerLines.length) {
    return [
      'CLIENT INTERVIEW: NOT RECORDED',
      'No interview has been recorded for this client. Do not infer their history, work, barriers, or preferences; program conservatively and say which answer would change your choice.',
    ].join('\n');
  }

  const lines = ['CLIENT INTERVIEW — CLIENT-STATED (the client\'s own intake answers; not verified fact):'];
  lines.push(...(clientLines.length ? clientLines : ['- NOT RECORDED']));
  lines.push('', 'TRAINER\'S INTERVIEW NOTES (the trainer\'s observations, not the client\'s words):');
  if (trainerNote) trainerLines.unshift(`- Summary: ${trainerNote}`);
  lines.push(...(trainerLines.length ? trainerLines : ['- NOT RECORDED']));
  lines.push(
    '',
    'The interview is not medical clearance. The PAR-Q and any medical clearance record remain authoritative; where they disagree with the interview, follow the clearance.',
  );
  return lines.join('\n');
}

module.exports = {
  FIELDS, BLOCKING, STATED_SUPERSEDES, resolveClientFacts, describeFacts, describeInterview,
  // Exported for the tests that pin the parsing rather than the resolution.
  countDays, ageFromDob, numInRange, STATED_RANGE,
};

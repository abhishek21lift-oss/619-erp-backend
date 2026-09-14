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
 *   UNVERIFIED         the database holds it, but the only source is the
 *                      client's own report rather than a studio measurement
 *   STATED             the trainer typed it for THIS generation, knowing it
 *                      is not on file, and it is labelled as their statement
 *   MISSING            nobody knows, and the prompt says NOT RECORDED
 *
 * and two flags a RECORDED or UNVERIFIED fact may additionally carry:
 *
 *   CONFLICTING        two of the studio's own records disagree; precedence
 *                      decided, and the loser is carried rather than dropped
 *   STALE              the assessment it came from is older than the studio
 *                      treats as current — see training-brief's STALE_AFTER_DAYS
 *
 * Six states, because four of them were being collapsed into "we have it".
 * A weight the client mentioned at the door, a weight measured eighteen months
 * ago and a weight measured on Tuesday all printed as the same bare number,
 * and the model — and the trainer reading the plan — had no way to tell which
 * one it was programming from.
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
const STATED_SUPERSEDES = ['equipment'];

/**
 * Sources that hold a real value the studio never measured.
 *
 * ── Why this list is one entry long ────────────────────────────────────────
 *
 * The temptation is to fill it: an enrolment form's height is "what they said",
 * a fitness profile's weight is "probably what they said". Neither is something
 * this codebase can demonstrate. `client_fitness_profiles` is written by an
 * authenticated PUT from staff (routes/diet.js), and pt_clients' own columns
 * come off the enrolment screen, also staff-entered. Marking those unverified
 * would be a guess about how a studio works, which is the same class of
 * mistake as the defaults this module exists to remove — it would just be a
 * pessimistic one.
 *
 * `weekly_checkins` is different and the code says so out loud. Its writer's
 * own comment describes it as "a thirty-second check-in at the door" that
 * should "record what the client said", and the row carries a `client_notes`
 * column beside the number. A weight from there is a person's report of their
 * weight. A weight from `pt_assessments` is a measurement taken during an
 * assessment. Programming a cut from the first as though it were the second is
 * exactly the error worth naming.
 *
 * An entry joins this list when the code that writes it shows the value came
 * from the client rather than from the studio. Not before.
 */
const UNVERIFIED_SOURCES = Object.freeze(new Set([
  'weekly_checkins.weight',
]));

/**
 * Which brief section a fact's source belongs to.
 *
 * Staleness is assessed per SECTION in training-brief.js — one date per
 * assessment, one threshold per kind. This is the join back to the individual
 * facts, so "the body section was measured 620 days ago" becomes "this weight
 * is 620 days old" on the one line where somebody is about to program from it.
 *
 * Sources with no entry have no section and are never reported stale. That is
 * not the same as fresh, and the absence is deliberate: pt_clients has no
 * assessment date, so there is no evidence about its age to report and
 * inventing one would be worse than saying nothing.
 */
const SOURCE_SECTION = Object.freeze({
  'pt_assessments.weight': 'body',
  'pt_lifestyle_assessments.workout_experience_level': 'lifestyle',
  'pt_goals.goal_type': 'goal',
});

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
  for (const [source, raw] of candidates) {
    const value = coerce(raw);
    if (value === null) continue;
    if (!winner) {
      winner = {
        value,
        source,
        // A value the studio holds but never measured is not the same fact as
        // one it did. Decided here, at the moment the source is known, so no
        // caller can lose it.
        origin: UNVERIFIED_SOURCES.has(source) ? 'unverified' : 'recorded',
      };
      continue;
    }
    if (!sameValue(winner.value, value)) conflicts.push({ source, value });
  }
  if (!winner) return null;
  return conflicts.length ? { ...winner, conflicts } : winner;
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
function resolveClientFacts(ctx, stated = {}, { stale = [] } = {}) {
  // Sections the brief reported as older than this studio treats as current.
  // Passed in rather than recomputed: one staleness rule, in training-brief.js,
  // and this reads its answer.
  const staleBySection = new Map((stale || []).map((st) => [st.section, st]));
  const {
    client = {}, profile = null, goals = [], latestAssessment = null,
    latestCheckin = null, lifestyle = null, workoutAssignments = [],
    studioEquipment = null,
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

    // ── Equipment ────────────────────────────────────────────────────────
    //
    // No column on pt_clients records this, and `training_mode` is
    // Offline / Online / Hybrid — WHERE a client trains, not what they can
    // lift with. The authoritative answer, where a studio has recorded one,
    // is the studio's own equipment list in the org-scoped settings store.
    //
    // Still missing when the studio has not recorded it, and MISSING is the
    // only honest answer then: the old default claimed "full gym" for every
    // client alive, and because equipment feeds the safety screen through
    // equipmentFrom(), that default was quietly ungating equipment-restricted
    // exercises for clients who may own a resistance band.
    equipment: fromSources([
      ['system_settings.studio_equipment', studioEquipment],
    ], text),
  };

  const facts = {};
  const recorded = [];
  const statedFields = [];
  const missing = [];
  // Held, but only on the client's own word. Listed separately from `recorded`
  // so a screen can say which is which without re-deriving it.
  const unverified = [];
  // Held, but from an assessment old enough that its age is itself a fact.
  const staleFields = [];
  // Facts two authoritative sources disagree about. Precedence decided, and
  // said so — this is the record of what it decided against.
  const conflicting = [];

  for (const field of FIELDS) {
    const supersedable = STATED_SUPERSEDES.includes(field)
      && text(stated[field]) !== null;
    const hit = supersedable ? null : resolved[field];
    if (hit) {
      const st = staleBySection.get(SOURCE_SECTION[hit.source]);
      facts[field] = st
        ? { ...hit, stale: { as_of: st.as_of, age_days: st.age_days, stale_after_days: st.stale_after_days } }
        : hit;
      if (hit.origin === 'unverified') unverified.push({ field, source: hit.source });
      else recorded.push({ field, source: hit.source });
      if (st) staleFields.push({ field, source: hit.source, ...st });
      if (hit.conflicts) {
        conflicting.push({
          field,
          chosen: { source: hit.source, value: hit.value },
          rejected: hit.conflicts,
        });
      }
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
      unverified,
      stated: statedFields,
      missing,
      conflicting,
      stale: staleFields,
      blocking: missing.filter((m) => m.blocking).map((m) => m.field),
      // Of the facts the prompt may state, how many the database holds at all.
      // An unverified value counts — the studio does hold it, and the question
      // this number answers is how much of the record is filled in, not how
      // much of it was measured; `unverified` above answers that one.
      //
      // Trainer statements deliberately do not count. A value typed into a box
      // thirty seconds ago is not something the studio knows about a client.
      completeness_pct: Math.round(((recorded.length + unverified.length) / FIELDS.length) * 100),
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
      continue;
    }
    if (f.origin === 'stated') {
      lines.push(`- ${LABEL[field]}: ${f.value} (stated by the trainer for this session, not on file)`);
      continue;
    }
    // Provenance, disagreement and age are three separate things and a fact
    // can carry all three at once. Composed rather than branched, so a stale
    // disputed self-reported weight says all of it instead of whichever the
    // first matching branch happened to be.
    const notes = [];
    if (f.origin === 'unverified') {
      notes.push(`from ${f.source} — UNVERIFIED, this is the client's own report and the studio has never measured it`);
    } else {
      notes.push(`from ${f.source}`);
    }
    if (f.conflicts) {
      notes.push(`DISPUTED — ${f.conflicts.map((c) => `${c.value} in ${c.source}`).join(', ')}`);
    }
    if (f.stale) {
      notes.push(`STALE — measured ${f.stale.as_of}, ${f.stale.age_days} days ago, and this studio treats it as current for ${f.stale.stale_after_days}`);
    }
    lines.push(`- ${LABEL[field]}: ${f.value} (${notes.join('; ')})`);
  }
  lines.push(
    '',
    'NOT RECORDED means the studio does not hold this value. Do not infer it, do not substitute a typical value, and do not write programming that depends on it. Where a decision would need it, program conservatively and say which value would change your choice.',
  );
  if (FIELDS.some((f) => facts[f]?.origin === 'unverified')) {
    lines.push(
      '',
      'UNVERIFIED means the number is what the client said, not what anybody measured. Use it, because it is the only figure there is — but do not build a prescription whose safety depends on it being exact, and say in the plan that it is worth measuring.',
    );
  }
  if (FIELDS.some((f) => facts[f]?.stale)) {
    lines.push(
      '',
      'STALE means the measurement is real but old. Program to it, and say in the plan that it needs repeating. Do NOT extrapolate it forward, and do not describe the client as having changed since — nobody has looked.',
    );
  }
  if (FIELDS.some((f) => facts[f]?.conflicts)) {
    lines.push(
      '',
      'DISPUTED means two of the studio\'s own records disagree. The value shown first is the one the studio\'s precedence rule selected, and it is the one to program to. Do NOT pick a different one, do not average them, and do not decide which record is right — that is the trainer\'s call, not yours. Say in the plan that the disagreement exists and which value you programmed to.',
    );
  }
  return lines.join('\n');
}

module.exports = {
  FIELDS, BLOCKING, STATED_SUPERSEDES, UNVERIFIED_SOURCES, SOURCE_SECTION,
  resolveClientFacts, describeFacts,
  // Exported for the tests that pin the parsing rather than the resolution.
  countDays, ageFromDob,
};

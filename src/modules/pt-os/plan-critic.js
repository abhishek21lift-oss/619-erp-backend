'use strict';
// Checking that the model did what the rules told it to.
//
// ── The hole this closes ───────────────────────────────────────────────────
//
// Stage 3 put the safety screen at the top of the prompt and left the blocked
// exercises out of the library the model was given. Both help. Neither is
// enforcement: the model still writes free text, and nothing looked at what
// came back. A plan that prescribed an overhead press for a client with
// shoulder pain would have been streamed to the trainer with the screen
// attached, saying the press had been excluded, next to a plan containing it.
//
// So this audits the OUTPUT against the same deterministic rules that shaped
// the input. A violation found here is a fact — a named exercise, on a named
// day, against a named constraint — and it is found without asking a model
// anything.
//
// ── Two kinds of finding, never merged ─────────────────────────────────────
//
// `violations` are rule breaches. They are checkable, reproducible, and a
// trainer can verify each one by looking at the same two rows this did.
//
// `critique` is a second model's opinion of the programme. It is useful and
// it is not evidence. The two are kept in separate fields all the way to the
// trainer's screen, because a list that mixes "prescribes a blocked exercise"
// with "the accessory volume looks high to me" teaches the reader to skim
// both.
//
// ── Name matching, and why it refuses to be clever ─────────────────────────
//
// The plan names exercises as free strings. To screen one, it has to be
// matched back to a library row. Trigram similarity was measured against
// production before this was written, and it is not safe:
//
//   "Overhead Press"          → "Overhead Lat"                   (0.474)
//   "Back Squat"              → "Hack Squat"                     (0.571)
//   "Barbell Bench Press"     → "Decline Barbell Bench Press"    (0.704)
//   "Dumbbell Lateral Raise"  → "Dumbbell Lying Rear Lateral Raise" (0.719)
//
// The first is the one that matters. An overhead press is a vertical push
// that loads the shoulder; "Overhead Lat" is a lat exercise. Screening the
// press through that row would CLEAR it for a client with shoulder pain —
// a fuzzy match turning a safety check into a safety failure.
//
// So only an exact match counts, after normalising case, punctuation and
// whitespace. That normalisation was checked too: of 890 exercises, exactly
// four normalise onto another, and all four pairs share a single
// target_muscle — so a normalised name never resolves to two different
// muscles.
//
// Everything else is `unverified`, reported by name, and never silently
// treated as safe. That list is the honest cost of refusing to guess, and it
// is smaller than the cost of guessing wrong once.

/** How bad a violation is, worst first. Only `critical` forces a revision. */
const SEVERITY = Object.freeze({ CRITICAL: 'critical', MAJOR: 'major', MINOR: 'minor' });
const SEVERITY_RANK = Object.freeze({ critical: 3, major: 2, minor: 1 });

/** Prescription types that owe sets and reps. Others owe their own fields. */
const SETS_REPS_TYPES = Object.freeze(['SETS_REPS', '', null, undefined]);

/**
 * The quality score's components, and what each is worth.
 *
 * Stated here rather than buried in the arithmetic, for the same reason
 * recovery.js states its weights: a trainer who thinks completeness is
 * weighted too heavily should be able to see that it is a fifth of it, and
 * argue with the number rather than either trusting or ignoring it.
 */
const SCORE_WEIGHTS = Object.freeze({
  safety: 40,        // no blocked exercise prescribed
  structure: 20,     // the days, warm-up and cool-down asked for
  completeness: 20,  // every exercise carries a full prescription
  progression: 10,   // the block says what changes and when
  evidence: 10,      // selection is verifiable against the library
});

/** A name the library and the plan can be compared on. */
function normaliseName(name) {
  return String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Every exercise in the plan, flattened, keeping where it came from.
 *
 * The day and the position travel with it so a violation can say "Monday,
 * exercise 3" rather than naming a movement the trainer then has to hunt for
 * in a twelve-week block.
 */
function planExercises(plan) {
  const schedule = plan?.weekly_schedule;
  if (!schedule || typeof schedule !== 'object') return [];
  const out = [];
  for (const [day, session] of Object.entries(schedule)) {
    const list = Array.isArray(session?.exercises) ? session.exercises : [];
    list.forEach((ex, i) => {
      if (!ex || typeof ex !== 'object') return;
      out.push({ ...ex, day, position: i + 1, name: text(ex.name) });
    });
  }
  return out;
}

/** Does this exercise owe sets and reps, or its own cardio fields? */
function owesSetsReps(ex) {
  const type = text(ex?.prescription_type).toUpperCase();
  return SETS_REPS_TYPES.includes(type) || type === 'SETS_REPS';
}

/**
 * Audit a generated plan against the screen that shaped it.
 *
 * @param {object} plan
 * @param {object} input
 * @param {Map<string, object>} input.screened
 *        Normalised exercise name → { verdict, reasons, name }. Built by
 *        looking the plan's own names up in the library, NOT by reusing the
 *        dozen rows retrieved for the prompt — those cover a fraction of what
 *        a model may name.
 * @param {object=} input.requested  { training_days, duration_weeks }
 */
function auditPlan(plan, { screened = new Map(), requested = {} } = {}) {
  const violations = [];
  const exercises = planExercises(plan);
  const unverified = [];

  // ── Safety: did it prescribe something the rules excluded? ──────────────
  for (const ex of exercises) {
    if (!ex.name) {
      violations.push({
        severity: SEVERITY.MAJOR,
        rule: 'exercise_unnamed',
        where: `${ex.day} #${ex.position}`,
        detail: 'an exercise has no name',
      });
      continue;
    }
    const hit = screened.get(normaliseName(ex.name));
    if (!hit) {
      // Not in the library at all, under any spelling this can safely match.
      // Reported, never assumed safe — see the header.
      unverified.push({ day: ex.day, position: ex.position, name: ex.name });
      continue;
    }
    if (hit.verdict === 'block') {
      violations.push({
        severity: SEVERITY.CRITICAL,
        rule: 'blocked_exercise_prescribed',
        where: `${ex.day} #${ex.position}`,
        exercise: ex.name,
        matched: hit.name,
        detail: `${ex.name} is excluded for this client: ${
          (hit.reasons || []).map((r) => r.because).join('; ')}`,
      });
    } else if (hit.verdict === 'caution') {
      violations.push({
        severity: SEVERITY.MINOR,
        rule: 'caution_exercise_prescribed',
        where: `${ex.day} #${ex.position}`,
        exercise: ex.name,
        detail: `${ex.name} needs care: ${(hit.reasons || []).map((r) => r.because).join('; ')}`,
      });
    }
  }

  // ── Structure: is it the block that was asked for? ──────────────────────
  const days = Object.keys(plan?.weekly_schedule || {}).length;
  const wantDays = num(requested.training_days);
  if (wantDays !== null && days !== wantDays) {
    violations.push({
      severity: SEVERITY.MAJOR,
      rule: 'frequency_mismatch',
      detail: `${days} training days generated, ${wantDays} requested`,
    });
  }

  const wantWeeks = num(requested.duration_weeks);
  const gotWeeks = num(plan?.weeks);
  if (wantWeeks !== null && gotWeeks !== null && gotWeeks !== wantWeeks) {
    violations.push({
      severity: SEVERITY.MAJOR,
      rule: 'duration_mismatch',
      detail: `${gotWeeks}-week block generated, ${wantWeeks} requested`,
    });
  }

  if (!text(plan?.warm_up)) {
    violations.push({ severity: SEVERITY.MAJOR, rule: 'no_warm_up', detail: 'no warm-up protocol' });
  }
  if (!text(plan?.cool_down)) {
    violations.push({ severity: SEVERITY.MINOR, rule: 'no_cool_down', detail: 'no cool-down' });
  }
  if (!exercises.length) {
    violations.push({
      severity: SEVERITY.CRITICAL,
      rule: 'no_exercises',
      detail: 'the plan prescribes no exercises at all',
    });
  }

  // ── Completeness: can a trainer actually run this session? ──────────────
  //
  // Counted per exercise and reported once per FIELD rather than once per
  // exercise. Twelve separate "missing RIR" lines is a wall a reader skips;
  // "9 of 24 exercises have no RIR or RPE" is a fact they act on.
  const missing = { sets: [], reps: [], effort: [], rest: [] };
  for (const ex of exercises) {
    const where = `${ex.day} #${ex.position} ${ex.name || '(unnamed)'}`;
    if (owesSetsReps(ex)) {
      if (num(ex.sets) === null) missing.sets.push(where);
      if (!text(ex.reps) && num(ex.reps) === null) missing.reps.push(where);
    }
    if (!text(ex.rir_or_rpe)) missing.effort.push(where);
    if (num(ex.rest_seconds) === null) missing.rest.push(where);
  }
  const total = exercises.length;
  const completenessRule = (key, rule, label, severity) => {
    if (!missing[key].length) return;
    violations.push({
      severity,
      rule,
      detail: `${missing[key].length} of ${total} exercises have no ${label}`,
      where: missing[key].slice(0, 8),
    });
  };
  completenessRule('sets', 'no_sets', 'set count', SEVERITY.MAJOR);
  completenessRule('reps', 'no_reps', 'rep prescription', SEVERITY.MAJOR);
  completenessRule('effort', 'no_effort_target', 'RIR or RPE target', SEVERITY.MINOR);
  completenessRule('rest', 'no_rest', 'rest period', SEVERITY.MINOR);

  if (!text(plan?.progression_notes)) {
    violations.push({
      severity: SEVERITY.MAJOR,
      rule: 'no_progression',
      detail: 'the block never says what changes week to week',
    });
  }

  violations.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const verified = total - unverified.length;
  return {
    violations,
    // Named separately because it is not a violation — it is the audit
    // reporting the limit of its own reach, which the trainer has to cover
    // with their eyes.
    unverified,
    counts: {
      exercises: total,
      verified,
      critical: violations.filter((v) => v.severity === SEVERITY.CRITICAL).length,
      major: violations.filter((v) => v.severity === SEVERITY.MAJOR).length,
      minor: violations.filter((v) => v.severity === SEVERITY.MINOR).length,
    },
    /** Whether a revision is worth spending a second generation on. */
    needs_revision: violations.some((v) => v.severity === SEVERITY.CRITICAL
      || v.rule === 'frequency_mismatch'),
  };
}

/**
 * A quality score, with the components that produced it.
 *
 * Never returned as a bare number. The same trap recovery.js documents
 * applies harder here: a tidy 82/100 on a coloured bar reads as a measurement
 * of how good the programme is, and it is nothing of the sort — it is a count
 * of rule breaches, which is a floor on quality and not an estimate of it. A
 * plan can score 100 and be a poor programme. It cannot score 100 and
 * prescribe a blocked exercise, and that is the whole claim.
 */
function scorePlan(audit) {
  const c = audit?.counts ?? { exercises: 0, verified: 0 };
  const by = (rule) => (audit?.violations || []).filter((v) => v.rule === rule);
  const any = (...rules) => rules.some((r) => by(r).length > 0);

  const components = {
    safety: any('blocked_exercise_prescribed') ? 0
      : any('caution_exercise_prescribed') ? Math.round(SCORE_WEIGHTS.safety * 0.7)
        : SCORE_WEIGHTS.safety,
    structure: SCORE_WEIGHTS.structure
      - (any('frequency_mismatch') ? 8 : 0)
      - (any('duration_mismatch') ? 4 : 0)
      - (any('no_warm_up') ? 5 : 0)
      - (any('no_cool_down') ? 3 : 0),
    completeness: SCORE_WEIGHTS.completeness
      - (any('no_sets') ? 6 : 0)
      - (any('no_reps') ? 6 : 0)
      - (any('no_effort_target') ? 5 : 0)
      - (any('no_rest') ? 3 : 0),
    progression: any('no_progression') ? 0 : SCORE_WEIGHTS.progression,
    // How much of the selection could be checked at all. A plan of exercises
    // none of which are in the library is not thereby unsafe — but nothing
    // here verified it, and the score must not read as though something did.
    evidence: c.exercises > 0
      ? Math.round((c.verified / c.exercises) * SCORE_WEIGHTS.evidence)
      : 0,
  };

  for (const k of Object.keys(components)) components[k] = Math.max(0, components[k]);
  const score = Object.values(components).reduce((s, v) => s + v, 0);

  return {
    score,
    max: 100,
    components,
    weights: SCORE_WEIGHTS,
    // The one sentence that should travel with the number wherever it is shown.
    basis: 'a count of deterministic rule breaches, not a judgement of programme quality',
  };
}

/**
 * What to tell the model when asking it to fix its own plan.
 *
 * Only the violations worth a second generation, stated as the specific thing
 * to change. A revision prompt that says "improve the plan" gets a different
 * plan; one that says "Monday #3 prescribes X, which is excluded because Y"
 * gets X replaced.
 */
function buildRevisionInstruction(audit) {
  const worth = (audit?.violations || []).filter(
    (v) => v.severity === SEVERITY.CRITICAL || v.severity === SEVERITY.MAJOR,
  );
  if (!worth.length) return null;

  return [
    'Your previous plan broke rules that were given to you. Fix exactly these and change nothing else:',
    ...worth.map((v) => `- ${v.where && !Array.isArray(v.where) ? `${v.where}: ` : ''}${v.detail}`),
    '',
    'An excluded exercise must be REPLACED with one that trains a different movement, not reworded,',
    'not given a lighter load, and not annotated with a caution. Reply with the corrected plan as the',
    'same JSON object and nothing else.',
  ].join('\n');
}

/** The critic's brief. Advisory: it may not overrule a rule, only add to it. */
const CRITIC_SYSTEM_PROMPT = `You are a second strength coach reviewing a colleague's draft programme for one client.

The programme has ALREADY passed a deterministic rule check for safety exclusions, session count, and prescription completeness. Do not repeat those checks and do not comment on them — they are handled, and a finding you raise about them is noise.

Judge only what a rule cannot: whether the exercise selection actually serves the stated goal, whether the weekly structure balances movement patterns sensibly, whether the progression is appropriate for this client's logged history, and whether anything about the programme would not survive contact with a real training week.

Rules:
1. Every point must cite something in the programme or the client data you were given. No general coaching advice.
2. If the client's history shows no trend, do not assert one.
3. Say nothing rather than pad. Three sharp points beat eight vague ones.
4. You are advisory. You cannot clear an exercise the rules excluded.

Reply with JSON only:
{"critique":[{"severity":"high"|"medium"|"low","point":"...","because":"..."}],"verdict":"sound"|"workable"|"weak"}

At most 6 points. If the programme is sound and you have nothing useful to add, reply {"critique":[],"verdict":"sound"}.`;

/** Parse the critic, keeping only points that obey the contract. */
function parseCritique(raw) {
  if (typeof raw !== 'string') return { critique: [], verdict: null };
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { critique: [], verdict: null };
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return { critique: [], verdict: null }; }

  const list = Array.isArray(parsed?.critique) ? parsed.critique : [];
  const critique = list
    .map((c) => {
      const point = text(c?.point);
      const because = text(c?.because);
      // Uncited, dropped — the same rule the coaching prompts follow. A point
      // a trainer cannot trace is one they cannot overrule.
      if (!point || !because) return null;
      return {
        severity: ['high', 'medium', 'low'].includes(c?.severity) ? c.severity : 'low',
        point,
        because,
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  return {
    critique,
    verdict: ['sound', 'workable', 'weak'].includes(parsed?.verdict) ? parsed.verdict : null,
  };
}

/** The audit, as a line the critic can read without re-deriving it. */
function describeAudit(audit) {
  if (!audit) return '';
  const L = [`RULE CHECK: ${audit.counts.critical} critical, ${audit.counts.major} major,`
    + ` ${audit.counts.minor} minor findings across ${audit.counts.exercises} exercises.`];
  for (const v of audit.violations.slice(0, 12)) {
    L.push(`- [${v.severity}] ${v.rule}: ${v.detail}`);
  }
  if (audit.unverified.length) {
    L.push(`- ${audit.unverified.length} exercises are not in the studio's library and could not be`
      + ` checked against this client's exclusions: ${audit.unverified.map((u) => u.name).join(', ')}.`);
  }
  return L.join('\n');
}

module.exports = {
  auditPlan,
  scorePlan,
  buildRevisionInstruction,
  parseCritique,
  describeAudit,
  planExercises,
  normaliseName,
  CRITIC_SYSTEM_PROMPT,
  SEVERITY,
  SCORE_WEIGHTS,
};

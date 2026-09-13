'use strict';
// The rules that do not need a model to be right.
//
// ── Why this is separate from the AI ───────────────────────────────────────
//
// "Do not prescribe overhead pressing to a client who reported shoulder pain
// this month" is not a judgement call, and it is not something that should be
// re-decided, probabilistically, every time a prompt is sent. It is a rule. It
// either fired or it did not, and a trainer must be able to see which.
//
// So the safety and volume decisions live here, as pure functions over rows
// the caller fetched, and the model's job is narrowed to what a model is
// actually better at: choosing between the exercises this file has already
// said are allowed, and explaining the choice. A rule that fires here cannot
// be talked out of by a well-phrased prompt, and a rule that did not fire
// cannot be invented by one.
//
// ── What production actually holds, measured before this was written ───────
//
// The original plan for this file was to match client injuries against
// `exercises.contraindications`. That does not work, and the reason is worth
// recording so nobody plans it again:
//
//   · 876 of 890 exercises have an EMPTY contraindications array. The 14 that
//     are populated are cardio machines carrying generic stop-signs ("Stop for
//     chest pain, faintness, or sharp joint/back pain"), not injury terms
//     anything could match against.
//   · `pt_clients.injuries` — the only injury field the AI workout generator
//     reads today — is empty for all 34 clients. The generator has therefore
//     been sending "Injuries: none" for every client it has ever written for,
//     while PAR-Q, mobility and posture sat unread.
//
// What IS populated, on all 890 exercises, is `target_muscle` (18 values),
// `muscle_group` (7), `equipment` (12) and `difficulty` (3). And what the
// client side holds is not free text either: PAR-Q past_history is a fixed set
// of boolean keys, the mobility screen scores eight named regions, and the
// posture screen picks from nine named findings.
//
// That makes the whole matching problem enum-to-enum. Both vocabularies are
// small, closed and written down below, which is why every rule here can be
// tested exhaustively rather than sampled.
//
// ── The two things this file refuses to do ─────────────────────────────────
//
// It will not infer a body region the form did not record. PAR-Q asks "joint
// problems?" as one boolean and never asks which joint; mapping that to a
// region would be this file inventing a clinical finding. It produces an
// unlocated caution and says the form does not record where.
//
// And it will not read silence as safety. A client with no mobility screen on
// file is not a client with no restrictions, so `coverage` reports which
// sources were actually present. An empty constraint list from an unassessed
// client and an empty one from a fully-assessed client are different facts,
// and the layer above must be able to tell them apart.

/** Severities, worst first. A rule may raise a verdict, never lower one. */
const VERDICTS = Object.freeze({ BLOCK: 'block', CAUTION: 'caution', ALLOW: 'allow' });
const RANK = Object.freeze({ block: 2, caution: 1, allow: 0 });

/** The eight regions the mobility screen scores. Verified against production. */
const MOBILITY_REGIONS = Object.freeze([
  'Neck', 'Shoulders', 'Thoracic Spine', 'Hip', 'Hamstrings', 'Quadriceps', 'Ankles', 'Wrists',
]);

/** The nine findings the posture screen offers. */
const POSTURE_ISSUES = Object.freeze([
  'Rounded Shoulders', 'Forward Head', 'Anterior Pelvic Tilt', 'Posterior Pelvic Tilt',
  'Kyphosis', 'Lordosis', 'Scoliosis', 'Knee Valgus', 'Flat Feet',
]);

/**
 * Body regions → the library fields that describe them.
 *
 * `muscles` are `exercises.target_muscle` values and `patterns` are
 * `exercises.movement_pattern` values, both spelled exactly as the library
 * spells them — a typo here is a rule that silently never fires, which is the
 * worst failure this file can have. The exhaustive test asserts every value
 * below appears in the library's own vocabulary.
 *
 * A region is deliberately wider than the joint. Shoulder pain is not only a
 * reason to avoid deltoid work; it is a reason to avoid the pressing and
 * overhead pulling that loads the joint, which is why Chest and Triceps are in
 * the shoulder row. Narrowing these to the obvious muscle would produce a rule
 * that passes an overhead press because its target muscle is Shoulders and its
 * pattern is the thing that actually hurts.
 */
const REGIONS = Object.freeze({
  shoulder: {
    label: 'shoulder',
    muscles: ['Shoulders', 'Chest', 'Triceps'],
    patterns: ['Vertical Push', 'Horizontal Push', 'Vertical Pull'],
  },
  back: {
    label: 'lower back and spine',
    // Abdominals is here because loaded trunk flexion is the work a sore back
    // is least able to take, and a crunch carries the pattern "Isolation" —
    // so without the muscle it would pass a back rule that catches every
    // deadlift. Carry is here for the same reason from the other direction:
    // a loaded carry is spinal compression that no other pattern describes.
    muscles: ['Lower Back', 'Middle Back', 'Lats', 'Abdominals'],
    patterns: ['Hinge', 'Trunk Flexion', 'Anti-Extension', 'Rotation', 'Carry'],
  },
  knee: {
    label: 'knee',
    muscles: ['Quadriceps', 'Hamstrings', 'Calves'],
    patterns: ['Squat', 'Lunge'],
  },
  hip: {
    label: 'hip',
    muscles: ['Glutes', 'Adductors', 'Abductors', 'Hamstrings'],
    patterns: ['Hinge', 'Squat', 'Lunge'],
  },
  neck: {
    label: 'neck',
    muscles: ['Neck', 'Traps'],
    patterns: ['Vertical Push'],
  },
  ankle: {
    label: 'ankle',
    muscles: ['Calves'],
    patterns: ['Squat', 'Lunge', 'Locomotion'],
  },
  wrist: {
    label: 'wrist',
    muscles: ['Forearms'],
    patterns: ['Horizontal Push', 'Vertical Push'],
  },
  hamstring: {
    label: 'hamstring',
    muscles: ['Hamstrings'],
    patterns: ['Hinge'],
  },
});

/** PAR-Q past_history keys that name a body region. */
const PARQ_REGION = Object.freeze({
  back_pain: 'back',
  knee_pain: 'knee',
  neck_pain: 'neck',
  hip_pain: 'hip',
  shoulder_pain: 'shoulder',
});

/**
 * PAR-Q keys that are a medical question rather than a programming one.
 *
 * These never change exercise selection here. A respiratory or cardiac history
 * is for a doctor to clear and a trainer to work within, and a file that
 * quietly swapped an exercise on the strength of one would be practising
 * medicine from a checkbox. They are surfaced as referrals, with the same rule
 * the coaching prompts already follow: say it should be referred, and stop.
 */
const PARQ_REFERRAL = Object.freeze({
  heart_disease: 'cardiac history',
  respiratory_disease: 'respiratory disease',
  copd: 'COPD',
  asthma: 'asthma',
  tuberculosis: 'tuberculosis history',
  known_disease: 'a diagnosed condition',
  current_treatment: 'ongoing treatment',
});

/**
 * PAR-Q keys that report a problem without saying where it is.
 *
 * The form has one box for "joint problems" and one for "previous fractures".
 * Neither records a joint. They are real information and they are not a region,
 * so they produce an unlocated caution that names the gap.
 */
const PARQ_UNLOCATED = Object.freeze({
  joint_problems: 'joint problems',
  previous_fractures: 'previous fractures',
  surgeries: 'previous surgery',
  has_pain: 'current pain',
});

/** Mobility region name → the region key it constrains. */
const MOBILITY_REGION_KEY = Object.freeze({
  Neck: 'neck',
  Shoulders: 'shoulder',
  'Thoracic Spine': 'back',
  Hip: 'hip',
  Hamstrings: 'hamstring',
  Quadriceps: 'knee',
  Ankles: 'ankle',
  Wrists: 'wrist',
});

/**
 * Posture findings → what they change.
 *
 * Always a caution, never a block. A posture screen is somebody looking at a
 * client standing still; it is a reason to bias volume, not a reason to forbid
 * a movement the client has no pain in. Treating an observation with the same
 * force as a reported pain would make the strictest client the one who was
 * looked at most carefully.
 */
const POSTURE_REGION = Object.freeze({
  'Rounded Shoulders': 'shoulder',
  'Forward Head': 'neck',
  Kyphosis: 'shoulder',
  'Anterior Pelvic Tilt': 'back',
  'Posterior Pelvic Tilt': 'back',
  Lordosis: 'back',
  Scoliosis: 'back',
  'Knee Valgus': 'knee',
  'Flat Feet': 'ankle',
});

/** Experience → the hardest exercise difficulty it may be prescribed. */
const DIFFICULTY_CEILING = Object.freeze({
  beginner: ['beginner'],
  intermediate: ['beginner', 'intermediate'],
  advanced: ['beginner', 'intermediate', 'advanced'],
  athlete: ['beginner', 'intermediate', 'advanced'],
});

/**
 * Weekly hard sets per muscle group: minimum effective, adaptive, maximum
 * recoverable.
 *
 * ── Read this before trusting the numbers ─────────────────────────────────
 *
 * These are published strength-and-conditioning heuristics, not values derived
 * from this studio's own outcomes. The studio has 379 attributable completed
 * sets across two logged weeks — nowhere near enough to fit landmarks to, and
 * saying so is more useful than a number that looks earned and is not.
 *
 * They are also stated against a COARSE grouping. The library's muscle_group
 * has seven values, so "Legs" is quadriceps, hamstrings, glutes and calves in
 * one bucket and "Arms" is biceps and triceps. Published landmarks are
 * per-muscle, so the ranges below are widened to account for that, and the
 * per-target_muscle split is reported alongside every verdict so a trainer can
 * see what a "Legs 20" was actually made of.
 *
 * Cardio is null on purpose. Sets are the wrong unit for it and a landmark
 * would be a category error, so it is counted and not judged.
 */
const LANDMARKS = Object.freeze({
  Chest: { mev: 8, mav: 16, mrv: 22 },
  Back: { mev: 10, mav: 20, mrv: 26 },
  Legs: { mev: 10, mav: 20, mrv: 28 },
  Shoulders: { mev: 8, mav: 18, mrv: 24 },
  Arms: { mev: 6, mav: 16, mrv: 24 },
  Core: { mev: 4, mav: 12, mrv: 20 },
  Cardio: null,
});

/** Consecutive weeks above MRV before overreaching is a call rather than a week. */
const WEEKS_OVER_MRV_FOR_DELOAD = 2;

/** Regressing lifts before the block, rather than the lift, is the problem. */
const REGRESSING_LIFTS_FOR_DELOAD = 2;

/** Below this, a readiness score is low enough to act on. See recovery.js. */
const LOW_READINESS = 50;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Truthy the way the PAR-Q forms actually store a yes. */
const isYes = (v) => v === true || v === 'yes' || v === 'Yes' || v === 'true';

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** A JSONB column that may arrive as an object or as text holding one. */
function asObject(value) {
  if (!value) return {};
  const raw = typeof value === 'string' ? safeParse(value) : value;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** A Postgres text[] or JSONB array, as a list of trimmed labels. */
function asLabels(value) {
  if (!value) return [];
  const raw = typeof value === 'string' ? (safeParse(value) ?? value) : value;
  if (Array.isArray(raw)) return raw.map((v) => str(v)).filter(Boolean);
  return [];
}

/**
 * One constraint, in the shape everything downstream reads.
 *
 * `evidence` is the field it came from, verbatim enough that a trainer can go
 * and look at the same row. A constraint nobody can trace is a constraint
 * nobody can overrule, and this file is meant to be overruled by a coach who
 * is standing in front of the client.
 */
function constraint({ verdict, region, source, evidence, note = null }) {
  const r = region ? REGIONS[region] : null;
  return {
    verdict,
    region: region ?? null,
    label: r?.label ?? null,
    muscles: r ? [...r.muscles] : [],
    patterns: r ? [...r.patterns] : [],
    source,
    evidence,
    note,
  };
}

/**
 * The client's constraints, from assessments the caller fetched.
 *
 * Every argument is a row this studio owns; none of it comes from a request
 * body. That is the same authority rule the plan generators' data loader
 * follows, and it matters more here — a constraint set the browser could
 * influence is a safety gate the browser could switch off.
 *
 * @param {object}  input
 * @param {object=} input.parq       pt_parq_forms row
 * @param {object=} input.mobility   pt_mobility_performance_assessments row
 * @param {object=} input.posture    pt_posture_assessments row
 * @param {object=} input.lifestyle  pt_lifestyle_assessments row
 * @param {object=} input.client     pt_clients row
 * @param {string[]=} input.equipment Equipment the studio has, as library spells it.
 */
function buildConstraints({
  parq = null, mobility = null, posture = null, lifestyle = null,
  client = null, equipment = null,
} = {}) {
  const constraints = [];
  const referrals = [];

  // ── PAR-Q ────────────────────────────────────────────────────────────────
  const past = asObject(parq?.past_history);
  const current = asObject(parq?.current_health);

  for (const [key, region] of Object.entries(PARQ_REGION)) {
    if (!isYes(past[key])) continue;
    // A history of pain is a caution, not a block. The client reported it on
    // an intake form which may be years old, and blocking an entire region on
    // it would leave a client who once had a sore knee unable to be prescribed
    // a squat forever. Pain reported NOW — by the mobility screen — blocks.
    constraints.push(constraint({
      verdict: VERDICTS.CAUTION,
      region,
      source: 'parq.past_history',
      evidence: key,
      note: 'reported on the PAR-Q as history; confirm whether it is current',
    }));
  }

  for (const [key, what] of Object.entries(PARQ_UNLOCATED)) {
    if (!isYes(past[key]) && !isYes(current[key])) continue;
    constraints.push(constraint({
      verdict: VERDICTS.CAUTION,
      region: null,
      source: isYes(past[key]) ? 'parq.past_history' : 'parq.current_health',
      evidence: key,
      note: `${what} reported; the form does not record which part of the body`,
    }));
  }

  for (const [key, what] of Object.entries(PARQ_REFERRAL)) {
    if (!isYes(past[key]) && !isYes(current[key])) continue;
    referrals.push({
      source: isYes(past[key]) ? 'parq.past_history' : 'parq.current_health',
      evidence: key,
      note: `${what} on file — a programming decision here would be a medical one; refer`,
    });
  }

  // ── Mobility: the only source that reports pain as a present-tense fact ──
  const regions = Array.isArray(mobility?.body_regions)
    ? mobility.body_regions
    : (Array.isArray(safeParse(mobility?.body_regions)) ? safeParse(mobility.body_regions) : []);

  for (const r of regions) {
    if (!r || typeof r !== 'object') continue;
    const key = MOBILITY_REGION_KEY[str(r.region)];
    if (!key) continue;
    if (r.pain === true) {
      constraints.push(constraint({
        verdict: VERDICTS.BLOCK,
        region: key,
        source: 'mobility.body_regions',
        evidence: `${str(r.region)}: pain`,
        note: 'pain on assessment — do not load this region until it is reassessed',
      }));
    } else if (r.restriction === true) {
      // Restricted is not injured. It is a range the client does not have yet,
      // which changes exercise selection and is a reason to program for it —
      // not a reason to train around it forever.
      constraints.push(constraint({
        verdict: VERDICTS.CAUTION,
        region: key,
        source: 'mobility.body_regions',
        evidence: `${str(r.region)}: restricted`,
        note: 'restricted range — select variations that fit the range available',
      }));
    }
  }

  // ── Posture ──────────────────────────────────────────────────────────────
  const postureIssues = [
    ...asLabels(posture?.front_issues),
    ...asLabels(posture?.side_issues),
    ...asLabels(posture?.back_issues),
  ];
  for (const issue of postureIssues) {
    const key = POSTURE_REGION[issue];
    if (!key) continue;
    constraints.push(constraint({
      verdict: VERDICTS.CAUTION,
      region: key,
      source: 'posture',
      evidence: issue,
      note: 'postural observation — bias volume rather than exclude the movement',
    }));
  }

  const experience = str(client?.workout_experience_level)
    || str(lifestyle?.workout_experience_level)
    || null;

  return {
    // ── The hard gate ─────────────────────────────────────────────────────
    //
    // Three states, not two. A studio that has cleared the client says so on
    // the form; a studio that has not run a PAR-Q has not cleared anybody, and
    // `unknown` must not read as `cleared` anywhere downstream. That is the
    // difference between "we checked" and "nobody asked", and it is exactly
    // the distinction a default would erase.
    gate: {
      status: parq ? (str(parq.workout_gate_status) || 'unknown') : 'unknown',
      cleared: Boolean(parq) && str(parq.workout_gate_status) === 'cleared',
      risk_level: parq ? (str(parq.risk_level) || null) : null,
      assessed_on: parq?.assessment_date ? String(parq.assessment_date).slice(0, 10) : null,
    },
    constraints,
    referrals,
    experience,
    difficulty_allowed: experience ? (DIFFICULTY_CEILING[experience.toLowerCase()] ?? null) : null,
    equipment: Array.isArray(equipment) && equipment.length ? equipment.map(str).filter(Boolean) : null,
    // ── What was actually looked at ───────────────────────────────────────
    //
    // Not decoration. Zero constraints from a client with all four assessments
    // means "screened, and clear". Zero from a client with none means "nobody
    // has looked", and a programme written against the second as though it
    // were the first is the failure this whole file exists to prevent.
    coverage: {
      parq: Boolean(parq),
      mobility: regions.length > 0,
      posture: Boolean(posture),
      lifestyle: Boolean(lifestyle),
      experience_known: Boolean(experience),
      equipment_known: Array.isArray(equipment) && equipment.length > 0,
      sources_present: [
        parq && 'parq', regions.length > 0 && 'mobility',
        posture && 'posture', lifestyle && 'lifestyle',
      ].filter(Boolean),
      screened: Boolean(parq) || regions.length > 0 || Boolean(posture),
    },
  };
}

/**
 * Screen one library exercise against a constraint set.
 *
 * The exercise is a row from `exercises`: name, target_muscle, muscle_group,
 * movement_pattern, equipment, difficulty.
 *
 * A constraint matches on EITHER the muscle or the pattern, because the
 * library populates them independently and 508 of 890 exercises carry a
 * movement_pattern of "General" or "Isolation" — a pattern-only rule would
 * pass more than half the library untested. Matching on either means a
 * shoulder rule catches a Dumbbell Lateral Raise by its target muscle and an
 * Overhead Press by both.
 *
 * Three library values are deliberately unmapped, and the exhaustive test
 * pins them so the choice has to be re-argued rather than drifted into:
 *
 *   · Horizontal Pull. Rowing is usually what a cranky shoulder should be
 *     doing MORE of, and it is exactly what the posture rules ask for when
 *     they say bias toward upper-back pulling. Putting it in the shoulder
 *     region would have this file caution the movement it is recommending.
 *   · Mobility. The 51 exercises carrying that pattern are the corrective
 *     work a restriction calls for. A rule that excluded them would train
 *     around a limitation forever instead of fixing it.
 *   · Biceps. The tendon does cross the shoulder, but a curl does not load
 *     the joint the way pressing does, and cautioning every arm exercise on a
 *     shoulder history would make the screen noise a trainer learns to skip.
 *
 * Returns the worst verdict any rule reached, with every reason that fired —
 * not just the deciding one, because a trainer overruling a block needs to see
 * all of what they are overruling.
 */
function screenExercise(exercise, screen = {}) {
  const reasons = [];
  const muscle = str(exercise?.target_muscle);
  const group = str(exercise?.muscle_group);
  const pattern = str(exercise?.movement_pattern);
  const equip = str(exercise?.equipment);
  const difficulty = str(exercise?.difficulty).toLowerCase();

  for (const c of screen.constraints || []) {
    // An unlocated constraint has no muscles and no patterns, so it cannot
    // select an exercise. It travels with the result instead, where a trainer
    // reads it once, rather than attaching itself to all 890 rows.
    if (!c.muscles.length && !c.patterns.length) continue;
    const hit = c.muscles.includes(muscle) || c.muscles.includes(group) || c.patterns.includes(pattern);
    if (!hit) continue;
    reasons.push({
      verdict: c.verdict,
      rule: `${c.region}_${c.verdict}`,
      because: `${c.source}: ${c.evidence}`,
      note: c.note,
    });
  }

  // Equipment the studio does not have is not a safety verdict, but it is
  // still a reason this exercise cannot be prescribed, so it blocks.
  if (screen.equipment && equip && !screen.equipment.includes(equip)) {
    reasons.push({
      verdict: VERDICTS.BLOCK,
      rule: 'equipment_unavailable',
      because: `equipment: ${equip}`,
      note: 'not in the equipment list this programme may draw on',
    });
  }

  // Difficulty is a ceiling, not a filter on the client's ambition: an
  // advanced movement for a beginner is a caution a trainer may take, because
  // a trainer can coach it and the library cannot know that.
  if (screen.difficulty_allowed && difficulty && !screen.difficulty_allowed.includes(difficulty)) {
    reasons.push({
      verdict: VERDICTS.CAUTION,
      rule: 'above_experience_level',
      because: `difficulty: ${difficulty} for a ${screen.experience} client`,
      note: 'prescribe only if the trainer is coaching the movement directly',
    });
  }

  const verdict = reasons.reduce(
    (worst, r) => (RANK[r.verdict] > RANK[worst] ? r.verdict : worst),
    VERDICTS.ALLOW,
  );
  return { verdict, reasons };
}

/**
 * Screen a list of exercises, partitioned by verdict.
 *
 * `allowed` and `caution` are what a generator may choose from; `blocked` is
 * carried rather than discarded so the reason an obvious exercise is missing
 * can be answered without re-running anything.
 */
function screenLibrary(exercises = [], screen = {}) {
  const allowed = [];
  const caution = [];
  const blocked = [];
  for (const ex of exercises) {
    const result = { ...ex, ...screenExercise(ex, screen) };
    if (result.verdict === VERDICTS.BLOCK) blocked.push(result);
    else if (result.verdict === VERDICTS.CAUTION) caution.push(result);
    else allowed.push(result);
  }
  return {
    allowed,
    caution,
    blocked,
    counts: { allowed: allowed.length, caution: caution.length, blocked: blocked.length },
  };
}

/**
 * Weekly set counts per muscle group, against the landmarks.
 *
 * `weeks` is [{ week, groups: { Chest: 9, … }, unattributable: 3 }], which the
 * caller builds by joining completed sets to the library. 93% of production's
 * completed sets join; the rest have no exercise_id and are reported as
 * `unattributable` rather than dropped, because a muscle group that looks
 * under-trained may simply be the part of the log that would not join.
 */
function volumeLandmarks(weeks = []) {
  const groups = new Map();
  let unattributable = 0;

  for (const w of weeks) {
    unattributable += Number(w?.unattributable) || 0;
    for (const [group, sets] of Object.entries(w?.groups || {})) {
      const n = Number(sets);
      if (!Number.isFinite(n)) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ week: w.week, sets: n });
    }
  }

  const rows = [...groups.entries()].map(([group, series]) => {
    const mark = LANDMARKS[group] ?? null;
    const latest = series[series.length - 1] ?? null;
    const mean = series.length
      ? Math.round((series.reduce((s, x) => s + x.sets, 0) / series.length) * 10) / 10
      : null;

    // Consecutive from the END of the series. An over-reaching week eight
    // weeks ago that was followed by a normal one is history, not a deload
    // trigger; what matters is whether it is still happening.
    let weeksOverMrv = 0;
    if (mark) {
      for (let i = series.length - 1; i >= 0 && series[i].sets > mark.mrv; i -= 1) weeksOverMrv += 1;
    }

    return {
      group,
      weeks: series,
      latest_sets: latest?.sets ?? null,
      mean_sets: mean,
      landmark: mark,
      // Null rather than a word when the group has no landmark — Cardio is
      // counted in sets and judging it in sets would be a category error.
      status: mark && latest
        ? (latest.sets > mark.mrv ? 'over_mrv'
          : latest.sets < mark.mev ? 'under_mev'
            : latest.sets > mark.mav ? 'above_mav' : 'in_range')
        : null,
      weeks_over_mrv: weeksOverMrv,
    };
  }).sort((a, b) => (b.latest_sets ?? 0) - (a.latest_sets ?? 0));

  return {
    groups: rows,
    under_mev: rows.filter((r) => r.status === 'under_mev').map((r) => r.group),
    over_mrv: rows.filter((r) => r.status === 'over_mrv').map((r) => r.group),
    // Groups with no sets at all this window are NOT under_mev — they are
    // untrained, which is a different conversation and may be deliberate.
    untrained: Object.keys(LANDMARKS).filter((g) => LANDMARKS[g] && !groups.has(g)),
    unattributable_sets: unattributable,
    weeks_observed: new Set(weeks.map((w) => w?.week).filter(Boolean)).size,
    // Stated so nobody reads these as this studio's own numbers.
    basis: 'published training-volume heuristics, adapted to the library\'s coarse muscle groups',
  };
}

/**
 * Should this client deload?
 *
 * Four independent triggers, each reporting whether it could even be
 * evaluated. That second half is the point: production holds RPE on 4 of 520
 * sets, so the fatigue trigger is usually unobservable, and "no deload
 * indicated" from four silent triggers is a very different claim from "no
 * deload indicated" from four that ran.
 *
 * @param {object=} input.history  buildTrainingHistory() output
 * @param {object=} input.recovery buildRecovery() output
 * @param {object=} input.volume   volumeLandmarks() output
 */
function deloadTriggers({ history = null, recovery = null, volume = null } = {}) {
  const triggers = [];
  const unobservable = [];

  const fatigue = history?.fatigue ?? null;
  if (!fatigue || fatigue.flag === null) {
    unobservable.push({
      trigger: 'accumulated_fatigue',
      reason: fatigue?.reason ?? 'no training history supplied',
    });
  } else if (fatigue.flag === 'accumulating') {
    triggers.push({
      trigger: 'accumulated_fatigue',
      evidence: `effort up ${fatigue.rpe_delta} RPE across ${fatigue.weeks_compared} weeks`
        + `${fatigue.volume_delta_pct !== null ? ` while tonnage moved ${fatigue.volume_delta_pct}%` : ''}`,
    });
  }

  const regressing = Array.isArray(history?.regressing) ? history.regressing : [];
  if (!history?.confidence?.enough_for_progression_calls) {
    unobservable.push({
      trigger: 'lifts_regressing',
      reason: 'no lift has enough sessions logged for a trend',
    });
  } else if (regressing.length >= REGRESSING_LIFTS_FOR_DELOAD) {
    triggers.push({
      trigger: 'lifts_regressing',
      evidence: `${regressing.length} lifts regressing: ${regressing.join(', ')}`,
    });
  }

  if (!volume || !volume.weeks_observed) {
    unobservable.push({ trigger: 'volume_over_mrv', reason: 'no attributable weekly volume' });
  } else {
    const sustained = (volume.groups || []).filter((g) => g.weeks_over_mrv >= WEEKS_OVER_MRV_FOR_DELOAD);
    if (sustained.length) {
      triggers.push({
        trigger: 'volume_over_mrv',
        evidence: sustained
          .map((g) => `${g.group} above ${g.landmark.mrv} sets for ${g.weeks_over_mrv} weeks`)
          .join('; '),
      });
    }
  }

  if (!recovery?.present || recovery.score === null || recovery.score === undefined) {
    unobservable.push({ trigger: 'readiness_declining', reason: 'no scored weekly check-ins' });
  } else if (recovery.trend === 'declining' && recovery.score < LOW_READINESS) {
    triggers.push({
      trigger: 'readiness_declining',
      evidence: `self-reported readiness ${recovery.score} and falling`
        + ` (${recovery.inputs} of ${recovery.max_inputs} questions answered)`,
    });
  }

  return {
    deload_indicated: triggers.length > 0,
    triggers,
    // Named, so "nothing fired" can be told apart from "nothing could fire".
    unobservable,
    evaluated: 4 - unobservable.length,
    of: 4,
  };
}

/**
 * Everything the rules can say about one client, in one object.
 *
 * This is what the AI layer is handed: not a client record to reason about
 * freely, but a screened library it may choose from and a list of decisions
 * that have already been made deterministically. The model's remaining job is
 * selection and explanation, which is the part it is good at.
 */
function evaluate({
  parq, mobility, posture, lifestyle, client, equipment,
  exercises = [], history = null, recovery = null, weeklyGroups = [],
} = {}) {
  const screen = buildConstraints({ parq, mobility, posture, lifestyle, client, equipment });
  const library = screenLibrary(exercises, screen);
  const volume = volumeLandmarks(weeklyGroups);
  const deload = deloadTriggers({ history, recovery, volume });

  return {
    gate: screen.gate,
    // A programme must not be generated at all for a client the studio has not
    // cleared. Returned as a flag rather than thrown, because the caller needs
    // to tell the trainer WHY nothing was generated, and an exception loses it.
    may_program: screen.gate.cleared,
    constraints: screen.constraints,
    referrals: screen.referrals,
    // Constraints with no region attached. They reach the trainer as text
    // rather than filtering the library, because the form never said where.
    unlocated: screen.constraints.filter((c) => !c.region),
    library,
    volume,
    deload,
    experience: screen.experience,
    coverage: screen.coverage,
  };
}

module.exports = {
  buildConstraints,
  screenExercise,
  screenLibrary,
  volumeLandmarks,
  deloadTriggers,
  evaluate,
  VERDICTS,
  REGIONS,
  LANDMARKS,
  MOBILITY_REGIONS,
  POSTURE_ISSUES,
  PARQ_REGION,
  PARQ_REFERRAL,
  PARQ_UNLOCATED,
  POSTURE_REGION,
  MOBILITY_REGION_KEY,
  DIFFICULTY_CEILING,
  WEEKS_OVER_MRV_FOR_DELOAD,
  REGRESSING_LIFTS_FOR_DELOAD,
  LOW_READINESS,
};

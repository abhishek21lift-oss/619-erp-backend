// Everything you need to know about a client before writing them a programme.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// The information required to design a workout is already in this database,
// spread across six screens a trainer would otherwise open one at a time:
// PAR-Q for medical clearance, fitness testing for capacity, posture and
// mobility for what the body will not do yet, lifestyle for how much recovery
// there is to spend, and goals for what it is all for.
//
// Nobody opens six screens before writing a programme. So they write it from
// memory, and the assessment data sits unread.
//
// ── The rule this file follows ─────────────────────────────────────────────
//
// It reports what was measured and it reports what is MISSING, and it never
// fills a gap with a guess.
//
// That second half is the important one. A brief that quietly omits the
// sections nobody has filled in reads as a complete picture of a client, and
// a trainer — or a model being handed this as context — will design against
// it as though it were. Every section therefore carries its own presence flag
// and its own date, so "no known injuries" is visibly different from "nobody
// has asked".

/** Sections a brief can carry, in the order a trainer would want to read them. */
const SECTIONS = ['readiness', 'body', 'capacity', 'limitations', 'lifestyle', 'nutrition', 'goal', 'history'];

/**
 * How old a section may be before it is reported as stale, in days.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Every section below already carries an `as_of`, and nothing read it. So a
 * mobility screen taken two years ago fed the programme with exactly the same
 * authority as one taken last Tuesday — and worse, an ABSENT finding in a
 * stale screen was being read as "nothing wrong there", when what it actually
 * means is "nothing was wrong there, two years ago, before the injury they
 * have not told us about".
 *
 * Stale is not missing and it is not fresh. It is a third thing: real data
 * whose age is itself a fact the trainer should weigh. So it is reported
 * rather than discarded — discarding it would throw away the only screen the
 * studio has, and silently trusting it is what this fixes.
 *
 * The numbers are clinical judgement, not physics, which is why they live in
 * one named table rather than scattered through the code:
 *
 *   readiness    365  a PAR-Q is conventionally re-screened annually, and
 *                     health changes
 *   limitations  180  posture and mobility move with training, injury and
 *                     desk time; half a year is generous
 *   capacity     180  a fitness test older than a training block no longer
 *                     describes current capacity
 *   body          90  weight and composition move fastest of all
 *   lifestyle    180  sleep, stress and occupation change with life
 *   nutrition    180  what somebody eats, what they cannot eat, and what
 *                     their gut does with it, on the same clock as lifestyle
 *   goal         180  a goal nobody has revisited in half a year may not be
 *                     the goal any more
 *
 * `history` has no threshold: it describes the active assignment, whose
 * currency is its own status rather than its age.
 */
const STALE_AFTER_DAYS = Object.freeze({
  readiness: 365,
  limitations: 180,
  capacity: 180,
  body: 90,
  lifestyle: 180,
  nutrition: 180,
  goal: 180,
});

/** Whole days between a YYYY-MM-DD and today, or null when undatable. */
function ageInDays(asOf, today = new Date()) {
  if (!asOf) return null;
  const then = new Date(`${String(asOf).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return null;
  const now = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.floor((now - then) / 86400000);
  return days >= 0 ? days : null;
}

/**
 * The date a section speaks as of.
 *
 * Most sections carry one `as_of`. `limitations` does not: it composes two
 * independent assessments, posture and mobility, either of which may be absent
 * on its own, and it nests a date under each.
 *
 * That nesting is why the first version of this function silently skipped the
 * single most safety-relevant section on the page — it read `s.as_of`, found
 * undefined, and moved on. The unit tests missed it because their fixtures were
 * synthetic sections with a flat date; a live client with a 2023 mobility screen
 * is what found it.
 *
 * The NEWEST of the nested dates wins. A section is as current as its freshest
 * evidence: a posture screen taken last week means the trainer has looked at
 * this client recently, even if the mobility screen beside it is older. Taking
 * the oldest would cry stale at a studio that is assessing properly.
 */
function sectionDate(section, s) {
  if (!s) return null;
  if (section === 'limitations') {
    const dates = [s.posture?.as_of, s.mobility?.as_of].filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }
  return s.as_of ?? null;
}

/**
 * Which present sections are older than their threshold.
 *
 * A section with no date is NOT reported stale — it is undated, which is a
 * different complaint and one this function has no evidence for. Saying "stale"
 * about something whose age is unknown would be the same class of mistake as
 * the defaults this engine exists to remove.
 */
function staleness(sections = {}, today = new Date()) {
  const out = [];
  for (const [section, threshold] of Object.entries(STALE_AFTER_DAYS)) {
    const s = sections[section];
    if (!s?.present) continue;
    const asOf = sectionDate(section, s);
    const days = ageInDays(asOf, today);
    if (days === null) continue;
    if (days > threshold) out.push({ section, as_of: asOf, age_days: days, stale_after_days: threshold });
  }
  return out;
}

/** Whole years between a date of birth and today, or null. */
function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** A number, or null — never NaN, never a string that renders as one. */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * JSONB that may hold an array, an object of flags, or nothing.
 *
 * The assessment screens store issue lists in several shapes depending on
 * which one wrote them; this flattens to a plain list of labels and drops
 * anything it cannot read rather than rendering "[object Object]" into a
 * clinical summary.
 */
function labelsFrom(value) {
  if (!value) return [];
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => (typeof v === 'string' ? v : v?.label ?? v?.name ?? v?.region ?? null)).filter(Boolean);
  }
  if (typeof raw === 'object') {
    // { rounded_shoulders: true, forward_head: false } → ['rounded shoulders']
    //
    // Strictly `true`. PAR-Q's past_history mixes booleans with a free-text
    // `occupation: "Student"`, and a truthiness test would report a client's
    // job as a medical condition.
    return Object.entries(raw)
      .filter(([, v]) => v === true || v === 'yes' || v === 'Yes')
      .map(([k]) => k.replace(/_/g, ' '));
  }
  return [];
}

/**
 * The mobility screen's findings, keeping WHY each region matters.
 *
 * body_regions is an array of objects — { region, score, pain, restriction } —
 * one per joint tested, including the ones that came back clean. Flattening it
 * to names would list every joint as a problem; running it through labelsFrom
 * returned an empty list, because these objects have no `label` or `name`, so
 * a client with a restricted AND painful neck reported no restrictions at all.
 * Verified against live data, which is the only reason this was found.
 *
 * Only regions with pain or restriction come back — those are the ones that
 * change what you may prescribe.
 */
function mobilityFindings(value) {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === 'object' && (r.pain === true || r.restriction === true))
    .map((r) => ({
      region: r.region ?? r.label ?? r.name ?? 'Unknown region',
      pain: r.pain === true,
      restriction: r.restriction === true,
      score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
    }));
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Free text a trainer typed, from a column that may not hold text.
 *
 * The assessment screens save their notes as a JSONB OBJECT with one field per
 * prompt — { summary, observations, precautions, … } — while the older screens
 * save a plain string. This brief typed them all as strings and passed them
 * through untouched, so the object reached the browser and was handed to React
 * as a child: "Objects are not valid as a React child", thrown in the middle
 * of the render.
 *
 * That is not a broken card. A throw during render unwinds to the nearest
 * boundary, which is the whole /pt-os segment — so opening one client's brief
 * took out Workout Plans, sessions and assessments with it. And because an
 * object whose every value is an empty string is still truthy, it threw for
 * every client whose PAR-Q had ever been opened, not just the ones with notes.
 *
 * Flattened rather than dropped: these are words a trainer wrote about a
 * client, and a brief that quietly discards them is the same failure this file
 * exists to prevent. Empty prompts are omitted; an object with nothing in it
 * becomes null, which is what "no notes" should have looked like all along.
 */
function textFrom(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    // Some rows hold the JSON as text rather than as jsonb.
    if (t.startsWith('{') || t.startsWith('[')) {
      const parsed = safeParse(t);
      if (parsed && typeof parsed === 'object') return textFrom(parsed);
    }
    return t;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const items = value.map((v) => textFrom(v)).filter(Boolean);
    return items.length ? items.join('\n') : null;
  }

  if (typeof value === 'object') {
    // "movement_limitations" → "Movement limitations: …", so the prompt the
    // trainer was answering survives into the brief.
    const lines = Object.entries(value)
      .map(([k, v]) => [k, textFrom(v)])
      .filter(([, v]) => v)
      .map(([k, v]) => `${k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}: ${v}`);
    return lines.length ? lines.join('\n') : null;
  }

  return null;
}

/**
 * Assemble the brief from rows the caller has already fetched.
 *
 * Pure, so the shape of the thing a trainer reads can be tested without a
 * database — and so the "missing" logic, which is the part that matters, is
 * testable directly.
 */
function buildBrief({
  client, parq, assessment, posture, mobility, lifestyle, nutrition, goal, assignment,
  recentSessions = [],
}) {
  const sections = {};

  // ── Readiness: is it safe to train them, and does anything need working
  // around. The gate status is the studio's own decision, recorded on the form.
  sections.readiness = parq ? {
    present: true,
    as_of: dateOf(parq.assessment_date),
    risk_level: parq.risk_level ?? null,
    risk_message: parq.risk_message ?? null,
    gate_status: parq.workout_gate_status ?? null,
    flagged_answers: num(parq.parq_yes_count),
    current_health: labelsFrom(parq.current_health),
    past_history: labelsFrom(parq.past_history),
    blood_group: parq.blood_group ?? null,
    notes: textFrom(parq.trainer_notes),
  } : { present: false };

  sections.body = assessment ? {
    present: true,
    as_of: dateOf(assessment.assessment_date),
    height_cm: num(assessment.height_cm),
    weight_kg: num(assessment.weight),
    bmi: num(assessment.bmi),
    body_fat_pct: num(assessment.body_fat_pct),
    lean_mass_kg: num(assessment.lean_body_mass_kg),
    waist_cm: num(assessment.waist_cm),
    waist_hip_ratio: num(assessment.waist_hip_ratio),
    resting_hr: num(assessment.resting_heart_rate),
    bp: assessment.bp_systolic && assessment.bp_diastolic
      ? `${assessment.bp_systolic}/${assessment.bp_diastolic}` : null,
    bp_category: assessment.bp_category ?? null,
  } : { present: false };

  // ── Capacity: what they can currently do. Scores are the studio's own
  // computed values from the fitness test; categories are the words that go
  // with them, kept together so a number never appears without its scale.
  sections.capacity = assessment ? {
    present: true,
    as_of: dateOf(assessment.assessment_date),
    overall: num(assessment.overall_fitness_score),
    strength: { score: num(assessment.strength_score_computed ?? assessment.strength_score), category: assessment.strength_category ?? null },
    cardio: { score: num(assessment.cardio_score_computed ?? assessment.cardio_score), category: assessment.cardio_category ?? null, vo2_max: num(assessment.vo2_max) },
    endurance: { score: num(assessment.endurance_score_computed), category: assessment.endurance_category ?? null },
    flexibility: { score: num(assessment.flexibility_score), category: assessment.flexibility_category ?? null },
  } : { present: false };

  // ── Limitations: the section that changes exercise SELECTION rather than
  // volume. Posture and mobility are separate assessments and either may be
  // absent on its own, so presence is per-source.
  const postureIssues = posture
    ? [...labelsFrom(posture.front_issues), ...labelsFrom(posture.side_issues), ...labelsFrom(posture.back_issues)]
    : [];
  sections.limitations = (posture || mobility || client?.injuries) ? {
    present: true,
    posture: posture ? {
      as_of: dateOf(posture.assessment_date),
      risk_level: posture.posture_risk_level ?? null,
      issues: postureIssues,
      notes: textFrom(posture.coach_notes),
    } : null,
    mobility: mobility ? {
      as_of: dateOf(mobility.assessment_date),
      category: mobility.mobility_category ?? null,
      score: num(mobility.mobility_score),
      // Only the joints that came back painful or restricted, each carrying
      // which of the two it was — "restricted" and "painful" call for
      // different changes to a programme.
      findings: mobilityFindings(mobility.body_regions),
      notes: textFrom(mobility.performance_notes),
    } : null,
    // Free text the trainer typed on the client record. Carried verbatim: it
    // is the one place an injury nobody ran an assessment for gets recorded.
    injuries: textFrom(client?.injuries),
    has_asymmetry: assessment?.has_asymmetry ?? null,
  } : { present: false };

  // ── Lifestyle: how much training this person can actually recover from.
  sections.lifestyle = lifestyle ? {
    present: true,
    as_of: dateOf(lifestyle.assessment_date),
    experience_level: lifestyle.workout_experience_level ?? null,
    years_training: num(lifestyle.years_of_experience),
    sleep_hours: num(lifestyle.sleep_duration_hours),
    sleep_quality: lifestyle.sleep_quality ?? null,
    stress_level: lifestyle.stress_level ?? null,
    occupation_type: lifestyle.occupation_type ?? null,
    activity_level: lifestyle.activity_level ?? null,
    daily_steps: lifestyle.daily_steps_bracket ?? null,
    energy_level: lifestyle.energy_level ?? null,
    recovery_quality: lifestyle.recovery_quality ?? null,
    recovery_risk: lifestyle.recovery_risk ?? null,
    lifestyle_score: num(lifestyle.lifestyle_score),
    notes: textFrom(lifestyle.coach_notes),
  } : { present: false };

  // ── Nutrition: what the training is being fuelled by, and what it must be
  // written around.
  //
  // ── Why a WORKOUT brief carries this ─────────────────────────────────────
  //
  // The studio has asked these questions and stored the answers since
  // migration 057, and until now only the diet generator ever read them. The
  // workout generator — the feature whose whole job is deciding how much work
  // a person can recover from — could not see that a client eats one meal a
  // day, drinks under a litre of water, or carries a medical condition their
  // nutrition assessment records and no other form does.
  //
  // Four of these fields change a PROGRAMME rather than a meal plan:
  //
  //   · medical_conditions / medical_notes — recorded here and nowhere else
  //     for clients whose PAR-Q predates this form. A constraint is a
  //     constraint whichever screen it was typed into.
  //   · meals_per_day and late_night_eating — energy availability and sleep
  //     quality, which is recovery, which is how much volume is affordable.
  //   · water_intake_liters — the one input that changes what a hard session
  //     is safe to prescribe in an Indian summer.
  //   · digestive_issues — decides whether a session can be programmed close
  //     to a meal at all.
  //
  // Everything else the assessment holds stays out of this brief. A workout
  // prompt does not need somebody's favourite foods, and a section that
  // carries everything gets skimmed.
  sections.nutrition = nutrition ? {
    present: true,
    as_of: dateOf(nutrition.assessment_date),
    diet_preferences: labelsFrom(nutrition.diet_preferences),
    allergies: labelsFrom(nutrition.food_allergies),
    meals_per_day: num(nutrition.meals_per_day),
    late_night_eating: nutrition.late_night_eating ?? null,
    water_intake_liters: num(nutrition.water_intake_liters ?? nutrition.daily_fluid_intake_liters),
    digestive_issues: labelsFrom(nutrition.digestive_issues),
    takes_supplements: nutrition.takes_supplements ?? null,
    // The two fields that are a SAFETY input rather than a dietary one. Kept
    // verbatim through textFrom for the same reason the PAR-Q notes are: they
    // are words a trainer wrote about a person.
    medical_conditions: labelsFrom(nutrition.medical_conditions),
    medical_notes: textFrom(nutrition.medical_notes),
  } : { present: false };

  sections.goal = goal ? {
    present: true,
    as_of: dateOf(goal.created_at),
    goal_type: goal.goal_type ?? null,
    priority: goal.priority_goal ?? null,
    description: textFrom(goal.goal_description),
    target_weight: num(goal.target_weight),
    target_body_fat: num(goal.target_body_fat),
    target_date: dateOf(goal.target_date),
    commitment_level: goal.commitment_level ?? null,
    motivation_level: goal.motivation_level ?? null,
    challenges: labelsFrom(goal.biggest_challenges),
    estimated_weeks: num(goal.estimated_duration_weeks),
  } : { present: false };

  // ── History: what they are running now and whether they turn up. Read from
  // the log rather than from the plan, because a programme on paper and a
  // programme being performed are different things.
  const completed = recentSessions.filter((s) => s.status === 'completed').length;
  sections.history = assignment ? {
    present: true,
    plan_id: assignment.plan_id,
    plan_name: assignment.plan_name,
    started_on: dateOf(assignment.start_date),
    duration_weeks: num(assignment.duration_weeks),
    days_per_week: num(assignment.planned_days_count),
    progress_pct: num(assignment.progress_pct),
    sessions_last_4_weeks: recentSessions.length,
    completed_last_4_weeks: completed,
  } : { present: false };

  const missing = SECTIONS.filter((k) => !sections[k].present);
  // Present, dated, and older than a trainer should silently trust.
  const stale = staleness(sections);

  return {
    client: {
      id: client?.id ?? null,
      name: client?.name ?? null,
      gender: client?.gender ?? null,
      age: ageFrom(client?.dob),
      goal: client?.goal ?? null,
      notes: textFrom(client?.notes),
    },
    sections,
    // Named explicitly rather than left for the reader to notice. A brief that
    // hides its gaps gets designed against as though it were complete.
    missing,
    // The same argument for age. An assessment nobody has repeated in two
    // years is not a current description of anybody.
    stale,
    completeness_pct: Math.round(((SECTIONS.length - missing.length) / SECTIONS.length) * 100),
  };
}

/** YYYY-MM-DD, or null. Dates arrive from pg as Date or string depending. */
function dateOf(v) {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
}

module.exports = {
  buildBrief, ageFrom, labelsFrom, mobilityFindings, textFrom, SECTIONS,
  staleness, ageInDays, sectionDate, STALE_AFTER_DAYS,
};

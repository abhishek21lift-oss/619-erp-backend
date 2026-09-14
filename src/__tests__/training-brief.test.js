// The training brief: everything needed to write a programme, in one payload.
//
// Two things here are worth testing and the rest is field mapping.
//
// The first is what the brief says it does NOT know. A brief that quietly
// omits the assessments nobody has filled in reads as a complete picture of a
// client, and whoever designs against it — a trainer, or a model handed this
// as context — will treat silence as "nothing to worry about".
//
// The second is the JSONB. These columns hold three different shapes depending
// on which screen wrote them, and getting one wrong does not throw: it returns
// an empty list, and an empty list of injuries looks exactly like a healthy
// client. Every fixture below is a shape copied from the live database.

const { buildBrief, ageFrom, labelsFrom, mobilityFindings, SECTIONS } = require('../modules/pt-os/training-brief');

const CLIENT = { id: 'c-1', name: 'Ratnam Yadav', gender: 'male', dob: '1998-04-12', goal: 'muscle_gain' };

/** Real body_regions from the live mobility assessment. */
const REGIONS = [
  { pain: true, score: 3, region: 'Neck', restriction: true },
  { pain: true, score: 3, region: 'Shoulders', restriction: false },
  { pain: false, score: 3, region: 'Thoracic Spine', restriction: false },
  { pain: false, score: 3, region: 'Hip', restriction: false },
];

/** Real past_history from the live PAR-Q: booleans, plus a free-text field. */
const PAST_HISTORY = {
  copd: false, asthma: false, back_pain: true, knee_pain: false,
  occupation: 'Student', surgeries: false,
};

describe('what the brief admits it does not know', () => {
  it('names every missing section rather than leaving it out', () => {
    const brief = buildBrief({ client: CLIENT });
    expect(brief.missing.sort()).toEqual([...SECTIONS].sort());
    expect(brief.completeness_pct).toBe(0);
  });

  it('marks a section absent rather than empty', () => {
    // { present: false } and { present: true, issues: [] } mean opposite
    // things — "nobody has asked" versus "asked, and nothing found".
    const brief = buildBrief({ client: CLIENT });
    expect(brief.sections.readiness).toEqual({ present: false });
    expect(brief.sections.limitations.present).toBe(false);
  });

  it('counts completeness from the sections actually filled', () => {
    const brief = buildBrief({
      client: CLIENT,
      parq: { assessment_date: '2026-07-01', risk_level: 'low' },
      lifestyle: { assessment_date: '2026-07-02', sleep_duration_hours: 6 },
    });
    expect(brief.missing).not.toContain('readiness');
    expect(brief.missing).not.toContain('lifestyle');
    expect(brief.completeness_pct).toBe(Math.round((2 / SECTIONS.length) * 100));
  });

  it('every section carries the date it was measured', () => {
    // A brief is read months after the assessments were taken. A capacity
    // score from last March is not the same claim as one from last week, and
    // the number alone cannot say which it is.
    const brief = buildBrief({
      client: CLIENT,
      assessment: { assessment_date: '2026-03-14', weight: 72, overall_fitness_score: 61 },
    });
    expect(brief.sections.body.as_of).toBe('2026-03-14');
    expect(brief.sections.capacity.as_of).toBe('2026-03-14');
  });
});

describe('mobility findings', () => {
  it('reports only the regions with pain or restriction', () => {
    const out = mobilityFindings(REGIONS);
    expect(out.map((r) => r.region)).toEqual(['Neck', 'Shoulders']);
  });

  it('keeps pain and restriction apart', () => {
    // They call for different changes: a restricted joint needs the movement
    // regressed, a painful one needs it removed and looked at.
    const [neck, shoulders] = mobilityFindings(REGIONS);
    expect(neck).toMatchObject({ pain: true, restriction: true });
    expect(shoulders).toMatchObject({ pain: true, restriction: false });
  });

  it('does NOT lose a restricted region to the generic label reader', () => {
    // This is the bug this function exists for. body_regions is an array of
    // objects with no `label` or `name`, so the generic reader returned an
    // empty list and a client with a restricted, painful neck reported no
    // restrictions at all. Found against live data.
    expect(mobilityFindings(REGIONS)).not.toHaveLength(0);
  });

  it('does not report a healthy joint as a finding', () => {
    // The other half: labelsFrom now falls back to `region`, which would list
    // every joint tested — including the clean ones — as a problem.
    expect(mobilityFindings(REGIONS).map((r) => r.region)).not.toContain('Hip');
    expect(labelsFrom(REGIONS)).toContain('Hip');   // why the two differ
  });

  it('survives a shape it has never seen', () => {
    expect(mobilityFindings(null)).toEqual([]);
    expect(mobilityFindings({ not: 'an array' })).toEqual([]);
    expect(mobilityFindings('[]')).toEqual([]);
  });
});

describe('PAR-Q history', () => {
  it('reports a flagged condition', () => {
    expect(labelsFrom(PAST_HISTORY)).toContain('back pain');
  });

  it('does not report the client\'s job as a medical condition', () => {
    // past_history mixes booleans with a free-text `occupation`. A truthiness
    // test puts "Student" in a list of health conditions.
    expect(labelsFrom(PAST_HISTORY)).not.toContain('occupation');
    expect(labelsFrom(PAST_HISTORY)).toEqual(['back pain']);
  });

  it('reads a plain array of issue names', () => {
    // The posture screen writes this shape.
    expect(labelsFrom(['Anterior Pelvic Tilt'])).toEqual(['Anterior Pelvic Tilt']);
  });

  it('reads JSONB that arrived as a string', () => {
    expect(labelsFrom('["Poor Diet","Office Work"]')).toEqual(['Poor Diet', 'Office Work']);
  });
});

describe('limitations', () => {
  it('is present when only a free-text injury exists', () => {
    // The one place an injury nobody ran an assessment for gets recorded. If
    // this needed a posture assessment to show, the note would never surface.
    const brief = buildBrief({ client: { ...CLIENT, injuries: 'Left rotator cuff, 2024' } });
    expect(brief.sections.limitations.present).toBe(true);
    expect(brief.sections.limitations.injuries).toBe('Left rotator cuff, 2024');
  });

  it('wires mobility through the findings reader, not the generic one', () => {
    // Tested through buildBrief, not against mobilityFindings directly. The
    // original defect was in the WIRING — the reader was correct and the call
    // site passed body_regions to labelsFrom — so a test that only exercised
    // the function passed while the brief still dropped every restriction.
    const brief = buildBrief({
      client: CLIENT,
      mobility: { assessment_date: '2026-07-01', mobility_category: 'fair', body_regions: REGIONS },
    });
    const { findings } = brief.sections.limitations.mobility;
    expect(findings).toEqual([
      { region: 'Neck', pain: true, restriction: true, score: 3 },
      { region: 'Shoulders', pain: true, restriction: false, score: 3 },
    ]);
  });

  it('merges posture issues from all three views', () => {
    const brief = buildBrief({
      client: CLIENT,
      posture: { assessment_date: '2026-07-01', front_issues: ['Uneven Shoulders'], side_issues: null, back_issues: ['Anterior Pelvic Tilt'] },
    });
    expect(brief.sections.limitations.posture.issues).toEqual(['Uneven Shoulders', 'Anterior Pelvic Tilt']);
  });
});

describe('history', () => {
  it('counts attendance from the log, not the plan', () => {
    // progress_pct is maintained on the assignment and can drift; what was
    // performed is what the sessions say.
    const brief = buildBrief({
      client: CLIENT,
      assignment: { plan_id: 'p-1', plan_name: 'Full Body', start_date: '2026-07-01', duration_weeks: 4, planned_days_count: 3, progress_pct: 90 },
      recentSessions: [{ status: 'completed' }, { status: 'completed' }, { status: 'in_progress' }],
    });
    expect(brief.sections.history.completed_last_4_weeks).toBe(2);
    expect(brief.sections.history.sessions_last_4_weeks).toBe(3);
  });
});

describe('ageFrom', () => {
  it('is null rather than NaN for a missing or unusable dob', () => {
    expect(ageFrom(null)).toBeNull();
    expect(ageFrom('not-a-date')).toBeNull();
  });

  it('rejects an impossible age instead of printing it', () => {
    expect(ageFrom('1750-01-01')).toBeNull();
  });
});

// ── The notes columns are not text ──────────────────────────────────────────
//
// This is the defect that took the pt-os segment to its error boundary in
// production. pt_parq_forms.trainer_notes and pt_lifestyle_assessments
// .coach_notes are JSONB OBJECTS — one field per prompt on the assessment
// screen — and the brief typed them as strings and passed them straight
// through. React throws on an object child, mid-render, which unwinds to the
// segment boundary: opening one client's brief took out Workout Plans,
// sessions and assessments with it.
//
// The empty case is the one that made it universal: an object whose every
// value is "" is still truthy, so it threw for every client whose PAR-Q had
// ever been opened, not only those with notes written.
describe('textFrom — free text out of columns that do not hold text', () => {
  const { textFrom } = require('../modules/pt-os/training-brief');

  // Copied verbatim from the live row for the client this was found on.
  const PARQ_NOTES = {
    posture: '', summary: '', precautions: '', observations: '',
    recommendations: '', contraindications: '', movement_limitations: '',
  };

  it('turns an all-empty notes object into null, not an object', () => {
    expect(textFrom(PARQ_NOTES)).toBeNull();
  });

  it('keeps what the trainer wrote, with the prompt it answers', () => {
    expect(textFrom({ ...PARQ_NOTES, movement_limitations: 'No overhead press' }))
      .toBe('Movement limitations: No overhead press');
  });

  it('keeps every answered prompt, in order', () => {
    expect(textFrom({ summary: 'Deconditioned', precautions: 'Watch the knee' }))
      .toBe('Summary: Deconditioned\nPrecautions: Watch the knee');
  });

  it('passes plain strings through, trimmed', () => {
    expect(textFrom('  needs a shoulder screen  ')).toBe('needs a shoulder screen');
    expect(textFrom('   ')).toBeNull();
  });

  it('reads a notes object that was stored as text', () => {
    expect(textFrom('{"summary":"Tight hips"}')).toBe('Summary: Tight hips');
  });

  it('never returns a non-string', () => {
    for (const v of [null, undefined, {}, [], [''], 0, false, { a: {} }, { a: [null] }]) {
      const out = textFrom(v);
      expect(out === null || typeof out === 'string').toBe(true);
    }
  });

  it('carries a whole brief without leaving an object in a text slot', () => {
    const brief = buildBrief({
      client: { ...CLIENT, injuries: null, notes: null },
      parq: { assessment_date: '2026-07-27', risk_level: 'low', trainer_notes: PARQ_NOTES },
      lifestyle: { assessment_date: '2026-07-27', coach_notes: { sleep: '', stress: '' } },
      goal: { created_at: '2026-07-27', goal_type: 'muscle_gain', goal_description: null },
    });
    for (const v of [
      brief.sections.readiness.notes,
      brief.sections.lifestyle.notes,
      brief.sections.goal.description,
      brief.client.notes,
    ]) {
      expect(v === null || typeof v === 'string').toBe(true);
    }
  });
});

// ── The assessment only the diet generator could see ───────────────────────
//
// pt_nutrition_assessments has been collected since migration 057 and the
// feature whose whole job is deciding how much work a person can recover from
// could not read a word of it — not that they eat once a day, not that they
// drink under a litre, and not the medical conditions recorded on that form
// and on no other.

describe('the nutrition section', () => {
  const { buildBrief, SECTIONS, STALE_AFTER_DAYS } = require('../modules/pt-os/training-brief');

  const NUTRITION = {
    assessment_date: '2026-08-01',
    diet_preferences: ['vegetarian'],
    food_allergies: ['peanuts'],
    meals_per_day: 2,
    late_night_eating: true,
    water_intake_liters: '1.5',
    digestive_issues: { bloating: true, reflux: false },
    takes_supplements: false,
    medical_conditions: ['hypothyroidism'],
    medical_notes: 'on levothyroxine',
  };

  const brief = (nutrition) => buildBrief({ client: { id: 'c1' }, nutrition });

  it('is one of the sections a brief is counted complete against', () => {
    expect(SECTIONS).toContain('nutrition');
  });

  it('is absent, not empty, when nobody has filled the form in', () => {
    const b = brief(null);
    expect(b.sections.nutrition).toEqual({ present: false });
    expect(b.missing).toContain('nutrition');
  });

  it('carries the four fields that change a programme rather than a meal plan', () => {
    const n = brief(NUTRITION).sections.nutrition;
    expect(n.present).toBe(true);
    expect(n.medical_conditions).toEqual(['hypothyroidism']);
    expect(n.medical_notes).toBe('on levothyroxine');
    expect(n.meals_per_day).toBe(2);
    expect(n.water_intake_liters).toBe(1.5);
    expect(n.late_night_eating).toBe(true);
    expect(n.digestive_issues).toEqual(['bloating']);
  });

  it('leaves out what a workout prompt has no business reading', () => {
    const n = brief({ ...NUTRITION, favourite_foods: ['biryani'], cravings: ['sugar'] });
    expect(Object.keys(n)).not.toContain('favourite_foods');
    expect(Object.keys(n)).not.toContain('cravings');
  });

  it('falls back to the daily fluid total when no water figure was given', () => {
    const n = brief({ ...NUTRITION, water_intake_liters: null, daily_fluid_intake_liters: '2.5' })
      .sections.nutrition;
    expect(n.water_intake_liters).toBe(2.5);
  });

  it('reports nothing rather than zero when neither was recorded', () => {
    const n = brief({ ...NUTRITION, water_intake_liters: null, daily_fluid_intake_liters: null })
      .sections.nutrition;
    expect(n.water_intake_liters).toBeNull();
  });

  it('goes stale on the same clock as lifestyle', () => {
    expect(STALE_AFTER_DAYS.nutrition).toBe(STALE_AFTER_DAYS.lifestyle);
    const old = new Date();
    old.setUTCDate(old.getUTCDate() - (STALE_AFTER_DAYS.nutrition + 1));
    const b = brief({ ...NUTRITION, assessment_date: old.toISOString().slice(0, 10) });
    expect(b.stale.map((s) => s.section)).toContain('nutrition');
  });

  it('is not stale on the day it was taken', () => {
    const b = brief({ ...NUTRITION, assessment_date: new Date().toISOString().slice(0, 10) });
    expect(b.stale.map((s) => s.section)).not.toContain('nutrition');
  });
});

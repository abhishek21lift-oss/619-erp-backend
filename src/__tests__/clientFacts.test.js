'use strict';
// What the generator is allowed to say about a client.
//
// ── The bug this pins shut ─────────────────────────────────────────────────
//
// The Client Profile card posted height 175, weight 75, gender male, age 30,
// experience "beginner" and four training days for every client whose record
// did not hold them, and the prompt printed all six under a heading that read
// CLIENT AUTHORITATIVE DATA. The model then programmed for a person who did
// not exist, and nothing downstream — not the plan, not the trainer, not the
// ledger — could tell an invented number from a measured one.
//
// So the property under test is not "the right value is returned". It is that
// a value this module cannot source is reported MISSING, with no third option.

const {
  resolveClientFacts, describeFacts, countDays, ageFromDob, FIELDS, BLOCKING,
} = require('../modules/pt-os/client-facts');

const bare = (over = {}) => ({
  client: { id: 'c1', name: 'Bare', ...over },
  profile: null, goals: [], latestAssessment: null, latestCheckin: null,
  lifestyle: null, workoutAssignments: [],
});

describe('a fact is recorded, stated, or missing — never assumed', () => {
  test('an empty record invents nothing at all', () => {
    const { facts, data_quality: dq } = resolveClientFacts(bare());
    for (const field of FIELDS) {
      expect(facts[field].value).toBeNull();
      expect(facts[field].origin).toBe('missing');
    }
    expect(dq.recorded).toEqual([]);
    expect(dq.completeness_pct).toBe(0);
  });

  test('the three facts a programme cannot be written without are the blocking ones', () => {
    const { data_quality: dq } = resolveClientFacts(bare());
    expect(dq.blocking).toEqual(['goal', 'experience_level', 'training_days']);
    expect(BLOCKING).toEqual(['goal', 'experience_level', 'training_days']);
  });

  test('height, weight, age and gender are missing but never blocking', () => {
    const { data_quality: dq } = resolveClientFacts(bare({
      goal: 'strength', workout_experience_level: 'advanced', sessions_per_week: 4,
    }));
    expect(dq.blocking).toEqual([]);
    expect(dq.missing.map((m) => m.field).sort())
      .toEqual(['age', 'equipment', 'gender', 'height_cm', 'weight_kg']);
  });

  test('every resolved fact names the column it came from', () => {
    const { data_quality: dq } = resolveClientFacts(bare({
      dob: '1990-01-01', gender: 'female', sessions_per_week: 3,
      goal: 'fat_loss', workout_experience_level: 'intermediate',
    }));
    const bySource = Object.fromEntries(dq.recorded.map((r) => [r.field, r.source]));
    expect(bySource.age).toBe('pt_clients.dob');
    expect(bySource.training_days).toBe('pt_clients.sessions_per_week');
    expect(bySource.goal).toBe('pt_clients.goal');
  });
});

describe('precedence', () => {
  test('a recorded value always beats a trainer-stated one', () => {
    const { facts } = resolveClientFacts(
      bare({ goal: 'fat_loss' }),
      { goal: 'strength' },
    );
    expect(facts.goal.value).toBe('fat_loss');
    expect(facts.goal.origin).toBe('recorded');
  });

  test('a stated value fills a gap and is marked as the trainer\'s, not the client\'s', () => {
    const { facts, data_quality: dq } = resolveClientFacts(bare(), { goal: 'strength' });
    expect(facts.goal).toEqual({ value: 'strength', source: 'trainer', origin: 'stated' });
    expect(dq.stated).toEqual([{ field: 'goal' }]);
    // A statement is not knowledge. Completeness answers "how much does the
    // studio hold", so a value typed thirty seconds ago must not raise it.
    expect(dq.recorded).toEqual([]);
    expect(dq.completeness_pct).toBe(0);
  });

  test('the latest assessment weight beats the enrolment weight beats the check-in', () => {
    const ctx = bare({ weight: 80 });
    ctx.latestAssessment = { weight: 78 };
    ctx.latestCheckin = { weight: 82 };
    expect(resolveClientFacts(ctx).facts.weight_kg)
      .toEqual({ value: 78, source: 'pt_assessments.weight', origin: 'recorded' });
  });
});

describe('training frequency reads the column the rest of the product writes', () => {
  // The old resolver looked only at `frequency`, a free-text column that is
  // rarely filled, and then took the browser's number — so a client enrolled
  // at three days a week was programmed for four.
  test('sessions_per_week wins', () => {
    const { facts } = resolveClientFacts(bare({
      sessions_per_week: 3, preferred_training_days: 'Mon, Tue, Wed, Thu, Fri', frequency: '6',
    }));
    expect(facts.training_days.value).toBe(3);
    expect(facts.training_days.source).toBe('pt_clients.sessions_per_week');
  });

  test('the named training days are counted when no count is stored', () => {
    const { facts } = resolveClientFacts(bare({ preferred_training_days: 'Mon, Wed, Fri' }));
    expect(facts.training_days.value).toBe(3);
    expect(facts.training_days.source).toBe('pt_clients.preferred_training_days');
  });

  test('free-text frequency is used only when it is a plain 1-7', () => {
    expect(resolveClientFacts(bare({ frequency: '5' })).facts.training_days.value).toBe(5);
    expect(resolveClientFacts(bare({ frequency: 'thrice weekly' })).facts.training_days.origin).toBe('missing');
    expect(resolveClientFacts(bare({ frequency: '9' })).facts.training_days.origin).toBe('missing');
  });

  test('countDays refuses nonsense rather than lowering the frequency quietly', () => {
    expect(countDays('Mon, Wed, Fri')).toBe(3);
    expect(countDays('')).toBeNull();
    expect(countDays(null)).toBeNull();
    expect(countDays('a,b,c,d,e,f,g,h')).toBeNull();
  });
});

describe('equipment has no column, and says so', () => {
  // training_mode is Offline / Online / Hybrid — where a client trains, not
  // what they can lift with. Nothing in the schema records equipment, so the
  // honest answer is missing. The old default claimed "full gym" for everyone.
  test('training_mode is never mistaken for an equipment record', () => {
    const { facts } = resolveClientFacts(bare({ training_mode: 'Offline' }));
    expect(facts.equipment.origin).toBe('missing');
  });
});

describe('age', () => {
  test('is computed from the date of birth, and refuses an unusable one', () => {
    expect(ageFromDob('2000-01-01')).toBeGreaterThan(20);
    expect(ageFromDob(null)).toBeNull();
    expect(ageFromDob('not a date')).toBeNull();
    expect(ageFromDob('1700-01-01')).toBeNull();
  });
});

describe('what the model is shown', () => {
  test('a missing fact is printed NOT RECORDED rather than left out', () => {
    const { facts } = resolveClientFacts(bare({ goal: 'strength' }));
    const text = describeFacts(facts);
    expect(text).toContain('Goal: strength');
    expect(text).toContain('Height (cm): NOT RECORDED');
    expect(text).toContain('Weight (kg): NOT RECORDED');
    // Omitting the line would invite the model to supply a plausible number of
    // its own; saying nothing is held, next to the instruction, does not.
    expect(text).toContain('Do not infer it, do not substitute a typical value');
  });

  test('a trainer\'s statement is shown as a statement', () => {
    const { facts } = resolveClientFacts(bare(), { experience_level: 'advanced' });
    expect(describeFacts(facts))
      .toContain('Experience level: advanced (stated by the trainer for this session, not on file)');
  });

  test('none of the old invented values can appear for an empty record', () => {
    const text = describeFacts(resolveClientFacts(bare()).facts);
    for (const invented of ['175', '75', 'male', 'beginner', 'general_fitness', '30']) {
      expect(text).not.toContain(invented);
    }
  });
});

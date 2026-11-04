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
  resolveClientFacts, describeFacts, describeInterview, countDays, ageFromDob,
  FIELDS, BLOCKING, STATED_SUPERSEDES,
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
      .toEqual(['age', 'equipment', 'gender', 'height_cm', 'session_minutes', 'weight_kg']);
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
  test("the client's active goal wins over the profile and enrolment goals", () => {
    const { facts, data_quality: dq } = resolveClientFacts({
      client: { goal: 'General Fitness' },
      profile: { goal: 'muscle_gain' },
      goals: [{ goal_type: 'fat_loss' }],
    });
    expect(facts.goal).toMatchObject({ value: 'fat_loss', source: 'pt_goals.goal_type' });
    // The older answers are not dropped: they are what the trainer is shown
    // as the disagreement.
    const goal = dq.conflicting.find((c) => c.field === 'goal');
    expect(goal.rejected.map((r) => r.source))
      .toEqual(['client_fitness_profiles.goal', 'pt_clients.goal']);
  });

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

  test('an over-long statement is not a statement', () => {
    // A wall of pasted text in a stated field would print under CLIENT
    // AUTHORITATIVE DATA. The numeric path refuses impossible values; text
    // gets the same rule rather than passing through unbounded.
    const { facts, data_quality: dq } = resolveClientFacts(bare(), {
      goal: 'g'.repeat(201),
      gender: 'x'.repeat(5000),
    });
    expect(facts.goal.origin).toBe('missing');
    expect(facts.gender.origin).toBe('missing');
    expect(dq.stated).toEqual([]);
  });

  test('the latest assessment weight beats the enrolment weight beats the check-in', () => {
    const ctx = bare({ weight: 80 });
    ctx.latestAssessment = { weight: 78 };
    ctx.latestCheckin = { weight: 82 };
    const { facts, data_quality: dq } = resolveClientFacts(ctx);

    expect(facts.weight_kg.value).toBe(78);
    expect(facts.weight_kg.source).toBe('pt_assessments.weight');
    expect(facts.weight_kg.origin).toBe('recorded');

    // Three sources, three different numbers, is a genuine disagreement and is
    // now reported as one — this assertion was a bare toEqual on the winner,
    // which passed while the other two readings vanished without trace. A
    // trainer looking at a plan built on 78kg should be able to see that the
    // enrolment record says 80 and the last check-in said 82.
    expect(facts.weight_kg.conflicts).toEqual([
      { source: 'pt_clients.weight', value: 80 },
      { source: 'weekly_checkins.weight', value: 82 },
    ]);
    expect(dq.conflicting.find((c) => c.field === 'weight_kg')).toBeDefined();
  });

  test('sources that agree are not reported as a disagreement', () => {
    const ctx = bare({ weight: 78 });
    ctx.latestAssessment = { weight: 78 };
    ctx.latestCheckin = { weight: '78' };
    const { facts, data_quality: dq } = resolveClientFacts(ctx);
    expect(facts.weight_kg.value).toBe(78);
    expect(facts.weight_kg.conflicts).toBeUndefined();
    expect(dq.conflicting).toEqual([]);
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

  test('the interview answer is used when the client record holds no count', () => {
    // The Client Interview asks how many days a week the client can really
    // train. The AI loader read that row into the context and this resolver
    // never looked at it, so the one answer the client had given was reported
    // as missing — and training_days blocks generation.
    const ctx = bare();
    ctx.interview = { lifestyle_training_days: 3 };
    const { facts } = resolveClientFacts(ctx);
    expect(facts.training_days).toEqual({
      value: 3,
      source: 'pt_client_interviews.lifestyle_training_days',
      origin: 'recorded',
    });
  });

  test('a stored count still wins, and the interview answer is shown as a disagreement', () => {
    const ctx = bare({ sessions_per_week: 4 });
    ctx.interview = { lifestyle_training_days: 2 };
    const { facts } = resolveClientFacts(ctx);
    expect(facts.training_days.value).toBe(4);
    expect(facts.training_days.source).toBe('pt_clients.sessions_per_week');
    expect(facts.training_days.conflicts).toEqual([
      { source: 'pt_client_interviews.lifestyle_training_days', value: 2 },
    ]);
  });

  test('the goal assessment fills in when enrolment recorded no count', () => {
    // pt_goals.training_days_per_week was written by the Goal wizard and read
    // by nothing. The trainer designed the week there; generation should not
    // call the client's frequency missing while that answer sits on file.
    const ctx = bare();
    ctx.goals = [{ goal_type: 'hypertrophy', training_days_per_week: 4 }];
    const { facts } = resolveClientFacts(ctx);
    expect(facts.training_days).toEqual({
      value: 4, source: 'pt_goals.training_days_per_week', origin: 'recorded',
    });
  });

  test('enrolment still wins over the goal, and the goal is reported', () => {
    const ctx = bare({ sessions_per_week: 3 });
    ctx.goals = [{ training_days_per_week: 5 }];
    const { facts } = resolveClientFacts(ctx);
    expect(facts.training_days.value).toBe(3);
    expect(facts.training_days.conflicts).toContainEqual({
      source: 'pt_goals.training_days_per_week', value: 5,
    });
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

describe('session length', () => {
  test('is read from the client record and reaches the prompt', () => {
    const { facts } = resolveClientFacts(bare({ session_minutes: 45 }));
    expect(facts.session_minutes).toEqual({
      value: 45, source: 'pt_clients.session_minutes', origin: 'recorded',
    });
    expect(describeFacts(facts)).toContain('- Session length (minutes): 45');
  });

  test('a trainer can set today\'s length, within the column\'s bounds', () => {
    const ctx = bare({ session_minutes: 60 });
    expect(resolveClientFacts(ctx, { session_minutes: 45 }).facts.session_minutes)
      .toEqual({ value: 45, source: 'trainer', origin: 'stated' });
    // Out of range is missing, not a number nobody checked.
    expect(resolveClientFacts(ctx, { session_minutes: 5 }).facts.session_minutes.origin)
      .toBe('missing');
    expect(resolveClientFacts(bare(), { session_minutes: 5 }).facts.session_minutes.origin)
      .toBe('missing');
  });

  test('missing is stated as missing, never as a default session', () => {
    const { facts } = resolveClientFacts(bare());
    expect(facts.session_minutes.origin).toBe('missing');
    expect(describeFacts(facts)).toContain('- Session length (minutes): NOT RECORDED');
  });
});

describe('equipment', () => {
  // training_mode is Offline / Online / Hybrid — where a client trains, not
  // what they can lift with.
  test('training_mode is never mistaken for an equipment record', () => {
    const { facts } = resolveClientFacts(bare({ training_mode: 'Offline' }));
    expect(facts.equipment.origin).toBe('missing');
  });

  test('the client\'s own recorded equipment beats the studio inventory', () => {
    const ctx = bare({ equipment: 'dumbbells' });
    ctx.studioEquipment = 'Barbell, Cable, Machine, Dumbbell';
    expect(resolveClientFacts(ctx).facts.equipment).toMatchObject({
      // The enum is mapped to the phrase the safety screen reads; "bands"
      // matched nothing there, so a bands-only client was screened as
      // unrestricted.
      value: 'dumbbells',
      source: 'pt_clients.equipment',
      origin: 'recorded',
      // The disagreement is still reported, not hidden.
      conflicts: [{ source: 'system_settings.studio_equipment', value: 'Barbell, Cable, Machine, Dumbbell' }],
    });
    expect(resolveClientFacts(bare({ equipment: 'bands' })).facts.equipment.value)
      .toBe('resistance bands');
    expect(resolveClientFacts(bare({ equipment: 'full_gym' })).facts.equipment.value)
      .toBe('full gym');
  });

  test('the studio\'s recorded equipment is the fallback when the client holds none', () => {
    const ctx = bare();
    ctx.studioEquipment = 'Barbell, Dumbbell, Cable';
    expect(resolveClientFacts(ctx).facts.equipment).toEqual({
      value: 'Barbell, Dumbbell, Cable',
      source: 'system_settings.studio_equipment',
      origin: 'recorded',
    });
  });

  // ── The fields where a statement beats the record ───────────────────────
  //
  // And it is an exception for a safety reason, not a convenience one. The
  // studio's list says what the gym owns; "dumbbells only today" says what is
  // actually available this session. Preferring the fuller list would ungate
  // exercises the trainer has just said cannot be done — the old "full gym"
  // default wearing a better hat.
  //
  // Session length is the same shape: the record says how long this client's
  // sessions usually run; the trainer knows today's slot is 45 minutes.
  test('a trainer stating today\'s equipment narrows the studio list', () => {
    const ctx = bare();
    ctx.studioEquipment = 'Barbell, Cable, Machine, Dumbbell';
    const { facts } = resolveClientFacts(ctx, { equipment: 'dumbbells only today' });
    expect(facts.equipment).toEqual({ value: 'dumbbells only today', source: 'trainer', origin: 'stated' });
  });

  test('a preferred-day pattern on the goal is used when enrolment holds none', () => {
    // pt_goals.preferred_training_days is TEXT[], so pg hands back an array.
    const ctx = bare();
    ctx.goals = [{ training_days_per_week: 3, preferred_training_days: ['Monday', 'Wednesday', 'Friday'] }];
    expect(resolveClientFacts(ctx).facts.preferred_days).toEqual({
      value: 'Monday, Wednesday, Friday',
      source: 'pt_goals.preferred_training_days',
      origin: 'recorded',
    });
  });

  test('short and long weekday names are the same days, not a conflict', () => {
    // Enrolment writes "Mon, Wed, Fri"; the Goal wizard writes the full names.
    // Normalise before comparing or every client with both is flagged.
    const ctx = bare({ preferred_training_days: 'Mon, Wed, Fri' });
    ctx.goals = [{ preferred_training_days: 'Monday, Wednesday, Friday' }];
    const { facts } = resolveClientFacts(ctx);
    expect(facts.preferred_days.value).toBe('Monday, Wednesday, Friday');
    expect(facts.preferred_days.conflicts).toBeUndefined();
  });

  test('keeps the exact weekdays the client is recorded to train', () => {
    // The count says three days; the weekdays say WHICH three. Losing them
    // let the generator choose any three, so a Mon/Wed/Fri client was
    // programmed Tue/Thu/Sat.
    const { facts } = resolveClientFacts(bare({
      sessions_per_week: 3, preferred_training_days: 'Mon, Wed, Fri',
    }));
    expect(facts.training_days.value).toBe(3);
    expect(facts.preferred_days.value).toBe('Monday, Wednesday, Friday');
  });

  test('refuses weekday text it cannot read rather than guessing', () => {
    for (const bad of ['Mon, someday', '3 days', '']) {
      expect(resolveClientFacts(bare({ preferred_training_days: bad }))
        .facts.preferred_days.origin).toBe('missing');
    }
  });

  test('omits weekdays that contradict a separately recorded count', () => {
    // sessions_per_week is the trainer's stated frequency; the picker can be
    // stale. Sending both would demand three sessions on exactly five days.
    const { facts } = resolveClientFacts(bare({
      sessions_per_week: 3, preferred_training_days: 'Mon, Tue, Wed, Thu, Fri',
    }));
    expect(facts.training_days.value).toBe(3);
    expect(facts.preferred_days.origin).toBe('missing');
  });

  test('and that exception applies to equipment and session length alone', () => {
    expect(STATED_SUPERSEDES).toEqual(['equipment', 'session_minutes']);
    // The anti-fabrication rule is unchanged everywhere else: a request body
    // still cannot rewrite who the client is.
    const ctx = bare({ goal: 'fat_loss', workout_experience_level: 'advanced', sessions_per_week: 5, dob: '1990-01-01' });
    const { facts } = resolveClientFacts(ctx, {
      goal: 'strength', experience_level: 'beginner', training_days: 2, age: 21,
    });
    expect(facts.goal.value).toBe('fat_loss');
    expect(facts.experience_level.value).toBe('advanced');
    expect(facts.training_days.value).toBe(5);
    expect(facts.age.origin).toBe('recorded');
  });

  test('an empty statement does not blank the studio list', () => {
    const ctx = bare();
    ctx.studioEquipment = 'Barbell';
    expect(resolveClientFacts(ctx, { equipment: '   ' }).facts.equipment.origin).toBe('recorded');
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

describe('the client interview, as the model reads it', () => {
  test('says NOT RECORDED when no interview exists, and forbids inference', () => {
    const text = describeInterview(null);
    expect(text).toContain('CLIENT INTERVIEW: NOT RECORDED');
    expect(text).toContain('Do not infer');
  });

  test('keeps the client\'s words apart from the trainer\'s summary', () => {
    const text = describeInterview({
      previous_workout_experience: 'beginner',
      training_history: 'Two years of home workouts.',
      job_details: 'Night shifts at a warehouse.',
      training_challenges: ['time', 'work_schedule'],
      challenge_other: null,
      lifestyle_training_days: 3,
      motivation: 'Keep up with my kids.',
      occupation_type: 'desk_job',
      sports_participation: 'previously',
      programme_readiness: 8,
      important_client_statements: 'I have never stuck with a gym.',
      notes: 'Very motivated; start with two short sessions.',
    });
    expect(text).toContain('CLIENT-STATED');
    expect(text).toContain('Previous training experience: beginner');
    expect(text).toContain('Training challenges: time, work schedule');
    expect(text).toContain('Days a week they can train: 3');
    expect(text).toContain('Occupation: Desk job');
    expect(text).toContain('Sport participation: Previously');
    expect(text).toContain('Programme readiness (1–10): 8');
    expect(text).toContain('In the client\'s words: I have never stuck with a gym.');
    // The trainer's judgement is under its own heading, not in the client block.
    const trainerBlock = text.slice(text.indexOf('TRAINER\'S INTERVIEW NOTES'));
    expect(trainerBlock).toContain('Very motivated');
    expect(trainerBlock).not.toContain('Home workouts');
  });

  test('never presents the interview as medical clearance', () => {
    const text = describeInterview({ notes: 'No pain reported.' });
    expect(text).toContain('The interview is not medical clearance');
    expect(text).toContain('PAR-Q');
  });

  test('an empty challenge list is not printed as an answer', () => {
    const text = describeInterview({ training_challenges: [] });
    expect(text).not.toContain('Training challenges:');
    expect(text).not.toContain('Occupation:');
    expect(text).not.toContain('Programme readiness');
  });
});

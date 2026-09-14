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
  resolveClientFacts, describeFacts, countDays, ageFromDob,
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

describe('equipment', () => {
  // training_mode is Offline / Online / Hybrid — where a client trains, not
  // what they can lift with.
  test('training_mode is never mistaken for an equipment record', () => {
    const { facts } = resolveClientFacts(bare({ training_mode: 'Offline' }));
    expect(facts.equipment.origin).toBe('missing');
  });

  test('the studio\'s recorded equipment is the authoritative answer', () => {
    const ctx = bare();
    ctx.studioEquipment = 'Barbell, Dumbbell, Cable';
    expect(resolveClientFacts(ctx).facts.equipment).toEqual({
      value: 'Barbell, Dumbbell, Cable',
      source: 'system_settings.studio_equipment',
      origin: 'recorded',
    });
  });

  // ── The one field where a statement beats the record ────────────────────
  //
  // And it is an exception for a safety reason, not a convenience one. The
  // studio's list says what the gym owns; "dumbbells only today" says what is
  // actually available this session. Preferring the fuller list would ungate
  // exercises the trainer has just said cannot be done — the old "full gym"
  // default wearing a better hat.
  test('a trainer stating today\'s equipment narrows the studio list', () => {
    const ctx = bare();
    ctx.studioEquipment = 'Barbell, Cable, Machine, Dumbbell';
    const { facts } = resolveClientFacts(ctx, { equipment: 'dumbbells only today' });
    expect(facts.equipment).toEqual({ value: 'dumbbells only today', source: 'trainer', origin: 'stated' });
  });

  test('and that exception applies to equipment ALONE', () => {
    expect(STATED_SUPERSEDES).toEqual(['equipment']);
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

// ── The two states that were being collapsed into "we have it" ─────────────
//
// A weight the client mentioned at the door, a weight measured eighteen months
// ago and a weight measured on Tuesday all printed as the same bare number, and
// the model programmed from all three with equal confidence.

describe('unverified: held, but never measured', () => {
  const fromCheckin = (over = {}) => ({
    ...bare(),
    latestCheckin: { weight: 82 },
    ...over,
  });

  test('a weight the client reported is unverified, not recorded', () => {
    const { facts, data_quality: dq } = resolveClientFacts(fromCheckin());
    expect(facts.weight_kg.value).toBe(82);
    expect(facts.weight_kg.origin).toBe('unverified');
    expect(dq.unverified).toEqual([{ field: 'weight_kg', source: 'weekly_checkins.weight' }]);
    expect(dq.recorded.map((r) => r.field)).not.toContain('weight_kg');
  });

  test('a weight the studio measured is recorded', () => {
    const { facts, data_quality: dq } = resolveClientFacts({
      ...bare(), latestAssessment: { weight: 80 }, latestCheckin: { weight: 82 },
    });
    expect(facts.weight_kg.origin).toBe('recorded');
    expect(facts.weight_kg.source).toBe('pt_assessments.weight');
    expect(dq.unverified).toEqual([]);
  });

  // It is still a value the studio holds, so it counts towards how filled-in
  // the record is. What it is not is something the studio MEASURED, and
  // `unverified` is where that question is answered.
  test('it counts towards completeness', () => {
    expect(resolveClientFacts(fromCheckin()).data_quality.completeness_pct)
      .toBe(Math.round((1 / FIELDS.length) * 100));
  });

  test('the model is told what unverified means, and only when it applies', () => {
    const shown = describeFacts(resolveClientFacts(fromCheckin()).facts);
    expect(shown).toContain('Weight (kg): 82 (from weekly_checkins.weight — UNVERIFIED');
    expect(shown).toMatch(/what the client said, not what anybody measured/);

    const measured = describeFacts(resolveClientFacts({
      ...bare(), latestAssessment: { weight: 80 },
    }).facts);
    expect(measured).toContain('Weight (kg): 80 (from pt_assessments.weight)');
    expect(measured).not.toMatch(/UNVERIFIED/);
  });
});

describe('stale: measured, but a long time ago', () => {
  const STALE_BODY = [{ section: 'body', as_of: '2024-01-03', age_days: 620, stale_after_days: 90 }];

  test('a fact from a stale section carries the age of its assessment', () => {
    const { facts, data_quality: dq } = resolveClientFacts(
      { ...bare(), latestAssessment: { weight: 80 } }, {}, { stale: STALE_BODY },
    );
    expect(facts.weight_kg.origin).toBe('recorded');
    expect(facts.weight_kg.stale).toEqual({ as_of: '2024-01-03', age_days: 620, stale_after_days: 90 });
    expect(dq.stale).toEqual([expect.objectContaining({ field: 'weight_kg', section: 'body' })]);
  });

  test('a fact from a section nobody called stale carries nothing', () => {
    const { facts, data_quality: dq } = resolveClientFacts(
      { ...bare(), latestAssessment: { weight: 80 } }, {}, { stale: [] },
    );
    expect(facts.weight_kg.stale).toBeUndefined();
    expect(dq.stale).toEqual([]);
  });

  // pt_clients has no assessment date, so there is no evidence about its age.
  // Saying nothing is the honest answer; inventing a date would be worse.
  test('a fact from a source with no assessment date is never called stale', () => {
    const { facts } = resolveClientFacts(
      { ...bare({ weight: 80 }) }, {}, { stale: STALE_BODY },
    );
    expect(facts.weight_kg.source).toBe('pt_clients.weight');
    expect(facts.weight_kg.stale).toBeUndefined();
  });

  test('the model is told to program to it, not to extrapolate from it', () => {
    const shown = describeFacts(resolveClientFacts(
      { ...bare(), latestAssessment: { weight: 80 } }, {}, { stale: STALE_BODY },
    ).facts);
    expect(shown).toContain('STALE — measured 2024-01-03, 620 days ago');
    expect(shown).toMatch(/Do NOT extrapolate it forward/);
  });
});

describe('a fact can be several things at once', () => {
  // ── Why this tests the formatter directly ──────────────────────────────
  //
  // It cannot be reached through resolveClientFacts today, and that is worth
  // saying rather than working around. The only unverified source,
  // weekly_checkins.weight, is LAST in its precedence chain, so it wins only
  // when nothing else holds a weight — which means it can never carry a
  // conflict. It also has no entry in SOURCE_SECTION, so it can never be
  // stale. The three states are mutually exclusive by the shape of today's
  // precedence, not by the shape of the code.
  //
  // The composition still has to be right, because the day a second unverified
  // source joins that list — one in the middle of a chain, or one with an
  // assessment date — a formatter that branched on the first match would
  // silently drop two of the three. So the branch-free composition is pinned
  // here, on a fact built by hand, and the comment says why the fixture is
  // synthetic.
  test('provenance, disagreement and age are all said, not the first that matched', () => {
    const line = describeFacts({
      weight_kg: {
        value: 82,
        source: 'weekly_checkins.weight',
        origin: 'unverified',
        conflicts: [{ source: 'pt_clients.weight', value: 91 }],
        stale: { as_of: '2024-01-03', age_days: 620, stale_after_days: 90 },
      },
    }).split('\n').find((l) => l.startsWith('- Weight'));

    expect(line).toMatch(/UNVERIFIED/);
    expect(line).toMatch(/DISPUTED — 91 in pt_clients\.weight/);
    expect(line).toMatch(/STALE — measured 2024-01-03/);
  });

  test('and the value itself is still the one precedence chose', () => {
    const line = describeFacts({
      weight_kg: {
        value: 82, source: 'weekly_checkins.weight', origin: 'unverified',
        conflicts: [{ source: 'pt_clients.weight', value: 91 }],
      },
    }).split('\n').find((l) => l.startsWith('- Weight'));
    expect(line.startsWith('- Weight (kg): 82 ')).toBe(true);
  });
});

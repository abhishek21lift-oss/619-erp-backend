// The safety and volume rules that run before any model is asked anything.
//
// ── What these tests are actually defending ───────────────────────────────
//
// Two failures, and they are not symmetrical.
//
// The loud one is a rule that fires when it should not: a client cautioned out
// of half the library because somebody ticked a box on an intake form. A
// trainer notices that within a day.
//
// The quiet one is a rule that never fires. Every rule here matches enum
// against enum — the library's `target_muscle` and `movement_pattern` on one
// side, the assessment forms' fixed keys on the other — so a single
// misspelling ("Quadricep", "Vertical press") produces a screen that passes
// every exercise and looks exactly like a clean client. Nobody notices that,
// ever, until somebody gets hurt.
//
// So the first block below is exhaustive rather than illustrative: every value
// the map uses is checked against the library's real vocabulary, and every
// library value the map does NOT use is pinned so that a deliberate omission
// has to be re-argued rather than drifted into.
//
// LIVE blocks use production rows, quoted from queries run while writing this.
'use strict';

const {
  buildConstraints, screenExercise, screenLibrary, volumeLandmarks,
  deloadTriggers, evaluate,
  VERDICTS, REGIONS, LANDMARKS, MOBILITY_REGION_KEY, POSTURE_REGION,
  PARQ_REGION, PARQ_REFERRAL, PARQ_UNLOCATED,
  WEEKS_OVER_MRV_FOR_DELOAD, LOW_READINESS,
} = require('../modules/pt-os/programming-rules');

// ── The library's vocabulary, as production holds it ───────────────────────
//
// SELECT DISTINCT target_muscle / movement_pattern FROM exercises
// WHERE deleted_at IS NULL — 890 rows, every one populated.
const LIB_MUSCLES = [
  'Quadriceps', 'Shoulders', 'Abdominals', 'Chest', 'Hamstrings', 'Triceps', 'Biceps',
  'Lats', 'Middle Back', 'Calves', 'Lower Back', 'Forearms', 'Glutes', 'Traps',
  'Adductors', 'Neck', 'Abductors', 'Cardiovascular',
];
const LIB_PATTERNS = [
  'General', 'Isolation', 'Horizontal Push', 'Squat', 'Horizontal Pull', 'Mobility',
  'Hinge', 'Trunk Flexion', 'Vertical Push', 'Vertical Pull', 'Lunge', 'Rotation',
  'Locomotion', 'Anti-Extension', 'Carry',
];
const LIB_GROUPS = ['Legs', 'Arms', 'Shoulders', 'Back', 'Core', 'Chest', 'Cardio'];

// Real rows, copied from the library.
const LIB = {
  benchPress:   { name: 'Barbell Bench Press - Medium Grip', muscle_group: 'Chest', target_muscle: 'Chest', movement_pattern: 'Horizontal Push', equipment: 'Barbell', difficulty: 'beginner' },
  benchChains:  { name: 'Bench Press with Chains', muscle_group: 'Arms', target_muscle: 'Triceps', movement_pattern: 'Horizontal Push', equipment: 'Barbell', difficulty: 'advanced' },
  lateralRaise: { name: 'Cable Seated Lateral Raise', muscle_group: 'Shoulders', target_muscle: 'Shoulders', movement_pattern: 'Isolation', equipment: 'Cable', difficulty: 'beginner' },
  deadlift:     { name: 'Barbell Deadlift', muscle_group: 'Back', target_muscle: 'Lower Back', movement_pattern: 'Hinge', equipment: 'Barbell', difficulty: 'intermediate' },
  squat:        { name: 'Barbell Squat', muscle_group: 'Legs', target_muscle: 'Quadriceps', movement_pattern: 'Squat', equipment: 'Barbell', difficulty: 'beginner' },
  crunches:     { name: 'Crunches', muscle_group: 'Core', target_muscle: 'Abdominals', movement_pattern: 'Trunk Flexion', equipment: 'Bodyweight', difficulty: 'beginner' },
  curl:         { name: 'Barbell Curl', muscle_group: 'Arms', target_muscle: 'Biceps', movement_pattern: 'Isolation', equipment: 'Barbell', difficulty: 'beginner' },
  treadmill:    { name: 'Treadmill Running', muscle_group: 'Cardio', target_muscle: 'Cardiovascular', movement_pattern: 'Locomotion', equipment: 'Bodyweight', difficulty: 'beginner' },
};

const parq = (o = {}) => ({
  assessment_date: '2026-08-01', workout_gate_status: 'cleared', risk_level: 'low',
  past_history: {}, current_health: {}, ...o,
});

const mobilityRow = (regions) => ({ assessment_date: '2026-08-01', body_regions: regions });

/** The eight regions the screen scores, all clean unless overridden. */
const cleanRegions = () => Object.keys(MOBILITY_REGION_KEY)
  .map((region) => ({ region, score: 3, pain: false, restriction: false }));

describe('the vocabulary the rules match on', () => {
  it('uses no muscle the library does not have', () => {
    for (const [key, region] of Object.entries(REGIONS)) {
      for (const m of region.muscles) {
        // A value here that the library never stores is a rule that can never
        // fire, and it fails open — the screen passes everything and reads as
        // a clean client.
        expect({ key, m, known: LIB_MUSCLES.includes(m) }).toEqual({ key, m, known: true });
      }
    }
  });

  it('uses no movement pattern the library does not have', () => {
    for (const [key, region] of Object.entries(REGIONS)) {
      for (const p of region.patterns) {
        expect({ key, p, known: LIB_PATTERNS.includes(p) }).toEqual({ key, p, known: true });
      }
    }
  });

  it('maps every region the mobility screen can report', () => {
    // The screen scores exactly these eight. One added to the form without a
    // row here is a finding that silently changes nothing.
    expect(Object.keys(MOBILITY_REGION_KEY).sort()).toEqual([
      'Ankles', 'Hamstrings', 'Hip', 'Neck', 'Quadriceps', 'Shoulders', 'Thoracic Spine', 'Wrists',
    ]);
    for (const key of Object.values(MOBILITY_REGION_KEY)) expect(REGIONS[key]).toBeTruthy();
  });

  it('maps every finding the posture screen offers', () => {
    expect(Object.keys(POSTURE_REGION).sort()).toEqual([
      'Anterior Pelvic Tilt', 'Flat Feet', 'Forward Head', 'Knee Valgus', 'Kyphosis',
      'Lordosis', 'Posterior Pelvic Tilt', 'Rounded Shoulders', 'Scoliosis',
    ]);
    for (const key of Object.values(POSTURE_REGION)) expect(REGIONS[key]).toBeTruthy();
  });

  it('leaves exactly three library values deliberately unmapped', () => {
    const used = new Set();
    for (const r of Object.values(REGIONS)) {
      r.muscles.forEach((m) => used.add(m));
      r.patterns.forEach((p) => used.add(p));
    }
    // Each of these is an argued choice, written down in the module: rowing is
    // what a sore shoulder should do more of, corrective work must never be
    // excluded by the limitation it corrects, and a curl does not load the
    // shoulder joint. Changing one should mean changing that argument too.
    expect(LIB_PATTERNS.filter((p) => !used.has(p) && p !== 'General' && p !== 'Isolation'))
      .toEqual(['Horizontal Pull', 'Mobility']);
    expect(LIB_MUSCLES.filter((m) => !used.has(m) && m !== 'Cardiovascular'))
      .toEqual(['Biceps']);
  });

  it('has a landmark for every muscle group the library uses', () => {
    expect(Object.keys(LANDMARKS).sort()).toEqual([...LIB_GROUPS].sort());
  });
});

describe('the medical gate', () => {
  it('is cleared only when the form says so', () => {
    expect(buildConstraints({ parq: parq() }).gate).toMatchObject({ status: 'cleared', cleared: true });
  });

  it('treats a missing PAR-Q as unknown, never as cleared', () => {
    // The failure this exists to stop: no form on file reading as a pass.
    // "Nobody asked" and "we checked" are different facts and must stay so.
    const g = buildConstraints({}).gate;
    expect(g.status).toBe('unknown');
    expect(g.cleared).toBe(false);
    expect(evaluate({}).may_program).toBe(false);
  });

  it('does not clear a form that is pending or refused', () => {
    for (const status of ['pending', 'referred', 'not_cleared', '']) {
      expect(buildConstraints({ parq: parq({ workout_gate_status: status }) }).gate.cleared).toBe(false);
    }
  });
});

describe('PAR-Q', () => {
  it('turns a recorded region pain into a caution, not a block', () => {
    // Intake history may be years old. Blocking a region on it would leave a
    // client who once had a sore knee unsquattable for the rest of their life.
    const { constraints } = buildConstraints({ parq: parq({ past_history: { knee_pain: true } }) });
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatchObject({ verdict: VERDICTS.CAUTION, region: 'knee', source: 'parq.past_history' });
  });

  it('reads the yes values the forms actually store', () => {
    for (const yes of [true, 'yes', 'Yes', 'true']) {
      expect(buildConstraints({ parq: parq({ past_history: { back_pain: yes } }) }).constraints).toHaveLength(1);
    }
    for (const no of [false, 'no', null, undefined, 0, '']) {
      expect(buildConstraints({ parq: parq({ past_history: { back_pain: no } }) }).constraints).toHaveLength(0);
    }
  });

  it('does not invent a body region the form never recorded', () => {
    // The form has one box for joint problems and never asks which joint.
    // Guessing one would be this file fabricating a clinical finding.
    const { constraints } = buildConstraints({ parq: parq({ past_history: { joint_problems: true } }) });
    expect(constraints[0].region).toBeNull();
    expect(constraints[0].muscles).toEqual([]);
    expect(constraints[0].patterns).toEqual([]);
    // And with nothing to match on, it cannot quietly filter the library.
    expect(screenExercise(LIB.squat, { constraints }).verdict).toBe(VERDICTS.ALLOW);
    // It travels as text instead, so the trainer still reads it.
    expect(evaluate({ parq: parq({ past_history: { joint_problems: true } }) }).unlocated).toHaveLength(1);
  });

  it('refers a medical history rather than programming around it', () => {
    const out = buildConstraints({ parq: parq({ past_history: { heart_disease: true, asthma: true } }) });
    expect(out.referrals.map((r) => r.evidence).sort()).toEqual(['asthma', 'heart_disease']);
    // A cardiac history must not silently swap an exercise. That is a doctor's
    // call made from a checkbox.
    expect(out.constraints).toHaveLength(0);
  });

  it('covers every key the production forms hold', () => {
    // Keys observed on pt_parq_forms. One the module ignores is a question the
    // studio asks the client and then throws away.
    const known = new Set([
      ...Object.keys(PARQ_REGION), ...Object.keys(PARQ_REFERRAL), ...Object.keys(PARQ_UNLOCATED),
    ]);
    const observed = [
      'copd', 'asthma', 'hip_pain', 'back_pain', 'knee_pain', 'neck_pain', 'surgeries',
      'tuberculosis', 'heart_disease', 'shoulder_pain', 'joint_problems', 'hospitalization',
      'previous_fractures', 'respiratory_disease', 'has_pain', 'known_disease',
      'current_treatment',
    ];
    // hospitalization is the one deliberate omission: it says nothing about
    // what the client may train, only that something happened.
    expect(observed.filter((k) => !known.has(k))).toEqual(['hospitalization']);
  });

  it('ignores the free text the forms mix in with the booleans', () => {
    // past_history carries occupation: "Student" alongside the medical flags.
    // A truthiness test would report a client's job as a condition.
    const { constraints, referrals } = buildConstraints({
      parq: parq({ past_history: { occupation: 'Student', previous_trainer: false } }),
    });
    expect(constraints).toHaveLength(0);
    expect(referrals).toHaveLength(0);
  });
});

describe('the mobility screen', () => {
  it('blocks a region reported painful today', () => {
    const regions = cleanRegions().map((r) => (r.region === 'Shoulders' ? { ...r, pain: true } : r));
    const { constraints } = buildConstraints({ mobility: mobilityRow(regions) });
    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toMatchObject({ verdict: VERDICTS.BLOCK, region: 'shoulder' });
  });

  it('only cautions a region that is restricted but not painful', () => {
    // Restricted is a range the client does not have yet. It changes what you
    // select; it is not a reason to train around the joint forever.
    const regions = cleanRegions().map((r) => (r.region === 'Ankles' ? { ...r, restriction: true } : r));
    const { constraints } = buildConstraints({ mobility: mobilityRow(regions) });
    expect(constraints[0]).toMatchObject({ verdict: VERDICTS.CAUTION, region: 'ankle' });
  });

  it('says nothing at all about the regions that came back clean', () => {
    expect(buildConstraints({ mobility: mobilityRow(cleanRegions()) }).constraints).toEqual([]);
  });

  it('reads the column whether it arrives parsed or as text', () => {
    const regions = [{ region: 'Hip', score: 3, pain: true, restriction: false }];
    expect(buildConstraints({ mobility: mobilityRow(regions) }).constraints).toHaveLength(1);
    expect(buildConstraints({ mobility: mobilityRow(JSON.stringify(regions)) }).constraints).toHaveLength(1);
  });
});

describe('the posture screen', () => {
  it('never blocks', () => {
    // Somebody looking at a client standing still is a reason to bias volume,
    // not a reason to forbid a movement they have no pain in. Otherwise the
    // client examined most carefully ends up with the fewest exercises.
    for (const issue of Object.keys(POSTURE_REGION)) {
      const { constraints } = buildConstraints({ posture: { front_issues: [issue] } });
      expect(constraints.every((c) => c.verdict === VERDICTS.CAUTION)).toBe(true);
    }
  });

  it('reads all three observation columns', () => {
    const { constraints } = buildConstraints({
      posture: { front_issues: ['Rounded Shoulders'], side_issues: ['Kyphosis'], back_issues: ['Anterior Pelvic Tilt'] },
    });
    expect(constraints).toHaveLength(3);
  });

  it('drops a label it has no rule for rather than guessing', () => {
    expect(buildConstraints({ posture: { front_issues: ['Something New'] } }).constraints).toEqual([]);
  });
});

describe('screening an exercise', () => {
  const shoulderPain = buildConstraints({
    mobility: mobilityRow(cleanRegions().map((r) => (r.region === 'Shoulders' ? { ...r, pain: true } : r))),
  });

  it('catches a press by its pattern and a raise by its muscle', () => {
    // 508 of 890 exercises carry "General" or "Isolation" as their pattern, so
    // a pattern-only rule would pass more than half the library untested. The
    // lateral raise below is exactly that case.
    expect(screenExercise(LIB.benchPress, shoulderPain).verdict).toBe(VERDICTS.BLOCK);
    expect(LIB.lateralRaise.movement_pattern).toBe('Isolation');
    expect(screenExercise(LIB.lateralRaise, shoulderPain).verdict).toBe(VERDICTS.BLOCK);
  });

  it('leaves the rest of the library alone', () => {
    expect(screenExercise(LIB.squat, shoulderPain).verdict).toBe(VERDICTS.ALLOW);
    expect(screenExercise(LIB.deadlift, shoulderPain).verdict).toBe(VERDICTS.ALLOW);
  });

  it('catches loaded trunk flexion on a painful back', () => {
    // A crunch's pattern is Trunk Flexion but plenty of ab work is tagged
    // Isolation, which is why Abdominals is in the back region's muscles.
    const backPain = buildConstraints({
      mobility: mobilityRow([{ region: 'Thoracic Spine', pain: true, restriction: false, score: 3 }]),
    });
    expect(screenExercise(LIB.crunches, backPain).verdict).toBe(VERDICTS.BLOCK);
    expect(screenExercise(LIB.deadlift, backPain).verdict).toBe(VERDICTS.BLOCK);
  });

  it('reports every reason, not just the deciding one', () => {
    const screen = buildConstraints({
      parq: parq({ past_history: { shoulder_pain: true } }),
      posture: { front_issues: ['Rounded Shoulders'] },
      mobility: mobilityRow(cleanRegions().map((r) => (r.region === 'Shoulders' ? { ...r, pain: true } : r))),
    });
    const { verdict, reasons } = screenExercise(LIB.benchPress, screen);
    // A trainer overruling a block needs to see all of what they are
    // overruling, not the one line that happened to be worst.
    expect(verdict).toBe(VERDICTS.BLOCK);
    expect(reasons.map((r) => r.because).sort()).toEqual([
      'mobility.body_regions: Shoulders: pain',
      'parq.past_history: shoulder_pain',
      'posture: Rounded Shoulders',
    ]);
  });

  it('blocks equipment the studio does not have', () => {
    const screen = buildConstraints({ parq: parq(), equipment: ['Bodyweight', 'Dumbbell'] });
    expect(screenExercise(LIB.squat, screen).verdict).toBe(VERDICTS.BLOCK);
    expect(screenExercise(LIB.crunches, screen).verdict).toBe(VERDICTS.ALLOW);
  });

  it('applies no equipment filter when the studio never said', () => {
    const screen = buildConstraints({ parq: parq() });
    expect(screen.equipment).toBeNull();
    expect(screen.coverage.equipment_known).toBe(false);
    expect(screenExercise(LIB.squat, screen).verdict).toBe(VERDICTS.ALLOW);
  });

  it('treats difficulty as a ceiling a trainer may take, not a wall', () => {
    const screen = buildConstraints({ parq: parq(), client: { workout_experience_level: 'beginner' } });
    // 360 of 890 exercises are above beginner. Blocking them outright would
    // remove two fifths of the library from a client a trainer is standing
    // next to and can coach through the movement.
    expect(screenExercise(LIB.benchChains, screen).verdict).toBe(VERDICTS.CAUTION);
    expect(screenExercise(LIB.squat, screen).verdict).toBe(VERDICTS.ALLOW);
  });

  it('applies no ceiling when experience is unknown', () => {
    // 24 of 34 production clients have no experience level recorded. Guessing
    // "beginner" would caution two fifths of the library for most of the roster.
    const screen = buildConstraints({ parq: parq() });
    expect(screen.difficulty_allowed).toBeNull();
    expect(screen.coverage.experience_known).toBe(false);
    expect(screenExercise(LIB.benchChains, screen).verdict).toBe(VERDICTS.ALLOW);
  });

  it('partitions a library and keeps the blocked ones', () => {
    const screen = buildConstraints({
      mobility: mobilityRow(cleanRegions().map((r) => (r.region === 'Shoulders' ? { ...r, pain: true } : r))),
    });
    const out = screenLibrary(Object.values(LIB), screen);
    expect(out.counts).toEqual({ allowed: 5, caution: 0, blocked: 3 });
    // Carried rather than discarded, so "why is there no bench press" has an
    // answer that does not need anything re-run.
    //
    // The chains variant is in the list because its target muscle is Triceps
    // and its pattern is Horizontal Push — both in the shoulder region. Its
    // name says nothing about shoulders, which is exactly why the rule reads
    // the library's fields rather than the exercise's name.
    expect(out.blocked.map((e) => e.name).sort()).toEqual([
      'Barbell Bench Press - Medium Grip', 'Bench Press with Chains', 'Cable Seated Lateral Raise',
    ]);
  });
});

describe('coverage', () => {
  it('separates a screened-and-clear client from an unassessed one', () => {
    // The whole point. Both produce zero constraints; they are not the same
    // client, and a programme written against the second as though it were the
    // first is the failure this module exists to prevent.
    const screened = buildConstraints({ parq: parq(), mobility: mobilityRow(cleanRegions()), posture: {} });
    const unseen = buildConstraints({});
    expect(screened.constraints).toEqual([]);
    expect(unseen.constraints).toEqual([]);
    expect(screened.coverage.screened).toBe(true);
    expect(unseen.coverage.screened).toBe(false);
    expect(screened.coverage.sources_present).toEqual(['parq', 'mobility', 'posture']);
    expect(unseen.coverage.sources_present).toEqual([]);
  });

  it('does not count a mobility row with no regions scored as a screen', () => {
    expect(buildConstraints({ mobility: mobilityRow([]) }).coverage.mobility).toBe(false);
  });
});

describe('weekly volume against the landmarks', () => {
  // LIVE. The best-logged client in production, joined to the library:
  //   2026-W34  Arms 12, Chest 9, Shoulders 9, Core 9, unattributable 3
  //   2026-W35  Legs 12, Arms 10, Shoulders 6, Back 3,  unattributable 3
  const live = [
    { week: '2026-W34', groups: { Arms: 12, Chest: 9, Shoulders: 9, Core: 9 }, unattributable: 3 },
    { week: '2026-W35', groups: { Legs: 12, Arms: 10, Shoulders: 6, Back: 3 }, unattributable: 3 },
  ];

  it('finds the real under-trained group', () => {
    const out = volumeLandmarks(live);
    // Back: 3 sets in the latest week against a minimum of 10. That is a real
    // finding on real data, and it is the kind of thing a trainer writing from
    // memory misses.
    expect(out.under_mev).toContain('Back');
    expect(out.groups.find((g) => g.group === 'Back')).toMatchObject({ latest_sets: 3, status: 'under_mev' });
  });

  it('reports the sets it could not attribute rather than dropping them', () => {
    // 29 of 408 completed production sets have no exercise_id and cannot be
    // joined. A muscle group that looks untrained may just be the half of the
    // log that would not join.
    expect(volumeLandmarks(live).unattributable_sets).toBe(6);
  });

  it('separates a group trained too little from one never trained', () => {
    const out = volumeLandmarks(live);
    expect(out.under_mev).not.toContain('Legs');
    expect(out.untrained).toEqual([]);
    const oneGroup = volumeLandmarks([{ week: '2026-W35', groups: { Chest: 12 } }]);
    // Never trained is a different conversation from under-trained, and may
    // well be deliberate.
    expect(oneGroup.under_mev).toEqual([]);
    expect(oneGroup.untrained.sort()).toEqual(['Arms', 'Back', 'Core', 'Legs', 'Shoulders']);
  });

  it('refuses to judge cardio in sets', () => {
    const out = volumeLandmarks([{ week: '2026-W35', groups: { Cardio: 2 } }]);
    expect(LANDMARKS.Cardio).toBeNull();
    expect(out.groups[0].status).toBeNull();
    expect(out.under_mev).toEqual([]);
  });

  it('counts weeks over the ceiling only while they are still consecutive', () => {
    // An over-reaching week followed by a normal one is history, not a trigger.
    const spike = [
      { week: '2026-W30', groups: { Chest: 30 } },
      { week: '2026-W31', groups: { Chest: 12 } },
    ];
    expect(volumeLandmarks(spike).groups[0].weeks_over_mrv).toBe(0);
    const sustained = [
      { week: '2026-W30', groups: { Chest: 30 } },
      { week: '2026-W31', groups: { Chest: 26 } },
    ];
    expect(volumeLandmarks(sustained).groups[0].weeks_over_mrv).toBe(2);
  });
});

describe('deload triggers', () => {
  const noHistory = { fatigue: { flag: null, reason: 'no RPE recorded — effort is not being captured' }, regressing: [], confidence: { enough_for_progression_calls: false } };

  it('says which triggers could not run, instead of implying they passed', () => {
    // Production holds RPE on 4 of 520 sets, so the fatigue trigger is
    // normally unobservable. "No deload indicated" from four silent triggers
    // is a very different claim from four that ran and found nothing.
    const out = deloadTriggers({ history: noHistory, recovery: null, volume: null });
    expect(out.deload_indicated).toBe(false);
    expect(out.evaluated).toBe(0);
    expect(out.of).toBe(4);
    expect(out.unobservable.map((u) => u.trigger).sort())
      .toEqual(['accumulated_fatigue', 'lifts_regressing', 'readiness_declining', 'volume_over_mrv']);
    expect(out.unobservable[0].reason).toContain('RPE');
  });

  it('fires on sustained volume over the ceiling', () => {
    const volume = volumeLandmarks([
      { week: '2026-W34', groups: { Chest: 30 } },
      { week: '2026-W35', groups: { Chest: 26 } },
    ]);
    const out = deloadTriggers({ history: noHistory, volume });
    expect(out.deload_indicated).toBe(true);
    expect(out.triggers[0]).toMatchObject({ trigger: 'volume_over_mrv' });
    expect(out.triggers[0].evidence).toContain(`${WEEKS_OVER_MRV_FOR_DELOAD} weeks`);
  });

  it('needs more than one lift going backwards', () => {
    const one = { ...noHistory, regressing: ['Bench Press'], confidence: { enough_for_progression_calls: true } };
    expect(deloadTriggers({ history: one }).deload_indicated).toBe(false);
    const two = { ...one, regressing: ['Bench Press', 'Barbell Squat'] };
    // One lift stalling is that lift's problem. Two is the block's.
    expect(deloadTriggers({ history: two }).triggers[0].trigger).toBe('lifts_regressing');
  });

  it('needs readiness to be both low and falling', () => {
    const falling = { present: true, score: LOW_READINESS - 10, trend: 'declining', inputs: 4, max_inputs: 4 };
    expect(deloadTriggers({ history: noHistory, recovery: falling }).triggers[0].trigger).toBe('readiness_declining');
    // Falling from very good is a client returning to normal.
    const high = { ...falling, score: 85 };
    expect(deloadTriggers({ history: noHistory, recovery: high }).deload_indicated).toBe(false);
    // And low but steady is a client who reports low, which is their baseline.
    const steady = { ...falling, trend: 'steady' };
    expect(deloadTriggers({ history: noHistory, recovery: steady }).deload_indicated).toBe(false);
  });
});

describe('the whole evaluation', () => {
  it('answers what this client may do, and why not, from the rows alone', () => {
    const out = evaluate({
      parq: parq({ past_history: { knee_pain: true, joint_problems: true } }),
      mobility: mobilityRow(cleanRegions().map((r) => (r.region === 'Shoulders' ? { ...r, pain: true } : r))),
      posture: { side_issues: ['Kyphosis'] },
      client: { workout_experience_level: 'intermediate' },
      equipment: ['Barbell', 'Bodyweight', 'Cable'],
      exercises: Object.values(LIB),
      weeklyGroups: [{ week: '2026-W35', groups: { Legs: 12, Back: 3 }, unattributable: 3 }],
    });

    expect(out.may_program).toBe(true);
    expect(out.library.blocked.map((e) => e.name).sort()).toEqual([
      // Shoulder pain.
      'Barbell Bench Press - Medium Grip',
      'Bench Press with Chains',
      'Cable Seated Lateral Raise',
    ]);
    // Knee history cautions the squat without removing it.
    expect(out.library.caution.map((e) => e.name)).toEqual(['Barbell Squat']);
    // The unlocated joint-problems caution reaches the trainer as text.
    expect(out.unlocated.map((c) => c.evidence)).toEqual(['joint_problems']);
    expect(out.volume.under_mev).toEqual(['Back']);
    expect(out.coverage.sources_present).toEqual(['parq', 'mobility', 'posture']);
  });

  it('refuses to program for a client nobody has cleared', () => {
    const out = evaluate({ exercises: Object.values(LIB) });
    expect(out.may_program).toBe(false);
    // Returned as a flag, not thrown: the trainer has to be told why nothing
    // was generated, and an exception loses the reason.
    expect(out.gate.status).toBe('unknown');
    expect(out.coverage.screened).toBe(false);
  });
});

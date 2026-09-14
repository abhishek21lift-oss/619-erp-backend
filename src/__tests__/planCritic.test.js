// Checking that the model did what the rules told it to.
//
// ── Why an audit exists at all ────────────────────────────────────────────
//
// Stage 3 put the safety screen at the top of the prompt and left blocked
// exercises out of the library the model was handed. Both reduce the odds.
// Neither is enforcement. The model writes free text, and until this module
// nothing read what came back — so a plan prescribing an overhead press for a
// client with shoulder pain would have reached the trainer WITH the screen
// attached, saying that press had been excluded, directly above a plan
// containing it.
//
// ── The test that matters most ────────────────────────────────────────────
//
// `refuses to clear an exercise it cannot match exactly`. Trigram similarity
// against production resolves "Overhead Press" to "Overhead Lat" at 0.474 —
// a lat exercise standing in for a shoulder-loading press. A fuzzy matcher
// would have cleared that press for a client whose shoulder is the reason it
// was excluded, and the audit would have reported zero violations while doing
// it. Guessing is worse than abstaining here, and the abstention is visible.
'use strict';

const {
  auditPlan, scorePlan, buildRevisionInstruction, parseCritique, describeAudit,
  planExercises, normaliseName, SEVERITY, SCORE_WEIGHTS,
} = require('../modules/pt-os/plan-critic');

/** A complete, rule-clean exercise. Tests remove from it rather than add. */
const ex = (o = {}) => ({
  name: 'Barbell Squat', prescription_type: 'SETS_REPS', sets: 4, reps: '8-10',
  rir_or_rpe: 'RIR 2', tempo: '3-1-1-0', rest_seconds: 120, notes: '', ...o,
});

/** A plan that passes every rule, so a failure is always the thing under test. */
const plan = (o = {}) => ({
  name: 'Block', description: 'x', goal: 'muscle_gain', level: 'intermediate',
  weeks: 8, days_per_week: 2, equipment: ['Barbell'],
  warm_up: '5 min bike, then ramp sets', cool_down: 'stretch',
  progression_notes: 'add 2.5kg to the main lift each week',
  weekly_schedule: {
    Monday: { name: 'Lower', focus: 'Legs', exercises: [ex()] },
    Thursday: { name: 'Upper', focus: 'Chest', exercises: [ex({ name: 'Bench Press' })] },
  },
  nutrition_notes: '',
  ...o,
});

const screenedMap = (entries) => new Map(
  entries.map(([name, verdict, because]) => [
    normaliseName(name),
    { name, verdict, reasons: because ? [{ because }] : [] },
  ]),
);

const CLEAN = screenedMap([['Barbell Squat', 'allow'], ['Bench Press', 'allow']]);
const REQUESTED = { training_days: 2, duration_weeks: 8 };

const audit = (p = plan(), screened = CLEAN, requested = REQUESTED) =>
  auditPlan(p, { screened, requested });

describe('a clean plan', () => {
  it('produces no violations at all', () => {
    const a = audit();
    expect(a.violations).toEqual([]);
    expect(a.needs_revision).toBe(false);
    expect(a.counts).toMatchObject({ exercises: 2, verified: 2, critical: 0, major: 0, minor: 0 });
  });

  it('scores 100, and says what that does and does not mean', () => {
    const q = scorePlan(audit());
    expect(q.score).toBe(100);
    // The sentence that must travel with the number. A plan can score 100 and
    // still be a poor programme; it cannot score 100 and prescribe a blocked
    // exercise, and that is the entire claim.
    expect(q.basis).toBe('a count of deterministic rule breaches, not a judgement of programme quality');
    expect(q.components).toEqual(SCORE_WEIGHTS);
  });
});

describe('safety', () => {
  it('catches a blocked exercise reaching the plan', () => {
    const screened = screenedMap([
      ['Barbell Squat', 'allow'],
      ['Bench Press', 'block', 'mobility.body_regions: Shoulders: pain'],
    ]);
    const a = audit(plan(), screened);

    expect(a.counts.critical).toBe(1);
    expect(a.violations[0]).toMatchObject({
      severity: SEVERITY.CRITICAL,
      rule: 'blocked_exercise_prescribed',
      exercise: 'Bench Press',
      where: 'Thursday #1',
    });
    // Where, so the trainer is not hunting a movement through a 12-week block.
    expect(a.violations[0].detail).toContain('Shoulders: pain');
    expect(a.needs_revision).toBe(true);
  });

  it('zeroes the safety score, whatever else the plan got right', () => {
    const screened = screenedMap([['Barbell Squat', 'allow'], ['Bench Press', 'block', 'x']]);
    const q = scorePlan(audit(plan(), screened));
    expect(q.components.safety).toBe(0);
    // Everything else still scored — the number says where the problem is.
    expect(q.components.structure).toBe(SCORE_WEIGHTS.structure);
    expect(q.score).toBe(100 - SCORE_WEIGHTS.safety);
  });

  it('reports a caution without demanding a regeneration', () => {
    const screened = screenedMap([
      ['Barbell Squat', 'caution', 'parq.past_history: knee_pain'],
      ['Bench Press', 'allow'],
    ]);
    const a = audit(plan(), screened);
    expect(a.counts.minor).toBe(1);
    expect(a.counts.critical).toBe(0);
    // A caution is information for the trainer, not a reason to spend another
    // generation and another half-minute of somebody waiting.
    expect(a.needs_revision).toBe(false);
  });

  it('refuses to clear an exercise it cannot match exactly', () => {
    // Nothing in the map matches, so nothing is cleared AND nothing is
    // condemned. The alternative — a fuzzy match — resolves "Overhead Press"
    // to "Overhead Lat" in this studio's real library, which would clear a
    // shoulder-loading press through a lat exercise for the client whose
    // shoulder is why it was excluded.
    const p = plan({
      weekly_schedule: {
        Monday: { name: 'Push', focus: 'Shoulders', exercises: [ex({ name: 'Overhead Press' })] },
        Thursday: { name: 'Lower', focus: 'Legs', exercises: [ex()] },
      },
    });
    const a = audit(p, screenedMap([['Barbell Squat', 'allow'], ['Overhead Lat', 'block', 'x']]));

    expect(a.violations).toEqual([]);
    expect(a.unverified).toEqual([{ day: 'Monday', position: 1, name: 'Overhead Press' }]);
    expect(a.counts.verified).toBe(1);
  });

  it('does not let an unverifiable plan score as a checked one', () => {
    const p = plan({
      weekly_schedule: {
        Monday: { name: 'A', focus: 'x', exercises: [ex({ name: 'Something Invented' })] },
        Thursday: { name: 'B', focus: 'y', exercises: [ex({ name: 'Also Invented' })] },
      },
    });
    const q = scorePlan(audit(p, new Map()));
    // Not unsafe — unchecked. The score must not read as though something
    // verified this selection, because nothing did.
    expect(q.components.evidence).toBe(0);
    expect(q.components.safety).toBe(SCORE_WEIGHTS.safety);
    expect(q.score).toBe(100 - SCORE_WEIGHTS.evidence);
  });

  it('matches through case, spacing and punctuation', () => {
    const p = plan({
      weekly_schedule: {
        Monday: { name: 'A', focus: 'x', exercises: [ex({ name: '  BENCH-PRESS  ' })] },
        Thursday: { name: 'B', focus: 'y', exercises: [ex()] },
      },
    });
    const a = audit(p, screenedMap([['Barbell Squat', 'allow'], ['Bench Press', 'block', 'x']]));
    // Folding case and punctuation is safe; guessing at word content is not.
    expect(a.counts.critical).toBe(1);
    expect(a.unverified).toEqual([]);
  });
});

describe('structure', () => {
  it('catches the wrong number of training days', () => {
    const a = audit(plan(), CLEAN, { training_days: 4, duration_weeks: 8 });
    expect(a.violations.find((v) => v.rule === 'frequency_mismatch').detail)
      .toBe('2 training days generated, 4 requested');
    // Worth a regeneration: a 4-day client handed 2 days has half a programme.
    expect(a.needs_revision).toBe(true);
  });

  it('catches the wrong block length', () => {
    const a = audit(plan({ weeks: 4 }), CLEAN, { training_days: 2, duration_weeks: 12 });
    expect(a.violations.find((v) => v.rule === 'duration_mismatch').detail)
      .toBe('4-week block generated, 12 requested');
  });

  it('catches an empty plan', () => {
    const a = audit(plan({ weekly_schedule: {} }), CLEAN, { training_days: 0, duration_weeks: 8 });
    expect(a.counts.critical).toBe(1);
    expect(a.violations[0].rule).toBe('no_exercises');
  });

  it('wants a warm-up more than a cool-down', () => {
    const a = audit(plan({ warm_up: '', cool_down: '' }));
    expect(a.violations.find((v) => v.rule === 'no_warm_up').severity).toBe(SEVERITY.MAJOR);
    expect(a.violations.find((v) => v.rule === 'no_cool_down').severity).toBe(SEVERITY.MINOR);
  });
});

describe('completeness', () => {
  it('counts missing fields once, not once per exercise', () => {
    const p = plan({
      weekly_schedule: {
        Monday: { name: 'A', focus: 'x', exercises: [ex({ rir_or_rpe: '' }), ex({ rir_or_rpe: '' })] },
        Thursday: { name: 'B', focus: 'y', exercises: [ex({ name: 'Bench Press' })] },
      },
    });
    const a = audit(p);
    const v = a.violations.filter((x) => x.rule === 'no_effort_target');
    // Twelve separate "missing RIR" lines is a wall a reader skips. One line
    // with a count is a fact they act on.
    expect(v).toHaveLength(1);
    expect(v[0].detail).toBe('2 of 3 exercises have no RIR or RPE target');
  });

  it('does not demand sets and reps of a cardio prescription', () => {
    const p = plan({
      weekly_schedule: {
        Monday: {
          name: 'Cardio',
          focus: 'Conditioning',
          exercises: [{
            name: 'Barbell Squat', prescription_type: 'TIME_DISTANCE',
            duration_seconds: 1200, distance: 5, distance_unit: 'km',
            rir_or_rpe: 'RPE 6', rest_seconds: 0,
          }],
        },
        Thursday: { name: 'B', focus: 'y', exercises: [ex({ name: 'Bench Press' })] },
      },
    });
    const a = audit(p);
    // Forcing cardio into sets × reps is the error the system prompt already
    // forbids; the audit must not re-introduce it from the other side.
    expect(a.violations.filter((v) => v.rule === 'no_sets' || v.rule === 'no_reps')).toEqual([]);
  });

  it('catches a plan that never says what changes week to week', () => {
    const a = audit(plan({ progression_notes: '' }));
    expect(a.violations.find((v) => v.rule === 'no_progression').severity).toBe(SEVERITY.MAJOR);
    expect(scorePlan(a).components.progression).toBe(0);
  });

  it('catches an unnamed exercise instead of screening the empty string', () => {
    const p = plan({
      weekly_schedule: {
        Monday: { name: 'A', focus: 'x', exercises: [ex({ name: '' })] },
        Thursday: { name: 'B', focus: 'y', exercises: [ex({ name: 'Bench Press' })] },
      },
    });
    const a = audit(p);
    expect(a.violations.find((v) => v.rule === 'exercise_unnamed')).toBeTruthy();
    expect(a.unverified).toEqual([]);
  });
});

describe('the revision instruction', () => {
  it('names the exact change, never "improve the plan"', () => {
    const screened = screenedMap([
      ['Barbell Squat', 'allow'],
      ['Bench Press', 'block', 'mobility.body_regions: Shoulders: pain'],
    ]);
    const text = buildRevisionInstruction(audit(plan(), screened));
    expect(text).toContain('Thursday #1: Bench Press is excluded');
    expect(text).toContain('Shoulders: pain');
    // The instruction that stops the cheapest wrong fix: keeping the exercise
    // and stapling a warning to it.
    expect(text).toContain('must be REPLACED');
    expect(text).toContain('not annotated with a caution');
  });

  it('is null when there is nothing worth a second generation', () => {
    expect(buildRevisionInstruction(audit())).toBeNull();
    const minorOnly = audit(plan({ cool_down: '' }));
    expect(buildRevisionInstruction(minorOnly)).toBeNull();
  });
});

describe('the critic', () => {
  it('drops a point that cites nothing', () => {
    const out = parseCritique(JSON.stringify({
      critique: [
        { severity: 'high', point: 'Pressing volume is high', because: 'three push days, no pull' },
        { severity: 'high', point: 'Could be better' },
      ],
      verdict: 'workable',
    }));
    // A point a trainer cannot trace is a point they cannot overrule — the
    // same contract the coaching prompts already enforce.
    expect(out.critique).toHaveLength(1);
    expect(out.verdict).toBe('workable');
  });

  it('survives a model that wraps its JSON in prose', () => {
    const out = parseCritique('Sure!\n```json\n{"critique":[],"verdict":"sound"}\n```');
    expect(out).toEqual({ critique: [], verdict: 'sound' });
  });

  it('returns nothing rather than throwing on junk', () => {
    for (const junk of ['', 'no json here', '{broken', null, undefined]) {
      expect(parseCritique(junk)).toEqual({ critique: [], verdict: null });
    }
  });

  it('refuses a verdict it was not offered', () => {
    const out = parseCritique(JSON.stringify({ critique: [], verdict: 'excellent' }));
    expect(out.verdict).toBeNull();
  });
});

describe('the audit as the critic reads it', () => {
  it('names the unverified exercises so the critic does not assume they were checked', () => {
    const p = plan({
      weekly_schedule: {
        Monday: { name: 'A', focus: 'x', exercises: [ex({ name: 'Invented Movement' })] },
        Thursday: { name: 'B', focus: 'y', exercises: [ex({ name: 'Bench Press' })] },
      },
    });
    const text = describeAudit(audit(p, screenedMap([['Bench Press', 'allow']])));
    expect(text).toContain('could not be checked against this client\'s exclusions');
    expect(text).toContain('Invented Movement');
  });
});

describe('flattening', () => {
  it('keeps the day and position with every exercise', () => {
    expect(planExercises(plan()).map((e) => `${e.day} #${e.position}`))
      .toEqual(['Monday #1', 'Thursday #1']);
  });

  it('survives a malformed schedule instead of throwing mid-generation', () => {
    // A parse that succeeded does not mean a shape that matches. Throwing here
    // would lose a generation the trainer already waited thirty seconds for.
    for (const bad of [null, undefined, {}, { weekly_schedule: null }, { weekly_schedule: 'x' },
      { weekly_schedule: { Monday: null } }, { weekly_schedule: { Monday: { exercises: 'no' } } },
      { weekly_schedule: { Monday: { exercises: [null, 'x'] } } }]) {
      expect(planExercises(bad)).toEqual([]);
    }
  });
});

// ── Enforcing an adaptation, not just asking for one ───────────────────────
//
// `mode=adapt` changed what the model was told. Nothing checked whether the
// block that came back bore any resemblance to the one the client was actually
// training, so a model that quietly rewrote the whole programme produced
// exactly the second plan the adapt path exists to prevent — and it read like
// a thoughtful continuation.

describe('adaptation retention', () => {
  const { MIN_RETENTION_PCT, MIN_EXERCISES_FOR_RETENTION } = require('../modules/pt-os/plan-critic');

  const planOf = (names) => ({
    weeks: 4,
    warm_up: 'five minutes on the bike',
    cool_down: 'stretching',
    progression_notes: 'add 2.5kg a week',
    weekly_schedule: {
      Monday: {
        exercises: names.map((name) => ({
          name, sets: 3, reps: '8-10', rir_or_rpe: 'RIR 2', rest_seconds: 120,
        })),
      },
    },
  });

  const BLOCK = ['Barbell Squat', 'Bench Press', 'Barbell Row', 'Overhead Press'];
  const auditAdapting = (names, continuing = BLOCK) =>
    auditPlan(planOf(names), { requested: { continuing: { exercise_names: continuing } } });

  const retention = (audit) => audit.violations.find((v) => v.rule === 'adaptation_discarded_block');

  it('passes an adaptation that keeps the programme and changes the prescription', () => {
    expect(retention(auditAdapting(BLOCK))).toBeUndefined();
  });

  it('passes an adaptation that swaps one movement out', () => {
    expect(retention(auditAdapting(['Barbell Squat', 'Bench Press', 'Barbell Row', 'Lat Pulldown'])))
      .toBeUndefined();
  });

  it('fails one that replaced the programme', () => {
    const v = retention(auditAdapting(['Leg Press', 'Cable Fly', 'Lat Pulldown', 'Lateral Raise']));
    expect(v).toBeDefined();
    expect(v.severity).toBe('critical');
    expect(v.detail).toMatch(/keeps only 0 of the 4 exercises/);
    // Names the movements it dropped, so a trainer can see what went.
    expect(v.where).toEqual(expect.arrayContaining([expect.stringContaining('squat')]));
  });

  it('fails at exactly below the stated threshold, and passes at it', () => {
    // Two of four kept is 50%, which is the floor and therefore allowed.
    expect(retention(auditAdapting(['Barbell Squat', 'Bench Press', 'Leg Press', 'Cable Fly'])))
      .toBeUndefined();
    // One of four is 25%.
    const v = retention(auditAdapting(['Barbell Squat', 'Leg Press', 'Cable Fly', 'Lateral Raise']));
    expect(v.detail).toContain(`${MIN_RETENTION_PCT}%`);
  });

  it('matches on normalised name, so spelling does not fail an honest plan', () => {
    expect(retention(auditAdapting(['barbell  squat', 'BENCH PRESS', 'Barbell Row', 'Overhead Press'])))
      .toBeUndefined();
  });

  // A NEW programme has nothing to retain. Firing the rule there would fail a
  // trainer who deliberately started their client on something different.
  it('never fires on a new programme', () => {
    expect(retention(auditPlan(planOf(['Leg Press']), { requested: {} }))).toBeUndefined();
    expect(retention(auditPlan(planOf(['Leg Press']), { requested: { continuing: null } }))).toBeUndefined();
  });

  it('never fires on a block too small for a ratio to mean anything', () => {
    const tiny = BLOCK.slice(0, MIN_EXERCISES_FOR_RETENTION - 1);
    expect(retention(auditAdapting(['Leg Press'], tiny))).toBeUndefined();
  });

  it('spends the one revision on it, and tells the model to put them back', () => {
    const audit = auditAdapting(['Leg Press', 'Cable Fly', 'Lat Pulldown', 'Lateral Raise']);
    expect(audit.needs_revision).toBe(true);
    const instruction = buildRevisionInstruction(audit);
    expect(instruction).toMatch(/Put the client's current exercises back/);
    expect(instruction).toMatch(/PROGRESS this block, not to replace it/);
  });

  it('leaves the replace-an-excluded-exercise instruction alone otherwise', () => {
    const audit = auditAdapting(BLOCK.concat(['Leg Press']));
    expect(buildRevisionInstruction(audit) ?? '').not.toMatch(/Put the client's current exercises back/);
  });
});

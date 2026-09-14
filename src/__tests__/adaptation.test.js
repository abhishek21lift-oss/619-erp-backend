'use strict';

// Deciding what to do with each lift, from what the client actually lifted.
//
// The verdict these tests defend hardest is INSUFFICIENT EVIDENCE. It is the
// default, it is the most common answer on this studio's data, and it is the
// one an engine under pressure to look clever will quietly replace with a
// plausible-sounding trend. Half the cases below exist to make sure it cannot.

const {
  adaptationDecisions, describeAdaptation, DECISION, repRange, sessionsOf, isRegressing,
} = require('../modules/pt-os/adaptation');

const set = (on, over = {}) => ({
  exercise_name: 'Barbell Squat', session_date: on, completed: true,
  weight_kg: 60, reps: 8, ...over,
});

/** N completed sets of one exercise on one day. */
const day = (on, n, over = {}) => Array.from({ length: n }, () => set(on, over));

const SQUAT = { name: 'Barbell Squat', sets: 3, reps: '8-10', target_weight: 60 };

const only = (input) => adaptationDecisions(input).decisions[0];

describe('when there is nothing to go on', () => {
  it('says so for an exercise that has never been logged', () => {
    const d = only({ prescribed: [SQUAT], sets: [] });
    expect(d.decision).toBe(DECISION.INSUFFICIENT);
    expect(d.because).toMatch(/No completed set of Barbell Squat has been logged/);
    expect(d.sessions_logged).toBe(0);
  });

  it('does not count sets the client did not complete', () => {
    const d = only({ prescribed: [SQUAT], sets: day('2026-08-03', 3, { completed: false }) });
    expect(d.decision).toBe(DECISION.INSUFFICIENT);
  });

  it('will not judge an AMRAP set against a rep target it invented', () => {
    const d = only({
      prescribed: [{ ...SQUAT, reps: 'AMRAP' }],
      sets: day('2026-08-03', 3),
    });
    expect(d.decision).toBe(DECISION.INSUFFICIENT);
    expect(d.because).toMatch(/no rep target to compare/);
  });

  it('will not judge sets logged with no reps recorded', () => {
    const d = only({ prescribed: [SQUAT], sets: day('2026-08-03', 3, { reps: null }) });
    expect(d.decision).toBe(DECISION.INSUFFICIENT);
    expect(d.because).toMatch(/no reps recorded/);
  });

  it('reports a whole session with no evidence as exactly that', () => {
    const r = adaptationDecisions({
      prescribed: [SQUAT, { name: 'Bench Press', sets: 3, reps: 8 }],
      sets: [],
    });
    expect(r.evidence_free).toBe(true);
    expect(r.counts.insufficient_evidence).toBe(2);
    expect(describeAdaptation(r)).toMatch(/NONE of the prescribed exercises has logged evidence/);
  });

  it('is not "evidence free" when there are no exercises at all', () => {
    expect(adaptationDecisions({ prescribed: [], sets: [] }).evidence_free).toBe(false);
  });
});

describe('progress, hold, regress', () => {
  it('progresses when every set was completed at the top of the range', () => {
    const d = only({ prescribed: [SQUAT], sets: day('2026-08-03', 3, { reps: 10 }) });
    expect(d.decision).toBe(DECISION.PROGRESS);
    expect(d.because).toMatch(/reaching the top of the prescribed 8-10/);
  });

  it('holds when a set fell short of the bottom of the range', () => {
    const d = only({
      prescribed: [SQUAT],
      sets: [set('2026-08-03', { reps: 10 }), set('2026-08-03', { reps: 10 }), set('2026-08-03', { reps: 6 })],
    });
    expect(d.decision).toBe(DECISION.HOLD);
    expect(d.because).toMatch(/Lowest set on 2026-08-03 was 6 reps/);
  });

  it('holds inside the range but below the top of it', () => {
    const d = only({ prescribed: [SQUAT], sets: day('2026-08-03', 3, { reps: 9 }) });
    expect(d.decision).toBe(DECISION.HOLD);
    expect(d.because).toMatch(/inside the prescribed 8-10 but not at the top/);
  });

  it('holds when sets were missed, however good the reps were', () => {
    const d = only({ prescribed: [SQUAT], sets: day('2026-08-03', 2, { reps: 12 }) });
    expect(d.decision).toBe(DECISION.HOLD);
    expect(d.because).toMatch(/2 of 3 prescribed sets were completed/);
  });

  it('regresses on two consecutive falls in the top set', () => {
    const d = only({
      prescribed: [SQUAT],
      sets: [
        ...day('2026-08-17', 3, { weight_kg: 50, reps: 10 }),
        ...day('2026-08-10', 3, { weight_kg: 55, reps: 10 }),
        ...day('2026-08-03', 3, { weight_kg: 60, reps: 10 }),
      ],
    });
    expect(d.decision).toBe(DECISION.REGRESS);
    expect(d.because).toMatch(/60 kg on 2026-08-03, 55 kg on 2026-08-10, 50 kg on 2026-08-17/);
  });

  // The rule that stops the engine chasing noise: one bad session is one bad
  // session, and dropping somebody's load for it would be worse than waiting.
  it('does not regress on a single bad session', () => {
    const d = only({
      prescribed: [SQUAT],
      sets: [
        ...day('2026-08-10', 3, { weight_kg: 50, reps: 10 }),
        ...day('2026-08-03', 3, { weight_kg: 60, reps: 10 }),
      ],
    });
    expect(d.decision).not.toBe(DECISION.REGRESS);
  });

  // A regression beats a met prescription. A client completing every set of
  // 60 kg after completing every set of 70 kg has not earned an increase.
  it('regresses even when the latest session met the prescription', () => {
    const d = only({
      prescribed: [SQUAT],
      sets: [
        ...day('2026-08-17', 3, { weight_kg: 50, reps: 10 }),
        ...day('2026-08-10', 3, { weight_kg: 55, reps: 10 }),
        ...day('2026-08-03', 3, { weight_kg: 60, reps: 10 }),
      ],
    });
    expect(d.decision).toBe(DECISION.REGRESS);
  });

  it('does not call a flat top set a regression', () => {
    expect(isRegressing([
      { top_weight_kg: 60 }, { top_weight_kg: 60 }, { top_weight_kg: 60 },
    ])).toBe(false);
  });

  it('cannot regress on sessions with no weight recorded', () => {
    expect(isRegressing([
      { top_weight_kg: null }, { top_weight_kg: 60 }, { top_weight_kg: 70 },
    ])).toBe(false);
  });
});

describe('matching the log to the prescription', () => {
  it('matches on normalised name, so spelling and case do not lose a lift', () => {
    const d = only({
      prescribed: [{ name: 'Barbell  SQUAT', sets: 3, reps: 10 }],
      sets: day('2026-08-03', 3, { exercise_name: 'barbell squat', reps: 10 }),
    });
    expect(d.decision).toBe(DECISION.PROGRESS);
  });

  it('does not borrow another exercise\'s history', () => {
    const d = only({
      prescribed: [SQUAT],
      sets: day('2026-08-03', 3, { exercise_name: 'Leg Press', reps: 10 }),
    });
    expect(d.decision).toBe(DECISION.INSUFFICIENT);
  });

  it('groups sets by day, newest first', () => {
    const s = sessionsOf([
      ...day('2026-08-03', 2, { weight_kg: 60 }),
      ...day('2026-08-10', 3, { weight_kg: 65 }),
    ]);
    expect(s.map((x) => x.on)).toEqual(['2026-08-10', '2026-08-03']);
    expect(s[0].completed_sets).toBe(3);
    expect(s[0].top_weight_kg).toBe(65);
  });

  it('reads a session_date the driver parsed into a Date', () => {
    const s = sessionsOf([set(new Date('2026-08-03T00:00:00Z'))]);
    expect(s[0].on).toBe('2026-08-03');
  });
});

describe('rep prescriptions it can and cannot read', () => {
  it.each([
    [10, { min: 10, max: 10 }],
    ['10', { min: 10, max: 10 }],
    ['8-10', { min: 8, max: 10 }],
    ['8 to 10', { min: 8, max: 10 }],
    ['8–10', { min: 8, max: 10 }],
  ])('reads %p', (input, want) => {
    expect(repRange(input)).toEqual(want);
  });

  it.each(['AMRAP', 'to failure', '', null, undefined, '0', 'many'])('refuses %p', (input) => {
    expect(repRange(input)).toBeNull();
  });
});

describe('what the model is told', () => {
  it('states every verdict with the arithmetic behind it', () => {
    const text = describeAdaptation(adaptationDecisions({
      prescribed: [SQUAT],
      sets: day('2026-08-03', 3, { reps: 10 }),
    }));
    expect(text).toContain('Barbell Squat: PROGRESS —');
    expect(text).toContain('2026-08-03');
  });

  it('forbids inventing a trend where the verdict is that there is none', () => {
    const text = describeAdaptation(adaptationDecisions({ prescribed: [SQUAT], sets: [] }));
    expect(text).toMatch(/do not invent a trend/i);
    expect(text).toMatch(/do NOT describe the client as progressing, plateaued or regressing/);
  });

  it('says nothing at all when there is no next session to decide about', () => {
    expect(describeAdaptation(adaptationDecisions({ prescribed: [], sets: [] }))).toBe('');
  });
});

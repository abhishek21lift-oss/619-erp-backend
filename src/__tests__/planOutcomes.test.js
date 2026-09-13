'use strict';
// What the programme we proposed actually did.
//
// The half of the loop stage 5 could not reach. Its memory closes at the
// moment a trainer clicks save, so a plan trained for six weeks and a plan
// never started both read as "accepted" and both fed the next generation as a
// success. These tests hold the rules that tell them apart, and — just as
// importantly — the rules that refuse to answer when nothing can be measured.
//
// The single most valuable verdict here is `not_taken_up`, because nothing in
// the system could reach it before: a plan the client does not do is not a
// plan, and the engine had no way to know.

const {
  outcomeOf, summariseOutcomes, describeOutcomes, VERDICTS, MIN_DAYS_FOR_OUTCOME,
} = require('../modules/pt-os/plan-outcomes');
const { MIN_SESSIONS_FOR_TREND } = require('../modules/pt-os/training-history');

const TODAY = '2026-09-13';

/** n days before TODAY, as YYYY-MM-DD. */
function daysAgo(n) {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function generation(over = {}) {
  return {
    id: 'gen-1',
    accepted_at: daysAgo(42),
    accepted_plan_id: 'plan-1',
    assignment_id: 'asg-1',
    sessions_per_week: 3,
    duration_weeks: 8,
    plan_exercise_names: ['Bench Press', 'Back Squat'],
    ...over,
  };
}

const session = (date, status = 'completed') => ({ session_date: date, status });

/** A set row as the log stores it. */
const set = (date, name, weight, reps) => ({
  session_date: date, exercise_name: name, weight_kg: weight, reps, completed: true,
});

/**
 * n sessions of one lift, `step` kg apart, oldest first — enough to give
 * exerciseTrend something to read.
 */
function progression(name, { from, step, sessions = MIN_SESSIONS_FOR_TREND, startDaysAgo = 30 }) {
  const rows = [];
  for (let i = 0; i < sessions; i++) {
    rows.push(set(daysAgo(startDaysAgo - i * 7), name, from + i * step, 5));
  }
  return rows;
}

describe('outcomeOf — was it trained at all', () => {
  test('a plan nobody logged a session against is not taken up', () => {
    const out = outcomeOf({ generation: generation(), sessions: [], sets: [], today: TODAY });
    expect(out.verdict).toBe(VERDICTS.NOT_TAKEN_UP);
    expect(out.because).toBe('no session logged against it in 42 days');
    expect(out.sessions_completed).toBe(0);
  });

  test('sessions started and never finished still count as not taken up, and say so', () => {
    // A different sentence, because it is a different conversation: the client
    // is turning up and not completing, not staying away.
    const out = outcomeOf({
      generation: generation(),
      sessions: [session(daysAgo(20), 'in_progress'), session(daysAgo(10), 'in_progress')],
      sets: [],
      today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.NOT_TAKEN_UP);
    expect(out.because).toContain('2 sessions started and none completed');
  });

  test('a plan too young to judge is too_early, not a failure', () => {
    const out = outcomeOf({
      generation: generation({ accepted_at: daysAgo(3) }),
      sessions: [], sets: [], today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.TOO_EARLY);
    expect(out.because).toContain('3 days ago');
  });

  test('the boundary is inclusive at MIN_DAYS_FOR_OUTCOME', () => {
    // Pinned as literals as well as the constant: a test written only as
    // `daysAgo(MIN_DAYS_FOR_OUTCOME)` moves with the threshold and would pass
    // for any value of it.
    expect(MIN_DAYS_FOR_OUTCOME).toBe(14);
    const at13 = outcomeOf({
      generation: generation({ accepted_at: daysAgo(13) }), sessions: [], sets: [], today: TODAY,
    });
    const at14 = outcomeOf({
      generation: generation({ accepted_at: daysAgo(14) }), sessions: [], sets: [], today: TODAY,
    });
    expect(at13.verdict).toBe(VERDICTS.TOO_EARLY);
    expect(at14.verdict).toBe(VERDICTS.NOT_TAKEN_UP);
  });
});

describe('outcomeOf — attribution and its limits', () => {
  test('a plan that was never assigned is unmeasurable, never "no progress"', () => {
    // This is the case acceptGeneration used to create every time. Reporting
    // it as a plan that produced nothing would teach the engine the opposite
    // of the truth.
    const out = outcomeOf({
      generation: generation({ assignment_id: null }), sessions: [], sets: [], today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.UNMEASURABLE);
    expect(out.attributable).toBe(false);
    expect(out.because).toContain('never assigned');
    expect(out.unmeasured).toContainEqual({
      what: 'everything',
      reason: 'the plan has no assignment to attribute sessions to',
    });
  });

  test('a proposal with no acceptance date is unmeasurable rather than dated from nothing', () => {
    const out = outcomeOf({
      generation: generation({ accepted_at: null }), sessions: [], sets: [], today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.UNMEASURABLE);
    expect(out.days_live).toBeNull();
  });

  test('an unassigned plan is unmeasurable even when sessions were somehow passed in', () => {
    // Order matters: attribution is checked before anything is counted, so a
    // caller who hands over sessions from elsewhere cannot produce a verdict
    // about a plan those sessions do not belong to.
    const out = outcomeOf({
      generation: generation({ assignment_id: null }),
      sessions: [session(daysAgo(5)), session(daysAgo(12))],
      sets: progression('Bench Press', { from: 60, step: 5 }),
      today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.UNMEASURABLE);
  });
});

describe('outcomeOf — did the prescribed lifts move', () => {
  const trained = [session(daysAgo(30)), session(daysAgo(23)), session(daysAgo(16))];

  test('reports progress on the plan\'s own lifts', () => {
    const out = outcomeOf({
      generation: generation(),
      sessions: trained,
      sets: progression('Bench Press', { from: 60, step: 5 }),
      today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.PROGRESSING);
    expect(out.progressing).toEqual(['Bench Press']);
    expect(out.because).toContain('up on Bench Press');
  });

  test('a lift going backwards outweighs one going forwards', () => {
    // Deliberate: a programme that is costing a client a lift is worth saying
    // so about even when something else improved.
    const out = outcomeOf({
      generation: generation(),
      sessions: trained,
      sets: [
        ...progression('Bench Press', { from: 80, step: -6 }),
        ...progression('Back Squat', { from: 100, step: 1 }),
      ],
      today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.REGRESSING);
    expect(out.regressing).toEqual(['Bench Press']);
  });

  test('measured and unmoved is flat, which is not the same as untrained', () => {
    const out = outcomeOf({
      generation: generation(),
      sessions: trained,
      sets: progression('Bench Press', { from: 60, step: 0 }),
      today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.FLAT);
    expect(out.plateaued).toEqual(['Bench Press']);
  });

  test('trained but with no lift at the trend threshold says so rather than guessing', () => {
    const out = outcomeOf({
      generation: generation(),
      sessions: trained,
      sets: progression('Bench Press', { from: 60, step: 5, sessions: MIN_SESSIONS_FOR_TREND - 1 }),
      today: TODAY,
    });
    expect(out.verdict).toBe(VERDICTS.NO_TREND_YET);
    expect(out.unmeasured).toContainEqual({
      what: 'progression',
      reason: `no prescribed lift has ${MIN_SESSIONS_FOR_TREND} logged sessions yet`,
    });
  });

  test('credits the plan only with the lifts it actually prescribed', () => {
    // A trainer adapting on the day logs whatever the client needed. Counting
    // that as the plan's progression would flatter it with somebody else's work.
    const out = outcomeOf({
      generation: generation({ plan_exercise_names: ['Bench Press'] }),
      sessions: trained,
      sets: [
        ...progression('Bench Press', { from: 60, step: 0 }),
        ...progression('Barbell Row', { from: 50, step: 10 }),
      ],
      today: TODAY,
    });
    expect(out.lifts.map((l) => l.exercise)).toEqual(['Bench Press']);
    expect(out.verdict).toBe(VERDICTS.FLAT);
    expect(out.off_plan_sets).toBe(MIN_SESSIONS_FOR_TREND);
  });

  test('matches an exercise name the way the rest of the engine does', () => {
    const out = outcomeOf({
      generation: generation({ plan_exercise_names: ['Bench Press'] }),
      sessions: trained,
      sets: progression('  bench   press ', { from: 60, step: 5 }),
      today: TODAY,
    });
    expect(out.off_plan_sets).toBe(0);
    expect(out.verdict).toBe(VERDICTS.PROGRESSING);
  });
});

describe('outcomeOf — adherence', () => {
  test('measures completed sessions against what the plan asked for', () => {
    // 42 days live = 6 whole weeks, 3 per week = 18 expected.
    const out = outcomeOf({
      generation: generation(),
      sessions: [session(daysAgo(30)), session(daysAgo(23)), session(daysAgo(16))],
      sets: [],
      today: TODAY,
    });
    expect(out.sessions_expected).toBe(18);
    expect(out.sessions_completed).toBe(3);
    expect(out.adherence_pct).toBe(17);
  });

  test('stops counting expected sessions once the block is over', () => {
    // A six-week plan still live at week twenty is finished, not fourteen
    // weeks behind. Without the cap, adherence falls forever after the block
    // ends and every old plan eventually reads as abandoned.
    const out = outcomeOf({
      generation: generation({ accepted_at: daysAgo(140), duration_weeks: 6 }),
      sessions: [session(daysAgo(100))],
      sets: [],
      today: TODAY,
    });
    expect(out.sessions_expected).toBe(18);
  });

  test('says adherence is unmeasurable when the plan names no frequency', () => {
    const out = outcomeOf({
      generation: generation({ sessions_per_week: null }),
      sessions: [session(daysAgo(20))],
      sets: [],
      today: TODAY,
    });
    expect(out.adherence_pct).toBeNull();
    expect(out.unmeasured).toContainEqual({
      what: 'adherence', reason: 'the plan names no weekly frequency',
    });
  });
});

describe('summariseOutcomes', () => {
  const at = (verdict) => ({ verdict, because: 'x', adherence_pct: null, off_plan_sets: 0 });

  test('counts each verdict and keeps unmeasurable apart from the rest', () => {
    const s = summariseOutcomes([
      at(VERDICTS.UNMEASURABLE), at(VERDICTS.NOT_TAKEN_UP), at(VERDICTS.PROGRESSING),
    ]);
    expect(s.accepted).toBe(3);
    expect(s.unmeasurable).toBe(1);
    expect(s.measured).toBe(2);
    expect(s.has_outcomes).toBe(true);
  });

  test('a history of nothing but unassigned plans has no outcomes at all', () => {
    const s = summariseOutcomes([at(VERDICTS.UNMEASURABLE), at(VERDICTS.UNMEASURABLE)]);
    expect(s.has_outcomes).toBe(false);
    expect(s.decisive).toBeNull();
  });

  test('too_early does not count as a measured outcome', () => {
    const s = summariseOutcomes([at(VERDICTS.TOO_EARLY)]);
    expect(s.measured).toBe(0);
    expect(s.has_outcomes).toBe(false);
  });

  test('the decisive outcome is the most recent one that measured something', () => {
    // Rows arrive newest first, so a fresh unmeasurable proposal must not
    // displace the older one that actually has an answer.
    const rows = [at(VERDICTS.TOO_EARLY), at(VERDICTS.NOT_TAKEN_UP), at(VERDICTS.PROGRESSING)];
    expect(summariseOutcomes(rows).decisive.verdict).toBe(VERDICTS.NOT_TAKEN_UP);
  });
});

describe('describeOutcomes — what the model is told', () => {
  const withDecisive = (over) => summariseOutcomes([{
    verdict: VERDICTS.NOT_TAKEN_UP, because: 'no session logged against it in 42 days',
    adherence_pct: null, sessions_completed: 0, sessions_expected: 18, off_plan_sets: 0, ...over,
  }]);

  test('says nothing at all for a client with no accepted proposal', () => {
    expect(describeOutcomes(summariseOutcomes([]))).toBe('');
  });

  test('tells the model there is no history rather than omitting the section', () => {
    const text = describeOutcomes(summariseOutcomes([
      { verdict: VERDICTS.UNMEASURABLE, because: 'x', adherence_pct: null, off_plan_sets: 0 },
    ]));
    expect(text).toContain('none can be assessed yet');
    expect(text).toContain('never assigned');
    expect(text).toContain('Do not infer that previous plans worked or failed');
  });

  test('an untrained programme is put to the model as a question about demand', () => {
    const text = describeOutcomes(withDecisive({}));
    expect(text).toContain('NOT TRAINED');
    expect(text).toContain('A plan the client does not do is not a plan');
  });

  test('carries adherence when there is any', () => {
    const text = describeOutcomes(withDecisive({
      verdict: VERDICTS.PROGRESSING, because: 'up on Bench Press',
      adherence_pct: 61, sessions_completed: 11, sessions_expected: 18,
    }));
    expect(text).toContain('11 of 18 prescribed sessions (61%)');
  });

  test('reports off-plan work as the trainer adapting, not as a fault', () => {
    const text = describeOutcomes(withDecisive({
      verdict: VERDICTS.FLAT, because: 'nothing moved', off_plan_sets: 12,
    }));
    expect(text).toContain('12 logged sets were for exercises that plan did not prescribe');
    expect(text).toContain('adapting it on the day');
  });

  test('always says how thin the evidence is, and that it is not a rule', () => {
    const text = describeOutcomes(withDecisive({}));
    expect(text).toContain('Based on 1 measurable programme out of 1 saved');
    // The sentence that stops history from becoming a safety override, the
    // same guarantee describeMemory carries.
    expect(text).toContain('the safety screen and the client\'s current data still decide');
  });
});

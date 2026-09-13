// What a trainer should be told without having to go and look.
//
// ── The failure this module exists for ────────────────────────────────────
//
// Measured on the live database before it was written:
//
//   1 client trained in the last 7 days
//   16 last trained 15-30 days ago
//   4 have not trained in over a month
//
// Nothing raised a flag about any of them, and not by oversight.
// client-snapshot.js's `missed_workout` fires only on a session that was
// SCHEDULED and not completed — deliberately, because "a client with nothing
// booked has not missed anything". That is right for a missed appointment and
// exactly wrong for clients who stop booking at all. Silence raised nothing,
// and silence was the signal.
//
// ── The split these tests defend hardest ──────────────────────────────────
//
// "16 clients have gone quiet" is noise. Against the term it is three
// different things, and only two are work:
//
//   7 quiet, still inside a paid term   → paying and not coming
//   8 quiet, term already finished      → they finished; win-back, not a chase
//   1 paid and never trained at all     → worst case
//
// Putting the middle group in the same list as the first is how a trainer
// learns to ignore the list, so `keeps a finished client out of the chase
// list` is the test that must not be relaxed.
'use strict';

const {
  detectSignals, summariseRoster, termState,
  SEVERITY, QUIET_DAYS, GONE_DAYS, NEVER_STARTED_DAYS,
} = require('../modules/pt-os/training-signals');
const { buildTrainingHistory } = require('../modules/pt-os/training-history');
const { volumeLandmarks, deloadTriggers } = require('../modules/pt-os/programming-rules');

const TODAY = '2026-09-13';           // the day the measurements above were taken
const daysAgo = (n) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const client = (o = {}) => ({
  id: 'cl-1', name: 'Test Client', pt_start_date: daysAgo(60), pt_end_date: daysAgo(-30), ...o,
});

const detect = (o = {}) => detectSignals({ client: client(), today: TODAY, ...o });

/** Completed sets for one exercise across N distinct sessions. */
const sets = (name, loads, muscle = 'Quadriceps') => loads.map((weight_kg, i) => ({
  exercise_name: name, weight_kg, reps: 8, rpe: null, rir: null,
  completed: true, session_date: daysAgo(20 - i * 3), target_muscle: muscle,
}));

/** The studio's ranges, as the platform seeds them. */
const RANGES = new Map([
  ['Lats', { mev_sets: 10, mrv_sets: 25 }],
  ['Chest', { mev_sets: 8, mrv_sets: 22 }],
]);

describe('the term decides what silence means', () => {
  it('flags a client who is paying and not coming', () => {
    const out = detect({ lastSession: daysAgo(16) });
    const s = out.signals.find((x) => x.id === 'gone_quiet');
    expect(s).toBeTruthy();
    expect(s.severity).toBe(SEVERITY.WARNING);
    expect(s.evidence).toContain('16 days ago');
    expect(out.days_quiet).toBe(16);
  });

  it('escalates once they have simply stopped', () => {
    const s = detect({ lastSession: daysAgo(GONE_DAYS + 1) }).signals[0];
    expect(s.severity).toBe(SEVERITY.CRITICAL);
    expect(s.recommendation).toContain('non-renewal');
  });

  it('keeps a finished client out of the chase list', () => {
    // 8 of the 16 quiet clients are here. They are not ghosting — they
    // completed what they bought. Listing them beside the paying ones is how
    // the whole list gets ignored.
    const out = detectSignals({
      client: client({ pt_end_date: daysAgo(20) }), today: TODAY, lastSession: daysAgo(25),
    });
    expect(out.signals[0].id).toBe('term_ended_inactive');
    expect(out.signals[0].severity).toBe(SEVERITY.INFO);
    expect(out.signals[0].recommendation).toContain('Win-back, not a chase');
  });

  it('says so when nothing records what they bought', () => {
    const out = detectSignals({
      client: client({ pt_end_date: null }), today: TODAY, lastSession: daysAgo(20),
    });
    expect(out.term.state).toBe('unknown');
    expect(out.signals[0].recommendation).toContain('nothing records what they bought');
  });

  it('says nothing about a client who trained this week', () => {
    expect(detect({ lastSession: daysAgo(2) }).signals).toEqual([]);
  });

  it('waits out a single missed week', () => {
    // One missed week is a holiday. Ten days is at least three missed
    // sessions for anyone training twice a week.
    expect(detect({ lastSession: daysAgo(QUIET_DAYS - 1) }).signals).toEqual([]);
    expect(detect({ lastSession: daysAgo(QUIET_DAYS) }).signals).toHaveLength(1);
  });

  it('holds the thresholds themselves, not just the boundary around them', () => {
    // Written against literals on purpose. Expressing these in terms of the
    // constants makes the test move with them, so lowering QUIET_DAYS to 3
    // would still pass while flagging every client who took a long weekend —
    // and a list that cries wolf is a list a trainer stops opening.
    expect(QUIET_DAYS).toBe(10);
    expect(GONE_DAYS).toBe(21);
    expect(NEVER_STARTED_DAYS).toBe(14);

    // A week off is not a signal, at the literal day count.
    expect(detect({ lastSession: daysAgo(7) }).signals).toEqual([]);
    // Three weeks is not drift.
    expect(detect({ lastSession: daysAgo(21) }).signals[0].severity).toBe(SEVERITY.CRITICAL);
  });
});

describe('a client who never started', () => {
  it('is the worst case, and is called that', () => {
    const out = detect({ lastSession: null });
    expect(out.signals[0]).toMatchObject({ id: 'never_started', severity: SEVERITY.CRITICAL });
    expect(out.signals[0].evidence).toContain('no completed session on record');
  });

  it('is not raised in the first fortnight of a term', () => {
    // A client who signed up on Tuesday has not failed to start.
    const out = detectSignals({
      client: client({ pt_start_date: daysAgo(NEVER_STARTED_DAYS - 1) }),
      today: TODAY, lastSession: null,
    });
    expect(out.signals).toEqual([]);
  });

  it('is not raised for someone who has not bought anything', () => {
    const out = detectSignals({
      client: client({ pt_end_date: daysAgo(5) }), today: TODAY, lastSession: null,
    });
    // A prospect who never trained is not a training problem.
    expect(out.signals).toEqual([]);
  });
});

describe('training signals reuse stages 1 and 2', () => {
  it('reports a regression with the lifts named', () => {
    // Three sessions, going down: 80 → 70 → 60.
    const history = buildTrainingHistory({ sets: sets('Barbell Squat', [80, 70, 60]) });
    const out = detect({ lastSession: daysAgo(2), history });
    const s = out.signals.find((x) => x.id === 'regression');
    expect(s.severity).toBe(SEVERITY.WARNING);
    expect(s.evidence).toBe('Barbell Squat');
  });

  it('reports a stall more quietly than a regression', () => {
    const history = buildTrainingHistory({ sets: sets('Barbell Squat', [80, 80, 80]) });
    const s = detect({ lastSession: daysAgo(2), history }).signals.find((x) => x.id === 'plateau');
    // Stalling is worth saying. It is not worth saying as loudly as going
    // backwards, which is what a trainer must look at first.
    expect(s.severity).toBe(SEVERITY.INFO);
  });

  it('refuses a plateau call the data cannot support, and says why', () => {
    // The production-normal case. Even the best-logged client has no exercise
    // with three sessions, so this is what almost every client returns.
    const history = buildTrainingHistory({ sets: sets('Barbell Squat', [80, 85]) });
    const out = detect({ lastSession: daysAgo(2), history });
    expect(out.signals.find((s) => s.id === 'plateau')).toBeUndefined();
    expect(out.unobservable.map((u) => u.signal)).toEqual(
      expect.arrayContaining(['plateau', 'regression']),
    );
    expect(out.unobservable[0].reason).toContain('logged sessions yet');
  });

  it('does not confuse "no sets" with "no plateau"', () => {
    const out = detect({ lastSession: null, history: buildTrainingHistory({ sets: [] }) });
    expect(out.unobservable).toEqual(
      expect.arrayContaining([{ signal: 'plateau', reason: 'no sets logged' }]),
    );
  });
});

describe('volume', () => {
  const volume = (n) => volumeLandmarks([{ week: '2026-W37', muscles: { Lats: n } }], RANGES);

  it('flags an under-trained group for someone actually training', () => {
    const s = detect({ lastSession: daysAgo(2), volume: volume(3) })
      .signals.find((x) => x.id === 'undertrained');
    // Measured against the studio's own range, not a constant in the engine.
    expect(s.evidence).toContain('Lats 3 sets vs 10 minimum');
  });

  it('stays quiet about volume for a client who has gone quiet', () => {
    // An under-trained muscle on somebody who has not been in for a month is
    // a symptom of the silence, not a second finding to act on.
    const out = detect({ lastSession: daysAgo(30), volume: volume(3) });
    expect(out.signals.map((s) => s.id)).toEqual(['gone_quiet']);
  });

  it('flags overreaching as louder than under-training', () => {
    const over = volumeLandmarks([{ week: '2026-W37', muscles: { Lats: 30 } }], RANGES);
    const s = detect({ lastSession: daysAgo(2), volume: over })
      .signals.find((x) => x.id === 'overreaching');
    expect(s.severity).toBe(SEVERITY.WARNING);
  });
});

describe('deload', () => {
  it('passes through a trigger that actually fired', () => {
    const volume = volumeLandmarks([
      { week: '2026-W36', muscles: { Chest: 30 } },
      { week: '2026-W37', muscles: { Chest: 26 } },
    ], RANGES);
    const history = buildTrainingHistory({ sets: sets('Bench Press', [60, 60, 60], 'Chest') });
    const s = detect({ lastSession: daysAgo(2), history, volume, deload: deloadTriggers({ history, volume }) })
      .signals.find((x) => x.id === 'deload_due');
    expect(s.severity).toBe(SEVERITY.WARNING);
    expect(s.evidence).toContain('Chest above 22 sets');
  });

  it('reports a blind deload check rather than an all-clear', () => {
    // Production holds RPE on 4 of 520 sets and no weekly check-ins at all,
    // so three of the four triggers are structurally unobservable.
    const history = buildTrainingHistory({ sets: [] });
    const out = detect({ lastSession: daysAgo(2), history, deload: deloadTriggers({ history }) });
    expect(out.signals.find((s) => s.id === 'deload_due')).toBeUndefined();
    expect(out.unobservable.find((u) => u.signal === 'deload').reason)
      .toContain('triggers could be evaluated');
  });
});

describe('the roster sweep', () => {
  // The live studio in miniature: one training, one paying and silent, one
  // finished, one never started.
  const roster = () => [
    detectSignals({ client: client({ id: 'a', name: 'Trains' }), today: TODAY, lastSession: daysAgo(2) }),
    detectSignals({ client: client({ id: 'b', name: 'Paying, silent' }), today: TODAY, lastSession: daysAgo(25) }),
    detectSignals({
      client: client({ id: 'c', name: 'Finished', pt_end_date: daysAgo(10) }),
      today: TODAY, lastSession: daysAgo(30),
    }),
    detectSignals({ client: client({ id: 'd', name: 'Never came' }), today: TODAY, lastSession: null }),
  ];

  it('lists only the clients with something to say', () => {
    const out = summariseRoster(roster());
    expect(out.clients).toBe(4);
    expect(out.clients_with_signals).toBe(3);
    // A sweep that returns all 34 every time is a sweep nobody reads twice.
    expect(out.clients_detail.map((r) => r.client_id)).not.toContain('a');
  });

  it('puts the worst first, then the longest silence', () => {
    const out = summariseRoster(roster());
    expect(out.clients_detail.map((r) => r.client_id)).toEqual(['d', 'b', 'c']);
    expect(out.critical).toBe(2);
    expect(out.info).toBe(1);
  });

  it('counts how many clients each signal touches', () => {
    const out = summariseRoster(roster());
    // Deterministic: severity, then client count, then id. Without the last
    // term these two criticals came back in whatever order the roster was in.
    expect(out.by_signal).toEqual([
      { id: 'gone_quiet', severity: 'critical', clients: 1 },
      { id: 'never_started', severity: 'critical', clients: 1 },
      { id: 'term_ended_inactive', severity: 'info', clients: 1 },
    ]);
    // Same input, same order, every time.
    expect(summariseRoster([...roster()].reverse()).by_signal).toEqual(out.by_signal);
  });

  it('states how many clients could not be assessed at all', () => {
    // On this studio's data most clients have too little history for a
    // plateau call. A sweep that quietly returned "all clear" for them would
    // be claiming a check nobody ran.
    const quietRoster = [
      detectSignals({
        client: client({ id: 'e' }), today: TODAY, lastSession: daysAgo(2),
        history: buildTrainingHistory({ sets: sets('Squat', [80, 85]) }),
      }),
    ];
    const out = summariseRoster(quietRoster);
    expect(out.clients_with_signals).toBe(0);
    expect(out.not_assessable).toBe(1);
  });
});

describe('term state', () => {
  it('reads the studio\'s own record rather than inferring one', () => {
    expect(termState({ pt_end_date: daysAgo(-5) }, TODAY)).toMatchObject({ state: 'current', days_left: 5 });
    expect(termState({ pt_end_date: daysAgo(5) }, TODAY)).toMatchObject({ state: 'ended', days_left: -5 });
    expect(termState({}, TODAY)).toMatchObject({ state: 'unknown', days_left: null });
  });
});

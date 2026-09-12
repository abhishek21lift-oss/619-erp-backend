// Turning logged sets into evidence a programme can be argued from.
//
// ── Why this module exists, and why these tests are about refusal ──────────
//
// The AI workout generator wrote programmes from a client's age, goal and
// equipment. Every set the studio had ever logged — 520 of them — was sitting
// in workout_sets unread, so the one question programming actually asks
// ("what happened last time, and what should change because of it") had no
// input at all.
//
// This module is that input. Most of what it must get right is not the
// arithmetic; it is knowing when NOT to answer. A programming engine that
// says "plateaued, deload" off two sessions will be confidently wrong at a
// client's expense, and the trainer reading a tidy number cannot tell it from
// a real one.
//
// The fixtures below are shaped like production rows, and the two marked LIVE
// are production rows.
'use strict';

const {
  buildTrainingHistory, exerciseTrend, weeklyVolume, adherence,
  fatigueSignal, estimate1RM, isoWeek,
  MIN_SESSIONS_FOR_TREND, MAX_REPS_FOR_E1RM,
} = require('../modules/pt-os/training-history');

const set = (o = {}) => ({
  exercise_name: 'Bench Press', weight_kg: 60, reps: 8, rpe: null, rir: null,
  completed: true, session_date: '2026-08-19', ...o,
});

describe('estimated 1RM', () => {
  it('is Epley', () => {
    // 60 × (1 + 8/30) = 76
    expect(estimate1RM(60, 8)).toBe(76);
  });

  it('refuses rep ranges where the formula is fiction', () => {
    // At 20 reps Epley says a 40kg set is a 93kg single. No coach believes
    // that, and a programme built on it would prescribe a load the client
    // cannot lift. Above the cap there is no estimate rather than a wrong one.
    expect(estimate1RM(40, MAX_REPS_FOR_E1RM)).not.toBeNull();
    expect(estimate1RM(40, MAX_REPS_FOR_E1RM + 1)).toBeNull();
    expect(estimate1RM(40, 20)).toBeNull();
  });

  it('has no answer for a set with no load', () => {
    // Bodyweight, unweighted machines, cardio logged as reps. Zero would be a
    // number, and it would drag every average it touched toward the floor.
    expect(estimate1RM(null, 10)).toBeNull();
    expect(estimate1RM(0, 10)).toBeNull();
  });
});

describe('one exercise\'s direction', () => {
  const onDates = (pairs) =>
    pairs.map(([session_date, weight_kg]) => set({ session_date, weight_kg }));

  it('says nothing at all below three sessions', () => {
    // THE assertion in this file. Two points is a line through noise, and
    // "regressing" is exactly the verdict a trainer would deload on.
    const two = exerciseTrend(onDates([['2026-08-01', 60], ['2026-08-08', 50]]));
    expect(two.sessions).toBe(2);
    expect(two.trend).toBeNull();
    expect(two.change_pct).toBeNull();
    // It still reports what it saw — the refusal is about the VERDICT, not
    // about hiding the data.
    expect(two.best_e1rm_kg).toBe(76);
    expect(two.latest_e1rm_kg).toBe(63.3);
  });

  it('calls a rise progressing once there are three', () => {
    const t = exerciseTrend(onDates([['2026-08-01', 60], ['2026-08-08', 62.5], ['2026-08-15', 67.5]]));
    expect(t.sessions).toBe(MIN_SESSIONS_FOR_TREND);
    expect(t.trend).toBe('progressing');
    expect(t.change_pct).toBeGreaterThan(0);
  });

  it('calls a fall regressing', () => {
    const t = exerciseTrend(onDates([['2026-08-01', 70], ['2026-08-08', 65], ['2026-08-15', 60]]));
    expect(t.trend).toBe('regressing');
    expect(t.change_pct).toBeLessThan(0);
  });

  it('treats a wobble inside the noise band as a plateau, not a trend', () => {
    // 60 → 61 → 60.5 is bar-speed, sleep and honest-RIR noise, not progress.
    const t = exerciseTrend(onDates([['2026-08-01', 60], ['2026-08-08', 61], ['2026-08-15', 60.5]]));
    expect(t.trend).toBe('plateaued');
  });

  it('takes the top set of a session, not the average', () => {
    // The next prescription is written against the best set. Averaging in the
    // back-off sets would under-report what the client can do.
    const t = exerciseTrend([
      set({ session_date: '2026-08-01', weight_kg: 50 }),
      set({ session_date: '2026-08-01', weight_kg: 70 }),
    ]);
    expect(t.sessions).toBe(1);
    expect(t.best_e1rm_kg).toBe(estimate1RM(70, 8));
  });

  it('counts loadless sets as volume but never as a strength reading', () => {
    const t = exerciseTrend([
      set({ session_date: '2026-08-01', weight_kg: null, reps: 20 }),
      set({ session_date: '2026-08-08', weight_kg: null, reps: 20 }),
    ]);
    expect(t.sets).toBe(2);
    expect(t.sets_without_load).toBe(2);
    expect(t.best_e1rm_kg).toBeNull();
    expect(t.trend).toBeNull();
  });
});

describe('prescribed work is not completed work', () => {
  it('computes performance from completed sets only', () => {
    // ── The correctness fix this file was rewritten for ───────────────────
    //
    // workout_sets holds BOTH halves: the row written when the trainer laid
    // the session out, and the same row with `completed` true once it
    // happened. Production: 408 completed, 112 not. Counting them together
    // credits a client with tonnage they never lifted — and then the next
    // programme progresses them from it.
    const h = buildTrainingHistory({
      sets: [
        set({ weight_kg: 100, reps: 10, completed: true }),
        set({ weight_kg: 200, reps: 10, completed: false }),
        set({ weight_kg: 200, reps: 10, completed: false }),
      ],
    });
    expect(h.totals.sets).toBe(1);
    expect(h.totals.sets_not_completed).toBe(2);
    expect(h.totals.volume_kg).toBe(1000); // the 100kg set, not the 200s
    expect(h.exercises[0].best_e1rm_kg).toBe(estimate1RM(100, 10));
  });

  it('names the work a client keeps skipping, but only once it is a pattern', () => {
    // One skipped set is a phone call. Three is a programming decision: an
    // accessory nobody ever finishes should stop being prescribed.
    const h = buildTrainingHistory({
      sets: [
        set({ exercise_name: 'Face Pull', completed: false }),
        set({ exercise_name: 'Face Pull', completed: false }),
        set({ exercise_name: 'Face Pull', completed: false }),
        set({ exercise_name: 'Calf Raise', completed: false }),
      ],
    });
    expect(h.skipped_exercises).toEqual([{ exercise: 'Face Pull', count: 3 }]);
  });
});

describe('adherence', () => {
  it('is null, not zero, when nothing was prescribed', () => {
    // A client with no programme has not failed to follow one. 0% on that
    // card is a trainer's problem reported as a client's.
    expect(adherence({ prescribed: 0, completed: 0 }).pct).toBeNull();
    expect(adherence({}).pct).toBeNull();
  });

  it('reports the shortfall as well as the percentage', () => {
    expect(adherence({ prescribed: 12, completed: 9 })).toEqual({
      pct: 75, prescribed: 12, completed: 9, missed: 3,
    });
  });

  it('never exceeds 100% for a client who trained extra', () => {
    expect(adherence({ prescribed: 8, completed: 11 }).pct).toBe(100);
  });
});

describe('fatigue', () => {
  it('will not claim a client is fresh when it simply cannot see', () => {
    // ── The honest-null that matters most ─────────────────────────────────
    //
    // This signal needs RPE, and production holds an RPE on 4 of 520 sets.
    // The field is in the workout log; trainers do not fill it in. So the
    // answer here is null nearly always — and the reason has to distinguish
    // "no weeks logged" from "weeks logged, no effort captured", because
    // "we cannot see fatigue" and "there is no fatigue" lead to opposite
    // programming decisions.
    const noRpe = fatigueSignal([
      { week: '2026-W30', sets: 20, sessions: 3, volume_kg: 5000, mean_rpe: null, sparse: false },
      { week: '2026-W31', sets: 20, sessions: 3, volume_kg: 5000, mean_rpe: null, sparse: false },
      { week: '2026-W32', sets: 20, sessions: 3, volume_kg: 5000, mean_rpe: null, sparse: false },
    ]);
    expect(noRpe.flag).toBeNull();
    expect(noRpe.reason).toMatch(/no RPE recorded/);
    expect(noRpe.observed_weeks).toBe(3);

    const noWeeks = fatigueSignal([]);
    expect(noWeeks.flag).toBeNull();
    expect(noWeeks.reason).toMatch(/not enough training weeks/);
  });

  it('flags effort climbing while tonnage does not', () => {
    const wk = (week, volume_kg, mean_rpe) =>
      ({ week, sets: 20, sessions: 3, volume_kg, mean_rpe, sparse: false });
    const f = fatigueSignal([
      wk('2026-W30', 6000, 6), wk('2026-W31', 6000, 6.5),
      wk('2026-W32', 5800, 7.5), wk('2026-W33', 5700, 8),
    ]);
    expect(f.flag).toBe('accumulating');
    expect(f.rpe_delta).toBeGreaterThanOrEqual(1);
  });

  it('does not flag effort climbing ALONGSIDE tonnage', () => {
    // A client getting closer to their limit on rising loads is the point of
    // a training block, not a warning.
    const wk = (week, volume_kg, mean_rpe) =>
      ({ week, sets: 20, sessions: 3, volume_kg, mean_rpe, sparse: false });
    const f = fatigueSignal([
      wk('2026-W30', 5000, 6), wk('2026-W31', 5500, 6.5),
      wk('2026-W32', 6200, 7.5), wk('2026-W33', 7000, 8),
    ]);
    expect(f.flag).toBe('none');
  });
});

describe('weekly volume', () => {
  it('groups by ISO week, so a Monday and a Tuesday are the same week', () => {
    expect(isoWeek('2026-08-19')).toBe(isoWeek('2026-08-20'));
    expect(isoWeek('2026-08-19')).not.toBe(isoWeek('2026-08-27'));
  });

  it('flags a week too thin to read as a training week', () => {
    const weeks = weeklyVolume([set({ session_date: '2026-08-19' })]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0].sparse).toBe(true);
  });
});

describe('LIVE — the best-logged client in the database', () => {
  // Production rows for the client with the most logged sets (77 across 5
  // sessions). Kept as a fixture because it is the shape the engine will
  // actually meet: loads on most sets, reps missing on a few, RPE on none,
  // and one prescribed set that was never done.
  const rows = [
    ['Bench Press', null, null, false, '2026-08-11'],
    ...Array.from({ length: 3 }, () => ['Shoulder Press', 20, 10, true, '2026-08-19']),
    ...Array.from({ length: 3 }, () => ['Tricep Pushdown', 35, 10, true, '2026-08-19']),
    ...Array.from({ length: 3 }, () => ['Preacher Curl', 50, 10, true, '2026-08-19']),
    ...Array.from({ length: 3 }, () => ['Bench Press', 35, 10, true, '2026-08-20']),
    ...Array.from({ length: 3 }, () => ['Crunches', null, 20, true, '2026-08-20']),
    ...Array.from({ length: 3 }, () => ['Shoulder Press', 12.5, 10, true, '2026-08-25']),
    ...Array.from({ length: 3 }, () => ['Tricep Pushdown', 35, 10, true, '2026-08-25']),
    ...Array.from({ length: 3 }, () => ['Seated Leg Curl', 80, 10, true, '2026-08-27']),
  ].map(([exercise_name, weight_kg, reps, completed, session_date]) =>
    ({ exercise_name, weight_kg, reps, rpe: null, rir: null, completed, session_date }));

  const h = buildTrainingHistory({ sets: rows, assignment: { prescribed: 8, completed: 5 } });

  it('reads the history that was there all along', () => {
    expect(h.has_history).toBe(true);
    expect(h.totals.sets).toBe(24);
    expect(h.totals.sets_not_completed).toBe(1);
    expect(h.totals.volume_kg).toBeGreaterThan(0);
  });

  it('makes no progression call on this client, and says why', () => {
    // The point of the LIVE fixture. This is the studio's BEST-logged client
    // and not one exercise has three sessions — so there is no trend to
    // report, and the engine says so rather than inventing one.
    //
    // Shoulder Press went 20kg to 12.5kg here, which looks like regression
    // and may well be one. With two sessions it is equally a deload, a
    // different machine, or a typo. The loop will catch it on the third.
    expect(h.confidence.exercises_with_trend).toBe(0);
    expect(h.confidence.enough_for_progression_calls).toBe(false);
    expect(h.plateaued).toEqual([]);
    expect(h.regressing).toEqual([]);
    for (const e of h.exercises) expect(e.trend).toBeNull();
  });

  it('still answers the questions it CAN answer', () => {
    // A conservative engine is not a silent one. Adherence, volume, what was
    // skipped and what the client last lifted are all answerable from two
    // sessions, and all of them are programming input.
    expect(h.adherence.pct).toBe(63);
    expect(h.adherence.missed).toBe(3);
    const shoulders = h.exercises.find((e) => e.exercise === 'Shoulder Press');
    expect(shoulders.sessions).toBe(2);
    expect(shoulders.latest_e1rm_kg).toBe(estimate1RM(12.5, 10));
    expect(h.weeks.length).toBeGreaterThan(0);
  });
});

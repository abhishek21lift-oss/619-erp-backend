'use strict';

// Naming the exact workout a client does next.
//
// The property that matters most here is that this resolver and the session
// log cannot disagree. Both go through progression.resolveWeek, so the last
// block of tests checks the two against each other on the same rows rather
// than asserting a number this file computed for itself.

const { nextSession, describeNextSession, UNRESOLVED, planDaysOf, coveredDayOf, addDays } = require('../modules/pt-os/next-session');
const { resolveWeek } = require('../modules/pt-os/progression');

// Mon / Wed / Fri, three exercises on each, starting Monday 3 August 2026.
const PLAN = {
  id: 'a1', plan_id: 'p1', plan_name: 'Upper/Lower', start_date: '2026-08-03',
  duration_weeks: 8, progression_type: 'weight', progression_amount: 2.5,
  progression_every_weeks: 1,
};

const rows = (day, week = 1, over = {}) => [
  { day_of_week: day, week_number: week, sort_order: 1, exercise_id: 'e1', name: 'Barbell Squat', sets: 3, reps: 8, target_weight: 60, ...over },
  { day_of_week: day, week_number: week, sort_order: 2, exercise_id: 'e2', name: 'Bench Press', sets: 3, reps: 8, target_weight: 40, ...over },
];

const PLAN_ROWS = [...rows(1), ...rows(3), ...rows(5)];

const session = (date, over = {}) => ({
  id: `s-${date}`, status: 'completed', session_date: date,
  workout_assignment_id: 'a1', ...over,
});

describe('states it refuses to guess at', () => {
  it('no assignment is no programme, not an empty week', () => {
    const n = nextSession({ assignment: null, today: '2026-08-05' });
    expect(n.resolvable).toBe(false);
    expect(n.reason).toBe(UNRESOLVED.NO_PROGRAMME);
  });

  it('an expired block is its own state, not "no programme"', () => {
    const n = nextSession({ assignment: PLAN, planRows: PLAN_ROWS, today: '2027-01-01', expired: true });
    expect(n.reason).toBe(UNRESOLVED.EXPIRED);
  });

  it('a plan with no days refuses rather than inventing one', () => {
    const n = nextSession({ assignment: PLAN, planRows: [], today: '2026-08-05' });
    expect(n.resolvable).toBe(false);
    expect(n.reason).toBe(UNRESOLVED.NO_DAYS);
    // Still says WHICH plan, so a trainer can go and fix it.
    expect(n.plan_name).toBe('Upper/Lower');
  });

  it('refuses rather than rolling past the end of the block', () => {
    // Week 8 of 8, every prescribed day done.
    const n = nextSession({
      assignment: PLAN,
      planRows: PLAN_ROWS,
      // Week 8 runs 2026-09-21 to 2026-09-27.
      sessions: [session('2026-09-21'), session('2026-09-23'), session('2026-09-25')],
      today: '2026-09-26',
    });
    expect(n.resolvable).toBe(false);
    expect(n.reason).toBe(UNRESOLVED.BLOCK_COMPLETE);
    expect(n.week).toBe(8);
  });
});

describe('which day comes next', () => {
  it('is the first prescribed day when nothing has been trained', () => {
    const n = nextSession({ assignment: PLAN, planRows: PLAN_ROWS, sessions: [], today: '2026-08-05' });
    expect(n.resolvable).toBe(true);
    expect(n.day).toBe('Monday');
    expect(n.week).toBe(1);
    expect(n.planned_days).toEqual(['Monday', 'Wednesday', 'Friday']);
  });

  // The rule that is easy to get wrong: a client who missed Monday and opens
  // this on Wednesday is owed MONDAY. Skipping to the nearest day would quietly
  // drop a session out of the block every time somebody missed one.
  it('owes a missed day rather than jumping to today', () => {
    const n = nextSession({
      assignment: PLAN, planRows: PLAN_ROWS, sessions: [], today: '2026-08-05', // a Wednesday
    });
    expect(n.day).toBe('Monday');
  });

  it('moves on once a day is completed', () => {
    const n = nextSession({
      assignment: PLAN, planRows: PLAN_ROWS,
      sessions: [session('2026-08-03', { workout_day: 'Monday' })],
      today: '2026-08-05',
    });
    expect(n.day).toBe('Wednesday');
    expect(n.completed_days_this_week).toEqual(['Monday']);
    expect(n.starts_next_week).toBe(false);
  });

  it('rolls into next week once the week is done, and says so', () => {
    const n = nextSession({
      assignment: PLAN, planRows: PLAN_ROWS,
      sessions: [session('2026-08-03'), session('2026-08-05'), session('2026-08-07')],
      today: '2026-08-08',
    });
    expect(n.week).toBe(2);
    expect(n.day).toBe('Monday');
    expect(n.starts_next_week).toBe(true);
  });

  it('counts a session by the weekday it fell on when the log named none', () => {
    // 2026-08-05 is a Wednesday and the row has no workout_day.
    const n = nextSession({
      assignment: PLAN, planRows: PLAN_ROWS,
      sessions: [session('2026-08-03'), session('2026-08-05')],
      today: '2026-08-06',
    });
    expect(n.completed_days_this_week).toEqual(['Monday', 'Wednesday']);
    expect(n.day).toBe('Friday');
  });

  it('does not count an unfinished session as a session', () => {
    const n = nextSession({
      assignment: PLAN, planRows: PLAN_ROWS,
      sessions: [session('2026-08-03', { status: 'in_progress' })],
      today: '2026-08-04',
    });
    expect(n.day).toBe('Monday');
    expect(n.completed_days_this_week).toEqual([]);
  });

  // A session logged against a DIFFERENT plan is not this plan's Monday.
  // Counting it would tell the trainer their client had already trained.
  it('ignores a session attributed to another assignment', () => {
    const n = nextSession({
      assignment: PLAN, planRows: PLAN_ROWS,
      sessions: [session('2026-08-03', { workout_assignment_id: 'other' })],
      today: '2026-08-04',
    });
    expect(n.day).toBe('Monday');
  });

  // Programme weeks run from the START DATE, not Monday to Sunday. A plan that
  // began on a Thursday has weeks running Thursday to Wednesday, and counting
  // completions in calendar weeks would credit sessions to the wrong one.
  it('counts completions in programme weeks, not calendar weeks', () => {
    const thursdayPlan = { ...PLAN, start_date: '2026-08-06' };
    const n = nextSession({
      assignment: thursdayPlan, planRows: PLAN_ROWS,
      // 2026-08-07 is the Friday inside programme week 1 (Aug 6-12).
      sessions: [session('2026-08-07', { workout_day: 'Friday' })],
      today: '2026-08-10', // the Monday AFTER it, still programme week 1
    });
    expect(n.week).toBe(1);
    expect(n.week_starts_on).toBe('2026-08-06');
    expect(n.completed_days_this_week).toEqual(['Friday']);
    // Monday and Wednesday of THIS programme week are still owed.
    expect(n.day).toBe('Monday');
  });
});

describe('the prescription it hands back', () => {
  it('is exactly what resolveWeek gives the session log for the same rows', () => {
    const n = nextSession({
      assignment: PLAN, planRows: PLAN_ROWS,
      sessions: [session('2026-08-03'), session('2026-08-05'), session('2026-08-07')],
      today: '2026-08-12', // programme week 2, Wednesday
    });
    const mondayRows = PLAN_ROWS.filter((r) => r.day_of_week === 1);
    const direct = resolveWeek(mondayRows, PLAN, n.week);
    expect(n.exercises.map((e) => e.target_weight))
      .toEqual(direct.exercises.map((e) => e.target_weight));
    expect(n.source).toBe(direct.source);
    expect(n.anchor_week).toBe(direct.anchor_week);
  });

  it('progresses a derived week rather than repeating week 1', () => {
    const n = nextSession({
      assignment: PLAN, planRows: PLAN_ROWS,
      sessions: [session('2026-08-03'), session('2026-08-05'), session('2026-08-07')],
      today: '2026-08-10',
    });
    expect(n.week).toBe(2);
    // +2.5 kg a week, one step in.
    expect(n.exercises[0].target_weight).toBe(62.5);
    expect(n.source).toBe('derived');
  });

  it('prefers a week the trainer wrote by hand, and says it is an override', () => {
    const withOverride = [
      ...PLAN_ROWS,
      ...rows(1, 2, { target_weight: 100, sets: 5 }),
    ];
    const n = nextSession({
      assignment: PLAN, planRows: withOverride,
      sessions: [session('2026-08-03'), session('2026-08-05'), session('2026-08-07')],
      today: '2026-08-10',
    });
    expect(n.week).toBe(2);
    expect(n.source).toBe('override');
    expect(n.exercises[0].target_weight).toBe(100);
  });

  it('sees a day the trainer only added in a later week', () => {
    // Saturday exists only in week 3. planDaysOf reads every week, so it is
    // part of the programme's shape.
    const withSaturday = [...PLAN_ROWS, ...rows(6, 3)];
    expect(planDaysOf(withSaturday)).toEqual([1, 3, 5, 6]);
  });
});

describe('the parts', () => {
  it('reads a named workout day, and falls back to the date', () => {
    expect(coveredDayOf({ workout_day: 'Friday' })).toBe(5);
    expect(coveredDayOf({ session_date: '2026-08-05' })).toBe(3); // a Wednesday
    expect(coveredDayOf({ session_date: '2026-08-09' })).toBe(7); // a Sunday
    expect(coveredDayOf({})).toBeNull();
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-08-30', 7)).toBe('2026-09-06');
  });

  it('handles a DATE the driver parsed into a Date object', () => {
    const n = nextSession({
      assignment: { ...PLAN, start_date: new Date('2026-08-03T00:00:00Z') },
      planRows: PLAN_ROWS, sessions: [], today: '2026-08-17',
    });
    // Three weeks in, not week 1 — which is what a raw String(date).slice
    // would have produced.
    expect(n.week).toBe(3);
  });
});

describe('what the model is told', () => {
  it('names the plan, the week, the day and every prescribed number', () => {
    const text = describeNextSession(nextSession({
      assignment: PLAN, planRows: PLAN_ROWS, sessions: [], today: '2026-08-03',
    }));
    expect(text).toContain('Upper/Lower, week 1 of 8, Monday');
    expect(text).toContain('Barbell Squat: 3 sets x 8 @ 60 kg');
    expect(text).toContain('Prescribed days: Monday, Wednesday, Friday');
  });

  it('says an override is an instruction rather than a suggestion', () => {
    const text = describeNextSession(nextSession({
      assignment: PLAN,
      planRows: [...PLAN_ROWS, ...rows(1, 2, { target_weight: 100 })],
      sessions: [session('2026-08-03'), session('2026-08-05'), session('2026-08-07')],
      today: '2026-08-10',
    }));
    expect(text).toMatch(/written by the trainer by hand/);
  });

  it('says WHY it could not resolve one, rather than going quiet', () => {
    for (const reason of Object.values(UNRESOLVED)) {
      const text = describeNextSession({ resolvable: false, reason });
      expect(text).toContain('THE NEXT SESSION IN THE CURRENT PROGRAMME:');
      // Every state has words of its own — no shared fallback sentence.
      expect(text).not.toMatch(/Could not be resolved\./);
    }
  });
});

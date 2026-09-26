'use strict';
// The pure rules behind goals, guided workouts and the recap: projections,
// progress and input validation. No database.

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const {
  projectTrend, projectSessions, progressPct, normaliseGoal, fitLine,
} = require('../modules/client-portal/member-goals.service');
const { normaliseWorkout } = require('../modules/client-portal/member-training.service');
const { monthRange, previousMonth } = require('../modules/client-portal/member-recap.service');

const NOW = '2026-09-26';

describe('projectTrend', () => {
  const losing = [
    { date: '2026-08-01', value: 80 },
    { date: '2026-08-15', value: 79 },
    { date: '2026-08-29', value: 78 },
    { date: '2026-09-12', value: 77 },
    { date: '2026-09-26', value: 76 },
  ];

  it('projects the date the line reaches the target', () => {
    // 1 kg per 14 days; 76 → 72 is 56 days.
    const p = projectTrend(losing, 72, NOW);
    expect(p.eta).toBe('2026-11-21');
    expect(p.per_week).toBe(-0.5);
  });

  it('offers no date when the trend moves away from the target', () => {
    expect(projectTrend(losing, 85, NOW)).toMatchObject({ eta: null, reason: 'off_trend' });
  });

  it('asks for more readings rather than guessing', () => {
    expect(projectTrend(losing.slice(-2), 72, NOW)).toMatchObject({ eta: null, reason: 'more_data', needed: 1 });
  });

  it('ignores readings older than the window', () => {
    const old = [{ date: '2025-01-01', value: 100 }, ...losing.slice(-2)];
    expect(projectTrend(old, 72, NOW).reason).toBe('more_data');
  });

  it('needs the readings to span enough time', () => {
    const bunched = [
      { date: '2026-09-24', value: 77 }, { date: '2026-09-25', value: 76.5 }, { date: '2026-09-26', value: 76 },
    ];
    expect(projectTrend(bunched, 72, NOW).reason).toBe('more_time');
  });

  it('refuses a projection years away', () => {
    const slow = [
      { date: '2026-07-01', value: 80 }, { date: '2026-08-01', value: 79.99 }, { date: '2026-09-26', value: 79.98 },
    ];
    expect(projectTrend(slow, 60, NOW).reason).toBe('far');
  });
});

describe('projectSessions', () => {
  it('extends the pace since the goal was set', () => {
    // 6 sessions in 14 days → 3 a week; 14 more take 33 days.
    expect(projectSessions(6, 20, '2026-09-13', NOW)).toMatchObject({ eta: '2026-10-29', per_week: 3 });
  });

  it('waits a week before judging a new goal', () => {
    expect(projectSessions(1, 20, '2026-09-24', NOW).reason).toBe('more_time');
  });

  it('is done when the count is reached', () => {
    expect(projectSessions(20, 20, '2026-08-01', NOW).eta).toBe(NOW);
  });
});

describe('progressPct', () => {
  it('works in both directions and clamps', () => {
    expect(progressPct(80, 77, 74)).toBe(50);
    expect(progressPct(60, 70, 80)).toBe(50);
    expect(progressPct(80, 82, 74)).toBe(0);
    expect(progressPct(60, 90, 80)).toBe(100);
    expect(progressPct(null, 70, 80)).toBeNull();
  });
});

describe('fitLine', () => {
  it('returns null for readings on one day', () => {
    expect(fitLine([{ date: NOW, value: 1 }, { date: NOW, value: 2 }])).toBeNull();
  });
});

describe('normaliseGoal', () => {
  it('accepts a lift goal and rounds the target', () => {
    expect(normaliseGoal({ kind: 'lift', exercise_name: ' Bench ', target_value: '82.46' }, NOW))
      .toEqual({ kind: 'lift', target: 82.5, exercise: 'Bench', targetDate: null });
  });

  it.each([
    [{ kind: 'nope', target_value: 5 }],
    [{ kind: 'weight', target_value: 10 }],
    [{ kind: 'sessions', target_value: 2.5 }],
    [{ kind: 'lift', target_value: 50 }],
    [{ kind: 'sessions', target_value: 10, target_date: NOW }],
    [{ kind: 'sessions', target_value: 10, target_date: '2031-01-01' }],
    [{ kind: 'sessions', target_value: 10, target_date: 'soon' }],
  ])('rejects %j', (body) => {
    expect(() => normaliseGoal(body, NOW)).toThrow();
  });
});

describe('normaliseWorkout', () => {
  const base = { request_id: 'abcdefgh-1234', exercises: [{ name: 'Row', sets: [{ weight_kg: 40, reps: 10 }] }] };

  it('keeps real sets and drops empty ones and empty exercises', () => {
    const w = normaliseWorkout({
      ...base,
      exercises: [
        { name: ' Row ', sets: [{ weight_kg: 40, reps: 10 }, { reps: 0 }, {}] },
        { name: 'Plank', sets: [{ duration_seconds: 60 }] },
        { name: 'Skipped', sets: [] },
      ],
    });
    expect(w.exercises).toEqual([
      { name: 'Row', sets: [{ weight_kg: 40, reps: 10, duration_seconds: null }] },
      { name: 'Plank', sets: [{ weight_kg: null, reps: null, duration_seconds: 60 }] },
    ]);
  });

  it.each([
    [{ ...base, request_id: 'bad id!' }],
    [{ ...base, exercises: [] }],
    [{ ...base, exercises: [{ name: '', sets: [{ reps: 1 }] }] }],
    [{ ...base, exercises: [{ name: 'Row', sets: [{ reps: 2.5 }] }] }],
    [{ ...base, exercises: [{ name: 'Row', sets: [{ weight_kg: 5000, reps: 1 }] }] }],
    [{ ...base, exercises: Array.from({ length: 31 }, () => base.exercises[0]) }],
    [{ ...base, duration_minutes: 0 }],
  ])('rejects %#', (body) => {
    expect(() => normaliseWorkout(body)).toThrow();
  });
});

describe('recap months', () => {
  it('bounds a month and wraps the year', () => {
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', next: '2027-01-01' });
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(() => monthRange('2026-1')).toThrow();
  });
});

'use strict';
// The member self-log keeps the effort, rest and notes the member recorded.
//
// workout_sets has carried rpe, rir, tempo, rest_seconds and notes since
// migration 068, and the trainer's log writes all five. The member path wrote
// weight, reps and duration only, so an autoregulated set arrived at the
// trainer as a bare number: no effort, no rest, no note saying the shoulder
// hurt. The prescription columns added in 258 make the same set comparable to
// what was prescribed, but only if the member side keeps them.

const mockQueries = [];
let mockResponder = () => ({ rows: [] });

jest.mock('../db/pool', () => {
  const query = jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    return mockResponder(flat, params || []);
  });
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

jest.mock('../modules/pt-os/workout-log.service', () => ({
  computePrFlags: jest.fn(async () => ({ is_pr_weight: false, is_pr_reps: false, is_pr_volume: false })),
  recomputeAssignmentProgress: jest.fn(async () => {}),
}));

const { logMyWorkout, normaliseWorkout, TrainingInputError } = require('../modules/client-portal/member-training.service');

const CLIENT = 'cl-1';
const ORG = '11111111-1111-4111-8111-111111111111';

const body = (over = {}) => ({
  request_id: 'req-12345678',
  exercises: [{
    name: 'Barbell Squat',
    notes: 'Knees track out',
    sets: [{
      weight_kg: 100, reps: 5, rpe: 8.5, rir: 2, tempo: '3-1-1-0',
      rest_seconds: 180, notes: 'felt heavy',
    }],
  }],
  ...over,
});

beforeEach(() => {
  mockQueries.length = 0;
  mockResponder = (sql) => {
    if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: true }] };
    if (/COUNT\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 0 }] };
    if (/FROM workout_sessions WHERE client_id/.test(sql)) return { rows: [] };
    if (/INSERT INTO workout_sessions/.test(sql)) return { rows: [{ id: 's1' }] };
    if (/SELECT DISTINCT ON/.test(sql)) return { rows: [] };
    if (/INSERT INTO workout_session_exercises/.test(sql)) return { rows: [{ id: 'se1' }] };
    return { rows: [] };
  };
});

describe('normaliseWorkout', () => {
  it('keeps per-set effort, rest and notes', () => {
    const w = normaliseWorkout(body());
    expect(w.exercises[0].sets[0]).toEqual({
      weight_kg: 100, reps: 5, duration_seconds: null, distance_m: null,
      rpe: 8.5, rir: 2, tempo: '3-1-1-0', rest_seconds: 180, notes: 'felt heavy',
    });
  });

  it('keeps the exercise note', () => {
    expect(normaliseWorkout(body()).exercises[0].notes).toBe('Knees track out');
  });

  it('refuses an RPE outside the scale rather than storing it', () => {
    const bad = body();
    bad.exercises[0].sets[0].rpe = 12;
    expect(() => normaliseWorkout(bad)).toThrow(TrainingInputError);
  });

  it('still accepts a set with no effort recorded', () => {
    const bare = body();
    bare.exercises[0].sets[0] = { weight_kg: 60, reps: 10 };
    const s = normaliseWorkout(bare).exercises[0].sets[0];
    expect(s.rpe).toBeNull();
    expect(s.rir).toBeNull();
  });
});

describe('logMyWorkout', () => {
  it('writes the five set columns and the exercise note', async () => {
    const out = await logMyWorkout(CLIENT, ORG, 'u-1', body());
    expect(out.created).toBe(true);

    const exercise = mockQueries.find((q) => /INSERT INTO workout_session_exercises/.test(q.sql));
    expect(exercise.sql).toContain('notes');
    expect(exercise.params[4]).toBe('Knees track out');

    const set = mockQueries.find((q) => /INSERT INTO workout_sets/.test(q.sql));
    expect(set.sql).toContain('rpe, rir, tempo, rest_seconds, notes');
    // Positional params after the ten the old statement wrote.
    expect(set.params.slice(10)).toEqual([8.5, 2, '3-1-1-0', 180, 'felt heavy']);
  });

  it('writes nulls, not zeros, when nothing was recorded', async () => {
    const bare = body();
    bare.exercises[0].sets[0] = { weight_kg: 60, reps: 10 };
    await logMyWorkout(CLIENT, ORG, 'u-1', bare);

    const set = mockQueries.find((q) => /INSERT INTO workout_sets/.test(q.sql));
    expect(set.params.slice(10)).toEqual([null, null, null, null, null]);
  });
});

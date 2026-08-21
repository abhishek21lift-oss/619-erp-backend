// Cardio actuals on the legacy Workout Log (migration 179).
//
// The legacy logger spent its whole life strength-only: workout_sets had
// weight/reps/RPE/RIR and nothing else, so a logged treadmill run had nowhere
// to put its numbers. The columns now mirror the Training OS
// cardio_performances vocabulary, and the session detail response carries the
// exercise's type + allowed prescription modes so the UI knows which fields
// to render instead of guessing per name.
//
// Pinned here:
//   - POST set stores cardio actuals (duration seconds, distance WITH its
//     unit — the DB refuses a unitless distance — calories, cadence…).
//   - An unknown distance/speed unit is rejected by validation, not stored
//     to fail later on read.
//   - PATCH can set and clear cardio fields independently of weight/reps.
//   - Session detail exposes exercise_type/prescription_mode_* per exercise,
//     which is the entire contract the mode-driven set row renders from.

const request = require('supertest');

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = global.__mockUser; next(); },
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
}));
jest.mock('../middleware/rbac', () => ({ requireRole: () => (_req, _res, next) => next() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

const pool = require('../db/pool');

function app() {
  const express = require('express');
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));
  return a;
}

const EX_ROW = {
  rows: [{ exercise_id: 'ex-cardio-1', exercise_name: 'Running, Treadmill', client_id: 'c-1' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  global.__mockUser = { id: 'u-1', role: 'admin', organization_id: 'org-1' };
});

const insertCall = () =>
  pool.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO workout_sets'));

const updateCall = () =>
  pool.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE workout_sets'));

describe('POST /workout-log/exercises/:id/sets — cardio actuals', () => {
  it('stores duration, distance+unit, calories and cadence', async () => {
    pool.query
      .mockResolvedValueOnce(EX_ROW)
      .mockResolvedValueOnce({ rows: [{ id: 'set-1' }] });

    await request(app())
      .post('/api/pt-os/workout-log/exercises/wse-1/sets')
      .send({
        set_number: 1,
        completed: false,
        duration_seconds: 1800,
        distance: 5.03,
        distance_unit: 'km',
        calories_burned: 320,
        cadence: 88,
      })
      .expect(201);

    const params = insertCall()[1];
    expect(params).toContain(1800);       // duration_seconds
    expect(params).toContain(5.03);       // distance
    expect(params).toContain('km');       // distance_unit travels with it
    expect(params).toContain(320);        // calories_burned
    expect(params).toContain(88);         // cadence
  });

  it('keeps strength sets cardio-clean — omitted fields persist as NULL', async () => {
    pool.query
      .mockResolvedValueOnce(EX_ROW)
      .mockResolvedValueOnce({ rows: [{ id: 'set-2' }] });

    await request(app())
      .post('/api/pt-os/workout-log/exercises/wse-1/sets')
      .send({ set_number: 1, weight_kg: 80, reps: 5 })
      .expect(201);

    const [sql, params] = insertCall();
    // Every cardio column still gets an explicit slot in the INSERT…
    for (const col of ['duration_seconds', 'steps_completed', 'rounds_completed']) {
      expect(sql).toContain(col);
    }
    // …filled with nulls when the caller said nothing about them.
    expect(params.slice(10, 21)).toEqual(new Array(11).fill(null));
  });

  it('rejects an unknown distance unit at validation, not at read time', async () => {
    await request(app())
      .post('/api/pt-os/workout-log/exercises/wse-1/sets')
      .send({ set_number: 1, distance: 5, distance_unit: 'furlongs' })
      .expect(400);
    expect(insertCall()).toBeUndefined();
  });
});

describe('PATCH /workout-log/sets/:id — cardio fields', () => {
  const EXISTING = {
    rows: [{
      id: 'set-1', weight_kg: null, reps: null, rpe: null, rir: null, tempo: null,
      rest_seconds: null, completed: false, notes: null,
      duration_seconds: null, distance: null, distance_unit: null, average_speed: null,
      speed_unit: null, calories_burned: null, average_heart_rate: null, cadence: null,
      steps_completed: null, floors_completed: null, rounds_completed: null,
      is_pr_weight: false, is_pr_reps: false, is_pr_volume: false,
      exercise_id: 'ex-cardio-1', exercise_name: 'Running, Treadmill', client_id: 'c-1',
    }],
  };

  it('sets speed with its unit', async () => {
    pool.query
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce({ rows: [{ id: 'set-1' }] });

    await request(app())
      .patch('/api/pt-os/workout-log/sets/set-1')
      .send({ average_speed: 12.5, speed_unit: 'kmh' })
      .expect(200);

    const [sql, params] = updateCall();
    expect(sql).toContain('average_speed =');
    expect(sql).toContain('speed_unit =');
    expect(params).toContain(12.5);
    expect(params).toContain('kmh');
  });

  it('clears a cardio field without touching weight/reps', async () => {
    pool.query
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce({ rows: [{ id: 'set-1' }] });

    await request(app())
      .patch('/api/pt-os/workout-log/sets/set-1')
      .send({ duration_seconds: null })
      .expect(200);

    const [sql] = updateCall();
    expect(sql).toContain('duration_seconds =');
    expect(sql).not.toContain('weight_kg =');
  });
});

describe('GET /workout-log/sessions/:id — prescription contract', () => {
  it('returns each exercise with its type and allowed modes', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 's-1', workout_assignment_id: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'wse-1', session_id: 's-1', exercise_name: 'Rowing, Stationary',
          exercise_type: 'Cardio',
          prescription_mode_primary: 'TIME_DISTANCE',
          prescription_mode_allowed: ['TIME', 'DISTANCE', 'TIME_DISTANCE'],
          sets: [{ id: 'set-9', set_number: 1, weight_kg: null, reps: null, completed: false,
                   duration_seconds: 6000, distance: 2000, distance_unit: 'm' }],
        }],
      });

    const res = await request(app()).get('/api/pt-os/workout-log/sessions/s-1').expect(200);

    const ex = res.body.data.exercises[0];
    expect(ex.exercise_type).toBe('Cardio');
    expect(ex.prescription_mode_primary).toBe('TIME_DISTANCE');
    expect(ex.prescription_mode_allowed).toContain('DISTANCE');
    // A cardio set contributes no volume and no PR noise to the summary.
    expect(res.body.data.summary.total_volume).toBe(0);
    expect(res.body.data.summary.total_reps).toBe(0);
  });
});

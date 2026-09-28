// A programme's shape — what the New programme sheet writes — must be true of
// the programme. The audit that prompted this (28 Sep) found:
//
//   · every client programme stored as a TEMPLATE, because the create route
//     read an absent is_template as true and the sheet never sent one;
//   · an assignment's end date always NULL, so a 4-week plan stayed active
//     forever — on the Today roster and linked by every logged session;
//   · a goal or difficulty outside the CHECK surfacing as a 500;
//   · no strength goal at all.
//
// sessions_per_week following the programmed days is a database trigger
// (migration 219); these tests cover the routes.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => {
  const query = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  adminManagerOrTrainer: (_req, _res, next) => next(),
}));
jest.mock('../lib/screeningGate', () => ({
  checkScreeningGate: jest.fn(async () => ({ blocked: null, warnings: [] })),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { shapeError, PLAN_GOALS } = require('../lib/workoutPlanShape');

const app = express();
app.use(express.json());
app.use('/api/workouts', require('../routes/workouts'));

const ORG = '11111111-1111-1111-1111-111111111111';
const TRAINER = { id: 'u-t', role: 'trainer', organization_id: ORG, trainer_id: 't-1' };

const flat = (s) => String(s).replace(/\s+/g, ' ');
const callFor = (re) => pool.query.mock.calls.find(([s]) => re.test(flat(s)));

beforeEach(() => {
  mockUser = TRAINER;
  pool.query.mockReset();
});

describe('POST /plans', () => {
  beforeEach(() => {
    pool.query.mockImplementation(async (sql) => (
      /INSERT INTO workout_plans/.test(flat(sql))
        ? { rows: [{ id: 'p1', name: 'Meet prep' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    ));
  });

  it('stores a programme as NOT a template unless asked', async () => {
    await request(app).post('/api/workouts/plans')
      .send({ name: 'Meet prep', goal: 'strength', difficulty: 'advanced', duration_weeks: 12 })
      .expect(201);
    const [, params] = callFor(/INSERT INTO workout_plans/);
    expect(params[7]).toBe(false);
  });

  it('still stores a template when one is asked for', async () => {
    await request(app).post('/api/workouts/plans')
      .send({ name: 'Studio template', is_template: true })
      .expect(201);
    expect(callFor(/INSERT INTO workout_plans/)[1][7]).toBe(true);
  });

  it('accepts strength as a goal', async () => {
    await request(app).post('/api/workouts/plans')
      .send({ name: 'Meet prep', goal: 'strength' })
      .expect(201);
    expect(callFor(/INSERT INTO workout_plans/)[1][3]).toBe('strength');
  });

  it('refuses an unknown goal or difficulty with a 400, before touching the database', async () => {
    const r1 = await request(app).post('/api/workouts/plans').send({ name: 'X', goal: 'powerbuilding' }).expect(400);
    expect(r1.body.error).toMatch(/goal/);
    const r2 = await request(app).post('/api/workouts/plans').send({ name: 'X', difficulty: 'elite' }).expect(400);
    expect(r2.body.error).toMatch(/difficulty/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('POST /assign', () => {
  it('derives the end date from the programme length when none is sent', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = flat(sql);
      if (/SELECT wp\.id, wp\.duration_weeks FROM workout_plans/.test(s)) return { rows: [{ id: 'p1', duration_weeks: 4 }] };
      if (/SELECT 1 FROM pt_clients/.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/INSERT INTO workout_assignments/.test(s)) return { rows: [{ id: 'a1' }] };
      return { rows: [] };
    });

    await request(app).post('/api/workouts/assign')
      .send({ workout_plan_id: 'p1', client_id: 'c1', start_date: '2026-10-05' })
      .expect(201);

    const [sql, params] = callFor(/INSERT INTO workout_assignments/);
    // start + weeks*7 - 1: a 4-week block started Monday 5 Oct ends Sunday 1 Nov.
    expect(flat(sql)).toMatch(/COALESCE\(\$6::date, \$5::date \+ \(\$10::int \* 7 - 1\)\)/);
    expect(params[4]).toBe('2026-10-05');
    expect(params[5]).toBeNull();
    expect(params[9]).toBe(4);
  });
});

describe('PUT /plans/:id', () => {
  const routed = (before, after) => async (sql) => {
    const s = flat(sql);
    if (/SELECT wp\.\* FROM workout_plans wp/.test(s)) return { rows: [before] };
    if (/UPDATE workout_plans SET name = COALESCE/.test(s)) return { rows: [after] };
    return { rows: [], rowCount: 0 };
  };

  it('moves the end date of running assignments when the length changes', async () => {
    pool.query.mockImplementation(routed(
      { id: 'p1', organization_id: ORG, duration_weeks: 4 },
      { id: 'p1', organization_id: ORG, duration_weeks: 6 },
    ));
    await request(app).put('/api/workouts/plans/p1').send({ duration_weeks: 6 }).expect(200);

    const call = callFor(/UPDATE workout_assignments SET end_date = start_date/);
    expect(call).toBeTruthy();
    // Only active rows whose end is still the one the OLD length derived: a
    // trainer-set end date and an open-ended (NULL) one both stay put.
    expect(flat(call[0])).toMatch(/end_date = start_date \+ \(\$2::int \* 7 - 1\)/);
    expect(flat(call[0])).toMatch(/status = 'active'/);
    // uuid, not text: organization_id is a uuid column and uuid = text has
    // no operator — the edit 500'd.
    expect(flat(call[0])).toMatch(/organization_id = \$4::uuid/);
    expect(call[1]).toEqual(['p1', 4, 6, ORG]);
  });

  it('leaves assignments alone when the length did not change', async () => {
    pool.query.mockImplementation(routed(
      { id: 'p1', organization_id: ORG, duration_weeks: 4 },
      { id: 'p1', organization_id: ORG, duration_weeks: 4, name: 'Renamed' },
    ));
    await request(app).put('/api/workouts/plans/p1').send({ name: 'Renamed' }).expect(200);
    expect(callFor(/UPDATE workout_assignments/)).toBeUndefined();
  });

  it('refuses a bad goal on edit too', async () => {
    await request(app).put('/api/workouts/plans/p1').send({ goal: 'bulk' }).expect(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('shapeError', () => {
  it('knows the six goals the database allows', () => {
    expect(PLAN_GOALS).toEqual(['weight_loss', 'muscle_gain', 'strength', 'endurance', 'general_fitness', 'recovery']);
    for (const g of PLAN_GOALS) expect(shapeError({ goal: g })).toBeNull();
  });

  it('holds weeks to whole numbers within the progression engine\'s range', () => {
    expect(shapeError({ duration_weeks: 0 })).toMatch(/duration_weeks/);
    expect(shapeError({ duration_weeks: 2.5 })).toMatch(/duration_weeks/);
    expect(shapeError({ duration_weeks: 105 })).toMatch(/duration_weeks/);
    expect(shapeError({ duration_weeks: '12' })).toBeNull();
  });
});

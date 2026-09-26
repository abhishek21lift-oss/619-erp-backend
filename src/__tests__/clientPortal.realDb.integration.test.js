'use strict';
// Every /api/me route, against a real migrated database.
//
// The member app's routes were only ever tested against a mocked pool, which
// returns whatever the fixture says whatever the SQL names. /api/me/profile
// selected `trainers.photo_url` — a column that exists in no migration and not
// in production — so it was a 500 for every member, and the member dashboard
// (the first screen after sign-in) showed nothing but "could not load your
// profile". Every mocked test passed.
//
// This runs each route's real SQL against the schema the migrations build, as
// a real member, so a column that does not exist fails here instead.
//
// Gated on RLS_TEST_DATABASE_URL, like the other real-database suites, and
// loud in CI if that is missing. Locally:
//   ./scripts/rls-proof-setup.sh
//   RLS_TEST_DATABASE_URL=postgres://postgres@localhost:55432/rls_proof npx jest clientPortal.realDb

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('/api/me against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the member portal schema check would skip.');
    });
  });
}

// The routes import the shared pool, which reads DATABASE_URL. Point it at the
// migrated database instead; `mock`-prefixed so jest allows the reference.
const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

// Unique to this suite. The real-database suites run in parallel against one
// database, so a studio id shared with another suite means each one's cleanup
// deletes rows the other still holds.
const ORG = 'c1e70000-0000-4000-8000-000000000174';
const CLIENT = 'me-int-client';
const USER = 'me-int-user';
const TRAINER = 'me-int-trainer';
const TRAINER_USER = 'me-int-trainer-user';
// A second client in the same studio with NO trainer assigned — the profile
// must fall back to the studio's own trainer for them.
const CLIENT_2 = 'me-int-client-2';
const SESSION = 'me-int-session';
const SESSION_EX = 'me-int-session-ex';

describeIf('/api/me against a real database', () => {
  let pool;
  let app;
  let asClient = CLIENT;

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Portal Studio', 'portal-int')
       ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(
      `INSERT INTO trainers (id, name, organization_id) VALUES ($1, 'Tara', $2)
       ON CONFLICT (id) DO NOTHING`, [TRAINER, ORG]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, email, organization_id, trainer_id, balance_amount)
       VALUES ($1, 'Mina', '+919000017401', 'mina@portal.test', $2, $3, 1500)
       ON CONFLICT (id) DO NOTHING`, [CLIENT, ORG, TRAINER]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, pt_client_id, is_active)
       VALUES ($1, 'Mina', 'mina@portal.test', '!not-a-hash', 'member', $2, $3, TRUE)
       ON CONFLICT (id) DO NOTHING`, [USER, ORG, CLIENT]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, trainer_id, is_active)
       VALUES ($1, 'Tara', 'tara@portal.test', '!not-a-hash', 'trainer', $2, $3, TRUE)
       ON CONFLICT (id) DO NOTHING`, [TRAINER_USER, ORG, TRAINER]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id)
       VALUES ($1, 'Nia', '+919000017402', $2) ON CONFLICT (id) DO NOTHING`, [CLIENT_2, ORG]);
    // The goal as the trainer sets it today — pt_goals, not pt_clients.goal.
    await pool.query(
      `INSERT INTO pt_goals (client_id, goal_type, priority_goal, is_active, organization_id)
       VALUES ($1, 'fat_loss', 'fat_loss', TRUE, $2)`, [CLIENT, ORG]);
    await pool.query(
      `INSERT INTO pt_payments (id, client_id, amount, payment_method, date, organization_id)
       VALUES ('me-int-pay', $1, 20000, 'CASH', CURRENT_DATE, $2) ON CONFLICT (id) DO NOTHING`, [CLIENT, ORG]);
    await pool.query(
      `INSERT INTO workout_sessions (id, client_id, session_date, program_name, workout_day,
                                     duration_minutes, status, notes, organization_id)
       VALUES ($1, $2, CURRENT_DATE, 'Strength base', 'Day 1', 55, 'completed',
               'INTERNAL: knee niggle, go easy', $3) ON CONFLICT (id) DO NOTHING`, [SESSION, CLIENT, ORG]);
    await pool.query(
      `INSERT INTO workout_session_exercises (id, session_id, exercise_name, sort_order)
       VALUES ($1, $2, 'Back squat', 1) ON CONFLICT (id) DO NOTHING`, [SESSION_EX, SESSION]);
    await pool.query(
      `INSERT INTO workout_sets (id, session_exercise_id, set_number, weight_kg, reps, completed, is_pr_weight)
       VALUES ('me-int-set-1', $1, 1, 60, 8, TRUE, FALSE),
              ('me-int-set-2', $1, 2, 65, 6, TRUE, TRUE)
       ON CONFLICT (id) DO NOTHING`, [SESSION_EX]);

    const express = require('express');
    app = express();
    app.use(express.json());
    // The mount's own guards (auth, requireClient) are covered elsewhere; this
    // suite is about the SQL, so the session is the member's, set directly.
    app.use('/api/me', (req, _res, next) => {
      req.user = { id: USER, role: 'member', organization_id: ORG, pt_client_id: asClient };
      next();
    }, require('../modules/client-portal/client-portal.routes'));
    // Surface the database error in the failure, not a bare 500.
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM weekly_checkins WHERE client_id = $1`, [CLIENT]);
    await pool.query(`DELETE FROM workout_sets WHERE session_exercise_id = $1`, [SESSION_EX]);
    await pool.query(`DELETE FROM workout_session_exercises WHERE id = $1`, [SESSION_EX]);
    await pool.query(`DELETE FROM workout_sessions WHERE id = $1`, [SESSION]);
    await pool.query(`DELETE FROM pt_payments WHERE id = 'me-int-pay'`);
    await pool.query(`DELETE FROM pt_goals WHERE client_id = $1`, [CLIENT]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, TRAINER_USER]]);
    await pool.query(`DELETE FROM pt_clients WHERE id = ANY($1)`, [[CLIENT, CLIENT_2]]);
    await pool.query(`DELETE FROM trainers WHERE id = $1`, [TRAINER]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await pool.end();
  });

  const request = () => require('supertest')(app);

  test.each([
    '/api/me/profile',
    '/api/me/membership',
    '/api/me/payments',
    '/api/me/attendance',
    '/api/me/measurements',
    '/api/me/workout',
    '/api/me/diet',
    '/api/me/checkins',
    '/api/me/sessions',
  ])('GET %s runs against the real schema', async (path) => {
    const res = await request().get(path);
    expect({ path, status: res.status, error: res.body.error }).toEqual({ path, status: 200, error: undefined });
  });

  test('the profile names the member and their trainer', async () => {
    const res = await request().get('/api/me/profile');
    expect(res.body.data).toMatchObject({ id: CLIENT, name: 'Mina', trainer_name: 'Tara', trainer_photo: null });
  });

  test('the profile goal is the active goal the trainer set, not the empty legacy field', async () => {
    const res = await request().get('/api/me/profile');
    expect(res.body.data.goal).toBe('fat_loss');
  });

  test('a client with no assigned trainer is shown the studio\'s trainer', async () => {
    asClient = CLIENT_2;
    try {
      const res = await request().get('/api/me/profile');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: CLIENT_2, trainer_name: 'Tara' });
    } finally {
      asClient = CLIENT;
    }
  });

  test('payments list the studio-recorded payment', async () => {
    const res = await request().get('/api/me/payments');
    expect(res.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'me-int-pay', payment_method: 'CASH', upi_order_id: null }),
    ]));
  });

  test('sessions show what was lifted, and never the trainer\'s notes', async () => {
    const res = await request().get('/api/me/sessions');
    const s = res.body.data.find((x) => x.id === SESSION);
    expect(s).toMatchObject({ program_name: 'Strength base', duration_minutes: 55, status: 'completed' });
    expect(s.exercises).toEqual([{
      name: 'Back squat',
      sets: [
        expect.objectContaining({ set_number: 1, weight_kg: 60, reps: 8, is_pr: false }),
        expect.objectContaining({ set_number: 2, weight_kg: 65, reps: 6, is_pr: true }),
      ],
    }]);
    expect(JSON.stringify(res.body)).not.toContain('INTERNAL');
  });

  test('POST /api/me/checkins writes this week, and a second send updates it', async () => {
    const first = await request().post('/api/me/checkins').send({ mood: 'good', weight: 70.5 });
    expect(first.status).toBe(201);
    const second = await request().post('/api/me/checkins').send({ mood: 'tired' });
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.mood).toBe('tired');
  });

  test('a check-in weight reaches the weight trend', async () => {
    await request().post('/api/me/checkins').send({ weight: 71.2 });
    const res = await request().get('/api/me/measurements');
    expect(res.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'checkin' }),
    ]));
    expect(Number(res.body.data.find((m) => m.source === 'checkin').weight_kg)).toBe(71.2);
  });
});

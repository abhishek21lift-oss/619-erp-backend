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

const ORG = '99999999-9999-4999-8999-999999999991';
const CLIENT = 'me-int-client';
const USER = 'me-int-user';
const TRAINER = 'me-int-trainer';

describeIf('/api/me against a real database', () => {
  let pool;
  let app;

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
       VALUES ($1, 'Mina', '+919000009001', 'mina@portal.test', $2, $3, 1500)
       ON CONFLICT (id) DO NOTHING`, [CLIENT, ORG, TRAINER]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, pt_client_id, is_active)
       VALUES ($1, 'Mina', 'mina@portal.test', '!not-a-hash', 'member', $2, $3, TRUE)
       ON CONFLICT (id) DO NOTHING`, [USER, ORG, CLIENT]);

    const express = require('express');
    app = express();
    app.use(express.json());
    // The mount's own guards (auth, requireClient) are covered elsewhere; this
    // suite is about the SQL, so the session is the member's, set directly.
    app.use('/api/me', (req, _res, next) => {
      req.user = { id: USER, role: 'member', organization_id: ORG, pt_client_id: CLIENT };
      next();
    }, require('../modules/client-portal/client-portal.routes'));
    // Surface the database error in the failure, not a bare 500.
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM weekly_checkins WHERE client_id = $1`, [CLIENT]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await pool.query(`DELETE FROM pt_clients WHERE id = $1`, [CLIENT]);
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
  ])('GET %s runs against the real schema', async (path) => {
    const res = await request().get(path);
    expect({ path, status: res.status, error: res.body.error }).toEqual({ path, status: 200, error: undefined });
  });

  test('the profile names the member and their trainer', async () => {
    const res = await request().get('/api/me/profile');
    expect(res.body.data).toMatchObject({ id: CLIENT, name: 'Mina', trainer_name: 'Tara', trainer_photo: null });
  });

  test('POST /api/me/checkins writes this week, and a second send updates it', async () => {
    const first = await request().post('/api/me/checkins').send({ mood: 'good', weight: 70.5 });
    expect(first.status).toBe(201);
    const second = await request().post('/api/me/checkins').send({ mood: 'tired' });
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.mood).toBe('tired');
  });
});

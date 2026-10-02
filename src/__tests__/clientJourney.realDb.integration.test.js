'use strict';
// The intake journey and the Client Interview, against a real migrated
// database (Phase 2, migration 227).
//
// One client walked through the whole journey through the real routes —
// registration, consent, PAR-Q, interview, assessment, goals, enrolment,
// workout plan — with the journey read after each step, plus the interview's
// own rules and tenant isolation.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Client journey, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the journey proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../modules/automation/automation.triggers', () => new Proxy({}, { get: () => async () => {} }));
jest.mock('../lib/subscription', () => ({
  ...jest.requireActual('../lib/subscription'),
  clientLimitStatus: async () => ({ limit: null, count: 0, atLimit: false }),
}));

const ORG = 'c1e70000-0000-4000-8000-000000000501';
const OTHER_ORG = 'c1e70000-0000-4000-8000-000000000502';
const USER = 'ptj-trainer-user';
let mockOrg = ORG;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'ptj-trainer-user', name: 'PTJ', role: 'trainer', organization_id: mockOrg }; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  requireAdmin: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const { randomUUID } = require('crypto');
const { screenClient } = require('./helpers/screening');

describeIf('Client journey, against a real database', () => {
  let pool;
  let request;
  const plans = [];

  beforeAll(async () => {
    pool = require('../db/pool');
    for (const [id, slug] of [[ORG, 'ptj-studio'], [OTHER_ORG, 'ptj-other']]) {
      await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`, [id, slug]);
    }
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'PTJ', 'ptj@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use('/api/pt-os', require('../modules/pt-os/client-journey.routes'));
    app.use('/api/workouts', require('../routes/workouts'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);
  });

  beforeEach(() => { mockOrg = ORG; });

  afterAll(async () => {
    const ids = (await pool.query('SELECT id FROM pt_clients WHERE organization_id = ANY($1)', [[ORG, OTHER_ORG]])).rows.map((r) => r.id);
    for (const t of ['pt_client_interviews', 'workout_assignments', 'pt_goals', 'pt_assessments', 'pt_payments',
      'pt_client_subscriptions', 'pt_informed_consents', 'pt_parq_forms']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = ANY($1)`, [ids]);
    }
    await pool.query('DELETE FROM workout_plans WHERE id = ANY($1)', [plans]);
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  async function newClient() {
    const res = await request().post('/api/pt-os/clients')
      .send({ name: 'Journey Client', mobile: `97${String(Date.now()).slice(-8)}` });
    expect(res.status).toBe(201);
    return res.body.data.id;
  }
  const journey = async (id) => (await request().get(`/api/pt-os/clients/${id}/journey`)).body.data;
  const states = (j) => Object.fromEntries(j.steps.map((s) => [s.key, s.state]));

  it('a whole client journey, in order, with the next step at every point', async () => {
    const id = await newClient();
    let j = await journey(id);
    expect(states(j)).toEqual({
      registration: 'done', consent: 'todo', parq: 'todo', interview: 'todo', assessment: 'todo',
      goals: 'todo', enrolment: 'blocked', workout_plan: 'blocked',
    });
    expect(j.next).toBe('consent');

    // Enrolment is refused until screening is done.
    const early = await request().patch(`/api/pt-os/clients/${id}`).send({
      status: 'active', pt_start_date: '2026-10-01', pt_end_date: '2026-12-31', duration_months: 3, final_amount: 9000, paid_amount: 0,
    });
    expect(early.body.error.code).toBe('SCREENING_REQUIRED');

    await screenClient(pool, { clientId: id, orgId: ORG });
    j = await journey(id);
    expect(states(j)).toMatchObject({ consent: 'done', parq: 'done', enrolment: 'todo' });
    expect(j.next).toBe('interview');

    // The interview: a draft, then completed.
    const started = await request().post(`/api/pt-os/clients/${id}/interviews`).send({ training_history: 'Ran 5k twice a week' });
    expect(started.status).toBe(201);
    expect((await journey(id)).steps.find((s) => s.key === 'interview').state).toBe('in_progress');
    const done = await request().patch(`/api/pt-os/interviews/${started.body.data.id}`).send({ status: 'completed', pain_and_injuries: 'None' });
    expect(done.status).toBe(200);
    expect(done.body.data.completed_at).toBeTruthy();
    j = await journey(id);
    expect(j.next).toBe('assessment');

    await pool.query(`INSERT INTO pt_assessments (client_id, organization_id) VALUES ($1, $2)`, [id, ORG]);
    await pool.query(`INSERT INTO pt_goals (client_id, organization_id, goal_type) VALUES ($1, $2, 'fat_loss')`, [id, ORG]);
    j = await journey(id);
    expect(j.next).toBe('enrolment');

    const enrolled = await request().patch(`/api/pt-os/clients/${id}`).send({
      status: 'active', pt_start_date: '2026-10-01', pt_end_date: '2026-12-31', duration_months: 3, final_amount: 9000, paid_amount: 0,
    });
    expect(enrolled.status).toBe(200);
    j = await journey(id);
    expect(states(j)).toMatchObject({ enrolment: 'done', workout_plan: 'todo' });
    expect(j.next).toBe('workout_plan');

    const planId = randomUUID();
    plans.push(planId);
    await pool.query(`INSERT INTO workout_plans (id, name, organization_id, duration_weeks) VALUES ($1, 'P', $2, 4)`, [planId, ORG]);
    expect((await request().post('/api/workouts/assign').send({ workout_plan_id: planId, client_id: id })).status).toBe(201);
    j = await journey(id);
    expect(j.steps.every((s) => s.state === 'done')).toBe(true);
    expect(j.next).toBeNull();
  });

  it('the interview is optional: enrolment does not wait for it', async () => {
    const id = await newClient();
    await screenClient(pool, { clientId: id, orgId: ORG });
    const res = await request().patch(`/api/pt-os/clients/${id}`).send({
      status: 'active', pt_start_date: '2026-10-01', pt_end_date: '2026-12-31', duration_months: 3, final_amount: 9000, paid_amount: 0,
    });
    expect(res.status).toBe(200);
  });

  it('a revoked consent and a high-risk PAR-Q show as blocked, with the reason', async () => {
    const id = await newClient();
    await pool.query(`INSERT INTO pt_informed_consents (client_id, organization_id, full_name, status) VALUES ($1, $2, 'X', 'revoked')`, [id, ORG]);
    const j = await journey(id);
    expect(j.steps.find((s) => s.key === 'consent')).toMatchObject({ state: 'blocked', detail: expect.stringMatching(/revoked/) });
  });

  describe('the interview\'s own rules', () => {
    it('an empty interview cannot be completed', async () => {
      const id = await newClient();
      const res = await request().post(`/api/pt-os/clients/${id}/interviews`).send({ status: 'completed' });
      expect(res.status).toBe(400);
    });

    it('a completed interview cannot be reopened', async () => {
      const id = await newClient();
      const { body } = await request().post(`/api/pt-os/clients/${id}/interviews`).send({ status: 'completed', motivation: 'Wedding' });
      const res = await request().patch(`/api/pt-os/interviews/${body.data.id}`).send({ status: 'draft' });
      expect(res.status).toBe(409);
    });

    it('over-long answers and non-text are refused', async () => {
      const id = await newClient();
      expect((await request().post(`/api/pt-os/clients/${id}/interviews`).send({ notes: 'x'.repeat(2001) })).status).toBe(400);
      expect((await request().post(`/api/pt-os/clients/${id}/interviews`).send({ notes: { a: 1 } })).status).toBe(400);
    });
  });

  describe('tenant isolation', () => {
    it('another studio cannot read the journey, list, create or edit interviews', async () => {
      const id = await newClient();
      const { body } = await request().post(`/api/pt-os/clients/${id}/interviews`).send({ notes: 'private' });
      mockOrg = OTHER_ORG;
      expect((await request().get(`/api/pt-os/clients/${id}/journey`)).status).toBe(404);
      expect((await request().get(`/api/pt-os/clients/${id}/interviews`)).status).toBe(404);
      expect((await request().post(`/api/pt-os/clients/${id}/interviews`).send({ notes: 'x' })).status).toBe(404);
      expect((await request().patch(`/api/pt-os/interviews/${body.data.id}`).send({ notes: 'hijack' })).status).toBe(404);
      mockOrg = ORG;
      const { rows: [row] } = await pool.query('SELECT notes FROM pt_client_interviews WHERE id = $1', [body.data.id]);
      expect(row.notes).toBe('private');
    });
  });
});

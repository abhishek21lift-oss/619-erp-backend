'use strict';
// Training eligibility, against a real migrated database (Phase 2).
//
// Every action that starts training — assigning a plan, booking a PT session,
// marking one completed, logging a workout — asks lib/screeningGate's
// checkTrainingEligibility, live: is this an enrolled client with a running
// term, and does nothing medically stop them. Enrolling a client who has
// never had a term needs their screening done first. These drive the real
// routes through each state.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Training eligibility, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the eligibility proof would skip.');
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

const ORG = 'c1e70000-0000-4000-8000-0000000003e5';
const OTHER_ORG = 'c1e70000-0000-4000-8000-0000000003e6';
const USER = 'pte-trainer-user';
const mockUser = { id: USER, name: 'PTE Trainer', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  requireAdmin: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const { randomUUID } = require('crypto');
const { screenClient } = require('./helpers/screening');

describeIf('Training eligibility, against a real database', () => {
  let pool;
  let request;
  const clients = [];
  const plans = [];

  beforeAll(async () => {
    pool = require('../db/pool');
    for (const [id, slug] of [[ORG, 'pte-studio'], [OTHER_ORG, 'pte-other']]) {
      await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`, [id, slug]);
    }
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'PTE Trainer', 'pte@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));
    app.use('/api/workouts', require('../routes/workouts'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);
  });

  afterAll(async () => {
    for (const t of ['pt_sessions', 'workout_sessions', 'workout_assignments', 'pt_payments',
      'pt_client_renewals', 'pt_client_subscriptions', 'pt_informed_consents', 'pt_parq_forms']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = ANY($1)`, [clients]);
    }
    await pool.query('DELETE FROM workout_plans WHERE id = ANY($1)', [plans]);
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [clients]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  /** A client in exactly the stated state, written directly. */
  async function client({ status = 'active', end = '+60', org = ORG, term = true } = {}) {
    const id = randomUUID();
    const endSql = end === null ? 'NULL' : `CURRENT_DATE ${end.startsWith('-') ? '-' : '+'} ${Math.abs(Number(end))}`;
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, status, pt_start_date, pt_end_date, duration_months,
                               final_amount, organization_id)
       VALUES ($1, 'Eligibility Client', $2, $3, ${term ? 'CURRENT_DATE - 30' : 'NULL'},
               ${term ? endSql : 'NULL'}, ${term ? 3 : 0}, ${term ? 9000 : 0}, $4)`,
      [id, `94${String(Date.now() + clients.length).slice(-8)}`, status, org],
    );
    clients.push(id);
    return id;
  }
  async function plan() {
    const id = randomUUID();
    plans.push(id);
    await pool.query(`INSERT INTO workout_plans (id, name, organization_id, duration_weeks) VALUES ($1, 'Plan', $2, 4)`, [id, ORG]);
    return id;
  }
  const assign = async (clientId) => request().post('/api/workouts/assign').send({ workout_plan_id: await plan(), client_id: clientId });
  const book = (clientId) => request().post('/api/pt-os/sessions').send({ client_id: clientId, date: '2026-10-05', start_time: '07:00' });
  const code = (res) => res.body.error?.code ?? res.body.code;

  describe('who may train', () => {
    it('an enrolled client with a running term may be assigned a plan and booked', async () => {
      const id = await client();
      expect((await assign(id)).status).toBe(201);
      expect((await book(id)).status).toBe(201);
    });

    it('a pending client is refused everywhere with CLIENT_NOT_ENROLLED', async () => {
      const id = await client({ status: 'pending', term: false });
      for (const res of [await assign(id), await book(id),
        await request().post('/api/pt-os/workout-log/sessions').send({ client_id: id })]) {
        expect(res.status).toBe(409);
        expect(code(res)).toBe('CLIENT_NOT_ENROLLED');
      }
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM workout_assignments WHERE client_id = $1', [id])).rows[0].n).toBe(0);
    });

    it('an expired client, or an active one past their last day, is TERM_EXPIRED', async () => {
      for (const id of [await client({ status: 'expired', end: '-5' }), await client({ end: '-1' })]) {
        const res = await assign(id);
        expect(res.status).toBe(409);
        expect(code(res)).toBe('TERM_EXPIRED');
      }
    });

    it('the last day of the term is a whole valid day', async () => {
      const id = await client({ end: '0' });
      expect((await assign(id)).status).toBe(201);
    });

    it('a frozen client is CLIENT_FROZEN', async () => {
      const res = await assign(await client({ status: 'frozen' }));
      expect(res.status).toBe(409);
      expect(code(res)).toBe('CLIENT_FROZEN');
    });

    it('another studio\'s client is a 404 and nothing is written', async () => {
      const id = await client({ org: OTHER_ORG });
      expect((await book(id)).status).toBe(404);
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM pt_sessions WHERE client_id = $1', [id])).rows[0].n).toBe(0);
    });
  });

  describe('the medical stops still win on an enrolled client', () => {
    it('revoked consent refuses a session booking (CONSENT_REVOKED)', async () => {
      const id = await client();
      await pool.query(`INSERT INTO pt_informed_consents (client_id, organization_id, full_name, status)
                        VALUES ($1, $2, 'X', 'revoked')`, [id, ORG]);
      const res = await book(id);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('CONSENT_REVOKED');
    });

    it('a high-risk PAR-Q with no clearance refuses assignment (PARQ_BLOCKED)', async () => {
      const id = await client();
      await pool.query(`INSERT INTO pt_parq_forms (client_id, organization_id, full_name, status, risk_level, workout_gate_status)
                        VALUES ($1, $2, 'X', 'submitted', 'high', 'blocked')`, [id, ORG]);
      const res = await assign(id);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('PARQ_BLOCKED');
    });

    it('missing paperwork on an enrolled client only warns', async () => {
      const res = await assign(await client());
      expect(res.status).toBe(201);
      expect(res.body.screening_warnings.length).toBeGreaterThan(0);
    });
  });

  describe('session status moves', () => {
    async function booked() {
      const id = await client();
      const res = await book(id);
      return { clientId: id, sessionId: res.body.data.id };
    }
    const patch = (id, body) => request().patch(`/api/pt-os/sessions/${id}`).send(body);

    it('scheduled → completed works for an eligible client', async () => {
      const { sessionId } = await booked();
      expect((await patch(sessionId, { status: 'completed' })).status).toBe(200);
    });

    it('a completed session cannot be cancelled or re-opened', async () => {
      const { sessionId } = await booked();
      await patch(sessionId, { status: 'completed' });
      for (const status of ['cancelled', 'scheduled', 'no_show']) {
        const res = await patch(sessionId, { status });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('INVALID_SESSION_TRANSITION');
      }
    });

    it('an unknown status is refused', async () => {
      const { sessionId } = await booked();
      expect((await patch(sessionId, { status: 'done' })).status).toBe(400);
    });

    it('completing re-checks the client NOW: a term that ended since booking refuses it', async () => {
      const { clientId, sessionId } = await booked();
      await pool.query(`UPDATE pt_clients SET status = 'expired', pt_end_date = CURRENT_DATE - 1 WHERE id = $1`, [clientId]);
      const res = await patch(sessionId, { status: 'completed' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TERM_EXPIRED');
    });

    it('a cancelled session can be rescheduled', async () => {
      const { sessionId } = await booked();
      await patch(sessionId, { status: 'cancelled' });
      expect((await patch(sessionId, { status: 'scheduled' })).status).toBe(200);
    });

    it('a booking with an impossible date is refused', async () => {
      const res = await request().post('/api/pt-os/sessions').send({ client_id: await client(), date: '2026-02-30' });
      expect(res.status).toBe(400);
    });
  });

  describe('enrolling a NEW client needs completed screening', () => {
    const enroll = (id, extra = {}) => request().patch(`/api/pt-os/clients/${id}`).send({
      status: 'active', pt_start_date: '2026-10-01', pt_end_date: '2026-12-31', duration_months: 3,
      final_amount: 9000, paid_amount: 0, ...extra,
    });

    it('is refused with what is missing, and nothing is written', async () => {
      const id = await client({ status: 'pending', term: false });
      const res = await enroll(id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SCREENING_REQUIRED');
      expect(res.body.error.missing).toEqual(['informed_consent', 'parq']);
      const { rows: [c] } = await pool.query('SELECT status, pt_end_date FROM pt_clients WHERE id = $1', [id]);
      expect(c).toEqual({ status: 'pending', pt_end_date: null });
    });

    it('a draft PAR-Q is not a screening', async () => {
      const id = await client({ status: 'pending', term: false });
      await pool.query(`INSERT INTO pt_informed_consents (client_id, organization_id, full_name, status)
                        VALUES ($1, $2, 'X', 'completed')`, [id, ORG]);
      await pool.query(`INSERT INTO pt_parq_forms (client_id, organization_id, full_name, status)
                        VALUES ($1, $2, 'X', 'draft')`, [id, ORG]);
      const res = await enroll(id);
      expect(res.body.error.missing).toEqual(['parq']);
    });

    it('goes through once consent and PAR-Q are complete', async () => {
      const id = await client({ status: 'pending', term: false });
      await screenClient(pool, { clientId: id, orgId: ORG });
      expect((await enroll(id)).status).toBe(200);
    });

    it('an already-enrolled client\'s edits are not re-gated', async () => {
      const id = await client();
      expect((await request().patch(`/api/pt-os/clients/${id}`).send({ notes: 'ok' })).status).toBe(200);
    });

    it('status cannot be set to active without a term', async () => {
      const id = await client({ status: 'pending', term: false });
      const res = await request().patch(`/api/pt-os/clients/${id}`).send({ status: 'active' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CLIENT_NOT_ENROLLED');
    });
  });

  describe('the profile reads screening the way the gate does', () => {
    const screening = async (id) => (await request().get(`/api/pt-os/clients/${id}`)).body.data.screening;

    it('a newer draft PAR-Q does not hide a submitted high-risk one, and the block reason is given', async () => {
      const id = await client();
      await pool.query(`INSERT INTO pt_parq_forms (client_id, organization_id, full_name, status, risk_level, workout_gate_status, assessment_date)
                        VALUES ($1, $2, 'X', 'submitted', 'high', 'blocked', CURRENT_DATE - 2)`, [id, ORG]);
      await pool.query(`INSERT INTO pt_parq_forms (client_id, organization_id, full_name, status, assessment_date)
                        VALUES ($1, $2, 'X', 'draft', CURRENT_DATE)`, [id, ORG]);
      const s = await screening(id);
      expect(s.parq.status).toBe('submitted');
      expect(s.parq.risk_level).toBe('high');
      expect(s.block.code).toBe('PARQ_BLOCKED');
      expect(s.block.message).toMatch(/clearance is required/);
      expect(s.complete).toBe(false);
    });

    it('a draft consent started after a revocation reads as revoked, not draft', async () => {
      const id = await client();
      await pool.query(`INSERT INTO pt_informed_consents (client_id, organization_id, full_name, status, created_at)
                        VALUES ($1, $2, 'X', 'revoked', NOW() - INTERVAL '1 day')`, [id, ORG]);
      await pool.query(`INSERT INTO pt_informed_consents (client_id, organization_id, full_name, status)
                        VALUES ($1, $2, 'X', 'draft')`, [id, ORG]);
      const s = await screening(id);
      expect(s.consent.status).toBe('revoked');
      expect(s.block.code).toBe('CONSENT_REVOKED');
    });

    it('nothing on file reads as none, with the warnings the gate gives', async () => {
      const s = await screening(await client());
      expect(s.consent.status).toBe('none');
      expect(s.parq.status).toBe('none');
      expect(s.block).toBeNull();
      expect(s.warnings.length).toBeGreaterThan(0);
    });

    it('only drafts read as in progress', async () => {
      const id = await client({ status: 'pending', term: false });
      await pool.query(`INSERT INTO pt_parq_forms (client_id, organization_id, full_name, status)
                        VALUES ($1, $2, 'X', 'draft')`, [id, ORG]);
      expect((await screening(id)).parq.status).toBe('in_progress');
    });

    it('a screened client reads as complete', async () => {
      const id = await client({ status: 'pending', term: false });
      await screenClient(pool, { clientId: id, orgId: ORG });
      const s = await screening(id);
      expect(s).toMatchObject({ complete: true, block: null, consent: { status: 'completed' }, parq: { status: 'submitted', complete: true } });
    });
  });
});

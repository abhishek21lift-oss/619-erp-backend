'use strict';
// active → expired, against a real migrated database.
//
// Nothing moved a client out of 'active' when their term ended: the sweep sent
// the "expired" message and left the row alone, so ended clients stayed
// active — counted as active, and still on their programme. expireEndedTerms()
// is the transition; Renew is the way back, and it must bring the programme
// back with it.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('PT term expiry, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the term-expiry proof would skip.');
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

const ORG = 'c1e70000-0000-4000-8000-0000000003d4';
const USER = 'ptx-trainer-user';
const mockUser = { id: USER, name: 'PTX Trainer', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const { randomUUID } = require('crypto');

describeIf('PT term expiry, against a real database', () => {
  let pool;
  let svc;
  let request;
  const clients = [];
  const plans = [];
  const TODAY = '2026-10-02';

  beforeAll(async () => {
    pool = require('../db/pool');
    svc = require('../modules/pt-os/pt-os.service');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'PT Expiry Studio', 'ptx-studio')
      ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'PTX Trainer', 'ptx@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM workout_assignments WHERE client_id = ANY($1)', [clients]);
    await pool.query('DELETE FROM workout_plans WHERE id = ANY($1)', [plans]);
    for (const t of ['pt_payments', 'pt_client_renewals', 'pt_client_subscriptions']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = ANY($1)`, [clients]);
    }
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [clients]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  /** A client written directly, so each state is exactly what the test says. */
  async function client({ status = 'active', end = null, deleted = false, paid = 6000, final = 9000 } = {}) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, status, pt_start_date, pt_end_date, duration_months,
                               final_amount, paid_amount, balance_amount, organization_id, deleted_at)
       VALUES ($1, 'Expiry Client', $2, $3, $4::date - 90, $4, $5, $6, $7, $8, $9, $10)`,
      [id, `92${String(Date.now() + clients.length).slice(-8)}`, status, end, end ? 3 : 0,
        final, paid, final - paid, ORG, deleted ? new Date() : null],
    );
    clients.push(id);
    return id;
  }
  async function assign(clientId, status = 'active') {
    const planId = randomUUID();
    plans.push(planId);
    await pool.query(`INSERT INTO workout_plans (id, name, organization_id) VALUES ($1, 'Plan', $2)`, [planId, ORG]);
    await pool.query(
      `INSERT INTO workout_assignments (id, workout_plan_id, client_id, status, start_date, organization_id)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)`, [randomUUID(), planId, clientId, status, ORG]);
  }
  const row = async (id) => (await pool.query(
    `SELECT status, paid_amount, final_amount, balance_amount, to_char(pt_end_date, 'YYYY-MM-DD') AS end_date
       FROM pt_clients WHERE id = $1`, [id])).rows[0];
  const plansOf = async (id) => (await pool.query(
    'SELECT status FROM workout_assignments WHERE client_id = $1', [id])).rows.map((r) => r.status);

  it('expires an active client whose last day has passed, and pauses their programme', async () => {
    const id = await client({ end: '2026-09-30' });
    await assign(id);
    const out = await svc.expireEndedTerms({ today: TODAY });

    expect(out.clientIds).toContain(id);
    expect((await row(id)).status).toBe('expired');
    expect(await plansOf(id)).toEqual(['paused']);
  });

  it('a term ending today is still live today; tomorrow it expires', async () => {
    const id = await client({ end: TODAY });
    await svc.expireEndedTerms({ today: TODAY });
    expect((await row(id)).status).toBe('active');
    await svc.expireEndedTerms({ today: '2026-10-03' });
    expect((await row(id)).status).toBe('expired');
  });

  it('touches status only: money, dates and balance are exactly as they were', async () => {
    const id = await client({ end: '2026-08-01', paid: 4000, final: 9000 });
    const before = await row(id);
    await svc.expireEndedTerms({ today: TODAY });
    const after = await row(id);
    expect(after).toEqual({ ...before, status: 'expired' });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM pt_payments WHERE client_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('leaves pending, frozen, deleted and still-running clients alone', async () => {
    const pending = await client({ status: 'pending', end: null, paid: 0, final: 0 });
    const frozen = await client({ status: 'frozen', end: '2026-08-01' });
    const deleted = await client({ end: '2026-08-01', deleted: true });
    const running = await client({ end: '2026-12-31' });
    await assign(running);
    await svc.expireEndedTerms({ today: TODAY });

    expect((await row(pending)).status).toBe('pending');
    expect((await row(frozen)).status).toBe('frozen');
    expect((await row(deleted)).status).toBe('active');
    expect((await row(running)).status).toBe('active');
    expect(await plansOf(running)).toEqual(['active']);
  });

  it('pauses a programme left active on an already-expired client', async () => {
    const id = await client({ status: 'expired', end: '2026-08-21' });
    await assign(id);
    await svc.expireEndedTerms({ today: TODAY });
    expect(await plansOf(id)).toEqual(['paused']);
  });

  it('does not resurrect finished or cancelled programmes', async () => {
    const id = await client({ end: '2026-09-01' });
    await assign(id, 'completed');
    await svc.expireEndedTerms({ today: TODAY });
    expect(await plansOf(id)).toEqual(['completed']);
  });

  it('is idempotent: a second pass changes nothing', async () => {
    await client({ end: '2026-09-15' });
    await svc.expireEndedTerms({ today: TODAY });
    const again = await svc.expireEndedTerms({ today: TODAY });
    expect(again.expired).toBe(0);
    expect(again.paused).toBe(0);
  });

  it('renewing an expired client makes them active and resumes the paused programme', async () => {
    const id = await client({ end: '2026-09-10' });
    await assign(id);
    await svc.expireEndedTerms({ today: TODAY });
    expect(await plansOf(id)).toEqual(['paused']);

    const res = await request().post(`/api/pt-os/clients/${id}/renew`).send({
      pt_start_date: TODAY, duration_months: 1, final_amount: 5000, paid_amount: 0,
    });
    expect(res.status).toBe(200);
    expect((await row(id)).status).toBe('active');
    expect(await plansOf(id)).toEqual(['active']);
  });
});

'use strict';
// Enrolment (PATCH /api/pt-os/clients/:id) is one locked transaction.
//
// It used to be an unlocked read of paid_amount followed by three separate
// writes on the pool: the client UPDATE, the first term in
// pt_client_subscriptions and the ledger row in pt_payments. So:
//   * two saves of one enrolment in flight together (the enroll page retries a
//     save that timed out while the first may still be running) both read
//     paid_amount = 0 and both booked the full amount — two payments;
//   * a failure between the UPDATE and the ledger INSERT left paid_amount
//     raised with no payment behind it.
// These drive the real route against a real migrated database.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Atomic enrolment, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the enrolment proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 6 });
});
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockPaymentReceived = jest.fn(async () => {});
jest.mock('../modules/automation/automation.triggers', () => new Proxy({}, {
  get: (_t, name) => (name === 'paymentReceived' ? mockPaymentReceived : async () => {}),
}));
jest.mock('../lib/subscription', () => ({
  ...jest.requireActual('../lib/subscription'),
  clientLimitStatus: async () => ({ limit: null, count: 0, atLimit: false }),
}));

const ORG = 'c1e70000-0000-4000-8000-0000000003c2';
const OTHER_ORG = 'c1e70000-0000-4000-8000-0000000003c3';
const USER = 'pta-trainer-user';
const mockUser = { id: USER, name: 'PTA Trainer', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

describeIf('Atomic enrolment, against a real database', () => {
  let pool;
  let request;
  const made = [];

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'PT Atomic Studio', 'pta-studio')
      ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'PTA Trainer', 'pta@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);
  });

  afterAll(async () => {
    await pool.query('DROP TRIGGER IF EXISTS pta_fail_payment ON pt_payments');
    await pool.query('DROP FUNCTION IF EXISTS pta_fail_payment()');
    const ids = made.filter(Boolean);
    for (const t of ['pt_payments', 'pt_client_renewals', 'pt_client_subscriptions']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = ANY($1)`, [ids]);
    }
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  beforeEach(() => mockPaymentReceived.mockClear());

  async function create() {
    const mobile = `91${String(Date.now() + made.length).slice(-8)}`;
    const res = await request().post('/api/pt-os/clients').send({ name: 'Atomic Client', mobile });
    if (res.status !== 201) throw new Error(`create ${res.status}: ${JSON.stringify(res.body)}`);
    made.push(res.body.data.id);
    return res.body.data;
  }
  const ENROL = {
    status: 'active', pt_start_date: '2026-09-01', pt_end_date: '2026-12-01', duration_months: 3,
    final_amount: 9000, paid_amount: 9000, payment_method: 'UPI',
  };
  const enroll = (id, body = ENROL) => request().patch(`/api/pt-os/clients/${id}`).send(body);
  const state = async (id) => {
    const { rows: [c] } = await pool.query(
      'SELECT status, paid_amount, balance_amount, pt_end_date FROM pt_clients WHERE id = $1', [id]);
    const { rows: pays } = await pool.query('SELECT amount FROM pt_payments WHERE client_id = $1', [id]);
    const { rows: terms } = await pool.query(
      "SELECT 1 FROM pt_client_subscriptions WHERE client_id = $1 AND source = 'enrollment'", [id]);
    return { client: c, payments: pays.map((p) => Number(p.amount)), terms: terms.length };
  };

  it('two saves of one enrolment in flight together book ONE payment and ONE term', async () => {
    const c = await create();
    const [a, b] = await Promise.all([enroll(c.id), enroll(c.id)]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const s = await state(c.id);
    expect(s.payments).toEqual([9000]);
    expect(s.terms).toBe(1);
    expect(Number(s.client.paid_amount)).toBe(9000);
    expect(Number(s.client.balance_amount)).toBe(0);
    expect(mockPaymentReceived).toHaveBeenCalledTimes(1);
  });

  it('a retry of a save that already landed changes nothing', async () => {
    const c = await create();
    expect((await enroll(c.id)).status).toBe(200);
    expect((await enroll(c.id)).status).toBe(200);
    const s = await state(c.id);
    expect(s.payments).toEqual([9000]);
    expect(s.terms).toBe(1);
  });

  it('a part payment then the rest books exactly the difference', async () => {
    const c = await create();
    await enroll(c.id, { ...ENROL, paid_amount: 4000 });
    await Promise.all([
      enroll(c.id, { ...ENROL, paid_amount: 9000 }),
      enroll(c.id, { ...ENROL, paid_amount: 9000 }),
    ]);
    const s = await state(c.id);
    expect(s.payments.sort((x, y) => x - y)).toEqual([4000, 5000]);
    expect(Number(s.client.paid_amount)).toBe(9000);
  });

  it('when the ledger write fails, nothing of the enrolment is kept', async () => {
    const c = await create();
    await pool.query(`CREATE OR REPLACE FUNCTION pta_fail_payment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ledger unavailable'; END $$`);
    await pool.query(`CREATE TRIGGER pta_fail_payment BEFORE INSERT ON pt_payments
      FOR EACH ROW WHEN (NEW.client_id = '${c.id}') EXECUTE FUNCTION pta_fail_payment()`);
    try {
      const res = await enroll(c.id);
      expect(res.status).toBe(500);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS pta_fail_payment ON pt_payments');
    }
    const s = await state(c.id);
    expect(s.client.status).toBe('pending');
    expect(Number(s.client.paid_amount || 0)).toBe(0);
    expect(s.client.pt_end_date).toBeNull();
    expect(s.payments).toEqual([]);
    expect(s.terms).toBe(0);
    expect(mockPaymentReceived).not.toHaveBeenCalled();

    // And the save works once the ledger is back.
    expect((await enroll(c.id)).status).toBe(200);
    expect((await state(c.id)).payments).toEqual([9000]);
  });

  it('a refusal releases the lock: the next save is not left waiting', async () => {
    const c = await create();
    const bad = await enroll(c.id, { ...ENROL, paid_amount: 10000 });
    expect(bad.status).toBe(400);
    expect((await enroll(c.id)).status).toBe(200);
  });

  it('the database refuses a second enrolment term (migration 225)', async () => {
    const c = await create();
    await enroll(c.id);
    await expect(pool.query(
      `INSERT INTO pt_client_subscriptions (client_id, plan_name, status, source)
       VALUES ($1, 'dup', 'active', 'enrollment')`, [c.id],
    )).rejects.toMatchObject({ code: '23505' });
    // Renewal-sourced rows are not constrained.
    await pool.query(
      `INSERT INTO pt_client_subscriptions (client_id, plan_name, status, source)
       VALUES ($1, 'r1', 'active', 'renewal'), ($1, 'r2', 'active', 'renewal')`, [c.id]);
  });

  it('another studio\'s client is still a 404, and nothing is locked or written', async () => {
    const c = await create();
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'PT Atomic Other', 'pta-other')
      ON CONFLICT (id) DO NOTHING`, [OTHER_ORG]);
    await pool.query('UPDATE pt_clients SET organization_id = $2 WHERE id = $1', [c.id, OTHER_ORG]);
    try {
      expect((await enroll(c.id)).status).toBe(404);
      expect((await state(c.id)).payments).toEqual([]);
    } finally {
      await pool.query('UPDATE pt_clients SET organization_id = $2 WHERE id = $1', [c.id, ORG]);
      await pool.query('DELETE FROM organizations WHERE id = $1', [OTHER_ORG]);
    }
  });
});

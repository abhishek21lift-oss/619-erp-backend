'use strict';
// UPI approval, against a real Postgres (Phase 5).
//
// Approving a member's UPI payment for a plan ran
//
//     SET pt_start_date = COALESCE(NULLIF(pt_start_date, ''), $1)
//
// and pt_start_date is a DATE column, so NULLIF made Postgres parse '' as a
// date — "invalid input syntax for type date" on EVERY plan approval. The
// money had arrived, the trainer could not approve it, and the term never
// activated. Every existing UPI test mocks the database, which is how a
// statement Postgres rejects outright stayed green.
//
// Here the whole route runs on a real database: approve books exactly one UPI
// payment and extends the term; a second approval, concurrent or retried, is
// refused and books nothing; a rejection books nothing at all.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('UPI approval, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the UPI approval proof would skip.');
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

const ORG = 'a9b00000-0000-4000-8000-000000000801';
const USER = 'upi-approval-user';
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'upi-approval-user', name: 'UPI', role: 'trainer', organization_id: 'a9b00000-0000-4000-8000-000000000801' };
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

describeIf('UPI approval, against a real database', () => {
  // An approval writes the ledger, a receipt and a PDF; the first one on a
  // cold connection can take longer than Jest's 5s default.
  jest.setTimeout(30000);

  let pool;
  let request;
  let seq = 0;

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'UPI Studio', 'upi-studio') ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'UPI', 'upi@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    // The studio has taken online payments: its own UPI id is set up.
    await pool.query(`INSERT INTO payment_settings (organization_id, upi_id, merchant_name, is_enabled)
      VALUES ($1, 'upistudio@okaxis', 'UPI Studio', TRUE) ON CONFLICT (organization_id) DO NOTHING`, [ORG]);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/payments/upi', require('../routes/upi-payments'));
    app.use(require('../middleware/errorHandler').errorHandler);
    request = () => require('supertest')(app);
  });

  afterAll(async () => {
    const ids = (await pool.query('SELECT id FROM pt_clients WHERE organization_id = $1', [ORG])).rows.map((r) => r.id);
    await pool.query('DELETE FROM payment_submissions WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM payment_events WHERE organization_id = $1', [ORG]).catch(() => {});
    await pool.query('DELETE FROM pt_payments WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = $1)', [ORG]);
    await pool.query('DELETE FROM invoices WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM pt_client_subscriptions WHERE client_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM pt_client_renewals WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM payment_receipts WHERE organization_id = $1', [ORG]).catch(() => {});
    await pool.query('DELETE FROM payment_orders WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM payment_settings WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  async function clientWithTerm({ start = '2026-09-01', end = '2026-11-30' } = {}) {
    seq += 1;
    const { rows: [c] } = await pool.query(
      `INSERT INTO pt_clients (name, mobile, organization_id, status, pt_start_date, pt_end_date, final_amount, paid_amount, balance_amount)
       VALUES ($1, $2, $3, 'active', $4, $5, 9000, 9000, 0) RETURNING id`,
      [`UPI Client ${seq}`, `98765${String(Date.now()).slice(-4)}${seq}`.slice(0, 10), ORG, start, end]);
    return c.id;
  }

  async function submittedOrder(clientId, amount = 3000) {
    const created = await request().post('/api/payments/upi/create')
      .send({ client_id: clientId, plan_name: 'Monthly PT', duration_months: 1, base_amount: amount });
    expect({ status: created.status, body: created.status === 201 ? null : created.body }).toEqual({ status: 201, body: null });
    const id = created.body.data.order.id;
    const utr = `${Date.now()}${seq}`.slice(-12);
    expect((await request().post(`/api/payments/upi/${id}/submit-utr`).send({ utr })).status).toBe(201);
    return id;
  }

  const upiPayments = async (clientId) => (await pool.query(
    `SELECT amount FROM pt_payments WHERE client_id = $1 AND payment_method = 'UPI'`, [clientId])).rows.map((r) => Number(r.amount));

  it('approving a plan payment books one UPI payment and extends the term', async () => {
    const clientId = await clientWithTerm();
    const orderId = await submittedOrder(clientId);
    const res = await request().post(`/api/payments/upi/${orderId}/approve`).send({});
    expect(res.status).toBe(200);
    expect(await upiPayments(clientId)).toEqual([3000]);
    const { rows: [c] } = await pool.query(
      `SELECT to_char(pt_start_date, 'YYYY-MM-DD') s, to_char(pt_end_date, 'YYYY-MM-DD') e, paid_amount FROM pt_clients WHERE id = $1`, [clientId]);
    expect(c.s).toBe('2026-09-01'); // the existing start is kept
    expect(c.e > '2026-11-30').toBe(true); // the term is extended
    expect(Number(c.paid_amount)).toBe(12000);
  });

  it('a client with no start date gets the paid window\'s start', async () => {
    const clientId = await clientWithTerm({ start: null, end: null });
    const orderId = await submittedOrder(clientId);
    expect((await request().post(`/api/payments/upi/${orderId}/approve`).send({})).status).toBe(200);
    const { rows: [c] } = await pool.query('SELECT pt_start_date, pt_end_date FROM pt_clients WHERE id = $1', [clientId]);
    expect(c.pt_start_date).not.toBeNull();
    expect(c.pt_end_date).not.toBeNull();
  });

  it('two concurrent approvals book the money once', async () => {
    const clientId = await clientWithTerm();
    const orderId = await submittedOrder(clientId);
    const results = await Promise.all([
      request().post(`/api/payments/upi/${orderId}/approve`).send({}),
      request().post(`/api/payments/upi/${orderId}/approve`).send({}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await upiPayments(clientId)).toEqual([3000]);
  });

  it('a rejected payment books nothing and leaves the term alone', async () => {
    const clientId = await clientWithTerm();
    const orderId = await submittedOrder(clientId);
    const res = await request().post(`/api/payments/upi/${orderId}/reject`).send({ reason: 'PAYMENT_NOT_RECEIVED' });
    expect(res.status).toBe(200);
    expect(await upiPayments(clientId)).toEqual([]);
    const { rows: [c] } = await pool.query(`SELECT to_char(pt_end_date, 'YYYY-MM-DD') e, paid_amount FROM pt_clients WHERE id = $1`, [clientId]);
    expect(c.e).toBe('2026-11-30');
    expect(Number(c.paid_amount)).toBe(9000);
    // And it cannot then be approved.
    expect((await request().post(`/api/payments/upi/${orderId}/approve`).send({})).status).toBeGreaterThanOrEqual(400);
    expect(await upiPayments(clientId)).toEqual([]);
  });
});

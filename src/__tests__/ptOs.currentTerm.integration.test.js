'use strict';
// The CURRENT PT TERM's Term Fee / Paid / Balance, against a real database.
//
// This has to be DB-backed, and it has to drive the real handler. The fix is
// entirely SQL — a LATERAL that nets closed terms off the lifetime total — and
// a mocked pool returns whatever the fixture says no matter what that SQL
// does. Equally, a test that runs a COPY of the route's SQL proves the query
// works but not that the route still uses it. So `../db/pool` is mocked to a
// REAL pg Pool against the test database: real route, real SQL, real rows.
//
// The bug this pins, from production:
//
//   client "Myself"  pt_clients said 80000 fee / 60000 paid / 20000 balance,
//                    and the payment ledger agreed (60000). The single
//                    pt_client_subscriptions row, written at enrollment
//                    before the money landed, said 0 / 0 / 0. The profile
//                    page preferred the subscription row and rendered
//                    ₹0 / ₹0 / ₹0 for a client who had paid 60,000.
//
//   client "Dewang"  two terms. Lifetime paid 20000, current term fee 11000.
//                    "Paid" for the current term is 11000, not 20000.
//
// Gated on RLS_TEST_DATABASE_URL and loud in CI if that is missing, so the
// proof cannot quietly skip in the one place it matters.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('PT current-term financials, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI — the current-term proof would skip.'
      );
    });
  });
}

const ORG_A = '5a5a5a5a-1111-4111-8111-111111111111';
const ORG_B = '5b5b5b5b-2222-4222-8222-222222222222';

let mockRealPool;
jest.mock('../db/pool', () => ({
  query: (...args) => mockRealPool.query(...args),
  connect: (...args) => mockRealPool.connect(...args),
}));

let mockUser = { id: 'u-a', role: 'admin', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));
jest.mock('../middleware/rbac', () => ({
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const express = require('express');
const request = require('supertest');

describeIf('PT current-term financials, against a real database', () => {
  let app;
  const ids = {};

  const mkClient = async (key, org, row) => {
    const { rows } = await mockRealPool.query(
      `INSERT INTO pt_clients
         (name, organization_id, final_amount, paid_amount, balance_amount,
          pt_start_date, pt_end_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id`,
      [key, org, row.fee, row.paid, row.balance, row.start, row.end]
    );
    ids[key] = rows[0].id;
    return rows[0].id;
  };

  const mkSub = (clientId, row) => mockRealPool.query(
    `INSERT INTO pt_client_subscriptions
       (client_id, plan_name, start_date, end_date, selling_price,
        amount_paid, balance_amount, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
    [clientId, row.plan ?? 'PT', row.start, row.end,
     row.price, row.paid, row.balance, row.source ?? 'enrollment']
  );

  const profile = async (key) => {
    const res = await request(app).get(`/api/pt-os/clients/${ids[key]}`);
    return res;
  };

  beforeAll(async () => {
    mockRealPool = new Pool({ connectionString: DB_URL, max: 4 });

    await mockRealPool.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1,'Term A','term-a'), ($2,'Term B','term-b')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    );

    // 1. Brand-new enrollment, paid in full. No subscription row yet — the
    //    backfill only writes one when the client crosses into "enrolled".
    await mkClient('fresh-full', ORG_A,
      { fee: 25000, paid: 25000, balance: 0, start: '2026-09-01', end: '2026-12-01' });

    // 2. Partial payment.
    await mkClient('partial', ORG_A,
      { fee: 30000, paid: 20000, balance: 10000, start: '2026-09-01', end: '2026-12-01' });
    await mkSub(ids['partial'],
      { start: '2026-09-01', end: '2026-12-01', price: 30000, paid: 5000, balance: 25000 });

    // 3. THE PRODUCTION BUG. A zero-value enrollment snapshot beside a client
    //    row that is correct and ledger-backed.
    await mkClient('zero-snapshot', ORG_A,
      { fee: 80000, paid: 60000, balance: 20000, start: '2025-05-23', end: '2025-08-23' });
    await mkSub(ids['zero-snapshot'],
      { start: '2025-05-23', end: '2025-07-23', price: 0, paid: 0, balance: 0 });

    // 4. Renewed client: two terms. Lifetime 20000, current term fee 11000.
    await mkClient('renewed', ORG_A,
      { fee: 11000, paid: 20000, balance: 0, start: '2026-01-25', end: '2026-02-25' });
    await mkSub(ids['renewed'],
      { start: '2025-06-06', end: '2025-07-06', price: 9000, paid: 9000, balance: 0 });
    await mkSub(ids['renewed'],
      { start: '2026-01-25', end: '2026-02-25', price: 11000, paid: 11000, balance: 0, source: 'renewal' });

    // 5. A junk row with no start_date, which the /subscriptions ordering
    //    (start_date ASC NULLS LAST) would have sorted LAST and handed to the
    //    page as "the current term".
    await mkClient('null-start', ORG_A,
      { fee: 15000, paid: 15000, balance: 0, start: '2026-03-01', end: '2026-06-01' });
    await mkSub(ids['null-start'],
      { start: null, end: null, price: 0, paid: 0, balance: 0 });

    // 6. Another studio's client, for the isolation case.
    await mkClient('other-org', ORG_B,
      { fee: 40000, paid: 40000, balance: 0, start: '2026-09-01', end: '2026-12-01' });

    app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  });

  afterAll(async () => {
    await mockRealPool.query(
      'DELETE FROM pt_client_subscriptions WHERE client_id IN (SELECT id FROM pt_clients WHERE organization_id = ANY($1))',
      [[ORG_A, ORG_B]]
    );
    await mockRealPool.query('DELETE FROM pt_clients WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]);
    await mockRealPool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG_A, ORG_B]]);
    await mockRealPool.end();
  });

  beforeEach(() => { mockUser = { id: 'u-a', role: 'admin', organization_id: ORG_A }; });

  // ── The reported bug ──────────────────────────────────────────────────────

  it('does NOT let a zero-value enrollment snapshot zero out a paid-up client', async () => {
    const res = await profile('zero-snapshot');
    expect(res.status).toBe(200);
    // Before the fix the page read 0 / 0 / 0 off the subscription row.
    expect(Number(res.body.data.current_term_fee)).toBe(80000);
    expect(Number(res.body.data.current_term_paid)).toBe(60000);
    expect(Number(res.body.data.current_term_balance)).toBe(20000);
  });

  it('reports a new enrollment paid in full as fully paid', async () => {
    const res = await profile('fresh-full');
    expect(Number(res.body.data.current_term_fee)).toBe(25000);
    expect(Number(res.body.data.current_term_paid)).toBe(25000);
    expect(Number(res.body.data.current_term_balance)).toBe(0);
    expect(res.body.data.due_status).toBe('CLEAR');
  });

  it('reports a partial payment as an outstanding balance', async () => {
    const res = await profile('partial');
    expect(Number(res.body.data.current_term_fee)).toBe(30000);
    // 20000 from the client row, NOT the 5000 frozen in the snapshot.
    expect(Number(res.body.data.current_term_paid)).toBe(20000);
    expect(Number(res.body.data.current_term_balance)).toBe(10000);
    expect(res.body.data.due_status).toBe('DUE');
  });

  // ── Multiple terms ────────────────────────────────────────────────────────

  it('nets closed terms off the lifetime total for a renewed client', async () => {
    const res = await profile('renewed');
    expect(Number(res.body.data.current_term_fee)).toBe(11000);
    // Lifetime is 20000; the 9000 first term is closed, so this term is 11000.
    expect(Number(res.body.data.current_term_paid)).toBe(11000);
    expect(Number(res.body.data.current_term_balance)).toBe(0);
    // And the lifetime figure itself is untouched, for the page's
    // "N terms · ₹X lifetime paid" line.
    expect(Number(res.body.data.paid_amount)).toBe(20000);
  });

  it('never treats a NULL-start_date row as a prior term', async () => {
    // This row sorts LAST under the /subscriptions ordering, so the old page
    // would have called it "current". It must subtract nothing.
    const res = await profile('null-start');
    expect(Number(res.body.data.current_term_fee)).toBe(15000);
    expect(Number(res.body.data.current_term_paid)).toBe(15000);
    expect(Number(res.body.data.current_term_balance)).toBe(0);
  });

  it('preserves historical subscription rows and still serves them', async () => {
    const res = await request(app).get(`/api/pt-os/clients/${ids['renewed']}/subscriptions`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // The closed term keeps its own numbers — history is not rewritten.
    const first = res.body.data.find((s) => s.source === 'enrollment');
    expect(Number(first.selling_price)).toBe(9000);
    expect(Number(first.amount_paid)).toBe(9000);
  });

  // ── Payments move the numbers immediately ─────────────────────────────────

  it('reflects a new payment in the current term without touching history', async () => {
    const before = await profile('partial');
    expect(Number(before.body.data.current_term_balance)).toBe(10000);

    const pay = await request(app)
      .post('/api/pt-os/payments')
      .send({ client_id: ids['partial'], amount: 10000, payment_method: 'CASH' });
    expect(pay.status).toBe(201);

    const after = await profile('partial');
    expect(Number(after.body.data.current_term_paid)).toBe(30000);
    expect(Number(after.body.data.current_term_balance)).toBe(0);
    expect(after.body.data.due_status).toBe('CLEAR');

    // The snapshot row is still the stale 5000 — and that is fine, because
    // nothing reads it for the current term any more. This asserts the fix
    // does not depend on back-writing history.
    const subs = await request(app).get(`/api/pt-os/clients/${ids['partial']}/subscriptions`);
    expect(Number(subs.body.data[0].amount_paid)).toBe(5000);
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────

  it('will not serve another studio\'s client profile', async () => {
    mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B };
    const res = await request(app).get(`/api/pt-os/clients/${ids['zero-snapshot']}`);
    expect(res.status).toBe(404);
  });

  it('will not serve another studio\'s subscription history', async () => {
    mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B };
    const res = await request(app).get(`/api/pt-os/clients/${ids['renewed']}/subscriptions`);
    expect(res.status).toBe(404);
  });

  it('does not let one studio\'s terms leak into another studio\'s totals', async () => {
    mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B };
    const res = await request(app).get(`/api/pt-os/clients/${ids['other-org']}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.current_term_fee)).toBe(40000);
    expect(Number(res.body.data.current_term_paid)).toBe(40000);
  });
});

'use strict';
// POST /api/pt-os/clients/:id/renew — the balance a renewal leaves behind,
// against a real database.
//
// The balance is computed in SQL, so a mocked pool would return whatever the
// fixture says no matter what the UPDATE does. `../db/pool` is a REAL pg Pool
// here: real route, real SQL, real rows (same approach as
// ptOs.currentTerm.integration.test.js).
//
// The bug this pins: the route set
//
//   balance_amount = GREATEST(final_amount - (paid_amount + paidNow), 0)
//
// but paid_amount is a LIFETIME total. A returning client who had paid 20,000
// over earlier terms, renewed for 12,000 with nothing paid, came out owing 0.
// The new balance is what they owed before, plus the new term, less what they
// paid now.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('renewal balance, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the renewal balance proof would skip.');
    });
  });
}

const ORG = '5c5c5c5c-3333-4333-8333-333333333333';

let mockRealPool;
jest.mock('../db/pool', () => ({
  query: (...args) => mockRealPool.query(...args),
  connect: (...args) => mockRealPool.connect(...args),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'u-renew', role: 'trainer', organization_id: '5c5c5c5c-3333-4333-8333-333333333333' };
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));
jest.mock('../middleware/rbac', () => ({
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../modules/automation/automation.triggers', () => ({
  paymentReceived: jest.fn(async () => {}),
  memberCreated: jest.fn(async () => {}),
}));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const express = require('express');
const request = require('supertest');

describeIf('renewal balance, against a real database', () => {
  let app;

  const mkClient = async (name, { fee, paid, balance }) => {
    const { rows } = await mockRealPool.query(
      `INSERT INTO pt_clients
         (name, organization_id, package_type, final_amount, paid_amount, balance_amount,
          pt_start_date, pt_end_date, status)
       VALUES ($1,$2,'PT 3 Months',$3,$4,$5,'2026-06-01','2026-09-01','active') RETURNING id`,
      [name, ORG, fee, paid, balance]
    );
    return rows[0].id;
  };

  const renew = (id, { price, paidNow }) => request(app)
    .post(`/api/pt-os/clients/${id}/renew`)
    .send({
      pt_start_date: '2026-09-01', duration_months: 3, package_type: 'PT 3 Months',
      base_amount: price, discount: 0, final_amount: price, paid_amount: paidNow,
    });

  const balanceOf = async (id) => {
    const { rows } = await mockRealPool.query(
      'SELECT balance_amount::numeric AS b, paid_amount::numeric AS p FROM pt_clients WHERE id = $1', [id]
    );
    return { balance: Number(rows[0].b), paid: Number(rows[0].p) };
  };

  beforeAll(async () => {
    mockRealPool = new Pool({ connectionString: DB_URL, max: 4 });
    await mockRealPool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Renew Org','renew-org')
       ON CONFLICT (id) DO NOTHING`, [ORG]
    );
    app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  });

  afterAll(async () => {
    const inOrg = 'SELECT id FROM pt_clients WHERE organization_id = $1';
    await mockRealPool.query(`DELETE FROM pt_client_subscriptions WHERE client_id IN (${inOrg})`, [ORG]);
    await mockRealPool.query(`DELETE FROM pt_client_renewals WHERE client_id IN (${inOrg})`, [ORG]);
    await mockRealPool.query('DELETE FROM pt_payments WHERE organization_id = $1', [ORG]);
    await mockRealPool.query('DELETE FROM pt_clients WHERE organization_id = $1', [ORG]);
    await mockRealPool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await mockRealPool.end();
  });

  it('a paid-up returning client renewed with nothing paid owes the new term', async () => {
    // Earlier terms: 20,000 paid in total, current term 11,000, nothing owed.
    const id = await mkClient('returning', { fee: 11000, paid: 20000, balance: 0 });
    const res = await renew(id, { price: 12000, paidNow: 0 });

    expect(res.status).toBe(200);
    expect(await balanceOf(id)).toEqual({ balance: 12000, paid: 20000 });
  });

  it('an older debt is carried into the new term', async () => {
    const id = await mkClient('owes-5000', { fee: 11000, paid: 6000, balance: 5000 });
    await renew(id, { price: 12000, paidNow: 12000 });

    expect(await balanceOf(id)).toEqual({ balance: 5000, paid: 18000 });
  });

  it('paying more than the new term settles the older debt first', async () => {
    const id = await mkClient('pays-all', { fee: 11000, paid: 6000, balance: 5000 });
    await renew(id, { price: 12000, paidNow: 17000 });

    expect(await balanceOf(id)).toEqual({ balance: 0, paid: 23000 });
  });

  it('a partial payment leaves the rest of the new term owed', async () => {
    const id = await mkClient('partial', { fee: 11000, paid: 11000, balance: 0 });
    await renew(id, { price: 12000, paidNow: 4000 });

    expect(await balanceOf(id)).toEqual({ balance: 8000, paid: 15000 });
  });
});

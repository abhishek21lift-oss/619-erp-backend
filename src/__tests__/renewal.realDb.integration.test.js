'use strict';
// Renewal against a real database (payments audit 2026-09-28, PAY-2). The
// unit test pins the statements; this proves the lock and the duplicate
// check actually hold when two submits race, and that the rows land as one.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('renewal against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the renewal proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 6 });
});
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('../modules/automation/automation.triggers', () => ({ paymentReceived: jest.fn() }));

const ORG = 'c1e70000-0000-4000-8000-000000000601';
const CLIENT = 'rn-int-client';

describeIf('renewal against a real database', () => {
  let pool;
  let renewClient;
  const req = { user: { id: 'u-rn', organization_id: ORG } };

  async function cleanup() {
    await pool.query('DELETE FROM pt_payments WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_client_renewals WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_client_subscriptions WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_clients WHERE id = $1', [CLIENT]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
  }

  beforeAll(async () => {
    pool = require('../db/pool');
    ({ renewClient } = require('../modules/pt-os/renewal.service'));
    await cleanup();
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Renew Studio', 'renew-int')`, [ORG]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM pt_payments WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_client_renewals WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_client_subscriptions WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_clients WHERE id = $1', [CLIENT]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id, final_amount, paid_amount, balance_amount, base_amount, status)
       VALUES ($1, 'Renew Client', '+919000060101', $2, 10000, 10000, 1500, 10000, 'active')`,
      [CLIENT, ORG]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  const body = { pt_start_date: '2026-10-31', duration_months: 1, final_amount: 12000, paid_amount: 4000 };

  it('writes the term, the history and a receipted payment together', async () => {
    const out = await renewClient(req, CLIENT, body);
    expect(out.paymentId).toBeTruthy();

    const { rows: [c] } = await pool.query('SELECT * FROM pt_clients WHERE id = $1', [CLIENT]);
    expect(Number(c.balance_amount)).toBe(1500 + 12000 - 4000);
    expect(Number(c.paid_amount)).toBe(14000);
    expect(Number(c.base_amount)).toBe(12000);
    expect(String(c.pt_end_date.toISOString?.() ?? c.pt_end_date).slice(0, 10)).toBe('2026-11-30');

    const { rows: [p] } = await pool.query('SELECT * FROM pt_payments WHERE client_id = $1', [CLIENT]);
    expect(p.payment_ref).toMatch(/^RCP-\d{8}-\d{6}$/);
    expect(Number(p.balance_applied)).toBe(4000);
    expect((await pool.query('SELECT 1 FROM pt_client_renewals WHERE client_id = $1', [CLIENT])).rowCount).toBe(1);
  });

  it('two simultaneous submits renew once', async () => {
    const results = await Promise.all([renewClient(req, CLIENT, body), renewClient(req, CLIENT, body)]);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM pt_client_renewals WHERE client_id = $1', [CLIENT])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM pt_payments WHERE client_id = $1', [CLIENT])).rowCount).toBe(1);
    const { rows: [c] } = await pool.query('SELECT balance_amount FROM pt_clients WHERE id = $1', [CLIENT]);
    expect(Number(c.balance_amount)).toBe(9500);
  });

  it('an overpayment is refused and nothing changes', async () => {
    const out = await renewClient(req, CLIENT, { ...body, paid_amount: 20000 });
    expect(out).toEqual({ overpaid: 20000, owed: 13500 });
    const { rows: [c] } = await pool.query('SELECT balance_amount, paid_amount FROM pt_clients WHERE id = $1', [CLIENT]);
    expect(Number(c.balance_amount)).toBe(1500);
    expect(Number(c.paid_amount)).toBe(10000);
  });
});

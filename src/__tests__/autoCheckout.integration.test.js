'use strict';
// Auto checkout, against a real database.
//
// The pass is one SQL statement whose behaviour depends on what Postgres does
// with a LEFT JOIN against a per-org settings table, a missing row, and an
// interval built from a text value. A mocked pool would assert the string and
// prove none of that.
//
// Every call is scoped to the org this file created, so a parallel suite's
// open check-in is never closed from here.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('auto checkout against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the auto-checkout proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 2 });
});

const OFF = 'ac000000-0000-4000-8000-000000000001';
const DEFAULT = 'ac000000-0000-4000-8000-000000000002';
const THIRTY = 'ac000000-0000-4000-8000-000000000003';
const ORGS = [OFF, DEFAULT, THIRTY];

describeIf('auto checkout against a real database', () => {
  let pool;
  let runAutoCheckout;

  beforeAll(() => {
    pool = require('../db/pool');
    ({ runAutoCheckout } = require('../modules/attendance/auto-checkout'));
  });

  beforeEach(async () => {
    await reset();
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES
         ($1, 'Auto Off', 'auto-off'),
         ($2, 'Auto Default', 'auto-default'),
         ($3, 'Auto Thirty', 'auto-thirty')`,
      ORGS
    );
    await pool.query(
      `INSERT INTO system_settings (organization_id, key, value, type)
       VALUES ($1, 'auto_checkout', 'false', 'boolean')`, [OFF]);
    await pool.query(
      `INSERT INTO system_settings (organization_id, key, value, type)
       VALUES ($1, 'auto_checkout', 'true', 'boolean'),
              ($1, 'auto_checkout_minutes', '30', 'number')`, [THIRTY]);
    await pool.query(
      `INSERT INTO attendance_logs
         (ref_id, ref_type, ref_name, date, check_in_time, status, method, organization_id)
       VALUES
         ('ac-off-open', 'client', 'Off Open', (NOW() - INTERVAL '2 hours')::date,
          NOW() - INTERVAL '2 hours', 'present', 'qr', $1),
         ('ac-def-open', 'client', 'Def Open', (NOW() - INTERVAL '2 hours')::date,
          NOW() - INTERVAL '2 hours', 'present', 'qr', $2),
         ('ac-def-old', 'client', 'Def Old', (NOW() - INTERVAL '3 days')::date,
          NOW() - INTERVAL '3 days', 'present', 'qr', $2),
         ('ac-thirty-open', 'client', 'Thirty Open', (NOW() - INTERVAL '2 hours')::date,
          NOW() - INTERVAL '2 hours', 'present', 'qr', $3)`,
      ORGS
    );
  });

  afterAll(async () => {
    await reset();
    await pool.end().catch(() => {});
  });

  async function reset() {
    await pool.query('DELETE FROM attendance_logs WHERE organization_id = ANY($1::uuid[])', [ORGS]);
    await pool.query('DELETE FROM system_settings WHERE organization_id = ANY($1::uuid[])', [ORGS]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [ORGS]);
  }

  async function rows() {
    const { rows: out } = await pool.query(
      `SELECT ref_id, duration_minutes,
              ROUND(EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 60)::int AS minutes
         FROM attendance_logs WHERE organization_id = ANY($1::uuid[])`, [ORGS]
    );
    return Object.fromEntries(out.map((r) => [r.ref_id, r]));
  }

  test('a studio that switched it off is untouched', async () => {
    const result = await runAutoCheckout(OFF);
    expect(result.closed).toBe(0);
    expect((await rows())['ac-off-open'].minutes).toBeNull();
  });

  test('a missing setting means on, at 60 minutes, with duration filled', async () => {
    await runAutoCheckout(DEFAULT);
    const row = (await rows())['ac-def-open'];
    expect(row.minutes).toBe(60);
    expect(row.duration_minutes).toBe(60);
  });

  test('an open row older than the 24-hour window is not rewritten', async () => {
    await runAutoCheckout(DEFAULT);
    expect((await rows())['ac-def-old'].minutes).toBeNull();
  });

  test('the studio\'s own minutes are used', async () => {
    await runAutoCheckout(THIRTY);
    const row = (await rows())['ac-thirty-open'];
    expect(row.minutes).toBe(30);
    expect(row.duration_minutes).toBe(30);
  });

  test('a second pass moves nothing', async () => {
    await runAutoCheckout(DEFAULT);
    const first = (await rows())['ac-def-open'].minutes;
    const second = await runAutoCheckout(DEFAULT);
    expect(second.closed).toBe(0);
    expect((await rows())['ac-def-open'].minutes).toBe(first);
  });

  test('the scheduled no-argument call applies each studio\'s own rule', async () => {
    // The job calls runAutoCheckout() with no org. Same rows, one pass.
    const out = await runAutoCheckout();
    expect(out.closed).toBeGreaterThanOrEqual(2);
    const after = await rows();
    expect(after['ac-off-open'].minutes).toBeNull();
    expect(after['ac-def-open'].minutes).toBe(60);
    expect(after['ac-def-old'].minutes).toBeNull();
    expect(after['ac-thirty-open'].minutes).toBe(30);
  });
});

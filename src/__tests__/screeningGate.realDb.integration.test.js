'use strict';
// The screening gate's SQL against a real database (assessment modules audit
// 2026-09-28, A-2, A-3, P-3). The unit test pins the decision; this proves the
// rows it decides from: that the latest-form read ignores drafts and forms
// another studio wrote, and that an expired clearance stops counting on the
// day it expires rather than whenever the form is next saved.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('screening gate against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the screening gate proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));

const ORG = 'c1e70000-0000-4000-8000-000000000301';
const FOREIGN = 'c1e70000-0000-4000-8000-000000000302';
const CLIENT = 'sg-int-client';

describeIf('screening gate against a real database', () => {
  let pool;
  let isTrainingBlocked;
  let checkScreeningGate;

  async function cleanup() {
    await pool.query('DELETE FROM pt_medical_clearances WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_parq_forms WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_informed_consents WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_clients WHERE id = $1', [CLIENT]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, FOREIGN]]);
  }

  async function form({ org = ORG, risk, gate, date, status = 'submitted' }) {
    const { rows: [f] } = await pool.query(
      `INSERT INTO pt_parq_forms (client_id, full_name, organization_id, risk_level, status, parq_yes_count,
                                  workout_gate_status, assessment_date)
       VALUES ($1, 'Gate Client', $2, $3, $4, 0, $5, $6) RETURNING id`,
      [CLIENT, org, risk, status, gate, date]);
    return f.id;
  }

  beforeAll(async () => {
    pool = require('../db/pool');
    ({ isTrainingBlocked, checkScreeningGate } = require('../lib/screeningGate'));
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Gate Studio', 'gate-int'), ($2, 'Other Studio', 'gate-int-other')`,
      [ORG, FOREIGN]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id) VALUES ($1, 'Gate Client', '+919000030101', $2)`,
      [CLIENT, ORG]);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM pt_medical_clearances WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_parq_forms WHERE client_id = $1', [CLIENT]);
    await pool.query('DELETE FROM pt_informed_consents WHERE client_id = $1', [CLIENT]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('an expired clearance stops counting even though the stored gate says cleared', async () => {
    const id = await form({ risk: 'high', gate: 'cleared', date: '2026-01-10' });
    await pool.query(
      `INSERT INTO pt_medical_clearances (parq_form_id, client_id, approval_status, expiry_date, organization_id)
       VALUES ($1, $2, 'approved', CURRENT_DATE - 1, $3)`, [id, CLIENT, ORG]);
    expect(await isTrainingBlocked(CLIENT)).toBe(true);

    await pool.query(`UPDATE pt_medical_clearances SET expiry_date = CURRENT_DATE WHERE parq_form_id = $1`, [id]);
    expect(await isTrainingBlocked(CLIENT)).toBe(false);
  });

  it('a newer low-risk form another studio wrote cannot lift the block', async () => {
    await form({ risk: 'high', gate: 'blocked', date: '2026-01-10' });
    await form({ org: FOREIGN, risk: 'low', gate: 'cleared', date: '2026-02-10' });
    expect(await isTrainingBlocked(CLIENT)).toBe(true);
  });

  it('a newer draft cannot hide a submitted high-risk form', async () => {
    await form({ risk: 'high', gate: 'blocked', date: '2026-01-10' });
    await form({ risk: 'low', gate: 'cleared', date: '2026-02-10', status: 'draft' });
    expect(await isTrainingBlocked(CLIENT)).toBe(true);
  });

  it('two forms on the same day resolve to the one written last', async () => {
    await form({ risk: 'low', gate: 'cleared', date: '2026-03-01' });
    await form({ risk: 'high', gate: 'blocked', date: '2026-03-01' });
    expect(await isTrainingBlocked(CLIENT)).toBe(true);
  });

  it('a revoked consent blocks; only drafts on file is a warning, not a block', async () => {
    await pool.query(
      `INSERT INTO pt_informed_consents (client_id, full_name, organization_id, status) VALUES ($1, 'Gate Client', $2, 'revoked')`,
      [CLIENT, ORG]);
    expect(await isTrainingBlocked(CLIENT)).toBe(true);

    await pool.query('DELETE FROM pt_informed_consents WHERE client_id = $1', [CLIENT]);
    await form({ risk: 'high', gate: 'blocked', date: '2026-01-10', status: 'draft' });
    const { blocked, warnings } = await checkScreeningGate({ user: { id: 'u' } }, CLIENT);
    expect(blocked).toBeNull();
    expect(warnings.join(' ')).toMatch(/No PAR-Q/);
  });
});

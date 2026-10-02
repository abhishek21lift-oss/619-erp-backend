'use strict';
// Enroll vs Renew, against a real migrated database.
//
// The client profile chose between "Enroll in PT" and "Renew PT" on
// `!!client.pt_start_date`, and POST /clients defaulted pt_start_date to today
// for every new client — so a name-and-phone add was offered Renew. Renewing
// them wrote a renewal row, and the enroll screen then refused them for having
// "renewed before". These drive the real routes through each state a client
// can be in and assert the one flag the profile now reads (`has_pt_term`) and
// what the renew route allows.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Enroll vs Renew, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the enroll/renew proof would skip.');
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

const ORG = 'c1e70000-0000-4000-8000-0000000003b1';
const USER = 'ptt-trainer-user';
const mockUser = { id: USER, name: 'PTT Trainer', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const { screenClient, unscreenClients } = require('./helpers/screening');

describeIf('Enroll vs Renew, against a real database', () => {
  let pool;
  let request;
  const made = [];

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'PT Term Studio', 'ptt-studio')
      ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'PTT Trainer', 'ptt@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);
  });

  afterAll(async () => {
    const ids = made.filter(Boolean);
    for (const t of ['pt_payments', 'pt_client_renewals', 'pt_client_subscriptions']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = ANY($1)`, [ids]);
    }
    await unscreenClients(pool, ids);
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  async function create(body) {
    // A distinct mobile each time: the studio refuses a second client on one number.
    const mobile = `90${String(Date.now() + made.length).slice(-8)}`;
    const res = await request().post('/api/pt-os/clients').send({ name: 'Client', mobile, ...body });
    if (res.status !== 201) throw new Error(`create ${res.status}: ${JSON.stringify(res.body)}`);
    made.push(res.body.data.id);
    // Enrolment needs completed screening (lib/screeningGate); these suites
    // test enrolment and renewal, so every client they make is screened.
    await screenClient(pool, { clientId: res.body.data.id, orgId: ORG });
    return res.body.data;
  }
  const profile = async (id) => (await request().get(`/api/pt-os/clients/${id}`)).body.data;
  const renew = (id, extra = {}) => request().post(`/api/pt-os/clients/${id}/renew`).send({
    pt_start_date: '2026-10-02', duration_months: 1, final_amount: 5000, paid_amount: 0, ...extra,
  });
  const enroll = (id, extra = {}) => request().patch(`/api/pt-os/clients/${id}`).send({
    status: 'active', pt_start_date: '2026-09-01', pt_end_date: '2026-12-01', duration_months: 3,
    final_amount: 9000, paid_amount: 0, ...extra,
  });
  const count = async (table, id) => Number((await pool.query(
    `SELECT COUNT(*) FROM ${table} WHERE client_id = $1`, [id])).rows[0].count);

  it('a new client with no package gets no PT dates and is not enrolled', async () => {
    const c = await create({});
    expect(c.pt_start_date).toBeNull();
    expect(c.pt_end_date).toBeNull();
    expect(c.status).toBe('pending');
    const p = await profile(c.id);
    expect(p.has_pt_term).toBe(false);
    expect(p.joining_date).toBeTruthy(); // the sign-up day is still recorded
  });

  it('a new client cannot be renewed — 409 NOT_ENROLLED, and nothing is written', async () => {
    const c = await create({});
    const res = await renew(c.id, { paid_amount: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ENROLLED');
    expect(await count('pt_client_renewals', c.id)).toBe(0);
    expect(await count('pt_client_subscriptions', c.id)).toBe(0);
    expect(await count('pt_payments', c.id)).toBe(0);
    const p = await profile(c.id);
    expect(Number(p.paid_amount)).toBe(0);
    expect(p.has_pt_term).toBe(false);
  });

  it('a legacy client with a start date but no term is still "Enroll", not "Renew"', async () => {
    const c = await create({});
    await pool.query(`UPDATE pt_clients SET pt_start_date = '2026-03-04' WHERE id = $1`, [c.id]);
    expect((await profile(c.id)).has_pt_term).toBe(false);
    expect((await renew(c.id)).status).toBe(409);
  });

  it('enrolling creates the term once; a repeat enrollment does not duplicate history', async () => {
    const c = await create({});
    expect((await enroll(c.id)).status).toBe(200);
    expect((await enroll(c.id)).status).toBe(200);
    const p = await profile(c.id);
    expect(p.has_pt_term).toBe(true);
    expect(p.status).toBe('active');
    expect(await count('pt_client_subscriptions', c.id)).toBe(1);
  });

  it('an enrolled client renews: one renewal row, history kept, balance carried', async () => {
    const c = await create({});
    await enroll(c.id, { paid_amount: 4000 });
    const before = await profile(c.id);
    expect(Number(before.balance_amount)).toBe(5000);

    const res = await renew(c.id, { pt_start_date: '2026-12-01', final_amount: 6000, paid_amount: 2000 });
    expect(res.status).toBe(200);
    const after = await profile(c.id);
    expect(after.has_pt_term).toBe(true);
    expect(await count('pt_client_renewals', c.id)).toBe(1);
    expect(await count('pt_client_subscriptions', c.id)).toBe(2);
    expect(Number(after.paid_amount)).toBe(6000);           // lifetime: 4000 + 2000
    expect(Number(after.balance_amount)).toBe(9000);        // 5000 owed + 6000 new - 2000 paid
    // A renewed client is not enrolled again over their history.
    expect((await enroll(c.id, { final_amount: 1 })).body.error.code).toBe('USE_RENEW');
  });

  it('a duplicate renewal inside the window is refused', async () => {
    const c = await create({});
    await enroll(c.id);
    const body = { pt_start_date: '2026-12-01', final_amount: 7000 };
    expect((await renew(c.id, body)).status).toBe(200);
    const dup = await renew(c.id, body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RENEWAL');
    expect(await count('pt_client_renewals', c.id)).toBe(1);
  });

  it('an expired term is still a term: Renew, not Enroll', async () => {
    const c = await create({});
    // A term that has already ended is entered as expired: 'active' with an
    // end date in the past is refused (TERM_EXPIRED).
    expect((await enroll(c.id, { pt_start_date: '2025-01-01', pt_end_date: '2025-04-01' })).body.error.code)
      .toBe('TERM_EXPIRED');
    await enroll(c.id, { status: 'expired', pt_start_date: '2025-01-01', pt_end_date: '2025-04-01' });
    const p = await profile(c.id);
    expect(p.days_left).toBeLessThan(0);
    expect(p.has_pt_term).toBe(true);
    expect((await renew(c.id, { pt_start_date: '2026-10-02' })).status).toBe(200);
  });

  it('a client cannot be created WITH a package: screening comes first', async () => {
    // Enrolling at creation would skip consent and PAR-Q, which cannot exist
    // before the client does. Add, screen, then enrol.
    const res = await request().post('/api/pt-os/clients').send({
      name: 'Package Client', mobile: `93${String(Date.now()).slice(-8)}`, duration_months: 2, base_amount: 8000,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SCREENING_REQUIRED');
  });

  it('a legacy client with renewal history but a cleared end date can still be renewed', async () => {
    const c = await create({});
    await enroll(c.id);
    await renew(c.id, { pt_start_date: '2026-12-01', final_amount: 3000 });
    await pool.query(`UPDATE pt_clients SET pt_end_date = NULL WHERE id = $1`, [c.id]);
    expect((await profile(c.id)).has_pt_term).toBe(true);
    expect((await renew(c.id, { pt_start_date: '2027-02-01', final_amount: 3100 })).status).toBe(200);
  });

  it('migration 224 clears only the invented start date, never a real one', async () => {
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '224_clear_fabricated_pt_start_date.sql'), 'utf8');

    const bare = await create({});
    await pool.query(`UPDATE pt_clients SET pt_start_date = '2026-05-05' WHERE id = $1`, [bare.id]);
    const enrolled = await create({});
    await enroll(enrolled.id);
    const owing = await create({});
    await pool.query(`UPDATE pt_clients SET pt_start_date = '2026-05-05', balance_amount = 500 WHERE id = $1`, [owing.id]);

    await pool.query(sql);
    await pool.query(sql); // idempotent

    const start = async (id) => (await pool.query(
      "SELECT to_char(pt_start_date, 'YYYY-MM-DD') AS d FROM pt_clients WHERE id = $1", [id])).rows[0].d;
    expect(await start(bare.id)).toBeNull();
    expect(String(await start(enrolled.id))).toMatch(/^2026-09-01/);
    expect(String(await start(owing.id))).toMatch(/^2026-05-05/); // money on the row: left alone
  });
});

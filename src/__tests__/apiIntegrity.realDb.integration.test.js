'use strict';
// API and data integrity, against a real migrated database (Phase 2).
//
//   * PATCH /clients/:id validates what it stores: status, phone numbers,
//     calendar dates, the term's order, and a renewed client's term;
//   * the photo is an image, by its bytes, under 1 MB;
//   * converting a lead is one locked transaction — two converts of one lead
//     make one client, and a number already in the studio is a clear 409.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('API integrity, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the integrity proof would skip.');
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
jest.mock('../modules/automation/automation.triggers', () => new Proxy({}, { get: () => async () => {} }));
jest.mock('../lib/subscription', () => ({
  ...jest.requireActual('../lib/subscription'),
  clientLimitStatus: async () => ({ limit: null, count: 0, atLimit: false }),
}));

const ORG = 'c1e70000-0000-4000-8000-0000000003f7';
const OTHER_ORG = 'c1e70000-0000-4000-8000-0000000003f8';
const USER = 'pti-trainer-user';
const mockUser = { id: USER, name: 'PTI Trainer', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const { randomUUID } = require('crypto');

// The smallest valid PNG: a 1x1 pixel.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describeIf('API integrity, against a real database', () => {
  let pool;
  let request;
  const clients = [];
  const leads = [];

  beforeAll(async () => {
    pool = require('../db/pool');
    for (const [id, slug] of [[ORG, 'pti-studio'], [OTHER_ORG, 'pti-other']]) {
      await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`, [id, slug]);
    }
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'PTI Trainer', 'pti@test.invalid', '!x', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use(require('../middleware/errorHandler').errorHandler || ((err, _req, res, _next) => res.status(500).json({ error: err.message })));
    request = () => require('supertest')(app);
  });

  afterAll(async () => {
    const leadClients = (await pool.query('SELECT id FROM pt_clients WHERE organization_id = ANY($1)', [[ORG, OTHER_ORG]])).rows.map((r) => r.id);
    const all = [...clients, ...leadClients];
    for (const t of ['pt_payments', 'pt_client_renewals', 'pt_client_subscriptions']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = ANY($1)`, [all]);
    }
    await pool.query('DELETE FROM pt_leads WHERE id = ANY($1)', [leads]);
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [all]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  const mobile = () => `95${String(Date.now() + clients.length + leads.length).slice(-8)}`;
  async function client({ renewals = 0, org = ORG } = {}) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, status, pt_start_date, pt_end_date, duration_months, final_amount, organization_id)
       VALUES ($1, 'Integrity Client', $2, 'active', '2026-09-01', '2026-12-01', 3, 9000, $3)`,
      [id, mobile(), org]);
    clients.push(id);
    for (let i = 0; i < renewals; i += 1) {
      await pool.query(`INSERT INTO pt_client_renewals (client_id, client_name) VALUES ($1, 'Integrity Client')`, [id]);
    }
    return id;
  }
  async function lead(phone = mobile()) {
    const id = randomUUID();
    await pool.query(`INSERT INTO pt_leads (id, name, mobile, status, organization_id) VALUES ($1, 'Lead', $2, 'new', $3)`,
      [id, phone, ORG]);
    leads.push(id);
    return id;
  }
  const patch = (id, body) => request().patch(`/api/pt-os/clients/${id}`).send(body);

  describe('PATCH /clients/:id stores only what is valid', () => {
    it.each([
      [{ status: 'done' }, 'status'],
      [{ mobile: '12345' }, 'mobile'],
      [{ whatsapp: '0000000000' }, 'whatsapp'],
      [{ dob: '1990-02-30' }, 'dob'],
      [{ pt_end_date: 'next month' }, 'pt_end_date'],
      [{ email: 'not-an-email' }, 'email'],
      [{ duration_months: 0 }, 'duration_months'],
    ])('%j is refused (400, field %s) and nothing changes', async (body, field) => {
      const id = await client();
      const before = (await pool.query('SELECT * FROM pt_clients WHERE id = $1', [id])).rows[0];
      const res = await patch(id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.field).toBe(field);
      const after = (await pool.query('SELECT * FROM pt_clients WHERE id = $1', [id])).rows[0];
      expect(after).toEqual(before);
    });

    it('an end date before the start date is refused', async () => {
      const res = await patch(await client(), { pt_end_date: '2026-08-01' });
      expect(res.status).toBe(400);
      expect(res.body.error.field).toBe('pt_end_date');
    });

    it('a renewed client\'s term cannot be changed here (USE_RENEW)', async () => {
      const id = await client({ renewals: 1 });
      const res = await patch(id, { pt_end_date: '2027-06-01' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USE_RENEW');
      expect((await pool.query("SELECT to_char(pt_end_date,'YYYY-MM-DD') d FROM pt_clients WHERE id = $1", [id])).rows[0].d).toBe('2026-12-01');
    });

    it('valid edits still save, and a renewed client\'s personal details still save', async () => {
      expect((await patch(await client(), { mobile: '9123456780', dob: '1990-05-01', email: 'a@b.co' })).status).toBe(200);
      expect((await patch(await client({ renewals: 1 }), { address: 'New address' })).status).toBe(200);
    });

    it('another studio\'s client is a 404', async () => {
      expect((await patch(await client({ org: OTHER_ORG }), { notes: 'x' })).status).toBe(404);
    });
  });

  describe('the profile photo', () => {
    const upload = (id, photo) => request().post(`/api/pt-os/clients/${id}/photo`).send({ photo });

    it('a real PNG is stored', async () => {
      const id = await client();
      expect((await upload(id, `data:image/png;base64,${PNG_1PX}`)).status).toBe(200);
      expect((await pool.query('SELECT photo_url FROM pt_clients WHERE id = $1', [id])).rows[0].photo_url).toMatch(/^data:image\/png;base64,/);
    });

    it.each([
      ['text claiming to be a PNG', `data:image/png;base64,${Buffer.from('hello world').toString('base64')}`],
      ['an SVG', `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`],
      ['a URL', 'javascript:alert(1)'],
      ['over 1 MB', `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 10).toString('base64')}`],
    ])('%s is refused, on upload and on PATCH', async (_label, photo) => {
      const id = await client();
      expect((await upload(id, photo)).status).toBe(400);
      expect((await patch(id, { photo_url: photo })).status).toBe(400);
      expect((await pool.query('SELECT photo_url FROM pt_clients WHERE id = $1', [id])).rows[0].photo_url).toBeNull();
    });

    it('PATCH with null removes the photo', async () => {
      const id = await client();
      await upload(id, `data:image/png;base64,${PNG_1PX}`);
      expect((await patch(id, { photo_url: null })).status).toBe(200);
      expect((await pool.query('SELECT photo_url FROM pt_clients WHERE id = $1', [id])).rows[0].photo_url).toBeNull();
    });
  });

  describe('converting a lead', () => {
    const convert = (id) => request().post(`/api/pt-os/leads/${id}/convert`);

    it('two converts of one lead in flight together make ONE client', async () => {
      const id = await lead();
      const results = await Promise.all([convert(id), convert(id), convert(id)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409]);
      const winner = results.find((r) => r.status === 201).body.data.client_id;
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.client_id).toBe(winner);
      const { rows } = await pool.query(
        `SELECT c.id FROM pt_clients c JOIN pt_leads l ON l.mobile = c.mobile WHERE l.id = $1`, [id]);
      expect(rows).toHaveLength(1);
    });

    it('a converted client starts pending, with no PT dates', async () => {
      const res = await convert(await lead());
      const { rows: [c] } = await pool.query('SELECT status, pt_start_date FROM pt_clients WHERE id = $1', [res.body.data.client_id]);
      expect(c).toEqual({ status: 'pending', pt_start_date: null });
    });

    it('a number already in the studio is a 409 DUPLICATE_MOBILE and the lead is left unconverted', async () => {
      const existing = await client();
      const phone = (await pool.query('SELECT mobile FROM pt_clients WHERE id = $1', [existing])).rows[0].mobile;
      const id = await lead(phone);
      const res = await convert(id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_MOBILE');
      expect((await pool.query('SELECT status FROM pt_leads WHERE id = $1', [id])).rows[0].status).toBe('new');
    });
  });
});

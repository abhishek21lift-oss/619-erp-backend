'use strict';
// The Command Center audit, pinned against a real database.
//
// Each case was a screen in the console that could not load in production:
//
//   ⌘K search      selected organizations.organization_id, a column that
//                  table has never had, so every search naming a studio 500'd.
//   Studio 360     Memberships selected pt_clients.package_id and start_date,
//                  neither of which exists, so the tab 500'd for every studio.
//   Plan pickers   Finance, Coupons and Announcements read the plan catalogue
//                  from a tenant route that refuses a Command Center session;
//                  /api/platform/plans is the same catalogue on the platform
//                  boundary.
//
// A mocked pool cannot catch any of these — the SQL is only wrong against the
// schema — which is why this runs against the real one.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Command Center audit, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the Command Center audit proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

const ORG = 'cc0a0d17-0000-4000-8000-00000000c0de';
const CID = 'cc-audit-client';

describeIf('Command Center audit, against a real database', () => {
  let pool;
  let app;
  let request;

  beforeAll(async () => {
    pool = require('../db/pool');
    request = require('supertest');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Zephyr Audit Studio', 'zephyr-audit-studio')
      ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO pt_clients (id, name, mobile, organization_id, package_type, pt_start_date, pt_end_date, paid_amount)
      VALUES ($1, 'Zephyr Client', '+919000055555', $2, 'Quarterly PT', '2026-07-01', '2026-09-30', 12000)
      ON CONFLICT (id) DO NOTHING`, [CID, ORG]);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/platform', require('../modules/platform/super-admin/search'));
    app.use('/api/platform', require('../modules/platform/super-admin/studios'));
    app.use('/api/platform', require('../modules/platform/super-admin/subscriptions'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM pt_clients WHERE id = $1', [CID]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  it('search finds a studio by name instead of failing on a column that does not exist', async () => {
    const res = await request(app).get('/api/platform/search?q=zephyr');
    expect(res.status).toBe(200);
    const studio = res.body.data.find((r) => r.kind === 'studio');
    expect(studio).toMatchObject({ id: ORG, org_id: ORG, title: 'Zephyr Audit Studio' });
  });

  it('Studio 360 memberships lists the package and the term from the columns pt_clients has', async () => {
    const res = await request(app).get(`/api/platform/studios/${ORG}/memberships`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ id: CID, plan_name: 'Quarterly PT' });
    expect(String(res.body.data[0].start_date)).toMatch(/2026-0[67]/);
    expect(res.body.data[0].end_date).toBeTruthy();
  });

  it('reports no MRR for a plan that no studio is on', async () => {
    const res = await request(app).get('/api/platform/subscription-metrics');
    expect(res.status).toBe(200);
    const empty = res.body.data.plan_distribution.filter((p) => p.studios === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const p of empty) expect(p.mrr_inr).toBe(0);
  });

  it('serves the plan catalogue on the platform boundary', async () => {
    const res = await request(app).get('/api/platform/plans');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.plans)).toBe(true);
    expect(res.body.data.plans.length).toBeGreaterThan(0);
    expect(res.body.data.plans[0]).toHaveProperty('effective_price_inr');
  });
});

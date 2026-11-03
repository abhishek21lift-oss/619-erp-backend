'use strict';
// Phase 0 fitness-testing integrity, pinned against a real database.
//
// G-01: pt_clients.weight/height is a cache of the LATEST test. Editing a
//       2024 test in 2026 must not change the client's current body.
// G-04: deleting a test is logged with its actor and identity, re-derives the
//       cache, and repairs the re-test cycle that pointed at the deleted row.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('assessment Phase 0 integrity, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the Phase 0 integrity proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

const ORG = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const USER = 'phase0-trainer-user';
const CID = 'phase0-client';
const mockUser = { id: USER, name: 'Phase 0 Trainer', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  invalidateUserCache: jest.fn(),
}));

const { screenClient, unscreenClients } = require('./helpers/screening');

describeIf('assessment Phase 0 integrity, against a real database', () => {
  let pool;
  let app;

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug)
      VALUES ($1, 'Phase 0 Studio', 'phase0-studio') ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'Phase 0 Trainer', 'phase0@test.invalid', '!x', 'trainer', $2, TRUE)
      ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    await pool.query(`INSERT INTO pt_clients (id, name, mobile, organization_id)
      VALUES ($1, 'Phase 0 Client', '9000000000', $2) ON CONFLICT (id) DO NOTHING`, [CID, ORG]);
    await screenClient(pool, { clientId: CID, orgId: ORG, name: 'Phase 0 Client' });

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/progress', require('../modules/progress/progress.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM progress_retest_schedules WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM strength_logs WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM pt_assessments WHERE client_id = $1', [CID]);
    await unscreenClients(pool, [CID]);
    await pool.query('DELETE FROM pt_clients WHERE id = $1', [CID]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  const request = () => require('supertest')(app);

  const record = (body) => request().post('/api/progress/assessments').send({
    client_id: CID, height_cm: 180, bp_not_measured: true, ...body,
  });
  const edit = (id, body) => request().patch(`/api/progress/assessments/${id}`).send(body);
  const remove = (id) => request().delete(`/api/progress/assessments/${id}`);

  const cache = async () => {
    const { rows: [c] } = await pool.query('SELECT weight, height FROM pt_clients WHERE id = $1', [CID]);
    return { weight: c.weight == null ? null : Number(c.weight), height: c.height == null ? null : Number(c.height) };
  };

  async function reset() {
    await pool.query('DELETE FROM progress_retest_schedules WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM strength_logs WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM pt_assessments WHERE client_id = $1', [CID]);
    await pool.query('UPDATE pt_clients SET weight = NULL, height = NULL WHERE id = $1', [CID]);
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
  }

  describe('G-01 — the client body cache follows the LATEST test', () => {
    test('editing a historical test leaves the current weight and height alone', async () => {
      await reset();
      const a = await record({ assessment_date: '2026-01-01', weight: 80, height_cm: 180 });
      const b = await record({ assessment_date: '2026-06-01', weight: 75, height_cm: 178 });
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(await cache()).toEqual({ weight: 75, height: 178 });

      const p = await edit(a.body.data.id, { weight: 90, height_cm: 190 });
      expect(p.status).toBe(200);
      expect(await cache()).toEqual({ weight: 75, height: 178 });
    });

    test('deleting the latest test re-derives the cache to the previous test', async () => {
      await reset();
      const a = await record({ assessment_date: '2026-01-01', weight: 80, height_cm: 180 });
      const b = await record({ assessment_date: '2026-06-01', weight: 75, height_cm: 178 });

      expect((await remove(b.body.data.id)).status).toBe(204);
      expect(await cache()).toEqual({ weight: 80, height: 180 });

      // b is gone; a is now both the oldest and the latest test.
      expect((await remove(a.body.data.id)).status).toBe(204);
    });

    test('deleting the only test leaves the cache untouched, not null', async () => {
      await reset();
      const a = await record({ assessment_date: '2026-03-01', weight: 72, height_cm: 171 });
      expect(a.status).toBe(201);
      expect(await cache()).toEqual({ weight: 72, height: 171 });

      expect((await remove(a.body.data.id)).status).toBe(204);
      expect(await cache()).toEqual({ weight: 72, height: 171 });
    });
  });

  describe('G-04 — delete is audited and repaired', () => {
    test('deleting the latest test logs its actor and identity, and re-points the open cycle', async () => {
      await reset();
      const a = await record({ assessment_date: '2026-01-01', weight: 80, height_cm: 180 });
      const b = await record({ assessment_date: '2026-06-01', weight: 75, height_cm: 178 });

      const open = async () => {
        const { rows: [s] } = await pool.query(
          `SELECT baseline_assessment_id, status FROM progress_retest_schedules
            WHERE client_id = $1 AND status IN ('upcoming','due','overdue','rescheduled')
            ORDER BY created_at DESC LIMIT 1`, [CID]);
        return s || null;
      };
      expect((await open()).baseline_assessment_id).toBe(b.body.data.id);

      expect((await remove(b.body.data.id)).status).toBe(204);
      expect((await open()).baseline_assessment_id).toBe(a.body.data.id);

      const { rows: audits } = await pool.query(
        `SELECT user_id, organization_id, entity_type, entity_id, new_data
           FROM activity_log WHERE action = 'assessment.delete' AND entity_id = $1`, [b.body.data.id]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        user_id: USER, organization_id: ORG, entity_type: 'pt_assessment',
      });
      expect(audits[0].new_data).toMatchObject({
        client_id: CID, assessment_number: 2, assessment_type: 'initial', assessment_date: '2026-06-01',
      });

      // Last test gone: the cycle has nothing to be timed from, so it closes.
      expect((await remove(a.body.data.id)).status).toBe(204);
      expect(await open()).toBeNull();
    });
  });
});

'use strict';
// Intake ownership, pinned against a real database.
//
// G-02: PAR-Q BMI is derived from stored height/weight. A caller cannot set it.
// G-03: Add Client no longer writes facts owned by Fitness, Goal, Lifestyle or
//       PAR-Q. Sending one is a 422 FIELD_MOVED naming the owner, not a 200
//       that silently dropped the value.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('client intake Phase 0 ownership, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the Phase 0 ownership proof would skip.');
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
jest.mock('../modules/automation/automation.triggers', () => new Proxy({}, {
  get: () => async () => {},
}));
jest.mock('../lib/subscription', () => ({
  ...jest.requireActual('../lib/subscription'),
  clientLimitStatus: async () => ({ limit: null, count: 0, atLimit: false }),
}));

const ORG = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0';
const OTHER_ORG = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e1';
const USER = 'phase0-intake-trainer';
const CID = 'phase0-intake-client';
const mockUser = { id: USER, name: 'Phase 0 Intake', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  invalidateUserCache: jest.fn(),
}));

const logger = require('../lib/logger');
const DEPRECATED = ['goal', 'height', 'weight', 'body_fat', 'health_conditions', 'injuries', 'occupation'];

describeIf('client intake Phase 0 ownership, against a real database', () => {
  let pool;
  let app;

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug)
      VALUES ($1, 'Phase 0 Intake', 'phase0-intake'), ($2, 'Phase 0 Other', 'phase0-other')
      ON CONFLICT (id) DO NOTHING`, [ORG, OTHER_ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'Phase 0 Intake', 'phase0-intake@test.invalid', '!x', 'trainer', $2, TRUE)
      ON CONFLICT (id) DO NOTHING`, [USER, ORG]);
    await pool.query(`INSERT INTO pt_clients (id, name, mobile, organization_id)
      VALUES ($1, 'Phase 0 Intake Client', '9000000001', $2) ON CONFLICT (id) DO NOTHING`, [CID, ORG]);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/parq.routes'));
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM pt_parq_forms WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_informed_consents WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM pt_clients WHERE organization_id = $1', [ORG]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  beforeEach(() => logger.warn.mockClear());

  const request = () => require('supertest')(app);
  const movedWarnings = () => logger.warn.mock.calls
    .filter(([payload]) => payload && payload.event === 'ownership.field_moved');

  const answers = () => Array.from({ length: 10 }, (_, i) => ({ question_id: i + 1, answer: 'no' }));

  describe('G-02 — PAR-Q BMI is derived, never accepted', () => {
    test('create ignores a supplied BMI and stores the value height/weight imply', async () => {
      const r = await request().post('/api/pt-os/parq/forms').send({
        client_id: CID, full_name: 'Phase 0 Intake Client',
        height_cm: 180, weight_kg: 81, bmi: 99, parq_answers: answers(),
      });
      expect(r.status).toBe(201);
      expect(Number(r.body.data.bmi)).toBeCloseTo(25.0, 1);
    });

    test('edit ignores a supplied BMI and keeps the stored derived value', async () => {
      const c = await request().post('/api/pt-os/parq/forms').send({
        client_id: CID, full_name: 'Phase 0 Intake Client',
        height_cm: 180, weight_kg: 81, parq_answers: answers(),
      });
      const p = await request().patch(`/api/pt-os/parq/forms/${c.body.data.id}`).send({ bmi: 99 });
      expect(p.status).toBe(200);
      expect(Number(p.body.data.bmi)).toBeCloseTo(25.0, 1);
    });

    test('editing height recomputes the BMI from the stored weight', async () => {
      const c = await request().post('/api/pt-os/parq/forms').send({
        client_id: CID, full_name: 'Phase 0 Intake Client',
        height_cm: 180, weight_kg: 81, parq_answers: answers(),
      });
      const p = await request().patch(`/api/pt-os/parq/forms/${c.body.data.id}`).send({ height_cm: 160 });
      expect(p.status).toBe(200);
      expect(Number(p.body.data.bmi)).toBeCloseTo(31.6, 1);
    });

    test('no height or weight stores null, even when a BMI is supplied', async () => {
      const r = await request().post('/api/pt-os/parq/forms').send({
        client_id: CID, full_name: 'Phase 0 Intake Client', bmi: 99, parq_answers: answers(),
      });
      expect(r.status).toBe(201);
      expect(r.body.data.bmi).toBeNull();
    });

    test('an existing mismatched row stays readable and is not silently rewritten', async () => {
      const { rows: [legacy] } = await pool.query(
        `INSERT INTO pt_parq_forms
           (client_id, full_name, height_cm, weight_kg, bmi, parq_answers, status, organization_id)
         VALUES ($1, 'Legacy Row', 180, 81, 44, $2::jsonb, 'submitted', $3) RETURNING id`,
        [CID, JSON.stringify(answers()), ORG]);
      const g = await request().get(`/api/pt-os/parq/forms/${legacy.id}`);
      expect(g.status).toBe(200);
      expect(Number(g.body.data.bmi)).toBe(44);

      const p = await request().patch(`/api/pt-os/parq/forms/${legacy.id}`).send({ trainer_name: 'Same Record' });
      expect(p.status).toBe(200);
      expect(Number(p.body.data.bmi)).toBe(44);
    });
  });

  describe('G-03 — Add Client cannot write facts owned elsewhere', () => {
    const legacyPayload = {
      goal: 'fat_loss', height: 170, weight: 80, body_fat: 20,
      health_conditions: 'asthma', injuries: 'knee', occupation: 'engineer',
    };

    test('create is refused with FIELD_MOVED and writes nothing', async () => {
      const before = await pool.query('SELECT COUNT(*)::int AS n FROM pt_clients WHERE organization_id = $1', [ORG]);
      const r = await request().post('/api/pt-os/clients').send({
        name: 'Shadow Intake', mobile: '9876500001', ...legacyPayload,
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('FIELD_MOVED');
      expect(r.body.error.fields.map((f) => f.field).sort()).toEqual([...DEPRECATED].sort());
      expect(r.body.error.fields.find((f) => f.field === 'weight')).toEqual({
        field: 'weight', owner: 'Fitness Testing', endpoint: 'POST/PATCH /api/progress/assessments',
      });
      const after = await pool.query('SELECT COUNT(*)::int AS n FROM pt_clients WHERE organization_id = $1', [ORG]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(movedWarnings()).toHaveLength(1);
      expect([...movedWarnings()[0][0].fields].sort()).toEqual([...DEPRECATED].sort());
    });

    test('a normal identity payload is unaffected', async () => {
      const r = await request().post('/api/pt-os/clients').send({
        name: 'Identity Only', mobile: '9876500002', email: 'identity@test.invalid', address: 'Pune',
      });
      expect(r.status).toBe(201);
      expect(r.body.deprecated_fields).toBeUndefined();
      const { rows: [c] } = await pool.query(
        'SELECT name, email, address FROM pt_clients WHERE id = $1', [r.body.data.id]);
      expect(c).toEqual({ name: 'Identity Only', email: 'identity@test.invalid', address: 'Pune' });
      expect(movedWarnings()).toHaveLength(0);
    });

    test('edit is refused and leaves stored legacy values unchanged', async () => {
      const c = await request().post('/api/pt-os/clients').send({ name: 'Legacy Owner', mobile: '9876500003' });
      await pool.query(
        `UPDATE pt_clients SET goal = 'muscle_gain', height = 165, weight = 70, body_fat = 18,
                health_conditions = 'old', injuries = 'old', occupation = 'teacher'
          WHERE id = $1`, [c.body.data.id]);

      const p = await request().patch(`/api/pt-os/clients/${c.body.data.id}`).send({
        ...legacyPayload, notes: 'identity edit',
      });
      expect(p.status).toBe(422);
      expect(p.body.error.code).toBe('FIELD_MOVED');

      const { rows: [row] } = await pool.query(
        `SELECT goal, height, weight, body_fat, health_conditions, injuries, occupation, notes
           FROM pt_clients WHERE id = $1`, [c.body.data.id]);
      expect(row.goal).toBe('muscle_gain');
      expect(Number(row.height)).toBe(165);
      expect(Number(row.weight)).toBe(70);
      expect(Number(row.body_fat)).toBe(18);
      expect(row.health_conditions).toBe('old');
      expect(row.injuries).toBe('old');
      expect(row.occupation).toBe('teacher');
      expect(row.notes).toBeNull();

      const ok = await request().patch(`/api/pt-os/clients/${c.body.data.id}`).send({ notes: 'identity edit' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.notes).toBe('identity edit');
      expect(movedWarnings()).toHaveLength(1);
    });

    test('a request that carries only a moved field is refused, not NO_FIELDS', async () => {
      const c = await request().post('/api/pt-os/clients').send({ name: 'Only Legacy', mobile: '9876500004' });
      const p = await request().patch(`/api/pt-os/clients/${c.body.data.id}`).send({ weight: 95 });
      expect(p.status).toBe(422);
      expect(p.body.error.fields).toEqual([
        { field: 'weight', owner: 'Fitness Testing', endpoint: 'POST/PATCH /api/progress/assessments' },
      ]);
      const { rows: [row] } = await pool.query('SELECT weight FROM pt_clients WHERE id = $1', [c.body.data.id]);
      expect(row.weight).toBeNull();
    });
  });
});

'use strict';
// The client-assessment audit, pinned against a real database.
//
// Every case here was a live defect: a number far outside its scale stored
// and scored, an edit that could not clear a value, an edit that crashed the
// server with the raw database error, a blood-pressure stop that one blank
// field switched off, a fitness test that could never be corrected, and a
// 1RM tested in Fitness that Strength Tracking never saw.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('assessment audit, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the assessment audit proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

const mockUser = {
  id: 'aa-trainer-user', role: 'trainer', trainer_id: null,
  organization_id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
};
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  invalidateUserCache: jest.fn(),
}));

const ORG = mockUser.organization_id;
const CID = 'aa-client';

describeIf('assessment audit, against a real database', () => {
  let pool;
  let app;

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Assessment Audit', 'assessment-audit')
      ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'Audit Trainer', 'aa-trainer@audit.test', '!not-a-hash', 'trainer', $2, TRUE)
      ON CONFLICT (id) DO NOTHING`, [mockUser.id, ORG]);
    await pool.query(`INSERT INTO pt_clients (id, name, mobile, organization_id, workout_experience_level)
      VALUES ($1, 'Audit Client', '+919000012345', $2, 'beginner') ON CONFLICT (id) DO NOTHING`, [CID, ORG]);
    // A completed Informed Consent and a low-risk, submitted PAR-Q: a client
    // who has never had a PT term must be screened before a fitness test
    // (lib/screeningGate, Phase 2).
    await pool.query(`INSERT INTO pt_informed_consents (client_id, organization_id, full_name, status)
      VALUES ($1, $2, 'Audit Client', 'completed')`, [CID, ORG]);
    const answers = Array.from({ length: 10 }, (_, i) => ({ question_id: i + 1, answer: 'no' }));
    await pool.query(`INSERT INTO pt_parq_forms (client_id, full_name, parq_answers, parq_yes_count, risk_level,
        status, workout_gate_status, organization_id, assessment_date)
      VALUES ($1, 'Audit Client', $2::jsonb, 0, 'low', 'submitted', 'cleared', $3, CURRENT_DATE - 1)`,
    [CID, JSON.stringify(answers), ORG]);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/progress', require('../modules/progress/progress.routes'));
    app.use('/api/pt-os', require('../modules/pt-os/parq.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    for (const t of ['strength_logs', 'pt_posture_assessments', 'pt_mobility_performance_assessments',
      'pt_lifestyle_assessments', 'pt_nutrition_assessments', 'pt_goals', 'pt_assessments']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = $1`, [CID]);
    }
    await pool.query('DELETE FROM pt_consent_records WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM pt_informed_consents WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM pt_parq_forms WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM pt_clients WHERE id = $1', [CID]);
    await pool.query('DELETE FROM users WHERE id = $1', [mockUser.id]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  const request = () => require('supertest')(app);

  describe('an edit can clear a value', () => {
    test('un-ticking every posture issue and emptying the note clears them', async () => {
      const c = await request().post('/api/progress/posture-assessments')
        .send({ client_id: CID, front_issues: ['Forward Head'], other_issue_notes: 'old note' });
      expect(c.status).toBe(201);
      const p = await request().patch(`/api/progress/posture-assessments/${c.body.data.id}`)
        .send({ front_issues: [], other_issue_notes: null });
      expect(p.status).toBe(200);
      expect(p.body.data.front_issues).toEqual([]);
      expect(p.body.data.other_issue_notes).toBeNull();
    });
  });

  describe('numbers stay on their scale, on create and on edit', () => {
    test('a stress level of 55 on a 1-10 scale is refused', async () => {
      const r = await request().post('/api/progress/lifestyle-assessments').send({ client_id: CID, stress_level: 55 });
      expect(r.status).toBe(400);
    });

    test('a bad edit is a 400, not a 500 with the database error', async () => {
      const c = await request().post('/api/progress/lifestyle-assessments').send({ client_id: CID, stress_level: 4 });
      const a = await request().patch(`/api/progress/lifestyle-assessments/${c.body.data.id}`).send({ sleep_quality: 'abc' });
      const b = await request().patch(`/api/progress/lifestyle-assessments/${c.body.data.id}`).send({ occupation_type: 'astronaut' });
      expect([a.status, b.status]).toEqual([400, 400]);
      expect(JSON.stringify(b.body)).not.toMatch(/constraint/);
    });

    test('a mobility region score of 42 is refused', async () => {
      const r = await request().post('/api/progress/mobility-performance-assessments')
        .send({ client_id: CID, body_regions: [{ region: 'Hip', score: 42 }] });
      expect(r.status).toBe(400);
    });

    test('a 150% body-fat target and a past target date are refused', async () => {
      const a = await request().post('/api/progress/goals').send({ client_id: CID, goal_type: 'fat_loss', target_body_fat: 150 });
      const b = await request().post('/api/progress/goals').send({ client_id: CID, goal_type: 'fat_loss', target_date: '2020-01-01' });
      expect([a.status, b.status]).toEqual([400, 400]);
    });
  });

  test('switching smoking to Never drops the cigarette count', async () => {
    const r = await request().post('/api/progress/lifestyle-assessments')
      .send({ client_id: CID, smoking_status: 'never', cigarettes_per_day: 10, years_smoking: 5 });
    expect(r.status).toBe(201);
    expect([r.body.data.cigarettes_per_day, r.body.data.years_smoking]).toEqual([null, null]);
  });

  test('a new goal replaces the active one', async () => {
    const first = await request().post('/api/progress/goals').send({ client_id: CID, goal_type: 'fat_loss' });
    const second = await request().post('/api/progress/goals').send({ client_id: CID, goal_type: 'muscle_gain' });
    expect([first.status, second.status]).toEqual([201, 201]);
    const { rows } = await pool.query('SELECT id FROM pt_goals WHERE client_id = $1 AND is_active', [CID]);
    expect(rows.map((r) => r.id)).toEqual([second.body.data.id]);
  });

  describe('the blood-pressure stop', () => {
    const squat = { strength_exercise: 'Squat', strength_test_data: { test1: { weightKg: 100, reps: 5 } }, weight: 80 };

    test('one number past the line is a reading: 180 systolic alone stops a 1RM', async () => {
      const r = await request().post('/api/progress/assessments').send({ client_id: CID, bp_systolic: 180, ...squat });
      expect(r.body.error?.code).toBe('BP_UNSAFE');
    });

    test('an impossible reading is refused', async () => {
      const r = await request().post('/api/progress/assessments').send({ client_id: CID, bp_systolic: 900, bp_diastolic: 60 });
      expect(r.status).toBe(400);
    });

    test('no reading at all needs the trainer to say it was not measured', async () => {
      const refused = await request().post('/api/progress/assessments').send({ client_id: CID, ...squat });
      expect(refused.body.error?.code).toBe('BP_REQUIRED');
      const ok = await request().post('/api/progress/assessments').send({ client_id: CID, bp_not_measured: true, ...squat });
      expect(ok.status).toBe(201);
      expect(ok.body.data.health_notes).toMatch(/not measured/);
    });
  });

  test('a fitness test can be corrected and deleted, and its 1RM reaches Strength Tracking', async () => {
    const c = await request().post('/api/progress/assessments').send({
      client_id: CID, bp_systolic: 118, bp_diastolic: 76, weight: 80, height_cm: 175,
      strength_exercise: 'Deadlift', strength_test_data: { test1: { weightKg: 150, reps: 3 } },
    });
    expect(c.status).toBe(201);
    const id = c.body.data.id;
    const lifts = async () => (await pool.query(
      'SELECT exercise_name, weight_kg FROM strength_logs WHERE assessment_id = $1', [id])).rows;
    expect(await lifts()).toEqual([{ exercise_name: 'Deadlift', weight_kg: '150.00' }]);

    // The client record carries the measured body, for Enrollment and the PAR-Q.
    const body = async () => (await pool.query('SELECT weight, height FROM pt_clients WHERE id = $1', [CID])).rows[0];
    expect(Number((await body()).weight)).toBe(80);

    const p = await request().patch(`/api/progress/assessments/${id}`).send({ weight: 78.5 });
    expect(p.status).toBe(200);
    expect(Number(p.body.data.weight)).toBe(78.5);
    expect(Number(p.body.data.bmi)).toBeCloseTo(25.6, 1);
    expect(Number((await body()).weight)).toBe(78.5);
    expect(await lifts()).toHaveLength(1);

    const d = await request().delete(`/api/progress/assessments/${id}`);
    expect(d.status).toBe(204);
    expect(await lifts()).toEqual([]);
  });

  test('the PAR-Q signature attests the answers are true, and nothing else is required', async () => {
    const { rows } = await pool.query('SELECT id FROM pt_parq_forms WHERE client_id = $1 LIMIT 1', [CID]);
    const r = await request().post(`/api/pt-os/parq/forms/${rows[0].id}/consent`)
      .send({ consent_checkboxes: { info_true: true }, client_signature: 'data:image/png;base64,AAA' });
    expect(r.status).toBe(201);
    const unsigned = await request().post(`/api/pt-os/parq/forms/${rows[0].id}/consent`)
      .send({ consent_checkboxes: { info_true: true } });
    expect(unsigned.status).toBe(400);
  });
});

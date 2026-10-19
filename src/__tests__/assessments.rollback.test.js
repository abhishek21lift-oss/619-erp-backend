'use strict';
// Rollback/failure-injection: a failed lift sync must roll back the assessment row.
const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

const mockUser = {
  id: 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1', role: 'trainer', trainer_id: null,
  organization_id: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
};
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  invalidateUserCache: jest.fn(),
}));

// Force the lift-sync step to fail so the transaction must roll back.
jest.mock('../modules/progress/strength-logs.repo', () => ({
  assessmentBelongs: jest.fn().mockResolvedValue(true),
  insertLog: jest.fn().mockRejectedValue(new Error('injected lift-sync failure')),
  findLog: jest.fn(), updateLog: jest.fn(), deleteLog: jest.fn().mockResolvedValue(true),
}));

const ORG = mockUser.organization_id;
const CID = 'rb-client';

describeIf('assessment rollback on lift-sync failure', () => {
  let pool;
  let app;

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Rb Audit', 'rb-audit') ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active) VALUES ($1, 'Rb Trainer', 'rb-trainer@audit.test', '!not-a-hash', 'trainer', $2, TRUE) ON CONFLICT (id) DO NOTHING`, [mockUser.id, ORG]);
    await pool.query(`INSERT INTO pt_clients (id, name, mobile, organization_id, workout_experience_level) VALUES ($1, 'Rb Client', '+919000077777', $2, 'beginner') ON CONFLICT (id) DO NOTHING`, [CID, ORG]);
    await pool.query(`INSERT INTO pt_informed_consents (client_id, organization_id, full_name, status) VALUES ($1, $2, 'Rb Client', 'completed')`, [CID, ORG]);
    const answers = Array.from({ length: 10 }, (_, i) => ({ question_id: i + 1, answer: 'no' }));
    await pool.query(`INSERT INTO pt_parq_forms (client_id, full_name, parq_answers, parq_yes_count, risk_level, status, workout_gate_status, organization_id, assessment_date) VALUES ($1, 'Rb Client', $2::jsonb, 0, 'low', 'submitted', 'cleared', $3, CURRENT_DATE - 1)`, [CID, JSON.stringify(answers), ORG]);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/progress', require('../modules/progress/progress.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    for (const t of ['strength_logs', 'pt_assessments']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = $1`, [CID]);
    }
    await pool.query('DELETE FROM pt_informed_consents WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM pt_parq_forms WHERE client_id = $1', [CID]);
    await pool.query('DELETE FROM pt_clients WHERE id = $1', [CID]);
    await pool.query('DELETE FROM users WHERE id = $1', [mockUser.id]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  test('a failed lift sync rolls back the assessment row and client body', async () => {
    const before = await pool.query('SELECT weight FROM pt_clients WHERE id = $1', [CID]);
    const beforeWeight = before.rows[0].weight;

    const r = await require('supertest')(app).post('/api/progress/assessments').send({
      client_id: CID, assessment_date: '2026-10-01', assessment_type: 'initial',
      bp_systolic: 120, bp_diastolic: 80, weight: 90, height_cm: 175,
      strength_exercise: 'Bench Press', strength_exercise_2: 'Squat',
      strength_test_data: {
        test1: { weightKg: 60, reps: 8, formula: 'epley', isDirect: false },
        test2: { weightKg: 80, reps: 5, formula: 'epley', isDirect: false },
      },
    });
    // The request must fail (500 or 4xx) — not a 201.
    expect(r.status).not.toBe(201);

    // No assessment row persisted.
    const { rows } = await pool.query('SELECT * FROM pt_assessments WHERE client_id = $1', [CID]);
    expect(rows).toHaveLength(0);
    // Client body NOT updated (rolled back).
    const after = await pool.query('SELECT weight FROM pt_clients WHERE id = $1', [CID]);
    expect(after.rows[0].weight).toEqual(beforeWeight);
  });
});

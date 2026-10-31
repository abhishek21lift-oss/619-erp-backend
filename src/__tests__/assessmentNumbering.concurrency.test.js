'use strict';
// Per-client assessment numbers used to be `(SELECT COUNT(*)+1 ...)` inside
// the INSERT. Two saves for the same client at the same moment both read the
// same count and both become "Assessment 3", so the history shows two third
// assessments and no second. Fixed by taking a transaction-scoped advisory
// lock keyed per form and client, then numbering from MAX+1 inside it — the
// pattern pt_assessments and PAR-Q already use.
//
// The static block is the guard that runs in CI (there is no database there,
// same reasoning as tenantScope.convention.test.js). The live block proves
// the race is gone when RLS_TEST_DATABASE_URL is set.

const fs = require('fs');
const path = require('path');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;
const mockDbUrl = DB_URL;

jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 6 });
});

const ROUTES = path.join(__dirname, '..', 'modules', 'progress', 'progress.routes.js');

const FORMS = [
  ['/lifestyle-assessments', 'pt_lifestyle_assessments', 'lifestyle'],
  ['/nutrition-assessments', 'pt_nutrition_assessments', 'nutrition'],
  ['/mobility-performance-assessments', 'pt_mobility_performance_assessments', 'mobility'],
  ['/posture-assessments', 'pt_posture_assessments', 'posture'],
];

describe('per-client assessment numbering is serialised', () => {
  const src = fs.readFileSync(ROUTES, 'utf8');

  // Each handler's own body, so a match in a neighbouring route cannot
  // satisfy the assertion.
  const handler = (route) => {
    const start = src.indexOf(`router.post('${route}'`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('}));', start);
    return src.slice(start, end);
  };

  it.each(FORMS)('%s is numbered inside the per-client lock', (route, _table, key) => {
    const body = handler(route);
    expect(body).toContain(`withNumberLock(\`${key}:\${b.client_id}\``);
  });

  it.each(FORMS)('%s no longer counts rows inside the INSERT', (route, table) => {
    const body = handler(route);
    expect(body).not.toMatch(/COUNT\(\*\)/);
    expect(body).toContain('MAX(assessment_number)');
    expect(body).toContain(`FROM ${table}`);
  });

  it('the lock helper is transaction-scoped and always releases its connection', () => {
    const helper = src.slice(src.indexOf('async function withNumberLock'));
    expect(helper).toContain('pg_advisory_xact_lock');
    expect(helper).toMatch(/'BEGIN'/);
    expect(helper).toMatch(/'COMMIT'/);
    expect(helper).toMatch(/'ROLLBACK'/);
    expect(helper).toContain('tx.release()');
    // A leaked connection on error would strand the pool after the first bad save.
    expect(helper).toMatch(/finally\s*{[\s\S]*release/);
  });
});

const mockUser = {
  id: 'an-trainer-user', role: 'trainer', trainer_id: null,
  organization_id: 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9',
};
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  invalidateUserCache: jest.fn(),
}));

const ORG = mockUser.organization_id;
const CID = 'an-client';

describeIf('assessment numbering under concurrent saves, against a real database', () => {
  let pool;
  let request;

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Numbering Audit', 'numbering-audit')
      ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'Numbering Trainer', 'an-trainer@audit.test', '!not-a-hash', 'trainer', $2, TRUE)
      ON CONFLICT (id) DO NOTHING`, [mockUser.id, ORG]);
    await pool.query(`INSERT INTO pt_clients (id, name, mobile, organization_id, workout_experience_level)
      VALUES ($1, 'Numbering Client', '+919000077777', $2, 'beginner') ON CONFLICT (id) DO NOTHING`, [CID, ORG]);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/progress', require('../modules/progress/progress.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);
  });

  afterAll(async () => {
    for (const t of ['pt_lifestyle_assessments', 'pt_nutrition_assessments', 'pt_mobility_performance_assessments', 'pt_posture_assessments']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = $1`, [CID]);
    }
    await pool.query('DELETE FROM pt_clients WHERE id = $1', [CID]);
    await pool.query('DELETE FROM users WHERE id = $1', [mockUser.id]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  test('five simultaneous lifestyle saves get five consecutive numbers', async () => {
    const saves = Array.from({ length: 5 }, (_, i) =>
      request().post('/api/progress/lifestyle-assessments').send({ client_id: CID, stress_level: (i % 10) + 1 }));
    const responses = await Promise.all(saves);

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const numbers = responses.map((r) => r.body.data.assessment_number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });
});

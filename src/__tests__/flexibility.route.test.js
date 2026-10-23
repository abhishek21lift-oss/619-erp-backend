'use strict';
// POST/PATCH /progress/assessments with the K11 four-test flexibility payload
// (v3 in flexibility_test_data). The DB is mocked at the pool boundary; the
// route, validation and repository SQL all run for real.

const ORG_A = '11111111-1111-1111-1111-111111111111';

let mockQueries = [];
let mockExistingAssessment = null;

jest.mock('../db/pool', () => {
  // One handler for the pool and for transaction clients: the same statements
  // run through both.
  const run = async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^SELECT dob, gender/i.test(text)) {
      return { rows: [{ dob: '1990-05-01', gender: 'Male', workout_experience_level: 'intermediate' }], rowCount: 1 };
    }
    if (/^SELECT \* FROM pt_assessments/i.test(text)) {
      return { rows: mockExistingAssessment ? [mockExistingAssessment] : [], rowCount: mockExistingAssessment ? 1 : 0 };
    }
    if (/^SELECT COALESCE\(MAX\(assessment_number\)/i.test(text)) return { rows: [{ n: 1 }], rowCount: 1 };
    if (/^UPDATE pt_assessments/i.test(text)) {
      return { rows: [{ ...(mockExistingAssessment || { id: 'a1' }), id: 'a1' }], rowCount: 1 };
    }
    const keys = text.match(/^INSERT INTO pt_assessments \((.*?)\) VALUES/);
    if (keys) {
      const row = { id: 'a1', organization_id: ORG_A };
      keys[1].split(', ').forEach((k, i) => { row[k] = params[i]; });
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    query: jest.fn(run),
    connect: jest.fn(async () => ({ query: jest.fn(run), release: jest.fn() })),
  };
});
jest.mock('../lib/orgGuard', () => ({ clientInOrg: jest.fn(async () => true) }));
jest.mock('../lib/screeningGate', () => ({
  checkTrainingEligibility: jest.fn(async () => ({ blocked: null, warnings: [] })),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', trainer_id: 't1', organization_id: ORG_A }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { clientInOrg } = require('../lib/orgGuard');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/progress', require('../modules/progress/progress.routes'));
  a.use((err, _req, res, _next) => {
    // A 500 is a route bug, not a response under test. The status assertion
    // only says "500"; printing the stack says why, in the same log.
    if (!err.status || err.status >= 500) console.error(err.stack || err);
    return res.status(err.status || 500).json({ error: err.message });
  });
  return a;
}

const quadSide = (over = {}) => ({
  contact: true, distance_cm: null, pain: false, pelvic_compensation: false, tightness: 'Mild', notes: '', ...over,
});
const hamSide = (over = {}) => ({
  hip_flexion_deg: 75, knee_extended: true, pelvic_compensation: false, pain: false, tightness: 'Normal', notes: '', ...over,
});
const hipSide = (over = {}) => ({
  thigh_position: 'below', knee_flexion_deg: 30, pelvic_compensation: false, pain: false, tightness: 'Normal', notes: '', ...over,
});

function battery() {
  return {
    protocol_version: 'k11-2026.01',
    tests: {
      quadriceps: { sides: { left: quadSide(), right: quadSide() }, completed: true },
      hamstrings: { sides: { left: hamSide(), right: hamSide() }, completed: true },
      hip_flexors: { sides: { left: hipSide(), right: hipSide() }, completed: true },
      sit_and_reach: {
        attempts: [{ inches: 16, valid: true }], knee_bending: false, bouncing: false, notes: '', completed: true,
      },
    },
  };
}

const post = (body) => request(app()).post('/api/progress/assessments').send({
  client_id: 'c1', assessment_date: '2026-01-10', ...body,
});

const insertCols = () => {
  const q = mockQueries.find((x) => /^INSERT INTO pt_assessments/i.test(x.sql));
  if (!q) return null;
  const keys = q.sql.match(/^INSERT INTO pt_assessments \((.*?)\) VALUES/)[1].split(', ');
  const cols = {};
  keys.forEach((k, i) => { cols[k] = q.params[i]; });
  return cols;
};

beforeEach(() => {
  mockQueries = [];
  mockExistingAssessment = null;
  clientInOrg.mockResolvedValue(true);
});

describe('POST /progress/assessments — K11 battery', () => {
  test('stores the derived v3 payload, with the K11 sit-and-reach norm and no mobility score', async () => {
    const res = await post({ flexibility_test_data: battery() });
    expect(res.status).toBe(201);

    const cols = insertCols();
    const stored = JSON.parse(cols.flexibility_test_data);
    expect(stored.protocol_version).toBe('k11-2026.01');
    expect(stored.tests.quadriceps.sides_interpretation).toEqual({ left: 'Normal', right: 'Normal' });
    expect(stored.tests.sit_and_reach.score_inches).toBe(1); // 16 in − 15 in zero point
    expect(stored.tests.sit_and_reach.norm.category).toBe('Good'); // male 36, 16 in
    expect(stored.tests.sit_and_reach.norm.table_version).toBe('k11-2026.01-sit-and-reach');
    expect(stored.tests.sit_and_reach.norm.message).toBe('K11 age/sex sit-and-reach norm');
    expect(stored.assessor_id).toBe('u1'); // from the session, never the body
    expect(stored.override).toEqual({ used: false, reason: null, by: null, at: null });
    expect(typeof stored.recorded_at).toBe('string');
    expect(cols.flexibility_category).toBeNull();
    expect(cols.flexibility_category_2).toBeNull();
    expect(cols.mobility_score_computed).toBeNull();
    expect(cols.has_asymmetry).toBe(false);
  });

  test('refuses a battery with a test still to record', async () => {
    const body = battery();
    body.tests.hip_flexors.completed = false;
    const res = await post({ flexibility_test_data: body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FLEXIBILITY_INCOMPLETE');
    expect(res.body.error.message).toMatch(/Still to record: Hip Flexors \(Thomas test\)/);
    expect(insertCols()).toBeNull();
  });

  test('refuses an unable test without an override reason, and accepts it with one', async () => {
    const body = battery();
    body.tests.hamstrings = {
      completed: false, unable_to_complete: true, unable_reason: 'Acute hamstring strain — pain on stretch',
    };
    const refused = await post({ flexibility_test_data: body });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('FLEXIBILITY_INCOMPLETE');
    expect(refused.body.error.message).toMatch(/override reason/i);

    body.override = { reason: 'Physio advice — the other three tests were recorded' };
    const accepted = await post({ flexibility_test_data: body });
    expect(accepted.status).toBe(201);
    const stored = JSON.parse(insertCols().flexibility_test_data);
    expect(stored.override).toMatchObject({ used: true, by: 'u1', reason: 'Physio advice — the other three tests were recorded' });
    expect(typeof stored.override.at).toBe('string');
    expect(stored.overall_status).toBe('completed_with_override');
  });

  test('refuses unknown protocol versions and out-of-range values', async () => {
    const version = await post({ flexibility_test_data: { ...battery(), protocol_version: 'k11-2099.99' } });
    expect(version.status).toBe(400);
    expect(version.body.error.code).toBe('FLEXIBILITY_INVALID');

    const range = battery();
    range.tests.hamstrings.sides.left.hip_flexion_deg = 200;
    const outOfRange = await post({ flexibility_test_data: range });
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.error.code).toBe('FLEXIBILITY_INVALID');
    expect(insertCols()).toBeNull();
  });

  test('a legacy {test1,test2} blob still stores exactly as before', async () => {
    const legacy = { test1: { testType: 'Sit and Reach', left: 10, right: 12, score: 4 } };
    const res = await post({ flexibility_test_data: legacy });
    expect(res.status).toBe(201);
    const cols = insertCols();
    expect(JSON.parse(cols.flexibility_test_data)).toEqual(legacy);
    expect(cols.flexibility_category).toBe('Average'); // 4 → legacy 0-10 band unchanged
  });

  test('a client outside the studio is refused before anything is stored', async () => {
    clientInOrg.mockResolvedValueOnce(false);
    const res = await post({ flexibility_test_data: battery() });
    expect(res.status).toBe(404);
    expect(insertCols()).toBeNull();
  });
});

describe('PATCH /progress/assessments/:id — v3 payload', () => {
  /** The row as it comes back from a first save, plus the canonical stored string. */
  async function storedRow() {
    await post({ flexibility_test_data: battery() });
    const cols = insertCols();
    expect(cols).not.toBeNull();
    const stored = JSON.parse(cols.flexibility_test_data);
    mockExistingAssessment = {
      id: 'a1', client_id: 'c1', organization_id: ORG_A, assessment_type: 'initial',
      assessment_date: '2026-01-10', weight: '80', height_cm: '180', bmi: '24.7',
      flexibility_test_data: stored,
    };
    return JSON.stringify(stored);
  }

  test('an unrelated edit round-trips the stored battery byte-identically', async () => {
    const before = await storedRow();
    mockQueries = [];
    const res = await request(app()).patch('/api/progress/assessments/a1').send({ weight: 78 });
    expect(res.status).toBe(200);

    const upd = mockQueries.find((q) => /^UPDATE pt_assessments/i.test(q.sql));
    // Ownership is enforced on the read that finds the row, before the write.
    const find = mockQueries.find((q) => /^SELECT \* FROM pt_assessments/i.test(q.sql));
    expect(find.sql).toMatch(/organization_id/);
    const after = upd.params.find((p) => typeof p === 'string' && p.includes('protocol_version'));
    expect(after).toBe(before);
  });

  test('a legacy blob is also untouched by an unrelated edit', async () => {
    const legacy = { test1: { testType: 'Sit and Reach', left: 10, right: 12, score: 4 } };
    mockExistingAssessment = {
      id: 'a1', client_id: 'c1', organization_id: ORG_A, assessment_type: 'initial',
      assessment_date: '2026-01-10', weight: '80', height_cm: '180', bmi: '24.7',
      flexibility_test_data: legacy,
    };
    const res = await request(app()).patch('/api/progress/assessments/a1').send({ weight: 79 });
    expect(res.status).toBe(200);
    const upd = mockQueries.find((q) => /^UPDATE pt_assessments/i.test(q.sql));
    const found = upd.params.find((p) => typeof p === 'string' && p.includes('test1'));
    expect(JSON.parse(found)).toEqual(legacy);
  });
});

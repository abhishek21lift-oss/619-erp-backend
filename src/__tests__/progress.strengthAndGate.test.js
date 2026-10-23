// Strength logs and fitness testing (assessment modules audit 2026-09-28,
// A-5, S-5, S-7).
//
//   – a strength log is permanent, so it is bounded: no zero, negative or
//     superhuman weights, and no 1RM estimated from a rep count nobody sent;
//   – a direct 1RM is the weight lifted, once;
//   – an assessment link must be one of this studio's assessments;
//   – fitness testing (maximal efforts) is refused while screening blocks.
'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';

let mockBlocked = null;
let mockAssessmentOwned = true;
let mockExistingLog = null;
let mockClient = null;
const mockQueries = [];
const mockTx = () => ({
  query: jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^SELECT COALESCE\(MAX\(assessment_number\)/i.test(text)) return { rows: [{ n: 1 }], rowCount: 1 };
    if (/^INSERT INTO pt_assessments/i.test(text)) {
      return { rows: [{ id: 'a1', client_id: 'c1', organization_id: ORG_A, assessment_number: 1, assessment_date: '2026-01-01' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
});
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^SELECT 1 FROM pt_assessments/i.test(text)) return { rows: [], rowCount: mockAssessmentOwned ? 1 : 0 };
    if (/^SELECT dob, gender, workout_experience_level/i.test(text)) return { rows: mockClient ? [mockClient] : [], rowCount: mockClient ? 1 : 0 };
    if (/^INSERT INTO strength_logs/i.test(text)) return { rows: [{ id: 'sl-1' }], rowCount: 1 };
    if (/^SELECT \* FROM strength_logs/i.test(text)) return { rows: mockExistingLog ? [mockExistingLog] : [], rowCount: mockExistingLog ? 1 : 0 };
    if (/^UPDATE strength_logs/i.test(text)) return { rows: [{ id: 'sl-1' }], rowCount: 1 };
    if (/^DELETE FROM strength_logs/i.test(text)) return { rows: [], rowCount: mockExistingLog ? 1 : 0 };
    if (/FROM pt_mobility_performance_assessments/i.test(text)) {
      return { rows: [{ id: 'm1', body_regions: [{ region: 'Shoulder', score: 3, pain: true }], mobility_tests: null }], rowCount: 1 };
    }
    if (/FROM pt_posture_assessments/i.test(text)) {
      return { rows: [{ id: 'p1', front_issues: null, side_issues: null, back_issues: ['Scoliosis'] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => mockTx()),
}));
jest.mock('../lib/orgGuard', () => ({ clientInOrg: jest.fn(async () => true) }));
jest.mock('../lib/screeningGate', () => ({
  checkTrainingEligibility: jest.fn(async () => ({ blocked: mockBlocked, warnings: [] })),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', organization_id: ORG_A }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/progress', require('../modules/progress/progress.routes'));
  a.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}

const insertParams = () => mockQueries.find((q) => /^INSERT INTO strength_logs/i.test(q.sql))?.params;
const assessmentCols = () => {
  const q = mockQueries.find((x) => /^INSERT INTO pt_assessments/i.test(x.sql));
  if (!q) return null;
  const keys = q.sql.match(/INSERT INTO pt_assessments \(([^)]*)\)/i)[1].split(',').map((k) => k.trim());
  return Object.fromEntries(keys.map((k, i) => [k, q.params[i]]));
};
const lift = (extra) => ({ client_id: 'c1', exercise_name: 'Squat', weight_kg: 100, reps_done: 5, ...extra });
// Jan 1 makes the client exactly `age` on every run date (the birthday has
// passed or is today), so the K11 age band is deterministic in CI.
const dobForAge = (age) => `${new Date().getFullYear() - age}-01-01`;

beforeEach(() => { mockBlocked = null; mockAssessmentOwned = true; mockExistingLog = null; mockClient = null; mockQueries.length = 0; });

describe('POST /progress/strength-logs', () => {
  test.each([
    ['zero weight', { weight_kg: 0 }],
    ['negative weight', { weight_kg: -60 }],
    ['a 2000 kg typo', { weight_kg: 2000 }],
    ['zero reps', { reps_done: 0 }],
    ['no reps on an estimated 1RM', { reps_done: undefined }],
    ['a future date', { log_date: '2099-01-01' }],
  ])('refuses %s', async (_label, extra) => {
    const res = await request(app()).post('/api/progress/strength-logs').send(lift(extra));
    expect(res.status).toBe(400);
    expect(insertParams()).toBeUndefined();
  });

  test('a single is its own 1RM (Epley no longer adds 3.3%)', async () => {
    const res = await request(app()).post('/api/progress/strength-logs').send(lift({ weight_kg: 230, reps_done: 1 }));
    expect(res.status).toBe(201);
    expect(insertParams()[5]).toBe(230);
  });

  test('a direct 1RM with no estimate stores the weight lifted, as one rep', async () => {
    const res = await request(app()).post('/api/progress/strength-logs')
      .send(lift({ weight_kg: 260, reps_done: undefined, is_direct_1rm: true }));
    expect(res.status).toBe(201);
    const p = insertParams();
    expect(p[4]).toBe(1);
    expect(p[5]).toBe(260);
  });

  test('a backdated lift keeps its date', async () => {
    await request(app()).post('/api/progress/strength-logs').send(lift({ log_date: '2026-01-15' }));
    expect(insertParams()[11]).toBe('2026-01-15');
  });

  test('an assessment id from outside the studio is refused', async () => {
    mockAssessmentOwned = false;
    const res = await request(app()).post('/api/progress/strength-logs').send(lift({ assessment_id: 'a-foreign' }));
    expect(res.status).toBe(404);
    expect(insertParams()).toBeUndefined();
  });
});

describe('POST /progress/assessments', () => {
  test('is refused while screening blocks the client', async () => {
    mockBlocked = { status: 403, body: { error: 'blocked', code: 'PARQ_BLOCKED' } };
    const res = await request(app()).post('/api/progress/assessments').send({ client_id: 'c1' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PARQ_BLOCKED');
    expect(mockQueries.some((q) => /INSERT INTO pt_assessments/i.test(q.sql))).toBe(false);
  });
});

describe('anthropometric classifications are persisted', () => {
  const body = { client_id: 'c1', weight: 80, height_cm: 175, waist_cm: 92, waist_iliac_cm: 74, hips_cm: 94 };

  beforeEach(() => {
    mockClient = { gender: 'Male', dob: '1998-04-12', workout_experience_level: 'intermediate' };
  });

  test('stores the Asian BMI band and sex-specific waist/WHR risk from waist_cm', async () => {
    const res = await request(app()).post('/api/progress/assessments').send(body);
    expect(res.status).toBe(201);
    const cols = assessmentCols();
    expect(cols.bmi).toBe(26.1);
    expect(cols.bmi_category).toBe('Obese');
    // If the 74 cm iliac reading had been substituted, this would be Low risk.
    expect(cols.waist_risk).toBe('Above low-risk threshold');
    expect(cols.whr_risk).toBe('Above low-risk threshold');
    expect(cols.waist_iliac_cm).toBe(74);
    expect(cols.waist_hip_ratio).toBe(0.98);
  });

  test('missing waist_cm is never replaced by waist_iliac_cm', async () => {
    const res = await request(app()).post('/api/progress/assessments')
      .send({ ...body, waist_cm: undefined });
    expect(res.status).toBe(201);
    const cols = assessmentCols();
    expect(cols.waist_cm).toBeNull();
    expect(cols.waist_risk).toBeNull();
    expect(cols.waist_hip_ratio).toBeNull();
    expect(cols.whr_risk).toBeNull();
  });

  test('unsupported sex leaves waist/WHR unclassified but still bands BMI', async () => {
    mockClient = { gender: 'Other', dob: '1998-04-12', workout_experience_level: 'intermediate' };
    const res = await request(app()).post('/api/progress/assessments').send(body);
    expect(res.status).toBe(201);
    const cols = assessmentCols();
    expect(cols.bmi_category).toBe('Obese');
    expect(cols.waist_risk).toBeNull();
    expect(cols.whr_risk).toBeNull();
  });
});

describe('K11 YMCA step-test category is persisted from client demographics', () => {
  const body = {
    client_id: 'c1', bp_systolic: 118, bp_diastolic: 70,
    cardio_test_type: 'YMCA 3-Minute Step Test', cardio_test_data: { recoveryHr: 90 },
  };

  test('a 30-year-old male at 90 bpm stores Above Average and 70', async () => {
    mockClient = { gender: 'Male', dob: dobForAge(30), workout_experience_level: 'intermediate' };
    const res = await request(app()).post('/api/progress/assessments').send(body);
    expect(res.status).toBe(201);
    const cols = assessmentCols();
    expect(cols.cardio_category).toBe('Above Average');
    expect(cols.cardio_score_computed).toBe(70);
  });

  test('a 30-year-old female at 94 bpm is graded on the female table', async () => {
    mockClient = { gender: 'Female', dob: dobForAge(30), workout_experience_level: 'intermediate' };
    const res = await request(app()).post('/api/progress/assessments').send(body);
    expect(res.status).toBe(201);
    const cols = assessmentCols();
    expect(cols.cardio_category).toBe('Good');
    expect(cols.cardio_score_computed).toBe(80);
  });

  test('the female 46–55 source gap at 94 bpm stays unclassified, never scored', async () => {
    mockClient = { gender: 'Female', dob: dobForAge(50), workout_experience_level: 'intermediate' };
    const res = await request(app()).post('/api/progress/assessments')
      .send({ ...body, cardio_test_data: { recoveryHr: 94 } });
    expect(res.status).toBe(201);
    expect(assessmentCols().cardio_category).toBeNull();
    expect(assessmentCols().cardio_score_computed).toBeNull();
  });

  test('outside 18–55 there is no K11 category and no invented score', async () => {
    mockClient = { gender: 'Male', dob: dobForAge(60), workout_experience_level: 'intermediate' };
    const res = await request(app()).post('/api/progress/assessments').send(body);
    expect(res.status).toBe(201);
    expect(assessmentCols().cardio_category).toBeNull();
    expect(assessmentCols().cardio_score_computed).toBeNull();
  });
});

describe('unsafe resting blood pressure stops exertion tests', () => {
  test('stage-2 hypertension with a strength test is refused', async () => {
    const res = await request(app()).post('/api/progress/assessments')
      .send({ client_id: 'c1', bp_systolic: 165, bp_diastolic: 95, strength_exercise: 'Squat' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BP_UNSAFE');
    expect(mockQueries.some((q) => /INSERT INTO pt_assessments/i.test(q.sql))).toBe(false);
  });

  test('hypotension with a cardio test is refused', async () => {
    const res = await request(app()).post('/api/progress/assessments')
      .send({ client_id: 'c1', bp_systolic: 85, bp_diastolic: 55, cardio_test_type: 'YMCA 3-Minute Step Test' });
    expect(res.status).toBe(400);
  });

  test('a hypertensive crisis reading is refused', async () => {
    const res = await request(app()).post('/api/progress/assessments')
      .send({ client_id: 'c1', bp_systolic: 185, bp_diastolic: 122, cardio_test_type: 'YMCA 3-Minute Step Test' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BP_UNSAFE');
  });
});

describe('other resting vitals stop exertion tests', () => {
  test('critical SpO₂ is refused', async () => {
    const res = await request(app()).post('/api/progress/assessments')
      .send({ client_id: 'c1', bp_systolic: 118, bp_diastolic: 70, resting_spo2: 88, cardio_test_type: 'YMCA 3-Minute Step Test' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SPO2_UNSAFE');
  });

  test('a resting heart rate above 100 is refused', async () => {
    const res = await request(app()).post('/api/progress/assessments')
      .send({ client_id: 'c1', bp_systolic: 118, bp_diastolic: 70, resting_heart_rate: 110, strength_exercise: 'Squat' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RHR_UNSAFE');
  });

  test('stage-1 blood pressure is a caution and does not block', async () => {
    const res = await request(app()).post('/api/progress/assessments')
      .send({ client_id: 'c1', bp_systolic: 135, bp_diastolic: 85, cardio_test_type: 'YMCA 3-Minute Step Test' });
    expect(res.status).toBe(201);
    expect(res.body.data.vitals_safety.level).toBe('caution');
    expect(mockQueries.some((q) => /INSERT INTO pt_assessments/i.test(q.sql))).toBe(true);
  });

  test('a trained athlete\'s 45 bpm is context, not a caution', async () => {
    mockClient = { workout_experience_level: 'athlete' };
    const res = await request(app()).post('/api/progress/assessments')
      .send({ client_id: 'c1', bp_systolic: 118, bp_diastolic: 70, resting_heart_rate: 45, cardio_test_type: 'YMCA 3-Minute Step Test' });
    expect(res.status).toBe(201);
    expect(res.body.data.vitals_safety.level).toBe('safe');
    expect(res.body.data.vitals_safety.athleteLowRhr).toBe(true);
  });
});

describe('PATCH / DELETE /progress/strength-logs/:id', () => {
  const existing = {
    id: 'sl-1', exercise_name: 'Squat', weight_kg: '2000.00', sets_done: 3, reps_done: 5,
    one_rm_formula: 'epley', is_direct_1rm: false, notes: null, log_date: '2026-09-01',
  };

  test('corrects a typo and recomputes the 1RM from the merged row', async () => {
    mockExistingLog = existing;
    const res = await request(app()).patch('/api/progress/strength-logs/sl-1').send({ weight_kg: 200 });
    expect(res.status).toBe(200);
    const upd = mockQueries.find((q) => /^UPDATE strength_logs/i.test(q.sql));
    expect(upd.params[2]).toBe(200);
    expect(upd.params[5]).toBeCloseTo(233.3, 1);
  });

  test('is bounded like create, and 404s outside the studio', async () => {
    mockExistingLog = existing;
    expect((await request(app()).patch('/api/progress/strength-logs/sl-1').send({ weight_kg: 0 })).status).toBe(400);
    mockExistingLog = null;
    expect((await request(app()).patch('/api/progress/strength-logs/sl-x').send({ weight_kg: 100 })).status).toBe(404);
    const find = mockQueries.find((q) => /^SELECT \* FROM strength_logs/i.test(q.sql));
    expect(find.sql).toMatch(/organization_id/);
  });

  test('deletes a studio\'s own log; 404 otherwise', async () => {
    mockExistingLog = existing;
    expect((await request(app()).delete('/api/progress/strength-logs/sl-1')).status).toBe(204);
    mockExistingLog = null;
    expect((await request(app()).delete('/api/progress/strength-logs/sl-x')).status).toBe(404);
    expect(mockQueries.find((q) => /^DELETE FROM strength_logs/i.test(q.sql)).sql).toMatch(/organization_id/);
  });
});

describe('referrals are derived on every read', () => {
  test('pain on a mobility screen', async () => {
    const res = await request(app()).get('/api/progress/mobility-performance-assessments').query({ client_id: 'c1' });
    expect(res.body.data[0].referrals).toEqual([expect.stringMatching(/Pain on Shoulder.*physiotherapist/)]);
  });

  test('suspected scoliosis on a posture screen', async () => {
    const res = await request(app()).get('/api/progress/posture-assessments').query({ client_id: 'c1' });
    expect(res.body.data[0].referrals).toEqual([expect.stringMatching(/scoliosis/i)]);
  });
});

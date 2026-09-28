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
const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^SELECT 1 FROM pt_assessments/i.test(text)) return { rows: [], rowCount: mockAssessmentOwned ? 1 : 0 };
    if (/^INSERT INTO strength_logs/i.test(text)) return { rows: [{ id: 'sl-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));
jest.mock('../lib/orgGuard', () => ({ clientInOrg: jest.fn(async () => true) }));
jest.mock('../lib/screeningGate', () => ({
  checkScreeningGate: jest.fn(async () => ({ blocked: mockBlocked, warnings: [] })),
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
const lift = (extra) => ({ client_id: 'c1', exercise_name: 'Squat', weight_kg: 100, reps_done: 5, ...extra });

beforeEach(() => { mockBlocked = null; mockAssessmentOwned = true; mockQueries.length = 0; });

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

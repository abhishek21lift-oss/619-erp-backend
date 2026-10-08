// The trainer's weekly check-in (screening audit 2026-10-08, M2).
//
//   – a week is the ISO week starting Monday, the same week the member app
//     writes, so the two sides of one week land on one row;
//   – every value is bounded like the member app's;
//   – a trainer save never erases what the member reported, and never
//     writes the member's own notes.
'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

let mockInOrg = true;
const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^INSERT INTO weekly_checkins/i.test(text)) return { rows: [{ id: 'wc-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));
jest.mock('../lib/orgGuard', () => ({ clientInOrg: jest.fn(async () => mockInOrg) }));
jest.mock('../lib/screeningGate', () => ({ checkTrainingEligibility: jest.fn(async () => ({ blocked: null, warnings: [] })) }));
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

const post = (body) => request(app()).post('/api/progress/weekly-checkins')
  .send({ client_id: CLIENT, week_start_date: '2026-10-05', ...body });
const insert = () => mockQueries.find((q) => /^INSERT INTO weekly_checkins/i.test(q.sql));

beforeEach(() => { mockInOrg = true; mockQueries.length = 0; });

test('a day inside the week is saved against that week\'s Monday', async () => {
  const res = await post({ week_start_date: '2026-10-04' }); // the Sunday the old page defaulted to
  expect(res.status).toBe(201);
  expect(insert().params[1]).toBe('2026-09-28');
});

test.each([
  ['no week', { week_start_date: undefined }],
  ['a week that is not a date', { week_start_date: '2026-10-0x' }],
  ['a day February does not have', { week_start_date: '2026-02-31' }],
  ['a weight no one weighs', { weight: 4000 }],
  ['a 30-hour night', { sleep_hours: 30 }],
  ['adherence over 100%', { adherence_pct: 140 }],
  ['a stress level of 11', { stress_level: 11 }],
  ['a mood the app does not offer', { mood: 'ecstatic' }],
  ['a client id that is not an id', { client_id: 'c1' }],
])('%s is a 400 and nothing is written', async (_label, body) => {
  const res = await post(body);
  expect(res.status).toBe(400);
  expect(insert()).toBeUndefined();
});

test('a client from another studio is a 404', async () => {
  mockInOrg = false;
  const res = await post({ weight: 70 });
  expect(res.status).toBe(404);
  expect(insert()).toBeUndefined();
});

test('the member\'s values survive a trainer save that leaves them blank', async () => {
  await post({ adherence_pct: 80 });
  const { sql } = insert();
  for (const col of ['weight', 'mood', 'sleep_hours', 'water_glasses', 'stress_level', 'energy_level', 'soreness_level']) {
    expect(sql).toContain(`${col} = COALESCE(EXCLUDED.${col}, weekly_checkins.${col})`);
  }
  expect(sql).toContain('trainer_notes = EXCLUDED.trainer_notes');
});

test('the member\'s own notes are never written by the trainer', async () => {
  await post({ client_notes: 'overwritten?', trainer_notes: 'Good week' });
  expect(insert().sql).not.toMatch(/client_notes/);
});

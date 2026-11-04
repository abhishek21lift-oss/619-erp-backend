'use strict';
// Mental Health Perception and Stress Management Techniques are asked in the
// Lifestyle assessment and owned by it. They are optional, so an older client
// that omits them still creates a row; a supplied value is range/keys checked
// here so a bad answer is a 400, not a database constraint violation.
//
// The pool is mocked for the same reason assessmentFreshness.test.js does it:
// these are route contracts, not SQL-engine tests. The real-database suites
// stay behind RLS_TEST_DATABASE_URL.

const express = require('express');
const request = require('supertest');

const ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';

let mockQueries = [];
let mockClientInOrg = true;
let mockLifestyleRows = [];

jest.mock('../db/pool', () => {
  const query = jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ text, params });
    if (/^SELECT 1 FROM pt_clients/i.test(text)) {
      return { rows: mockClientInOrg ? [{ ok: 1 }] : [], rowCount: mockClientInOrg ? 1 : 0 };
    }
    if (/SELECT water_intake_liters, meals_per_day, breakfast_regularity, late_night_eating/i.test(text)) {
      return { rows: [{}], rowCount: 1 };
    }
    if (/^SELECT \* FROM pt_lifestyle_assessments WHERE id =/i.test(text)) {
      return { rows: mockLifestyleRows, rowCount: mockLifestyleRows.length };
    }
    if (/^UPDATE pt_lifestyle_assessments SET/i.test(text)) {
      return { rows: [{ id: 'l1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const clientQuery = jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ text, params });
    if (/^INSERT INTO pt_lifestyle_assessments/i.test(text)) return { rows: [{ id: 'new-l1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return {
    query,
    connect: jest.fn(async () => ({ query: clientQuery, release: jest.fn() })),
  };
});
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', organization_id: ORG }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }));

const app = express();
app.use(express.json());
app.use('/api/progress', require('../modules/progress/progress.routes'));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

const post = (extra = {}) => request(app)
  .post('/api/progress/lifestyle-assessments')
  .send({ client_id: CLIENT, ...extra });

const inserts = () => mockQueries.filter((q) => /^INSERT INTO pt_lifestyle_assessments/i.test(q.text));
const updates = () => mockQueries.filter((q) => /^UPDATE pt_lifestyle_assessments SET/i.test(q.text));

beforeEach(() => {
  mockQueries = [];
  mockClientInOrg = true;
  mockLifestyleRows = [];
});

describe('Lifestyle — mental health and stress management', () => {
  it('stores both answers on create', async () => {
    const res = await post({
      mental_health_perception: 7,
      stress_management_techniques: ['exercise', 'therapy'],
    });

    expect(res.status).toBe(201);
    const [insert] = inserts();
    expect(insert.text).toMatch(/mental_health_perception/);
    expect(insert.text).toMatch(/stress_management_techniques/);
    expect(insert.params).toContain(7);
    expect(insert.params).toContainEqual(['exercise', 'therapy']);
  });

  it('stores null when the client skips both questions', async () => {
    const res = await post();

    expect(res.status).toBe(201);
    expect(inserts()[0].params.slice(-2)).toEqual([null, null]);
  });

  it('rejects a rating outside 1–10', async () => {
    expect((await post({ mental_health_perception: 11 })).status).toBe(400);
    expect((await post({ mental_health_perception: 0 })).status).toBe(400);
  });

  it('rejects an unknown technique key', async () => {
    const res = await post({ stress_management_techniques: ['shouting'] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.fields)).toMatch(/stress_management_techniques/);
  });

  it('rejects none combined with another technique', async () => {
    const res = await post({ stress_management_techniques: ['none', 'exercise'] });

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty('stress_management_techniques');
  });

  it('updates both answers through PATCH', async () => {
    mockLifestyleRows = [{ id: 'l1', client_id: CLIENT, assessment_date: '2026-10-01', stress_level: 5 }];

    const res = await request(app)
      .patch('/api/progress/lifestyle-assessments/l1')
      .send({ mental_health_perception: 8, stress_management_techniques: ['nature'] });

    expect(res.status).toBe(200);
    const [update] = updates();
    expect(update.text).toMatch(/mental_health_perception = \$/);
    expect(update.text).toMatch(/stress_management_techniques = \$/);
    expect(update.params).toContain(8);
    expect(update.params).toContainEqual(['nature']);
  });

  it('keeps a foreign client out before any insert', async () => {
    mockClientInOrg = false;

    const res = await post({ mental_health_perception: 7 });

    expect(res.status).toBe(404);
    expect(inserts()).toHaveLength(0);
  });

  it('does not fail an older client that sends an unknown key', async () => {
    const res = await post({ unknown_future_field: true });

    expect(res.status).toBe(201);
  });
});

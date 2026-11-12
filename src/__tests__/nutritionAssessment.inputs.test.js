'use strict';
// The diet engine needs dietary pattern, food culture, regional cuisines and
// meal timing. None of them was asked anywhere, so every generated plan
// guessed. This pins the capture surface: schema, INSERT params, PATCH
// allowlist.

const express = require('express');
const request = require('supertest');

const ORG = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';

let mockQueries = [];
let mockExisting = null;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ text, params });
    if (/^SELECT 1 FROM pt_clients/i.test(text)) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (/^SELECT \* FROM pt_nutrition_assessments WHERE id = \$1/i.test(text)) {
      return { rows: mockExisting ? [mockExisting] : [], rowCount: mockExisting ? 1 : 0 };
    }
    if (/^UPDATE pt_nutrition_assessments SET/i.test(text)) return { rows: [{ id: 'n1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => ({
    query: async (sql, params = []) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      mockQueries.push({ text, params });
      if (/^INSERT INTO pt_nutrition_assessments/i.test(text)) return { rows: [{ id: 'n1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  })),
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', organization_id: ORG }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));

const app = express();
app.use(express.json());
app.use('/api/progress', require('../modules/progress/progress.routes'));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

const insertOf = () => mockQueries.find((q) => /^INSERT INTO pt_nutrition_assessments/i.test(q.text));
const updateOf = () => mockQueries.find((q) => /^UPDATE pt_nutrition_assessments SET/i.test(q.text));

beforeEach(() => {
  mockQueries = [];
  mockExisting = null;
});

describe('the planning inputs reach the row', () => {
  it('stores pattern, culture, cuisines and timing', async () => {
    const res = await request(app).post('/api/progress/nutrition-assessments').send({
      client_id: CLIENT,
      dietary_pattern: 'vegetarian',
      food_culture: 'indian',
      regional_cuisines: ['South Indian', 'Punjabi'],
      meal_timing_preference: 'early',
    });

    expect(res.status).toBe(201);
    const insert = insertOf();
    expect(insert.text).toContain(
      'dietary_pattern, food_culture, regional_cuisines, meal_timing_preference',
    );
    // The four columns are appended after organization_id so no existing
    // placeholder moved.
    expect(insert.params[42]).toBe(ORG);
    expect(insert.params.slice(43)).toEqual([
      'vegetarian', 'indian', ['South Indian', 'Punjabi'], 'early',
    ]);
  });

  it('stores null when the trainer left them blank', async () => {
    const res = await request(app).post('/api/progress/nutrition-assessments').send({
      client_id: CLIENT, dietary_pattern: null, regional_cuisines: [],
    });

    expect(res.status).toBe(201);
    expect(insertOf().params.slice(43)).toEqual([null, null, null, null]);
  });

  it('refuses a pattern the engine cannot act on', async () => {
    const res = await request(app).post('/api/progress/nutrition-assessments').send({
      client_id: CLIENT, dietary_pattern: 'keto',
    });

    expect(res.status).toBe(400);
    expect(insertOf()).toBeUndefined();
  });

  it('refuses six cuisines or an oversized one', async () => {
    const many = await request(app).post('/api/progress/nutrition-assessments').send({
      client_id: CLIENT, regional_cuisines: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(many.status).toBe(400);

    const long = await request(app).post('/api/progress/nutrition-assessments').send({
      client_id: CLIENT, regional_cuisines: ['x'.repeat(41)],
    });
    expect(long.status).toBe(400);

    expect(insertOf()).toBeUndefined();
  });

  it('accepts the same fields on PATCH', async () => {
    mockExisting = { id: 'n1', client_id: CLIENT, assessment_date: '2026-11-01' };

    const res = await request(app).patch('/api/progress/nutrition-assessments/n1')
      .send({ food_culture: 'western' });

    expect(res.status).toBe(200);
    const update = updateOf();
    expect(update.text).toContain('food_culture');
    expect(update.params).toContain('western');
  });
});

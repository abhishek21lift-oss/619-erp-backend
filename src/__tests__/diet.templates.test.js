'use strict';
// POST /api/diet/templates — validation and one transaction.
//
// The route used to default every macro with `parseFloat(...) || 0`, so a
// blank protein box was stored as a measured zero, and it inserted the
// template before it knew whether the meal ids existed. These tests pin:
//   · absent macros stay NULL; negative or non-numeric is refused
//   · goal and calorie validation
//   · a meal id outside the studio refuses the whole write
//   · template + links commit together, or roll back together

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];
let mockMealRows = [{ id: 'meal-1' }];
let mockFailOn = null;

const mockClient = {
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    if (mockFailOn && mockFailOn.test(flat)) throw new Error('boom');
    if (/FROM meals/i.test(flat)) return { rows: mockMealRows, rowCount: mockMealRows.length };
    if (/INSERT INTO diet_templates/i.test(flat)) {
      return { rows: [{ id: 'tpl-new', name: params[1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: jest.fn(async () => mockClient),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'trainer', organization_id: ORG_A, trainer_id: null };
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/diet', require('../routes/diet'));

const statements = (re) => mockQueries.filter((q) => re.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockMealRows = [{ id: 'meal-1' }];
  mockFailOn = null;
  mockClient.release.mockClear();
});

const valid = () => ({
  name: 'Cut 1',
  goal: 'weight_loss',
  daily_calories: 1800,
  daily_protein_g: 140,
  meals: [{ meal_id: 'meal-1' }],
});

describe('POST /api/diet/templates', () => {
  it('writes the template and its links in one transaction', async () => {
    const res = await request(app).post('/api/diet/templates').send(valid()).expect(201);
    expect(res.body.template.id).toBe('tpl-new');

    expect(mockQueries[0].sql).toBe('BEGIN');
    expect(mockQueries[mockQueries.length - 1].sql).toBe('COMMIT');
    expect(statements(/^INSERT INTO diet_templates/i)).toHaveLength(1);
    expect(statements(/^INSERT INTO diet_plan_meals/i)).toHaveLength(1);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('leaves a blank macro NULL rather than storing a measured zero', async () => {
    await request(app).post('/api/diet/templates').send({
      ...valid(), daily_protein_g: '', daily_carbs_g: undefined, daily_fats_g: null,
    }).expect(201);

    const [insert] = statements(/^INSERT INTO diet_templates/i);
    // $1 id, $2 name, $3 description, $4 goal, $5 calories,
    // $6 protein, $7 carbs, $8 fats, $9 user, $10 org
    expect(insert.params[5]).toBeNull();
    expect(insert.params[6]).toBeNull();
    expect(insert.params[7]).toBeNull();
  });

  it('refuses a negative macro', async () => {
    const res = await request(app).post('/api/diet/templates').send({
      ...valid(), daily_protein_g: -1,
    });
    expect(res.status).toBe(400);
    expect(mockQueries).toHaveLength(0);
  });

  it('refuses a non-numeric macro', async () => {
    const res = await request(app).post('/api/diet/templates').send({
      ...valid(), daily_carbs_g: 'lots',
    });
    expect(res.status).toBe(400);
    expect(mockQueries).toHaveLength(0);
  });

  it('refuses a goal outside the template set', async () => {
    const res = await request(app).post('/api/diet/templates').send({
      ...valid(), goal: 'fat_loss',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/goal must be one of/i);
    expect(mockQueries).toHaveLength(0);
  });

  it('refuses fractional calories', async () => {
    const res = await request(app).post('/api/diet/templates').send({
      ...valid(), daily_calories: 1800.5,
    });
    expect(res.status).toBe(400);
    expect(mockQueries).toHaveLength(0);
  });

  it('keeps the historical 2000 default when calories are absent', async () => {
    await request(app).post('/api/diet/templates').send({
      name: 'Bare', meals: [],
    }).expect(201);

    const [insert] = statements(/^INSERT INTO diet_templates/i);
    expect(insert.params[4]).toBe(2000);
  });

  it('refuses a meal id the studio cannot see, before inserting the template', async () => {
    mockMealRows = [];
    const res = await request(app).post('/api/diet/templates').send(valid());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/meal not found/i);
    expect(statements(/^INSERT INTO diet_templates/i)).toHaveLength(0);
    expect(mockQueries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('binds the caller studio into the meal-visibility query', async () => {
    await request(app).post('/api/diet/templates').send(valid()).expect(201);
    const [check] = statements(/FROM meals/i);
    expect(check.sql).toMatch(/organization_id IS NULL OR organization_id = \$2/i);
    expect(check.params[1]).toBe(ORG_A);
  });

  it('rolls back when the template insert fails', async () => {
    mockFailOn = /INSERT INTO diet_templates/i;
    const res = await request(app).post('/api/diet/templates').send(valid());
    expect(res.status).toBe(500);
    expect(mockQueries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
    expect(mockClient.release).toHaveBeenCalled();
  });
});

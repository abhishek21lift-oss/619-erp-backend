'use strict';
// POST /api/diet/plans/from-ai — saving a reviewed AI diet as a real diet.
//
// The generator's plans could only be previewed, so trainers retyped them.
// What this file holds:
//   · trainer-only, and the client must be in the caller's studio (404)
//   · template, meals, links and assignment are written in ONE transaction,
//     every studio-owned row stamped with the caller's studio
//   · anything malformed or out of range is refused (400) before a write
//   · a failure mid-way rolls the whole plan back

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];
let mockClientInOrg = true;
let mockFailOn = null;

const mockClient = {
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    if (mockFailOn && mockFailOn.test(flat)) throw new Error('boom');
    if (/RETURNING \*/i.test(flat)) return { rows: [{ id: 'as-1', status: 'active' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM pt_clients/i.test(flat)) return { rows: [], rowCount: mockClientInOrg ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => mockClient),
}));

let mockCurrentUser = { id: 'usr-1', role: 'trainer', organization_id: ORG_A, trainer_id: null };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');
const { mealType, templateGoal, normalisePlan } = require('../modules/nutrition/ai-diet.service');

const app = express();
app.use(express.json());
app.use('/api/diet', require('../routes/diet'));

const PLAN = {
  name: 'High-Protein Fat Loss Plan',
  description: 'Balanced Indian meals',
  goal: 'fat_loss',
  total_calories: 2100,
  macros: { protein_g: 160, carbs_g: 200, fat_g: 70 },
  meal_frequency: 3,
  meals: [
    { name: 'Breakfast', time: '08:00', calories: 500, protein_g: 35, carbs_g: 50, fat_g: 15,
      foods: [{ name: 'Oats', quantity: '60 g', calories: 230, protein_g: 8, carbs_g: 40, fat_g: 4 }] },
    { name: 'Lunch', time: '13:30', calories: 800, protein_g: 60, carbs_g: 80, fat_g: 25, foods: [] },
    { name: 'Dinner', time: '20:00', calories: 800, protein_g: 65, carbs_g: 70, fat_g: 30, foods: [] },
  ],
  notes: 'Drink water',
};

const inserts = (table) => mockQueries.filter((q) => new RegExp(`^INSERT INTO ${table}\\b`, 'i').test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockClientInOrg = true;
  mockFailOn = null;
  mockClient.release.mockClear();
  mockCurrentUser = { id: 'usr-1', role: 'trainer', organization_id: ORG_A, trainer_id: null };
});

describe('POST /api/diet/plans/from-ai', () => {
  it('writes the template, every meal, their links and an active assignment in one transaction', async () => {
    const res = await request(app).post('/api/diet/plans/from-ai').send({ client_id: 'cl-1', plan: PLAN });
    expect(res.status).toBe(201);
    expect(res.body.meals).toBe(3);

    expect(mockQueries[0].sql).toBe('BEGIN');
    expect(mockQueries[mockQueries.length - 1].sql).toBe('COMMIT');
    expect(inserts('diet_templates')).toHaveLength(1);
    expect(inserts('meals')).toHaveLength(3);
    expect(inserts('diet_plan_meals')).toHaveLength(3);
    expect(inserts('diet_assignments')).toHaveLength(1);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('stamps every studio-owned row with the caller studio', async () => {
    await request(app).post('/api/diet/plans/from-ai').send({ client_id: 'cl-1', plan: PLAN }).expect(201);
    for (const q of [...inserts('diet_templates'), ...inserts('meals'), ...inserts('diet_assignments')]) {
      expect(q.params).toContain(ORG_A);
    }
  });

  it('maps the generator goal onto the template goal set', async () => {
    await request(app).post('/api/diet/plans/from-ai').send({ client_id: 'cl-1', plan: PLAN }).expect(201);
    expect(inserts('diet_templates')[0].params).toContain('weight_loss');
  });

  it('refuses a client outside the studio with 404 and writes nothing', async () => {
    mockClientInOrg = false;
    const res = await request(app).post('/api/diet/plans/from-ai').send({ client_id: 'cl-x', plan: PLAN });
    expect(res.status).toBe(404);
    expect(mockQueries).toHaveLength(0);
  });

  it('is trainer-only', async () => {
    mockCurrentUser = { id: 'usr-m', role: 'member', organization_id: ORG_A, pt_client_id: 'cl-1' };
    const res = await request(app).post('/api/diet/plans/from-ai').send({ client_id: 'cl-1', plan: PLAN });
    expect(res.status).toBe(403);
    expect(mockQueries).toHaveLength(0);
  });

  it.each([
    ['no meals', { ...PLAN, meals: [] }],
    ['impossible calories', { ...PLAN, total_calories: 90000 }],
    ['a negative macro', { ...PLAN, macros: { ...PLAN.macros, protein_g: -5 } }],
    ['a meal without a name', { ...PLAN, meals: [{ ...PLAN.meals[0], name: '' }] }],
  ])('refuses %s with 400 before any write', async (_label, plan) => {
    const res = await request(app).post('/api/diet/plans/from-ai').send({ client_id: 'cl-1', plan });
    expect(res.status).toBe(400);
    expect(mockQueries).toHaveLength(0);
  });

  it('rolls the whole plan back when a write fails part-way', async () => {
    mockFailOn = /^INSERT INTO diet_assignments/i;
    const res = await request(app).post('/api/diet/plans/from-ai').send({ client_id: 'cl-1', plan: PLAN });
    expect(res.status).toBe(500);
    expect(mockQueries.map((q) => q.sql)).toContain('ROLLBACK');
    expect(mockQueries.map((q) => q.sql)).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });
});

describe('plan normalisation', () => {
  it('keeps an absent macro unknown rather than zero', () => {
    const p = normalisePlan({ ...PLAN, meals: [{ name: 'Snack', time: '16:00', calories: 200 }] });
    expect(p.meals[0].protein_g).toBeNull();
  });

  it('puts the foods in the meal description', () => {
    expect(normalisePlan(PLAN).meals[0].description).toBe('60 g Oats');
  });

  it.each([
    ['Pre-workout shake', '17:00', 'pre_workout'],
    ['Post Workout', '19:00', 'post_workout'],
    ['Breakfast', '', 'breakfast'],
    ['Meal 2', '13:00', 'lunch'],
    ['Meal 3', '4:30 pm', 'snacks'],
    ['Meal 4', '20:30', 'dinner'],
    ['Something', '', 'snacks'],
  ])('%s at %s is %s', (name, time, type) => {
    expect(mealType(name, time)).toBe(type);
  });

  it.each([
    ['fat_loss', 'weight_loss'], ['Muscle Gain', 'muscle_gain'], ['general fitness', 'maintenance'],
    ['keto', 'keto'], ['something odd', 'custom'],
  ])('goal %s maps to %s', (goal, expected) => {
    expect(templateGoal(goal)).toBe(expected);
  });
});

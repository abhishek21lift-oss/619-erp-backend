'use strict';
// The save path now writes what the generator actually produced: one row per
// food, the meal's slot and clock time, and the calculation the plan was
// generated against. Legacy string quantities keep the old description path.

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];

const mockClient = {
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    if (/RETURNING \*/i.test(flat)) return { rows: [{ id: 'as-1', status: 'active' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: jest.fn(async () => mockClient),
}));

const { saveAiDietPlan, normalisePlan } = require('../modules/nutrition/ai-diet.service');

const inserts = (table) => mockQueries.filter((q) => new RegExp(`^INSERT INTO ${table}\\b`, 'i').test(q.sql));

const CALC = {
  version: '1.0.0',
  calorie_target: 2000,
  macros: { protein_g: 150, carbs_g: 200, fat_g: 60 },
  inputs: { weight_kg: 80, food_culture: 'indian', dietary_pattern: 'vegetarian' },
};

const PLAN = {
  name: 'Structured plan', description: '', goal: 'fat_loss',
  total_calories: 2000, macros: { protein_g: 150, carbs_g: 200, fat_g: 60 }, fiber_g: 30,
  meals: [
    {
      name: 'Pre-workout', slot: 'pre_workout', time: '05:30', day_offset: 0,
      calories: 200, protein_g: 20, carbs_g: 20, fat_g: 5,
      foods: [{
        name: 'Banana', quantity: 1, unit: 'medium', grams: 120,
        calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4, fiber_g: 3,
        food_id: 'food-banana', nutrition_source: 'reference',
      }],
    },
    {
      name: 'Post-workout', slot: 'post_workout', time: '00:00', day_offset: 1,
      calories: 300, protein_g: 30, carbs_g: 30, fat_g: 8,
      foods: [{
        name: 'Whey protein', quantity: 1, unit: 'scoop', grams: 30,
        calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5,
        nutrition_source: 'model',
      }],
    },
  ],
};

beforeEach(() => {
  mockQueries.length = 0;
  mockClient.release.mockClear();
});

test('writes one diet_meal_foods row per structured food', async () => {
  await saveAiDietPlan({
    plan: PLAN, clientId: 'cl-1', orgId: ORG_A, userId: 'usr-1', calculation: CALC,
  });
  const rows = inserts('diet_meal_foods');
  expect(rows).toHaveLength(2);
  expect(rows[0].params).toEqual(expect.arrayContaining(['Banana', 1, 'medium', 120, 'reference', 'food-banana']));
  expect(rows[1].params).toEqual(expect.arrayContaining(['Whey protein', 1, 'scoop', 30, 'model']));
});

test('writes slot, serve_time and day_offset on the plan meal link', async () => {
  await saveAiDietPlan({ plan: PLAN, clientId: 'cl-1', orgId: ORG_A, userId: 'usr-1' });
  const links = inserts('diet_plan_meals');
  expect(links[0].params).toEqual(expect.arrayContaining(['pre_workout', '05:30', 0]));
  expect(links[1].params).toEqual(expect.arrayContaining(['post_workout', '00:00', 1]));
});

test('writes the calculation onto the template', async () => {
  await saveAiDietPlan({
    plan: PLAN, clientId: 'cl-1', orgId: ORG_A, userId: 'usr-1', calculation: CALC,
  });
  const [t] = inserts('diet_templates');
  expect(t.sql).toContain('calculation_version');
  expect(t.params).toEqual(expect.arrayContaining(['1.0.0', JSON.stringify(CALC)]));
});

test('legacy string quantity writes no food rows and keeps the time as serving_size', async () => {
  const legacy = {
    ...PLAN,
    meals: [{
      name: 'Breakfast', time: '08:00', calories: 500,
      foods: [{ name: 'Oats', quantity: '60 g', calories: 230 }],
    }],
  };
  const out = await saveAiDietPlan({ plan: legacy, clientId: 'cl-1', orgId: ORG_A, userId: 'usr-1' });
  expect(inserts('diet_meal_foods')).toHaveLength(0);
  expect(inserts('meals')[0].params).toEqual(expect.arrayContaining(['08:00']));
  expect(out.meals).toBe(1);
});

test('normalisePlan keeps the schedule fields and structured foods', () => {
  const p = normalisePlan(PLAN);
  expect(p.fiber_g).toBe(30);
  expect(p.meals[0]).toMatchObject({ slot: 'pre_workout', serve_time: '05:30', day_offset: 0 });
  expect(p.meals[1]).toMatchObject({ serve_time: '00:00', day_offset: 1 });
  expect(p.meals[0].foods[0]).toMatchObject({
    food_id: 'food-banana', name: 'Banana', quantity: 1, unit: 'medium', grams: 120,
    nutrition_source: 'reference',
  });
  expect(p.meals[0].description).toBe('1 medium Banana');
});

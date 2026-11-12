'use strict';
// Food names are the model's words; a reference row is the studio's. Matching
// one to the other must be forgiving about spelling and strict about numbers:
// a wrong name is a lookup miss, a wrong calorie is a mislabelled plan.

const ORG = '11111111-1111-1111-1111-111111111111';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const {
  normaliseFoodName, loadFoodReference, stampPlanFoods,
} = require('../modules/nutrition/food-reference');

const FOODS = [
  {
    id: 'food-roti', organization_id: null, name: 'Roti', normalized_name: 'roti',
    aliases: ['chapati'], culture: 'indian', serving_unit: 'piece', serving_grams: 40,
    calories: 120, protein_g: 3.5, carbs_g: 24, fats_g: 1.2, fiber_g: 3,
  },
  {
    id: 'food-paneer', organization_id: null, name: 'Paneer (raw)', normalized_name: 'paneer raw',
    aliases: [], culture: 'indian', serving_unit: 'g', serving_grams: 100,
    calories: 265, protein_g: 18, carbs_g: 4, fats_g: 20, fiber_g: 0,
  },
  {
    id: 'food-org', organization_id: ORG, name: 'Studio Shake', normalized_name: 'studio shake',
    aliases: [], culture: 'mixed', serving_unit: 'scoop', serving_grams: 30,
    calories: 120, protein_g: 24, carbs_g: 3, fats_g: 1.5, fiber_g: 0,
  },
];

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: FOODS });
});

describe('normaliseFoodName', () => {
  test('folds case, brackets and punctuation', () => {
    expect(normaliseFoodName('  Paneer (Raw) ')).toBe('paneer raw');
    expect(normaliseFoodName('Dal & Rice')).toBe('dal and rice');
  });
});

describe('loadFoodReference', () => {
  test('matches by canonical name and alias, case-insensitively', async () => {
    const ref = await loadFoodReference(ORG);
    expect(ref.matchFood('PANEEr raw')?.id).toBe('food-paneer');
    expect(ref.matchFood('Paneer (raw)')?.id).toBe('food-paneer');
    expect(ref.matchFood('chapati')?.id).toBe('food-roti');
    expect(ref.matchFood('unknown dish')).toBeNull();
  });

  test('namesForCulture includes mixed foods and excludes other cultures', async () => {
    const ref = await loadFoodReference(ORG);
    expect(ref.namesForCulture('indian')).toEqual(
      expect.arrayContaining(['Roti', 'Paneer (raw)', 'Studio Shake']),
    );
    expect(ref.namesForCulture('western')).not.toContain('Roti');
    expect(ref.namesForCulture('western')).toContain('Studio Shake');
    expect(ref.namesForCulture('mixed')).toContain('Roti');
  });

  test('the query is tenant-scoped and active-only', async () => {
    await loadFoodReference(ORG);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('is_active = TRUE');
    expect(sql).toContain('organization_id IS NULL OR organization_id = $1');
    expect(pool.query.mock.calls[0][1]).toEqual([ORG]);
  });
});

describe('stampPlanFoods', () => {
  const plan = (food) => ({ meals: [{ name: 'Breakfast', foods: [food] }] });

  test('converts a per-unit quantity to grams and trusts matching numbers', async () => {
    const ref = await loadFoodReference(ORG);
    const stamped = stampPlanFoods(plan({
      name: 'Roti', quantity: 2, unit: 'piece', calories: 240,
    }), ref);
    const food = stamped.meals[0].foods[0];
    expect(food.food_id).toBe('food-roti');
    expect(food.grams).toBe(80);
    expect(food.nutrition_source).toBe('reference');
  });

  test('keeps the food_id but labels a calorie mismatch as model', async () => {
    const ref = await loadFoodReference(ORG);
    const stamped = stampPlanFoods(plan({
      // 150 g paneer is 397.5 kcal; 600 is ~50% over, outside the 25% band.
      name: 'Paneer (raw)', quantity: 150, unit: 'g', calories: 600,
    }), ref);
    const food = stamped.meals[0].foods[0];
    expect(food.food_id).toBe('food-paneer');
    expect(food.grams).toBe(150);
    expect(food.nutrition_source).toBe('model');
  });

  test('an unconvertible unit keeps the name and stamps model', async () => {
    const ref = await loadFoodReference(ORG);
    const food = stampPlanFoods(plan({
      name: 'Roti', quantity: 2, unit: 'bowl', calories: 240,
    }), ref).meals[0].foods[0];
    expect(food.grams).toBeNull();
    expect(food.nutrition_source).toBe('model');
  });

  test('stamping is idempotent', async () => {
    const ref = await loadFoodReference(ORG);
    const once = stampPlanFoods(plan({
      name: 'Roti', quantity: 2, unit: 'piece', calories: 240,
    }), ref);
    const twice = stampPlanFoods(once, ref);
    expect(twice).toEqual(once);
  });

  test('a legacy string quantity is left untouched', async () => {
    const ref = await loadFoodReference(ORG);
    const food = stampPlanFoods(plan({
      name: 'Roti', quantity: '60 g', calories: 240,
    }), ref).meals[0].foods[0];
    expect(food).toEqual({ name: 'Roti', quantity: '60 g', calories: 240 });
  });

  test('a null plan stays null', async () => {
    const ref = await loadFoodReference(ORG);
    expect(stampPlanFoods(null, ref)).toBeNull();
  });
});

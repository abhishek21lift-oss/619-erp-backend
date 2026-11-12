'use strict';
// What the plan must prove before a trainer is allowed to trust it: the
// numbers it was asked to hit, the meals the schedule named, and nothing the
// client is allergic to. Pure functions, no database.

const {
  validatePlan, targetsStale, TOLERANCES, ALLERGEN_GROUPS,
} = require('../modules/nutrition/diet-validation');

const targets = (o = {}) => ({
  calorie_target: 2000,
  macros: { protein_g: 150, carbs_g: 200, fat_g: 60 },
  fiber_g: 30,
  ...o,
});
const meal = (o = {}) => ({
  name: 'Meal', time: '08:00', calories: 500,
  protein_g: 30, carbs_g: 50, fat_g: 15, foods: [], ...o,
});
const food = (name) => ({
  name, quantity: 100, unit: 'g', calories: 500,
});
const planWith = (o = {}) => {
  const meals = o.meals ?? [meal({})];
  return {
    name: 'Plan',
    total_calories: meals.reduce((n, m) => n + (Number(m.calories) || 0), 0),
    macros: { protein_g: 150, carbs_g: 200, fat_g: 60 },
    meals,
    ...o,
  };
};

test('daily calories outside tolerance is a blocker', () => {
  const plan = planWith({ total_calories: 2000, meals: [meal({ calories: 1500 })] });
  const r = validatePlan(plan, { targets: targets({ calorie_target: 2000 }) });
  expect(r.ok).toBe(false);
  expect(r.blockers.join(' ')).toMatch(/calories/i);
});

test('protein below 90% is a blocker, carbs/fat 15% off is a warning', () => {
  const r = validatePlan(planWith({
    total_calories: 2000,
    macros: { protein_g: 100, carbs_g: 300, fat_g: 70 },
    meals: [meal({
      calories: 2000, protein_g: 100, carbs_g: 300, fat_g: 70,
    })],
  }), { targets: targets({ calorie_target: 2000, macros: { protein_g: 160, carbs_g: 200, fat_g: 60 } }) });
  expect(r.blockers.join(' ')).toMatch(/protein/i);
  expect(r.warnings.join(' ')).toMatch(/carbs/i);
});

test('a dairy allergy hits paneer, curd and ghee by group', () => {
  const plan = planWith({
    meals: [meal({ foods: [food('Paneer'), food('Curd'), food('Ghee')] })],
  });
  const r = validatePlan(plan, { restrictions: { allergies: 'dairy' } });
  expect(r.blockers.filter((b) => /dairy/i.test(b))).toHaveLength(3);
  expect(ALLERGEN_GROUPS.dairy).toContain('paneer');
});

test('an unknown allergy token warns instead of blocking', () => {
  const r = validatePlan(planWith({ meals: [meal({ foods: [food('Mystery sauce')] })] }),
    { restrictions: { allergies: ['kiwi'] } });
  expect(r.ok).toBe(true);
  expect(r.warnings.join(' ')).toMatch(/kiwi/i);
});

test('vegan blocks egg and dairy, vegetarian allows dairy but blocks egg', () => {
  const egg = planWith({ meals: [meal({ foods: [food('Boiled egg')] })] });
  expect(validatePlan(egg, { restrictions: { dietaryPattern: 'vegan' } }).ok).toBe(false);
  expect(validatePlan(egg, { restrictions: { dietaryPattern: 'vegetarian' } }).ok).toBe(false);
  expect(validatePlan(egg, { restrictions: { dietaryPattern: 'eggetarian' } }).ok).toBe(true);
});

test('a scheduled pre_workout meal that is missing blocks', () => {
  const schedule = [
    { slot: 'breakfast', time: '07:30' },
    { slot: 'pre_workout', time: '05:30' },
    { slot: 'post_workout', time: '08:30' },
  ];
  const plan = planWith({ meals: [meal({ slot: 'breakfast', time: '07:30' })] });
  const r = validatePlan(plan, { schedule });
  expect(r.ok).toBe(false);
  expect(r.blockers.join(' ')).toMatch(/pre_workout/i);
});

test('meal times outside the main window block, pre/post may cross midnight', () => {
  const schedule = [
    { slot: 'breakfast', time: '04:00' },
    { slot: 'post_workout', time: '00:00', day_offset: 1 },
  ];
  const plan = planWith({
    meals: [
      meal({ slot: 'breakfast', time: '04:00' }),
      meal({ slot: 'post_workout', time: '00:00', day_offset: 1 }),
    ],
  });
  const r = validatePlan(plan, { schedule });
  expect(r.blockers.join(' ')).toMatch(/04:00/);
  expect(r.blockers.join(' ')).not.toMatch(/00:00/);
});

test('target drift is reported, not blocked', () => {
  expect(targetsStale(
    { inputs: { weight_kg: 80, height_cm: 180, goal: 'fat_loss' } },
    { weight_kg: 82, height_cm: 180, goal: 'fat_loss' },
  )).toBe(true);
  expect(targetsStale({ inputs: { weight_kg: 80 } }, { weight_kg: 80.4 })).toBe(false);
});

test('the tolerance table is exported, not copied by callers', () => {
  expect(TOLERANCES.dailyCaloriesPct).toBe(0.05);
  expect(TOLERANCES.proteinMinPct).toBe(0.90);
});

test('a recorded allergen that names a group member expands to that group', () => {
  const plan = planWith({
    total_calories: 500,
    meals: [meal({
      calories: 190,
      foods: [{
        name: 'Peanut butter', quantity: 2, unit: 'tbsp',
        calories: 190, protein_g: 7, carbs_g: 6, fat_g: 16,
      }],
    })],
  });
  const r = validatePlan(plan, { restrictions: { allergies: ['peanuts'] } });
  expect(r.ok).toBe(false);
  expect(r.blockers.join(' ')).toMatch(/Allergy "peanuts"/);
});

test('reference lookups accept the food reference Map and per-serving rows', () => {
  const foodsById = new Map([['food-roti', {
    id: 'food-roti', name: 'Roti', serving_unit: 'piece', serving_grams: 40,
    calories: 120, protein_g: 3.5, carbs_g: 24, fats_g: 1.2,
  }]]);
  const roti = {
    name: 'Roti', quantity: 2, unit: 'piece', grams: 80,
    calories: 240, protein_g: 7, carbs_g: 48, fat_g: 2.4, food_id: 'food-roti',
  };
  const plan = planWith({
    total_calories: 540,
    meals: [
      meal({ calories: 240, protein_g: 7, carbs_g: 48, fat_g: 2.4, foods: [roti] }),
      meal({ name: 'Dinner', time: '20:00', calories: 300, protein_g: 0, carbs_g: 0, fat_g: 0 }),
    ],
  });

  const match = validatePlan(plan, { foodsById });
  expect(match.blockers.join(' ')).not.toMatch(/unknown food_id/);

  const wrong = validatePlan(
    { ...plan, meals: [{ ...plan.meals[0], foods: [{ ...roti, calories: 600 }] }, plan.meals[1]] },
    { foodsById },
  );
  expect(wrong.warnings.join(' ')).toMatch(/do not match the reference food/);
});

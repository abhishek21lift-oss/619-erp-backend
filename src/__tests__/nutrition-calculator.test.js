'use strict';
// Deterministic targets: the server decides the numbers, the model only
// distributes them. Every value here is pinned by spec §6.1.

const { calculateTargets, NUTRITION_ENGINE_VERSION, GOAL_ADJUSTMENTS } = require('../modules/nutrition/nutrition-calculator');

test('male 30y 80kg 180cm moderately_active fat_loss', () => {
  const r = calculateTargets({ age: 30, gender: 'male', weight_kg: 80, height_cm: 180,
    activity_level: 'moderately_active', goal: 'fat_loss' });
  expect(r.bmr_kcal).toBe(1780);              // 10*80 + 6.25*180 - 5*30 + 5
  expect(r.tdee_kcal).toBe(2759);             // round(1780 * 1.55)
  expect(r.calorie_target).toBe(2207);        // round(2759 * 0.8)
  expect(r.activity_multiplier).toBe(1.55);
  expect(r.calorie_adjustment_pct).toBe(-20);
  expect(r.macros.protein_g).toBe(160);       // 80 * 2.0
  expect(r.version).toBe(NUTRITION_ENGINE_VERSION);
});

test('female 45y 65kg 160cm moderately_active maintenance', () => {
  const r = calculateTargets({ age: 45, gender: 'female', weight_kg: 65, height_cm: 160,
    activity_level: 'moderately_active', goal: 'general_fitness' });
  expect(r.bmr_kcal).toBe(1264);              // 650 + 1000 - 225 - 161
  expect(r.tdee_kcal).toBe(1959);             // round(1264 * 1.55)
  expect(r.calorie_target).toBe(1959);
  expect(r.calorie_adjustment_pct).toBe(0);
});

test('unknown gender returns no BMR and names gender', () => {
  const r = calculateTargets({ age: 30, gender: 'other', weight_kg: 80, height_cm: 180,
    activity_level: 'sedentary', goal: 'fat_loss' });
  expect(r.bmr_kcal).toBeNull();
  expect(r.calorie_target).toBeNull();
  expect(r.missing).toContain('gender');
});

test('calorie floor and cap are recorded as warnings', () => {
  const low = calculateTargets({ age: 60, gender: 'female', weight_kg: 42, height_cm: 150,
    activity_level: 'sedentary', goal: 'fat_loss' });
  expect(low.calorie_target).toBeGreaterThanOrEqual(1200);
  expect(low.warnings.map((w) => w.code)).toContain('calorie_floor');
  // The floor is BMR, so a sedentary deficit from a 1.2 multiplier is below
  // BMR by construction (0.8 * 1.2 = 0.96) and is raised. The clamp is the
  // spec: no plan is written under resting expenditure.
  const sedentary = calculateTargets({ age: 30, gender: 'male', weight_kg: 80, height_cm: 180,
    activity_level: 'sedentary', goal: 'fat_loss' });
  expect(sedentary.calorie_target).toBe(1780);
  expect(sedentary.warnings.map((w) => w.code)).toContain('calorie_floor');
  const high = calculateTargets({ age: 20, gender: 'male', weight_kg: 300, height_cm: 240,
    activity_level: 'extra_active', goal: 'hypertrophy', target_weight_kg: 320 });
  expect(high.warnings.map((w) => w.code)).toContain('calorie_cap');
});

test('macros reconcile to the calorie target within 50 kcal', () => {
  for (const goal of Object.keys(GOAL_ADJUSTMENTS)) {
    const r = calculateTargets({ age: 30, gender: 'male', weight_kg: 80, height_cm: 180,
      activity_level: 'moderately_active', goal });
    const kcal = 4 * r.macros.protein_g + 4 * r.macros.carbs_g + 9 * r.macros.fat_g;
    expect(Math.abs(kcal - r.calorie_target)).toBeLessThanOrEqual(50);
    expect(r.macros.protein_g).toBeGreaterThanOrEqual(Math.round(80 * 1.2));
    expect(r.macros.protein_g).toBeLessThanOrEqual(Math.round(80 * 2.2));
  }
});

test('the carb floor survives reconciliation', () => {
  // 100 kg fat_loss at a 1720 kcal target: protein 200 g and fat 60 g leave
  // less than 1 g/kg for carbs. The floor is the spec; the reconciliation
  // step must not quietly spend it, and the warning must tell the trainer the
  // macros are off target rather than claim a floor that no longer holds.
  const r = calculateTargets({ age: 30, gender: 'female', weight_kg: 100, height_cm: 165,
    activity_level: 'sedentary', goal: 'fat_loss' });
  expect(r.macros.carbs_g).toBeGreaterThanOrEqual(100);
  expect(r.warnings.map((w) => w.code)).toContain('macro_floor_conflict');
});

test('fiber and water follow the spec constants', () => {
  const r = calculateTargets({ age: 30, gender: 'male', weight_kg: 80, height_cm: 180,
    activity_level: 'moderately_active', goal: 'general_fitness' });
  expect(r.fiber_g).toBe(39);                 // round(14 * 2759 / 1000)
  expect(r.water_ml).toBe(2750);              // 80 * 35 = 2800, rounded to the nearest 250
});

test('fiber is clamped to 25–50 g', () => {
  const tiny = calculateTargets({ age: 30, gender: 'female', weight_kg: 40, height_cm: 150,
    activity_level: 'sedentary', goal: 'fat_loss' });
  expect(tiny.fiber_g).toBe(25);
  const huge = calculateTargets({ age: 25, gender: 'male', weight_kg: 120, height_cm: 200,
    activity_level: 'extra_active', goal: 'hypertrophy' });
  expect(huge.fiber_g).toBe(50);
});

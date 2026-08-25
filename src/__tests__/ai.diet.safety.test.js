'use strict';

// Tests for src/lib/ai/dietSafety.js — P0-4 deterministic TDEE/macro safety.
//
// The unit under test owns the nutrition math that the AI diet generator used
// to delegate to the model. Every test here proves the deterministic system
// (not the LLM) is in control of BMR, TDEE, goal-adjusted calories, macro
// splits, and safety validation.
//
// The one imported dependency is calcBmr from fitness-scoring.js, verified
// here to be called with correctly normalised gender values.

const { calcBmr } = require('../modules/progress/fitness-scoring');
const {
  normaliseActivityLevel,
  normaliseGender,
  calcTDEE,
  calcGoalCalories,
  calcMacros,
  validateDietPlan,
  buildDietSafetyContext,
  TDEE_MULTIPLIERS,
  GOAL_ADJUSTMENTS,
} = require('../lib/ai/dietSafety');

/* ── Activity Level Normalisation ──────────────────────────────────────────── */

describe('normaliseActivityLevel', () => {
  test('maps DB/frontend exact values', () => {
    expect(normaliseActivityLevel('sedentary')).toBe('sedentary');
    expect(normaliseActivityLevel('lightly_active')).toBe('lightly_active');
    expect(normaliseActivityLevel('moderately_active')).toBe('moderately_active');
    expect(normaliseActivityLevel('very_active')).toBe('very_active');
    expect(normaliseActivityLevel('extra_active')).toBe('extra_active');
  });

  test('maps lifestyle-scoring display strings', () => {
    expect(normaliseActivityLevel('Sedentary')).toBe('sedentary');
    expect(normaliseActivityLevel('Lightly Active')).toBe('lightly_active');
    expect(normaliseActivityLevel('Moderately Active')).toBe('moderately_active');
    expect(normaliseActivityLevel('Active')).toBe('moderately_active');
    expect(normaliseActivityLevel('Very Active')).toBe('very_active');
  });

  test('maps common free-text variants', () => {
    expect(normaliseActivityLevel('high')).toBe('very_active');
    expect(normaliseActivityLevel('moderate')).toBe('moderately_active');
    expect(normaliseActivityLevel('low')).toBe('sedentary');
  });

  test('is case-insensitive', () => {
    expect(normaliseActivityLevel('SEDENTARY')).toBe('sedentary');
    expect(normaliseActivityLevel('Lightly_Active')).toBe('lightly_active');
    expect(normaliseActivityLevel('VERY ACTIVE')).toBe('very_active');
  });

  test('returns null for unrecognised values', () => {
    expect(normaliseActivityLevel('')).toBeNull();
    expect(normaliseActivityLevel(null)).toBeNull();
    expect(normaliseActivityLevel(undefined)).toBeNull();
    expect(normaliseActivityLevel('super_active')).toBeNull();
  });
});

/* ── Gender Normalisation ──────────────────────────────────────────────────── */

describe('normaliseGender', () => {
  test('maps "Male"/"male" to "Male"', () => {
    expect(normaliseGender('Male')).toBe('Male');
    expect(normaliseGender('male')).toBe('Male');
    expect(normaliseGender('M')).toBe('Male');
  });

  test('maps "Female"/"female" to "Female"', () => {
    expect(normaliseGender('Female')).toBe('Female');
    expect(normaliseGender('female')).toBe('Female');
    expect(normaliseGender('F')).toBe('Female');
  });

  test('returns "Other" for non-binary values', () => {
    expect(normaliseGender('Other')).toBe('Other');
    expect(normaliseGender('Prefer not to say')).toBe('Other');
  });

  test('returns null for missing input', () => {
    expect(normaliseGender(null)).toBeNull();
    expect(normaliseGender(undefined)).toBeNull();
    expect(normaliseGender('')).toBeNull();
  });
});

/* ── TDEE Computation ──────────────────────────────────────────────────────── */

describe('calcTDEE', () => {
  test('multiplies BMR by the correct activity factor', () => {
    // Male, 30, 80kg, 175cm → BMR = 10*80 + 6.25*175 - 5*30 + 5 = 800 + 1093.75 - 150 + 5 = 1748.75 → 1749
    const bmr = calcBmr(80, 175, 30, 'Male');
    expect(bmr).toBe(1749);
    expect(calcTDEE(bmr, 'sedentary')).toBe(Math.round(1749 * 1.2));
    expect(calcTDEE(bmr, 'lightly_active')).toBe(Math.round(1749 * 1.375));
    expect(calcTDEE(bmr, 'moderately_active')).toBe(Math.round(1749 * 1.55));
    expect(calcTDEE(bmr, 'very_active')).toBe(Math.round(1749 * 1.725));
    expect(calcTDEE(bmr, 'extra_active')).toBe(Math.round(1749 * 1.9));
  });

  test('uses the normalised activity level', () => {
    const bmr = calcBmr(80, 175, 30, 'Male');
    expect(calcTDEE(bmr, 'Sedentary')).toBe(calcTDEE(bmr, 'sedentary'));
    expect(calcTDEE(bmr, 'Very Active')).toBe(calcTDEE(bmr, 'very_active'));
    expect(calcTDEE(bmr, 'moderate')).toBe(calcTDEE(bmr, 'moderately_active'));
  });

  test('returns null when BMR is null', () => {
    expect(calcTDEE(null, 'sedentary')).toBeNull();
  });

  test('returns null for unrecognised activity level', () => {
    const bmr = calcBmr(80, 175, 30, 'Male');
    expect(calcTDEE(bmr, 'unknown_level')).toBeNull();
  });
});

/* ── Goal-Adjusted Calories ────────────────────────────────────────────────── */

describe('calcGoalCalories', () => {
  const tdee = 2500;

  test('weight_loss applies a 500-calorie deficit', () => {
    const result = calcGoalCalories(tdee, 'weight_loss');
    expect(result).toBe(2000);
  });

  test('muscle_gain applies a 300-calorie surplus', () => {
    const result = calcGoalCalories(tdee, 'muscle_gain');
    expect(result).toBe(2800);
  });

  test('recomposition applies a 200-calorie deficit', () => {
    const result = calcGoalCalories(tdee, 'recomposition');
    expect(result).toBe(2300);
  });

  test('maintenance applies no adjustment', () => {
    const result = calcGoalCalories(tdee, 'maintenance');
    expect(result).toBe(2500);
  });

  test('clamps adjustment to the safe range for the goal type', () => {
    // weight_loss allows -1000 to 0
    expect(calcGoalCalories(tdee, 'weight_loss', -2000)).toBe(1500);
    expect(calcGoalCalories(tdee, 'weight_loss', 500)).toBe(2500);
    // muscle_gain allows 0 to 500
    expect(calcGoalCalories(tdee, 'muscle_gain', -100)).toBe(2500);
    expect(calcGoalCalories(tdee, 'muscle_gain', 1000)).toBe(3000);
  });

  test('returns null for unrecognised goal', () => {
    expect(calcGoalCalories(tdee, 'unknown_goal')).toBeNull();
  });

  test('returns null when TDEE is null', () => {
    expect(calcGoalCalories(null, 'weight_loss')).toBeNull();
  });
});

/* ── Macro Distribution ────────────────────────────────────────────────────── */

describe('calcMacros', () => {
  test('weight_loss uses lower protein end (1.6 g/kg)', () => {
    const result = calcMacros(2000, 80, 'weight_loss');
    // Protein: 1.6 * 80 = 128g → 512 cal
    // Fat: 25% of 2000 = 500 cal → ~56g
    // Carbs: remainder = 2000 - 512 - 500 = 988 cal → 247g
    expect(result.protein_g).toBe(128);
    expect(result.fat_g).toBe(56);
    expect(result.carbs_g).toBe(247);
  });

  test('muscle_gain uses upper protein end (2.2 g/kg)', () => {
    const result = calcMacros(2800, 80, 'muscle_gain');
    // Protein: 2.2 * 80 = 176g → 704 cal
    // Fat: 25% of 2800 = 700 cal → ~78g
    // Carbs: remainder = 2800 - 704 - 700 = 1396 cal → 349g
    expect(result.protein_g).toBe(176);
    expect(result.carbs_g).toBe(349);
  });

  test('returns null when calories or weight is missing', () => {
    expect(calcMacros(null, 80, 'weight_loss')).toBeNull();
    expect(calcMacros(2000, null, 'weight_loss')).toBeNull();
  });
});

/* ── Safety Validation ─────────────────────────────────────────────────────── */

describe('validateDietPlan', () => {
  const ref = { weightKg: 80, goal: 'weight_loss', tdee: 2500, goalCalories: 2000 };

  test('passes a plan that matches the authoritative targets', () => {
    const plan = { total_calories: 2000, macros: { protein_g: 128, carbs_g: 247, fat_g: 56 } };
    const result = validateDietPlan(plan, ref);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('flags a plan that deviates from the target by >200 kcal', () => {
    const plan = { total_calories: 1600, macros: { protein_g: 128, carbs_g: 247, fat_g: 56 } };
    const result = validateDietPlan(plan, ref);
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toContain('deviate');
  });

  test('errors on calories below the safe floor', () => {
    const plan = { total_calories: 500, macros: { protein_g: 128, carbs_g: 247, fat_g: 56 } };
    const result = validateDietPlan(plan, ref);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('below the safe minimum'))).toBe(true);
  });

  test('errors on calories above the safe ceiling', () => {
    const plan = { total_calories: 6000, macros: { protein_g: 128, carbs_g: 247, fat_g: 56 } };
    const result = validateDietPlan(plan, ref);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds the safe maximum'))).toBe(true);
  });

  test('warns on protein below 0.8 g/kg', () => {
    const plan = { total_calories: 2000, macros: { protein_g: 40, carbs_g: 300, fat_g: 80 } };
    const result = validateDietPlan(plan, ref);
    // 40g / 80kg = 0.5 g/kg < 0.8
    expect(result.warnings.some((w) => w.includes('below minimum recommended intake'))).toBe(true);
  });

  test('warns on protein above 3.5 g/kg', () => {
    const plan = { total_calories: 4000, macros: { protein_g: 300, carbs_g: 300, fat_g: 100 } };
    const result = validateDietPlan(plan, ref);
    // 300g / 80kg = 3.75 g/kg > 3.5
    expect(result.warnings.some((w) => w.includes('exceeds the safe maximum'))).toBe(true);
  });

  test('returns errors for a non-object plan', () => {
    const result = validateDietPlan(null, ref);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Plan is not a valid object');
  });

  test('handles missing macros gracefully', () => {
    const plan = { total_calories: 2000 };
    const result = validateDietPlan(plan, ref);
    expect(result.valid).toBe(true);
  });
});

/* ── Full Context Builder ──────────────────────────────────────────────────── */

describe('buildDietSafetyContext', () => {
  test('returns a complete context for a typical female client', () => {
    // Female, 32, 65kg, 160cm, moderately active, weight_loss
    const ctx = buildDietSafetyContext({
      weightKg: 65, heightCm: 160, age: 32, gender: 'female',
      activityLevel: 'moderately_active', goal: 'weight_loss',
    });
    // BMR: 10*65 + 6.25*160 - 5*32 - 161 = 650 + 1000 - 160 - 161 = 1329
    expect(ctx.bmr).toBe(1329);
    // TDEE: 1329 * 1.55 = 2060
    expect(ctx.tdee).toBe(2060);
    // Goal: 2060 - 500 = 1560
    expect(ctx.goal_calories).toBe(1560);
    // Macros: protein 1.6*65 = 104g, fat 25% of 1560 = 390/9 = 43g, carbs = (1560-416-390)/4 = 189g
    expect(ctx.macros.protein_g).toBe(104);
    expect(ctx.macros.fat_g).toBe(43);
    expect(ctx.macros.carbs_g).toBe(189);
    expect(ctx.goal_adjustment.type).toBe('deficit');
  });

  test('returns a complete context for a male muscle_gain client', () => {
    const ctx = buildDietSafetyContext({
      weightKg: 80, heightCm: 175, age: 30, gender: 'Male',
      activityLevel: 'very_active', goal: 'muscle_gain',
    });
    // BMR: 10*80 + 6.25*175 - 5*30 + 5 = 800 + 1093.75 - 150 + 5 = 1748.75 → 1749
    expect(ctx.bmr).toBe(1749);
    // TDEE: 1749 * 1.725 = 3017
    expect(ctx.tdee).toBe(3017);
    // Goal: 3017 + 300 = 3317
    expect(ctx.goal_calories).toBe(3317);
    // Protein: 2.2 * 80 = 176g
    expect(ctx.macros.protein_g).toBe(176);
  });

  test('returns null when required inputs are missing', () => {
    expect(buildDietSafetyContext({ weightKg: 65, heightCm: 160, age: 32, gender: 'female', activityLevel: null, goal: 'weight_loss' })).toBeNull();
    expect(buildDietSafetyContext({ weightKg: 65, heightCm: 160, age: 32, gender: 'female', activityLevel: 'moderately_active', goal: null })).toBeNull();
    expect(buildDietSafetyContext({})).toBeNull();
    expect(buildDietSafetyContext(null)).toBeNull();
  });
});
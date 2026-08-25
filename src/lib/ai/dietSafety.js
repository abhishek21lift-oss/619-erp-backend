'use strict';

// src/lib/ai/dietSafety.js — Deterministic TDEE and macro computation
// for the AI diet generator (P0-4).
//
// The AI diet generator's system prompt previously told the model to
// "Calculate accurate TDEE" — delegating the core nutrition math to an
// LLM that cannot reliably do arithmetic. This module takes ownership of
// every numeric target the diet plan needs: BMR, TDEE, goal-adjusted
// calories, and macro split. The model gets the authoritative numbers as
// a prompt section and only has to fill in the meal structure around them.
//
// Every TDEE multiplier and macro ratio here is a NEW threshold — none of
// these existed in the codebase before this file was created. The only
// pre-existing piece is calcBmr (Mifflin-St Jeor), imported from
// fitness-scoring.js, which this module calls rather than re-implementing.
//
// Per the AI invariants: deterministic system owns measurements/scores/
// safety/TDEE/macros/permissions/quotas/rate limits. The model is never
// in the write path. This module enforces both.

const { calcBmr } = require('../../modules/progress/fitness-scoring');

// ── TDEE Multipliers ───────────────────────────────────────────────────────

// Standard Mifflin-St Jeor activity multipliers. Keyed by a NORMALISED
// activity-level identifier; the normalisation function below handles
// both DB storage values and display-string formats.

const TDEE_MULTIPLIERS = {
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
};

// ── Activity Level Normalisation ───────────────────────────────────────────

// The pt_lifestyle_assessments table stores arbitrary text activity_level
// values (no CHECK constraint). The frontend sends one of:
//   ['sedentary', 'lightly_active', 'moderately_active', 'very_active',
//    'extra_active']
// The lifestyle-scoring module's classifyActivity() returns display strings:
//   ['Sedentary', 'Lightly Active', 'Moderately Active', 'Active',
//    'Very Active']
// Both need to map to the same multiplier set. Note the mismatch:
// 'extra_active' (frontend) has no match in lifestyle-scoring display
// strings, and 'Active' (lifestyle-scoring) has no match in the frontend
// vocabulary — this normaliser handles both.

// Build the map deduplicating overwrites by processing in order.
function buildLevelMap() {
  const map = {};
  const entries = [
    // DB/frontend exact values — highest priority
    ['sedentary', 'sedentary'],
    ['lightly_active', 'lightly_active'],
    ['moderately_active', 'moderately_active'],
    ['very_active', 'very_active'],
    ['extra_active', 'extra_active'],
    // lifestyle-scoring display strings
    ['Sedentary', 'sedentary'],
    ['Lightly Active', 'lightly_active'],
    ['Moderately Active', 'moderately_active'],
    ['Active', 'moderately_active'],
    ['Very Active', 'very_active'],
    // common free-text
    ['high', 'very_active'],
    ['moderate', 'moderately_active'],
    ['low', 'sedentary'],
  ];
  for (const [raw, normalised] of entries) {
    map[raw.toLowerCase()] = normalised;
  }
  return map;
}

const LEVEL_MAP_BUILT = buildLevelMap();

function normaliseActivityLevel(level) {
  if (!level) return null;
  const key = String(level).toLowerCase().trim();
  return LEVEL_MAP_BUILT[key] || null;
}

// ── Gender Normalisation ───────────────────────────────────────────────────

// calcBmr (fitness-scoring.js) tests `gender === 'Male'` strictly. The DB
// stores 'Male'/'Female'/'Other' (migration 012 CHECK) but some records and
// test mocks carry lowercase. Normalise here so the SAME authoritative BMR
// function is called with a shape it understands — no formula duplication.
function normaliseGender(gender) {
  if (!gender) return null;
  const g = String(gender).toLowerCase().trim();
  if (g === 'male' || g === 'm') return 'Male';
  if (g === 'female' || g === 'f') return 'Female';
  return 'Other';
}

// ── TDEE Computation ───────────────────────────────────────────────────────

function calcTDEE(bmr, activityLevel) {
  if (bmr == null) return null;
  const normalised = normaliseActivityLevel(activityLevel);
  const multiplier = normalised ? TDEE_MULTIPLIERS[normalised] : null;
  if (!multiplier) return null;
  return Math.round(bmr * multiplier);
}

// ── Goal-Adjusted Calories ─────────────────────────────────────────────────

const GOAL_ADJUSTMENTS = {
  weight_loss: { type: 'deficit', default: -500, min: -1000, max: 0 },
  muscle_gain: { type: 'surplus', default: 300, min: 0, max: 500 },
  recomposition: { type: 'deficit', default: -200, min: -500, max: 0 },
  maintenance: { type: 'maintenance', default: 0, min: 0, max: 0 },
};

function calcGoalCalories(tdee, goal, customAdjustment) {
  if (tdee == null) return null;
  const adj = GOAL_ADJUSTMENTS[goal];
  if (!adj) return null;
  const adjustment = customAdjustment != null ? customAdjustment : adj.default;
  // Clamp to the safe range for this goal type
  const clamped = Math.max(adj.min, Math.min(adj.max, adjustment));
  return Math.round(tdee + clamped);
}

// ── Macro Targets ──────────────────────────────────────────────────────────

// Minimum safe floors (generally accepted thresholds, not from any DB table).
// Reported as new thresholds in the P0-4 final report.
const MIN_CALORIES = { default: 1200, withMedicalSupervision: 800 };
const PROTEIN_RANGE = { min: 1.6, max: 2.2 }; // g/kg BW
const FAT_PCT_RANGE = { min: 0.2, max: 0.35 }; // 20-35% of calories
// Carbs are the remainder after protein + fat.

function calcMacros(calories, weightKg, goal) {
  if (!calories || !weightKg) return null;

  // Protein: 1.6-2.2 g/kg. For muscle_gain use the upper end; for
  // weight_loss use the lower end to preserve calories for fat/carbs.
  const proteinPerKg = goal === 'muscle_gain' ? PROTEIN_RANGE.max : PROTEIN_RANGE.min;
  const proteinG = Math.round(proteinPerKg * weightKg);
  const proteinCal = proteinG * 4;

  // Fat: 20-35% of remaining calories. Use 25% as default midpoint.
  const fatRatio = 0.25;
  const fatCal = Math.round(calories * fatRatio);
  const fatG = Math.round(fatCal / 9);

  // Carbs: remainder
  const carbsCal = Math.max(0, calories - proteinCal - fatCal);
  const carbsG = Math.round(carbsCal / 4);

  return { protein_g: proteinG, carbs_g: carbsG, fat_g: fatG };
}

// ── Safety Validation ──────────────────────────────────────────────────────

// Safe ranges for validating a generated plan. These are NEW thresholds not
// present anywhere else in the codebase — see the P0-4 final report entry.
const SAFE_CALORIES = { min: 800, max: 5000 };
const SAFE_PROTEIN_G_PER_KG = { min: 0.8, max: 3.5 };
const SAFE_FAT_PCT = { min: 0.10, max: 0.50 };
const SAFE_CARBS_PCT = { min: 0.10, max: 0.75 };

function validateDietPlan(plan, { weightKg, goal, tdee, goalCalories }) {
  const warnings = [];
  const errors = [];

  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Plan is not a valid object'], warnings: [] };
  }

  // Calorie range check
  if (plan.total_calories != null) {
    if (plan.total_calories < SAFE_CALORIES.min) {
      errors.push(`Total calories (${plan.total_calories}) is below the safe minimum of ${SAFE_CALORIES.min}.`);
    } else if (plan.total_calories > SAFE_CALORIES.max) {
      errors.push(`Total calories (${plan.total_calories}) exceeds the safe maximum of ${SAFE_CALORIES.max}.`);
    }

    // Warn if the generated plan deviates significantly from the authoritative target
    if (goalCalories != null) {
      const deviation = Math.abs(plan.total_calories - goalCalories);
      if (deviation > 200) {
        warnings.push(`Generated calories (${plan.total_calories}) deviate from the authoritative target (${goalCalories}) by ${deviation} kcal.`);
      }
    }
  }

  // Macro validation
  const macros = plan.macros || {};
  if (macros.protein_g != null && weightKg) {
    const proteinPerKg = macros.protein_g / weightKg;
    if (proteinPerKg < SAFE_PROTEIN_G_PER_KG.min) {
      warnings.push(`Protein (${macros.protein_g}g, ${proteinPerKg.toFixed(1)} g/kg) is below minimum recommended intake of ${SAFE_PROTEIN_G_PER_KG.min} g/kg.`);
    } else if (proteinPerKg > SAFE_PROTEIN_G_PER_KG.max) {
      warnings.push(`Protein (${macros.protein_g}g, ${proteinPerKg.toFixed(1)} g/kg) exceeds the safe maximum of ${SAFE_PROTEIN_G_PER_KG.max} g/kg.`);
    }
  }

  if (macros.fat_g != null && plan.total_calories) {
    const fatPct = (macros.fat_g * 9) / plan.total_calories;
    if (fatPct < SAFE_FAT_PCT.min) {
      warnings.push(`Fat (${(fatPct * 100).toFixed(0)}% of calories) is below the minimum of ${(SAFE_FAT_PCT.min * 100).toFixed(0)}%.`);
    } else if (fatPct > SAFE_FAT_PCT.max) {
      warnings.push(`Fat (${(fatPct * 100).toFixed(0)}% of calories) exceeds the maximum of ${(SAFE_FAT_PCT.max * 100).toFixed(0)}%.`);
    }
  }

  if (macros.carbs_g != null && plan.total_calories) {
    const carbsPct = (macros.carbs_g * 4) / plan.total_calories;
    if (carbsPct < SAFE_CARBS_PCT.min) {
      warnings.push(`Carbs (${(carbsPct * 100).toFixed(0)}% of calories) are below the minimum of ${(SAFE_CARBS_PCT.min * 100).toFixed(0)}%.`);
    } else if (carbsPct > SAFE_CARBS_PCT.max) {
      warnings.push(`Carbs (${(carbsPct * 100).toFixed(0)}% of calories) exceed the maximum of ${(SAFE_CARBS_PCT.max * 100).toFixed(0)}%.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Build authoritive nutrition context for the prompt ─────────────────────

function buildDietSafetyContext(input) {
  if (!input) return null;
  const { weightKg, heightCm, age, gender, activityLevel, goal } = input;
  if (!weightKg || !heightCm || !age || !gender || !activityLevel || !goal) {
    return null;
  }

  const bmr = calcBmr(weightKg, heightCm, age, normaliseGender(gender));
  if (bmr == null) return null;

  const tdee = calcTDEE(bmr, activityLevel);
  if (tdee == null) return null;

  const goalCalories = calcGoalCalories(tdee, goal);
  if (goalCalories == null) return null;

  const macros = calcMacros(goalCalories, weightKg, goal);
  if (macros == null) return null;

  return {
    bmr,
    tdee,
    goal_calories: goalCalories,
    macros,
    goal_adjustment: GOAL_ADJUSTMENTS[goal] || null,
  };
}

module.exports = {
  normaliseActivityLevel,
  normaliseGender,
  calcTDEE,
  calcGoalCalories,
  calcMacros,
  validateDietPlan,
  buildDietSafetyContext,
  TDEE_MULTIPLIERS,
  GOAL_ADJUSTMENTS,
  // Exported for testing
  MIN_CALORIES,
  PROTEIN_RANGE,
  FAT_PCT_RANGE,
  SAFE_CALORIES,
  SAFE_PROTEIN_G_PER_KG,
  SAFE_FAT_PCT,
  SAFE_CARBS_PCT,
};
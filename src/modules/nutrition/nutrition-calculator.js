'use strict';
// Deterministic nutrition targets.
//
// The model writes meals; it does not decide how much to eat. This module is
// the one place BMR, TDEE, calories and macros are computed, so a plan can be
// checked against the numbers it was asked to hit. Formula constants are spec
// §6.1 and versioned: changing one is a new NUTRITION_ENGINE_VERSION, not an
// edit in place.
//
// Pure: no database, no clock (today is passed in), no network.

const { calcBmr } = require('../progress/fitness-scoring');
const {
  calcSafeWeeklyRate, calcEstimatedDurationWeeks, calcRequiredWeeklyRate,
} = require('../progress/goal-scoring');

const NUTRITION_ENGINE_VERSION = '1.0.0';

const ACTIVITY_MULTIPLIERS = Object.freeze({
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
});

/** Keyed on the canonical goals from pt-os/goal-classification. */
const GOAL_ADJUSTMENTS = Object.freeze({
  fat_loss: -0.20,
  body_recomposition: -0.10,
  hypertrophy: 0.10,
  strength: 0.05,
  powerlifting: 0.05,
  endurance: 0,
  general_fitness: 0,
  recovery: 0,
  flexibility_mobility: 0,
});

const PROTEIN_G_PER_KG = Object.freeze({
  fat_loss: 2.0,
  body_recomposition: 2.0,
  hypertrophy: 1.8,
  strength: 1.8,
  powerlifting: 1.8,
  endurance: 1.6,
  general_fitness: 1.6,
  recovery: 1.6,
  flexibility_mobility: 1.4,
});

const LOSS_GOALS = ['fat_loss', 'body_recomposition'];
const GAIN_GOALS = ['hypertrophy', 'strength', 'powerlifting', 'endurance'];

const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

function calculateTargets(input = {}) {
  const {
    age, gender, activity_level: activityLevel, goal,
    target_date: targetDate, today,
    safe_weekly_rate_kg: storedRate, estimated_duration_weeks: storedWeeks,
  } = input;
  const weight = isNum(input.weight_kg) ? Number(input.weight_kg) : null;
  const height = isNum(input.height_cm) ? Number(input.height_cm) : null;
  const targetWeight = isNum(input.target_weight_kg) ? Number(input.target_weight_kg) : null;
  const targetBodyFat = isNum(input.target_body_fat_pct) ? Number(input.target_body_fat_pct) : null;

  const warnings = [];
  const missing = [];
  const warn = (code, message) => warnings.push({ code, message });

  const inputs = {
    age: age ?? null,
    gender: gender ?? null,
    weight_kg: weight,
    height_cm: height,
    activity_level: activityLevel ?? null,
    goal: goal ?? null,
    target_weight_kg: targetWeight,
    target_body_fat_pct: targetBodyFat,
    safe_weekly_rate_kg: isNum(storedRate) && Number(storedRate) > 0 ? Number(storedRate) : null,
    estimated_duration_weeks: isNum(storedWeeks) && Number(storedWeeks) > 0 ? Math.round(Number(storedWeeks)) : null,
    target_date: targetDate || null,
    today: today || null,
  };

  const empty = (extra = {}) => ({
    version: NUTRITION_ENGINE_VERSION,
    bmr_kcal: null,
    tdee_kcal: null,
    calorie_target: null,
    activity_multiplier: null,
    calorie_adjustment_pct: null,
    macros: { protein_g: null, carbs_g: null, fat_g: null },
    fiber_g: null,
    water_ml: null,
    target: null,
    reconciled: false,
    warnings,
    missing,
    inputs,
    ...extra,
  });

  // 1. BMR. Unknown gender means "nobody recorded it", never a guess: the
  // calculator has no third formula and the prompt must not invent one.
  const bmr = calcBmr(weight, height, age, gender);
  if (bmr == null) {
    if (!isNum(age)) missing.push('age');
    if (!isNum(weight)) missing.push('weight_kg');
    if (!isNum(height)) missing.push('height_cm');
    const sex = String(gender ?? '').trim().toLowerCase();
    if (sex !== 'male' && sex !== 'female') missing.push('gender');
    return empty();
  }

  // 2. Activity.
  const multiplier = ACTIVITY_MULTIPLIERS[activityLevel];
  if (!multiplier) {
    missing.push('activity_level');
    return empty({ bmr_kcal: bmr });
  }

  // 3. TDEE.
  const tdee = Math.round(bmr * multiplier);

  // 4. Goal adjustment.
  const adjustment = GOAL_ADJUSTMENTS[goal];
  if (adjustment === undefined) {
    missing.push('goal');
    return empty({ bmr_kcal: bmr, tdee_kcal: tdee, activity_multiplier: multiplier });
  }

  // 5. Calorie target with the two safety clamps.
  const floor = Math.max(bmr, String(gender).trim().toLowerCase() === 'male' ? 1500 : 1200);
  const cap = tdee + 750;
  let calorieTarget = Math.round(tdee * (1 + adjustment));
  if (calorieTarget < floor) {
    calorieTarget = floor;
    warn('calorie_floor', `Calorie target raised to the safe minimum of ${floor} kcal.`);
  }
  if (calorieTarget > cap) {
    calorieTarget = cap;
    warn('calorie_cap', `Calorie target capped at ${cap} kcal for this energy expenditure.`);
  }

  // 6. Protein, clamped to 1.2–2.2 g/kg.
  const perKg = PROTEIN_G_PER_KG[goal] ?? PROTEIN_G_PER_KG.general_fitness;
  const proteinMin = Math.round(weight * 1.2);
  const proteinMax = Math.round(weight * 2.2);
  const protein = Math.min(proteinMax, Math.max(proteinMin, Math.round(weight * perKg)));

  // 7. Fat: 25% of the target, floored at 0.6 g/kg and capped at 35%.
  const fatMin = Math.round(weight * 0.6);
  const fatMax = Math.round((calorieTarget * 0.35) / 9);
  let fat = Math.min(fatMax, Math.max(fatMin, Math.round((calorieTarget * 0.25) / 9)));

  // 8. Carbs take the remainder; if they fall under 1 g/kg, give fat back
  // toward its floor before declaring a conflict.
  const carbFloor = Math.round(weight);
  let carbs = Math.round((calorieTarget - 4 * protein - 9 * fat) / 4);
  if (carbs < carbFloor) {
    const deficitKcal = 4 * (carbFloor - carbs);
    const cut = Math.min(Math.max(0, fat - fatMin), Math.ceil(deficitKcal / 9));
    if (cut > 0) {
      fat -= cut;
      carbs = Math.round((calorieTarget - 4 * protein - 9 * fat) / 4);
    }
  }

  // 9. Reconcile the rounding into carbs. The floor outranks the target: a
  // body-weight minimum is a health floor, so when the two conflict the plan
  // is knowingly over target. Applying the floor before this step let the
  // reconciliation quietly spend it again.
  const delta = calorieTarget - (4 * protein + 4 * carbs + 9 * fat);
  let reconciled = delta !== 0;
  carbs += Math.round(delta / 4);
  if (carbs < carbFloor) {
    carbs = carbFloor;
    reconciled = true;
    warn('macro_floor_conflict', 'Carbohydrates were raised to the minimum for body weight; macros may not sum to the calorie target.');
  }
  const reconciledKcal = 4 * protein + 4 * carbs + 9 * fat;
  if (Math.abs(calorieTarget - reconciledKcal) > 50) {
    warn('macro_reconciliation_gap', `Macros sum to ${reconciledKcal} kcal against a ${calorieTarget} kcal target.`);
  }

  // 10–11. Fibre and water.
  const fiber = Math.min(50, Math.max(25, Math.round((14 * calorieTarget) / 1000)));
  const water = Math.min(5000, Math.max(1500, Math.round((35 * weight) / 250) * 250));

  // 12–13. Target weight, rate, timeline.
  let targetBlock = null;
  if (targetWeight != null || targetBodyFat != null) {
    const deltaKg = targetWeight != null ? Math.round((weight - targetWeight) * 10) / 10 : null;
    let direction = null;
    if (deltaKg != null && Math.abs(deltaKg) >= 0.5) direction = deltaKg > 0 ? 'loss' : 'gain';

    let rate = inputs.safe_weekly_rate_kg;
    if (rate == null && direction) rate = calcSafeWeeklyRate(weight, direction);

    let weeks = inputs.estimated_duration_weeks;
    if (weeks == null && targetWeight != null && rate) {
      weeks = calcEstimatedDurationWeeks(weight, targetWeight, rate);
    }

    let aggressive = false;
    if (today && targetDate && targetWeight != null && rate) {
      const days = Math.round(
        (Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000,
      );
      const required = calcRequiredWeeklyRate(weight, targetWeight, days);
      aggressive = required != null && Math.abs(required) > Math.abs(rate) * 1.5;
    }

    targetBlock = {
      weight_kg: targetWeight,
      body_fat_pct: targetBodyFat,
      delta_kg: deltaKg,
      direction,
      weekly_rate_kg: rate ?? null,
      timeline_weeks: weeks ?? null,
      target_date: targetDate || null,
      aggressive,
    };

    const mismatch = (LOSS_GOALS.includes(goal) && direction === 'gain')
      || (GAIN_GOALS.includes(goal) && direction === 'loss');
    if (mismatch) {
      warn('target_goal_mismatch', 'The target weight moves against the training goal.');
      targetBlock.weekly_rate_kg = null;
      targetBlock.timeline_weeks = null;
      targetBlock.aggressive = false;
    }
  }

  return {
    version: NUTRITION_ENGINE_VERSION,
    bmr_kcal: bmr,
    tdee_kcal: tdee,
    calorie_target: calorieTarget,
    activity_multiplier: multiplier,
    calorie_adjustment_pct: Math.round(adjustment * 100),
    macros: { protein_g: protein, carbs_g: carbs, fat_g: fat },
    fiber_g: fiber,
    water_ml: water,
    target: targetBlock,
    reconciled,
    warnings,
    missing,
    inputs,
  };
}

module.exports = {
  NUTRITION_ENGINE_VERSION,
  ACTIVITY_MULTIPLIERS,
  GOAL_ADJUSTMENTS,
  PROTEIN_G_PER_KG,
  calculateTargets,
};

'use strict';
// One fact, one owner. Several screens show facts another screen asks for:
// alcohol is asked in Lifestyle but consumed by Nutrition's hydration score,
// and water/meals are asked in Nutrition but consumed by Lifestyle's six
// components. Each module used to prefer its own copy, so two forms could
// disagree about the same client. Precedence lives here, once, and the
// non-owner's copy is only a fallback for rows written before the move.

const logger = require('../../lib/logger');

const num = (v) => (v == null || v === '' ? null : Number(v));
const str = (v) => (v == null || v === '' ? null : v);

// A fallback read is expected on rows written before the move, but it is still
// worth seeing: it says the canonical record is missing a fact the owner asks.
function logDeprecatedRead(field, owner, source, context) {
  logger.info({
    event: 'ownership.deprecated_read',
    field,
    owner,
    source,
    ...context,
  }, 'Read a fact from a legacy column because the owner has no answer');
}

// Alcohol: Lifestyle owns both the status and the weekly quantity. Nutrition's
// alcoholic_drinks_per_week column predates that move and is read only when
// Lifestyle has no answer.
function resolveAlcohol(lifestyle = {}, legacyNutrition = {}, context = {}) {
  const drinksPerWeek = num(lifestyle.drinks_per_week)
    ?? num(legacyNutrition.alcoholic_drinks_per_week);
  if (num(lifestyle.drinks_per_week) == null && num(legacyNutrition.alcoholic_drinks_per_week) != null) {
    logDeprecatedRead('drinks_per_week', 'Lifestyle', 'pt_nutrition_assessments.alcoholic_drinks_per_week', context);
  }
  return { status: str(lifestyle.alcohol_status), drinksPerWeek };
}

// Water, meal frequency, breakfast and late-night eating: Nutrition asks
// them. The Lifestyle row keeps copies for its six-component score; those
// copies are read only when Nutrition has no answer.
function resolveNutritionHabits(lifestyle = {}, nutrition = {}, context = {}) {
  const out = {
    water_intake_liters: num(nutrition.water_intake_liters) ?? num(lifestyle.water_intake_liters),
    meal_frequency: num(nutrition.meals_per_day) ?? num(lifestyle.meal_frequency),
    breakfast_habit: str(nutrition.breakfast_regularity) ?? str(lifestyle.breakfast_habit),
    late_night_eating: (nutrition.late_night_eating ?? null) ?? (lifestyle.late_night_eating ?? null),
  };
  const fallbacks = [
    ['water_intake_liters', 'pt_lifestyle_assessments.water_intake_liters'],
    ['meal_frequency', 'pt_lifestyle_assessments.meal_frequency'],
    ['breakfast_habit', 'pt_lifestyle_assessments.breakfast_habit'],
    ['late_night_eating', 'pt_lifestyle_assessments.late_night_eating'],
  ];
  for (const [field, source] of fallbacks) {
    const owned = field === 'water_intake_liters' ? num(nutrition.water_intake_liters)
      : field === 'meal_frequency' ? num(nutrition.meals_per_day)
        : field === 'breakfast_habit' ? str(nutrition.breakfast_regularity)
          : (nutrition.late_night_eating ?? null);
    if (owned == null && out[field] != null) logDeprecatedRead(field, 'Nutrition', source, context);
  }
  return out;
}

// Medical conditions: PAR-Q owns them. Nutrition's medical_conditions column
// predates that move and is read only when the client has no submitted PAR-Q
// to answer for them. An existing PAR-Q that reports nothing is still an
// answer, so the legacy list is not consulted then.
const PARQ_CONDITION_KEYS = {
  current_health: {
    known_disease: 'Known disease',
    current_treatment: 'Ongoing treatment',
    has_pain: 'Current pain',
  },
  past_history: {
    heart_disease: 'Heart disease',
    respiratory_disease: 'Respiratory disease',
    asthma: 'Asthma',
    copd: 'COPD',
    tuberculosis: 'Tuberculosis',
    joint_problems: 'Joint problems',
    previous_fractures: 'Previous fractures',
    surgeries: 'Previous surgery',
  },
};
const PARQ_CONDITION_QUESTIONS = {
  1: 'Heart condition',
  6: 'Joint problem',
  7: 'Asthma, diabetes, epilepsy or high blood pressure',
  8: 'Diagnosed condition',
  9: 'Injury or condition under treatment',
  10: 'Other medical reason',
};

const isYes = (v) => v === true || v === 'yes' || v === 'Yes' || v === 'true';

function parqConditions(parq) {
  const out = [];
  for (const [section, keys] of Object.entries(PARQ_CONDITION_KEYS)) {
    const answers = parq[section];
    if (!answers || typeof answers !== 'object') continue;
    for (const [key, label] of Object.entries(keys)) {
      if (isYes(answers[key])) out.push(label);
    }
  }
  for (const a of Array.isArray(parq.parq_answers) ? parq.parq_answers : []) {
    const label = a && PARQ_CONDITION_QUESTIONS[String(a.question_id)];
    if (label && isYes(a.answer)) out.push(label);
  }
  return out;
}

function resolveMedicalConditions(parq, legacyNutrition = {}, context = {}) {
  if (parq) return parqConditions(parq);
  const legacy = Array.isArray(legacyNutrition.medical_conditions) ? legacyNutrition.medical_conditions : [];
  if (legacy.length) {
    logDeprecatedRead('medical_conditions', 'PAR-Q', 'pt_nutrition_assessments.medical_conditions', context);
  }
  return legacy;
}

module.exports = { resolveAlcohol, resolveNutritionHabits, resolveMedicalConditions };

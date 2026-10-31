'use strict';
// One fact, one owner. Several screens show facts another screen asks for:
// alcohol is asked in Lifestyle but consumed by Nutrition's hydration score,
// and water/meals are asked in Nutrition but consumed by Lifestyle's six
// components. Each module used to prefer its own copy, so two forms could
// disagree about the same client. Precedence lives here, once, and the
// non-owner's copy is only a fallback for rows written before the move.

const num = (v) => (v == null || v === '' ? null : Number(v));
const str = (v) => (v == null || v === '' ? null : v);

// Alcohol: Lifestyle owns both the status and the weekly quantity. Nutrition's
// alcoholic_drinks_per_week column predates that move and is read only when
// Lifestyle has no answer.
function resolveAlcohol(lifestyle = {}, legacyNutrition = {}) {
  return {
    status: str(lifestyle.alcohol_status),
    drinksPerWeek: num(lifestyle.drinks_per_week) ?? num(legacyNutrition.alcoholic_drinks_per_week),
  };
}

module.exports = { resolveAlcohol };

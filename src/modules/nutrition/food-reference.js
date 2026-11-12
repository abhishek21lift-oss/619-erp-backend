'use strict';
// Match what the model called a food to what the studio knows a food is.
//
// The prompt gets names from the studio's reference table; the model still
// writes its own words, quantities and units back. This module is the join
// between the two. It is deliberately forgiving about naming (case, brackets,
// aliases) and strict about numbers: a name that matches but whose calories
// are 40% off is not a reference food, it is a model estimate wearing a
// food_id. The label says which, so the trainer does.
//
// Never throws on an unmatched food: an unknown dish is normal, and a plan
// must still be reviewable.

const pool = require('../../db/pool');

const REFERENCE_TOLERANCE = 0.25;

/** Lowercase, `&` to “and”, punctuation to spaces, collapsed. */
function normaliseFoodName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const UNIT_ALIASES = {
  gram: 'g',
  grams: 'g',
  millilitre: 'ml',
  millilitres: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
};

function normaliseUnit(unit) {
  const key = String(unit ?? '').trim().toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES[key] ?? key;
}

/**
 * Grams for the stated quantity, or null when the unit cannot be converted.
 * For g/ml the reference macros are quoted per `serving_grams`.
 */
function toGrams(food, quantity, unit) {
  const gramsPer = Number(food.serving_grams);
  if (!(gramsPer > 0)) return null;
  const stated = normaliseUnit(unit);
  const reference = normaliseUnit(food.serving_unit);
  if ((reference === 'g' || reference === 'ml') && (stated === 'g' || stated === 'ml')) {
    return { grams: quantity, scale: quantity / gramsPer };
  }
  if (stated === reference) return { grams: quantity * gramsPer, scale: quantity };
  return null;
}

const MACROS = [
  ['protein_g', 'protein_g'],
  ['carbs_g', 'carbs_g'],
  ['fat_g', 'fats_g'],
  ['fiber_g', 'fiber_g'],
];

function withinTolerance(actual, expected) {
  return Math.abs(actual - expected) <= Math.abs(expected) * REFERENCE_TOLERANCE;
}

/** Every stated value that can be compared must agree with reference × scale. */
function macrosWithin(reference, stated, scale) {
  const expectedCals = Number(reference.calories) * scale;
  const actualCals = Number(stated.calories);
  if (!Number.isFinite(expectedCals) || !Number.isFinite(actualCals)) return false;
  if (!withinTolerance(actualCals, expectedCals)) return false;

  for (const [statedKey, referenceKey] of MACROS) {
    const actual = Number(stated[statedKey]);
    const expected = Number(reference[referenceKey]);
    if (stated[statedKey] == null || reference[referenceKey] == null) continue;
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
    if (!withinTolerance(actual, expected * scale)) return false;
  }
  return true;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The studio's foods, plus the lookups the generator needs. One query per
 * generation; the caller holds the result for both the prompt and validation.
 */
async function loadFoodReference(orgId) {
  const { rows } = await pool.query(
    `SELECT id, organization_id, name, normalized_name, aliases, category, culture, region,
            serving_unit, serving_grams, calories, protein_g, carbs_g, fats_g, fiber_g
       FROM foods
      WHERE is_active = TRUE
        AND (organization_id IS NULL OR organization_id = $1)
      ORDER BY organization_id NULLS FIRST, name
      LIMIT 1000`,
    [orgId],
  );
  return referenceFromRows(rows);
}

/** Pure constructor, exported for tests and for a safe empty fallback. */
function referenceFromRows(rows = []) {
  const foods = Array.isArray(rows) ? rows : [];
  const byId = new Map(foods.map((food) => [String(food.id), food]));
  const byName = new Map();

  // Canonical names first, then aliases: a global row sorts before an org row,
  // so a studio alias can never shadow the canonical name of a seed food.
  for (const food of foods) {
    const key = normaliseFoodName(food.normalized_name || food.name);
    if (key && !byName.has(key)) byName.set(key, food);
  }
  for (const food of foods) {
    for (const alias of Array.isArray(food.aliases) ? food.aliases : []) {
      const key = normaliseFoodName(alias);
      if (key && !byName.has(key)) byName.set(key, food);
    }
  }

  return {
    foods,
    byId,
    matchFood: (name) => byName.get(normaliseFoodName(name)) ?? null,
    namesForCulture: (culture) => {
      const wanted = String(culture ?? '').trim().toLowerCase();
      // A mixed kitchen is every kitchen: the default has to offer the
      // Indian seed too, or a client with no recorded culture gets a plan
      // with no reference foods at all.
      const names = foods
        .filter((food) => {
          if (!wanted || wanted === 'mixed') return true;
          const c = String(food.culture ?? '').trim().toLowerCase();
          return c === 'mixed' || c === wanted;
        })
        .map((food) => food.name)
        .filter(Boolean);
      return [...new Set(names)].slice(0, 120);
    },
  };
}

/** A stable object for “the foods read failed”: generation continues cold. */
const EMPTY_FOOD_REFERENCE = referenceFromRows([]);

/**
 * Stamp every numeric-quantity food with its reference identity. Stated
 * calories and macros are never overwritten — only labelled.
 */
function stampPlanFoods(plan, reference) {
  if (!plan || typeof plan !== 'object') return plan ?? null;
  if (!Array.isArray(plan.meals)) return { ...plan };

  const stamp = (food) => {
    if (!food || typeof food !== 'object') return food;
    // Legacy plans wrote "60 g" into quantity; that path stays as it was.
    if (typeof food.quantity !== 'number') return food;

    const known = food.food_id != null ? reference.byId.get(String(food.food_id)) : null;
    const match = known ?? reference.matchFood(food.name);
    if (!match) return { ...food, grams: null, nutrition_source: 'model' };

    const converted = toGrams(match, food.quantity, food.unit);
    const grams = converted ? round2(converted.grams) : null;
    const trusted = converted != null && macrosWithin(match, food, converted.scale);
    return {
      ...food,
      food_id: match.id,
      grams,
      nutrition_source: trusted ? 'reference' : 'model',
    };
  };

  return {
    ...plan,
    meals: plan.meals.map((meal) => (
      meal && typeof meal === 'object' && Array.isArray(meal.foods)
        ? { ...meal, foods: meal.foods.map(stamp) }
        : meal
    )),
  };
}

module.exports = {
  REFERENCE_TOLERANCE,
  normaliseFoodName,
  loadFoodReference,
  referenceFromRows,
  EMPTY_FOOD_REFERENCE,
  stampPlanFoods,
};

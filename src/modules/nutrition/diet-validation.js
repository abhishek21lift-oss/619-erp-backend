'use strict';
// What a generated plan must prove before a trainer can trust it.
//
// Pure: no database, no clock. The validator answers three questions the
// prompt cannot enforce — did the meals add up to the numbers the server
// calculated, do the meals exist at the times the scheduler fixed, and is
// anything in them something the client must not eat. Blockers cost one
// bounded revision; warnings travel with the plan so the trainer sees the
// soft misses (carbs, fiber, unverified foods) instead of a silent pass.

const TOLERANCES = Object.freeze({
  dailyCaloriesPct: 0.05, dailyCaloriesAbs: 50,
  proteinMinPct: 0.90, proteinMaxPct: 1.30,
  macroPct: 0.15, fiberMinPct: 0.80,
  mealCaloriesPct: 0.07, mealCaloriesAbs: 25,
  foodReferencePct: 0.25,
});

// Group vocabularies, not a food database. A name is matched against these
// groups so "Ghee" fails a dairy allergy without the seed having to list every
// dairy word a model might write.
const ALLERGEN_GROUPS = Object.freeze({
  dairy: ['milk', 'paneer', 'curd', 'dahi', 'yogurt', 'yoghurt', 'ghee', 'cheese', 'butter', 'lassi', 'buttermilk', 'cream'],
  nuts: ['almond', 'cashew', 'walnut', 'pistachio', 'peanut', 'hazelnut', 'pecan'],
  gluten: ['wheat', 'roti', 'chapati', 'bread', 'maida', 'semolina', 'atta', 'suji', 'pasta', 'noodle'],
  shellfish: ['prawn', 'shrimp', 'crab', 'lobster', 'shellfish'],
  soy: ['soy', 'tofu', 'tempeh', 'edamame'],
  egg: ['egg', 'omelette', 'omelet', 'mayonnaise', 'mayo'],
  fish: ['fish', 'salmon', 'tuna', 'cod', 'mackerel', 'sardine', 'anchovy'],
  meat: ['chicken', 'mutton', 'lamb', 'beef', 'pork', 'turkey', 'meat', 'keema'],
});

// A pattern forbids groups; `honey` is literal because it has no group.
const DIETARY_PATTERN_GROUPS = Object.freeze({
  vegan: ['dairy', 'egg', 'fish', 'shellfish', 'meat', 'honey'],
  vegetarian: ['egg', 'fish', 'shellfish', 'meat'],
  eggetarian: ['fish', 'shellfish', 'meat'],
});

const PRE_POST = new Set(['pre_workout', 'post_workout']);
const MAIN_WINDOW = { start: 5 * 60, end: 23 * 60 + 59 };
const TOTAL_CALORIE_RANGE = { min: 500, max: 10000 };
const MAX_FOODS_PER_MEAL = 30;
const LOSS_GOALS = new Set(['fat_loss', 'body_recomposition']);
const GAIN_GOALS = new Set(['hypertrophy', 'strength', 'powerlifting', 'endurance']);

const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const fold = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A term hits as a word (or its plural), never inside a longer word. */
function hasTerm(text, term) {
  const t = fold(term);
  if (!t) return false;
  return new RegExp(`(?:^| )${escapeRe(t)}(?:s|es)?(?: |$)`).test(text);
}

/** Arrays stay arrays; a comma/newline string becomes one. One definition. */
function asList(value) {
  const raw = Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(/[\n,]/) : [];
  return raw.map((v) => String(v ?? '').trim()).filter(Boolean);
}

function structuredFoods(plan) {
  const out = [];
  for (const meal of Array.isArray(plan?.meals) ? plan.meals : []) {
    for (const food of Array.isArray(meal?.foods) ? meal.foods : []) {
      if (food && typeof food === 'object' && String(food.name ?? '').trim()) {
        out.push({ meal, food, name: fold(food.name) });
      }
    }
  }
  return out;
}

const sumOf = (values) => (values.length ? values.reduce((a, b) => a + b, 0) : null);

function mealCalorieSum(meals) {
  const values = meals.map((m) => num(m?.calories));
  return values.every((n) => n != null) ? sumOf(values) : null;
}

function validatePlan(plan, {
  targets = null,
  schedule = null,
  restrictions = {},
  foodsById = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  const results = [];

  const flag = (id, level, message) => {
    let entry = results.find((r) => r.id === id);
    if (!entry) {
      entry = { id, status: 'ok', details: [] };
      results.push(entry);
    }
    entry.details.push(message);
    if (level === 'blocker') {
      entry.status = 'blocker';
      blockers.push(message);
    } else {
      if (entry.status !== 'blocker') entry.status = 'warn';
      warnings.push(message);
    }
  };
  const pass = (id) => {
    if (!results.some((r) => r.id === id)) results.push({ id, status: 'ok', details: [] });
  };
  const inTolerance = (actual, target, pct, abs = 0) => (
    actual != null && target != null
    && Math.abs(actual - target) <= Math.max(abs, Math.abs(target) * pct)
  );

  const meals = Array.isArray(plan?.meals) ? plan.meals : [];
  const foods = structuredFoods(plan);
  const dailyCalories = mealCalorieSum(meals);

  // 1. The target the plan was asked to hit, end to end.
  if (targets?.calorie_target != null && dailyCalories != null) {
    if (inTolerance(dailyCalories, targets.calorie_target, TOLERANCES.dailyCaloriesPct, TOLERANCES.dailyCaloriesAbs)) {
      pass('daily_calories');
    } else {
      flag('daily_calories', 'blocker', `Daily calories ${Math.round(dailyCalories)} are outside tolerance of the ${targets.calorie_target} kcal target.`);
    }
  }

  // 2–3. Protein is a floor and a ceiling; carbs and fat are soft misses.
  const macroSum = (key) => {
    const values = meals.map((m) => num(m?.[key]));
    return values.every((n) => n != null) ? sumOf(values) : null;
  };
  const protein = macroSum('protein_g');
  const proteinTarget = num(targets?.macros?.protein_g);
  if (protein != null && proteinTarget != null) {
    if (protein < proteinTarget * TOLERANCES.proteinMinPct) {
      flag('daily_protein', 'blocker', `Daily protein ${Math.round(protein)} g is below 90% of the ${proteinTarget} g target.`);
    } else if (protein > proteinTarget * TOLERANCES.proteinMaxPct) {
      flag('daily_protein', 'blocker', `Daily protein ${Math.round(protein)} g is above 130% of the ${proteinTarget} g target.`);
    } else {
      pass('daily_protein');
    }
  }
  for (const [key, label] of [['carbs_g', 'carbs'], ['fat_g', 'fat']]) {
    const actual = macroSum(key);
    const target = num(targets?.macros?.[key]);
    const id = `daily_${label}`;
    if (actual == null || target == null) continue;
    if (inTolerance(actual, target, TOLERANCES.macroPct)) pass(id);
    else flag(id, 'warn', `Daily ${label} ${Math.round(actual)} g is more than 15% from the ${target} g target.`);
  }

  // 4. Fiber, only when the plan carries any.
  const fiberValues = [
    ...meals.map((m) => num(m?.fiber_g)),
    ...foods.map(({ food }) => num(food.fiber_g)),
  ].filter((n) => n != null);
  if (fiberValues.length && targets?.fiber_g != null) {
    const total = sumOf(fiberValues);
    if (total < targets.fiber_g * TOLERANCES.fiberMinPct) {
      flag('fiber', 'warn', `Fiber ${Math.round(total)} g is below 80% of the ${targets.fiber_g} g target.`);
    } else {
      pass('fiber');
    }
  }

  // 5–6. Each meal's foods must add up to the meal it is printed under.
  meals.forEach((meal, i) => {
    const name = String(meal?.name ?? `Meal ${i + 1}`);
    const list = Array.isArray(meal?.foods) ? meal.foods.filter((f) => f && typeof f === 'object' && f.name != null) : [];
    if (!list.length) return;
    const cals = list.map((f) => num(f.calories));
    if (cals.every((n) => n != null)) {
      const sum = sumOf(cals);
      if (!inTolerance(sum, num(meal.calories), TOLERANCES.mealCaloriesPct, TOLERANCES.mealCaloriesAbs)) {
        flag('meal_calories', 'blocker', `Meal "${name}" lists ${Math.round(sum)} kcal in foods but ${meal.calories ?? 'no'} kcal on the meal.`);
      } else {
        pass('meal_calories');
      }
    }
    for (const [key, label] of [['protein_g', 'protein'], ['carbs_g', 'carbs'], ['fat_g', 'fat']]) {
      const target = num(meal?.[key]);
      const values = list.map((f) => num(f[key]));
      if (target == null || !values.every((n) => n != null)) continue;
      if (inTolerance(sumOf(values), target, TOLERANCES.macroPct)) pass('meal_macros');
      else flag('meal_macros', 'warn', `Meal "${name}" ${label} does not match its foods.`);
    }
  });

  // 7. The meals must add up to the total the plan prints.
  const declared = num(plan?.total_calories);
  if (dailyCalories != null && declared != null) {
    if (inTolerance(dailyCalories, declared, TOLERANCES.dailyCaloriesPct, TOLERANCES.dailyCaloriesAbs)) pass('daily_sum');
    else flag('daily_sum', 'blocker', `Meals add up to ${Math.round(dailyCalories)} kcal but the plan says ${declared} kcal.`);
  }

  // 8–9. A structured food must be countable and carry its own numbers.
  for (const { meal, food } of foods) {
    const name = String(food.name);
    if (!(num(food.quantity) > 0) || !String(food.unit ?? '').trim()) {
      flag('food_quantity', 'blocker', `Food "${name}" needs a positive quantity and a unit.`);
    } else {
      pass('food_quantity');
    }
    if (num(food.calories) == null) {
      flag('food_calories', 'blocker', `Food "${name}" has no numeric calories.`);
    } else {
      pass('food_calories');
    }
    if (['protein_g', 'carbs_g', 'fat_g'].some((k) => num(food[k]) == null)) {
      flag('food_macros', 'warn', `Food "${name}" is missing a macro; its contribution is unverified.`);
    } else {
      pass('food_macros');
    }
    if (Array.isArray(meal.foods) && meal.foods.length > MAX_FOODS_PER_MEAL) {
      flag('food_quantity', 'blocker', `Meal "${meal.name}" lists more than ${MAX_FOODS_PER_MEAL} foods.`);
    }
  }

  // 10–12. The schedule is fixed: its slots must exist at usable times.
  if (Array.isArray(schedule) && schedule.length) {
    const bySlot = new Map(meals.filter((m) => m?.slot).map((m) => [String(m.slot), m]));
    for (const slot of schedule.filter((s) => PRE_POST.has(s?.slot))) {
      if (!bySlot.has(slot.slot)) {
        flag('pre_post', 'blocker', `Scheduled ${slot.slot} meal (${slot.time}) is missing from the plan.`);
      } else {
        pass('pre_post');
      }
    }
    for (const slot of schedule.filter((s) => !PRE_POST.has(s?.slot))) {
      if (!bySlot.has(slot.slot)) {
        flag('meal_frequency', 'blocker', `Scheduled meal "${slot.slot}" (${slot.time}) is missing from the plan.`);
      } else {
        pass('meal_frequency');
      }
    }
    if (meals.length !== schedule.length) {
      flag('meal_frequency', 'blocker', `The plan has ${meals.length} meals but the schedule has ${schedule.length} slots.`);
    }
  }

  const seenTimes = new Set();
  meals.forEach((meal, i) => {
    const name = String(meal?.name ?? `Meal ${i + 1}`);
    const time = String(meal?.time ?? '').trim();
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) {
      flag('meal_times', 'blocker', `Meal "${name}" has no valid HH:MM time.`);
    } else {
      const minutes = Number(match[1]) * 60 + Number(match[2]);
      const isMain = !PRE_POST.has(meal?.slot);
      if (isMain && (minutes < MAIN_WINDOW.start || minutes > MAIN_WINDOW.end)) {
        flag('meal_times', 'blocker', `Meal "${name}" at ${time} is outside the 05:00–23:59 window.`);
      } else {
        pass('meal_times');
      }
      if (seenTimes.has(time)) flag('meal_times', 'blocker', `Two meals are scheduled at ${time}.`);
      seenTimes.add(time);
    }
  });
  if (Array.isArray(schedule) && schedule.length) {
    const order = new Map(schedule.map((s, i) => [String(s.slot), i]));
    const indices = meals
      .map((m) => order.get(String(m?.slot)))
      .filter((n) => n != null);
    if (indices.some((n, i) => i > 0 && n < indices[i - 1])) {
      flag('meal_times', 'blocker', 'Meals are not in the scheduled order.');
    }
  }

  // 13. Allergies and foods to avoid. Known terms expand to a group; an
  // unknown token still warns, because silence would read as clearance.
  const checkRestriction = (raw, { phrase, id }) => {
    for (const token of asList(raw)) {
      const terms = ALLERGEN_GROUPS[token] ?? [token];
      const known = Boolean(ALLERGEN_GROUPS[token]);
      let hits = 0;
      for (const { meal, food, name } of foods) {
        const hit = terms.find((term) => hasTerm(name, term));
        if (!hit) continue;
        hits += 1;
        flag(id, 'blocker', `${phrase} "${token}": meal "${meal.name}" contains ${food.name} (${hit}).`);
      }
      if (!known && hits === 0) {
        flag(id, 'warn', `${phrase} "${token}" is not a known group; no food matched — verify manually.`);
      }
    }
  };
  checkRestriction(restrictions?.allergies, { phrase: 'Allergy', id: 'allergens' });
  checkRestriction(restrictions?.foodsToAvoid, { phrase: 'Food to avoid', id: 'allergens' });

  // 14. Dietary pattern.
  const pattern = String(restrictions?.dietaryPattern ?? '').trim().toLowerCase();
  if (pattern && DIETARY_PATTERN_GROUPS[pattern]) {
    for (const group of DIETARY_PATTERN_GROUPS[pattern]) {
      const terms = ALLERGEN_GROUPS[group] ?? [group];
      for (const { meal, food, name } of foods) {
        const hit = terms.find((term) => hasTerm(name, term));
        if (hit) {
          flag('dietary_pattern', 'blocker', `Dietary pattern "${pattern}" forbids ${hit} in "${food.name}" (meal "${meal.name}").`);
        }
      }
    }
    pass('dietary_pattern');
  }

  // 15. Reference-food identity, only when the caller supplies the table.
  if (foodsById) {
    for (const { meal, food } of foods) {
      if (food.food_id == null) continue;
      const ref = foodsById[String(food.food_id)];
      if (!ref) {
        flag('food_references', 'blocker', `Food "${food.name}" references an unknown food_id.`);
        continue;
      }
      const grams = num(food.grams);
      const refCals = num(ref.calories_per_100g);
      if (grams != null && refCals != null) {
        const expected = (refCals * grams) / 100;
        if (!inTolerance(num(food.calories), expected, TOLERANCES.foodReferencePct)) {
          flag('food_references', 'warn', `Food "${food.name}" calories do not match the reference food within 25%.`);
        } else {
          pass('food_references');
        }
      }
      void meal;
    }
  }

  // 16. Anything the model estimated is flagged as such.
  for (const { food } of foods) {
    if (food.nutrition_source === 'model') {
      flag('unverified', 'warn', `Food "${food.name}" uses model-estimated nutrition.`);
    }
  }

  // 17. The engine's own macro reconciliation, surfaced with the plan.
  if (targets?.reconciled && targets?.macros && plan?.macros) {
    for (const [key, label] of [['protein_g', 'protein'], ['carbs_g', 'carbs'], ['fat_g', 'fat']]) {
      const a = num(plan.macros[key]);
      const b = num(targets.macros[key]);
      if (a != null && b != null && !inTolerance(a, b, TOLERANCES.macroPct)) {
        flag('macro_reconciliation', 'warn', `Plan ${label} differs from the engine's reconciled macro target.`);
      }
    }
    pass('macro_reconciliation');
  }

  // 18. A target pointing the opposite way from the goal is a data error, not
  // a plan error — flag it, never block on it.
  const direction = targets?.target?.direction;
  const goal = String(targets?.inputs?.goal ?? '').trim().toLowerCase();
  if (direction && goal) {
    if ((direction === 'loss' && GAIN_GOALS.has(goal)) || (direction === 'gain' && LOSS_GOALS.has(goal))) {
      flag('target_goal_consistency', 'warn', `Target direction "${direction}" contradicts the ${goal} goal.`);
    } else {
      pass('target_goal_consistency');
    }
  }

  // 19. The same bounds normalisePlan enforces at save time.
  if (declared == null || declared < TOTAL_CALORIE_RANGE.min || declared > TOTAL_CALORIE_RANGE.max) {
    flag('total_calories', 'blocker', `Plan total_calories must be between ${TOTAL_CALORIE_RANGE.min} and ${TOTAL_CALORIE_RANGE.max}.`);
  } else {
    pass('total_calories');
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    checks: results.map((r) => ({
      id: r.id,
      status: r.status,
      detail: r.details.length ? r.details.join(' ') : null,
    })),
  };
}

/** True when the record has moved enough that the plan's numbers are stale. */
function targetsStale(calculation, live = {}) {
  const inputs = calculation?.inputs;
  if (!inputs) return false;
  for (const [field, tolerance] of [['weight_kg', 0.5], ['height_cm', 1]]) {
    const was = num(inputs[field]);
    const now = num(live?.[field]);
    if (was != null && now != null && Math.abs(was - now) >= tolerance) return true;
  }
  const wasGoal = fold(inputs.goal);
  const nowGoal = fold(live?.goal);
  return Boolean(wasGoal && nowGoal && wasGoal !== nowGoal);
}

module.exports = {
  TOLERANCES,
  ALLERGEN_GROUPS,
  DIETARY_PATTERN_GROUPS,
  asList,
  validatePlan,
  targetsStale,
};

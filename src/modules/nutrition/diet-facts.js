'use strict';
// What the diet engine knows about a client, and where each fact came from.
//
// The generator already had a resolver, but it answered a prompt-shaped
// question ("what do I tell the model?"). This one answers an engine-shaped
// one ("what may I compute with?"): typed enums, bounded numbers, and an
// `origins` map so the trainer can see whether a value came from the record,
// from the request, or from a default the engine chose.
//
// Precedence follows the rest of the platform: the canonical module owns the
// fact and the request body only fills a gap. One deliberate exception —
// `dietary_pattern` — because a recorded pattern is a safety fact and an
// allergy-adjacent one, so the record beats the browser.

const {
  fromSources, when, withFreshness, numInRange,
} = require('../pt-os/client-facts');
const { parseWorkoutTime } = require('./meal-scheduler');

const FOOD_CULTURES = Object.freeze(['indian', 'western', 'mixed']);
const DIETARY_PATTERNS = Object.freeze(['vegetarian', 'eggetarian', 'non_vegetarian', 'vegan']);
const MEAL_TIMING_PREFERENCES = Object.freeze(['early', 'standard', 'late', 'no_preference']);

const DEFAULT_FOOD_CULTURE = 'mixed';
const DEFAULT_TIMING = 'standard';
const DEFAULT_DURATION = 60;
const MAX_CUISINES = 5;
const MAX_CUISINE_LENGTH = 40;
const MAX_NOTES = 300;

// Fields the engine can plan without but plans better with. Listed once so
// `missing` is a fact about the record, not a per-caller opinion.
const PLANNING_OPTIONAL = Object.freeze(['target_weight_kg', 'workout_time', 'dietary_pattern']);

const fold = (v) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');

const ACTIVITY_ALIASES = {
  sedentary: 'sedentary',
  lightlyactive: 'lightly_active',
  light: 'lightly_active',
  moderatelyactive: 'moderately_active',
  moderate: 'moderately_active',
  veryactive: 'very_active',
  extraactive: 'extra_active',
  athlete: 'extra_active',
};

/** Map a studio's free-text activity label onto the engine's five keys. */
function normaliseActivityLevel(value) {
  const key = fold(value);
  return key ? (ACTIVITY_ALIASES[key] ?? null) : null;
}

const PATTERN_ALIASES = {
  vegan: 'vegan',
  vegetarian: 'vegetarian',
  eggetarian: 'eggetarian',
  eggitarian: 'eggetarian',
  nonvegetarian: 'non_vegetarian',
  nonveg: 'non_vegetarian',
};

/**
 * Only an unambiguous label counts. 'Jain' and 'Keto' are real preferences
 * with real food rules, but neither maps onto one of the four patterns, and
 * guessing would either forbid food the client eats or allow food they do not.
 */
function classifyDietaryPattern(value) {
  const list = Array.isArray(value) ? value : [value];
  for (const entry of list) {
    const key = fold(entry);
    if (PATTERN_ALIASES[key]) return PATTERN_ALIASES[key];
  }
  return null;
}

const asEnum = (value, allowed) => {
  const key = String(value ?? '').trim().toLowerCase();
  return allowed.includes(key) ? key : null;
};

const shortText = (value, max = MAX_NOTES) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, max) : null;
};

function cuisineList(value) {
  const raw = Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(',') : [];
  const list = raw.map((c) => String(c ?? '').trim()).filter(Boolean)
    .map((c) => c.slice(0, MAX_CUISINE_LENGTH))
    .slice(0, MAX_CUISINES);
  return list.length ? list : null;
}

/** Bounded context for the prompt. No diagnosis and no advice is inferred. */
function digestiveNotes(value) {
  if (!Array.isArray(value)) return null;
  const parts = value.slice(0, 5).map((item) => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return null;
    const issue = String(item.issue ?? '').trim();
    if (!issue) return null;
    const detail = [item.frequency, item.severity != null ? `${item.severity}/10` : null]
      .filter(Boolean).join(', ');
    return detail ? `${issue} (${detail})` : issue;
  }).filter(Boolean);
  return parts.length ? parts.join('; ').slice(0, MAX_NOTES) : null;
}

function resolveDietPlanningFacts(ctx = {}, body = {}) {
  const client = ctx.client || {};
  const profile = ctx.profile || {};
  const nutrition = ctx.nutrition || {};
  const activeGoal = Array.isArray(ctx.goals) ? ctx.goals[0] || null : null;

  const origins = {};
  const missing = [];
  const stale = [];
  const conflicts = [];

  const goalWeight = withFreshness(fromSources(
    [['goal', activeGoal?.target_weight, when(activeGoal, 'created_at', 'updated_at', 'start_date')]],
    (v) => numInRange(v, 'target_weight_kg'),
  ));
  const statedTargetWeight = goalWeight == null
    ? numInRange(body.target_weight_kg, 'target_weight_kg')
    : null;
  const targetWeight = goalWeight?.value ?? statedTargetWeight ?? null;
  origins.target_weight_kg = targetWeight == null ? null : (goalWeight ? 'recorded' : 'stated');
  if (goalWeight?.stale) stale.push('target_weight_kg');
  for (const c of goalWeight?.conflicts ?? []) {
    conflicts.push({ field: 'target_weight_kg', source: c.source, value: c.value });
  }

  // Body fat is a separate target, never converted from weight.
  const bodyFatRaw = Number(activeGoal?.target_body_fat);
  const targetBodyFat = Number.isFinite(bodyFatRaw) && bodyFatRaw > 3 && bodyFatRaw < 70
    ? bodyFatRaw : null;
  origins.target_body_fat_pct = targetBodyFat == null ? null : 'recorded';

  const rateRaw = Number(activeGoal?.safe_weekly_rate_kg);
  const safeRate = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : null;
  origins.safe_weekly_rate_kg = safeRate == null ? null : 'recorded';

  const weeksRaw = Number(activeGoal?.estimated_duration_weeks);
  const durationWeeks = Number.isFinite(weeksRaw) && weeksRaw > 0 ? Math.round(weeksRaw) : null;
  origins.estimated_duration_weeks = durationWeeks == null ? null : 'recorded';

  const targetDate = when(activeGoal, 'target_date');
  origins.target_date = targetDate == null ? null : 'recorded';

  const recordedTime = parseWorkoutTime(client.preferred_workout_time);
  const statedTime = recordedTime == null ? parseWorkoutTime(body.workout_time) : null;
  const workoutTime = recordedTime ?? statedTime;
  origins.workout_time = recordedTime ? 'recorded' : statedTime ? 'stated' : null;

  const recordedDuration = numInRange(client.session_minutes, 'workout_duration_minutes');
  const statedDuration = recordedDuration == null
    ? numInRange(body.workout_duration_minutes, 'workout_duration_minutes')
    : null;
  const workoutDuration = recordedDuration ?? statedDuration ?? DEFAULT_DURATION;
  origins.workout_duration_minutes = recordedDuration != null ? 'recorded'
    : statedDuration != null ? 'stated' : 'default';

  const recordedCulture = asEnum(nutrition.food_culture, FOOD_CULTURES);
  const statedCulture = recordedCulture == null ? asEnum(body.food_culture, FOOD_CULTURES) : null;
  const foodCulture = recordedCulture ?? statedCulture ?? DEFAULT_FOOD_CULTURE;
  origins.food_culture = recordedCulture ? 'recorded' : statedCulture ? 'stated' : 'default';

  const recordedCuisines = cuisineList(nutrition.regional_cuisines);
  const statedCuisines = recordedCuisines == null ? cuisineList(body.regional_cuisines) : null;
  const regionalCuisines = recordedCuisines ?? statedCuisines;
  origins.regional_cuisines = recordedCuisines ? 'recorded' : statedCuisines ? 'stated' : null;

  const recordedPattern = asEnum(nutrition.dietary_pattern, DIETARY_PATTERNS);
  const derivedPattern = recordedPattern
    ?? classifyDietaryPattern(nutrition.diet_preferences)
    ?? classifyDietaryPattern(profile.diet_preference);
  const statedPattern = derivedPattern == null ? classifyDietaryPattern(body.dietary_pattern) : null;
  const dietaryPattern = derivedPattern ?? statedPattern;
  origins.dietary_pattern = recordedPattern ? 'recorded'
    : derivedPattern ? 'recorded' : statedPattern ? 'stated' : null;

  const recordedTiming = asEnum(nutrition.meal_timing_preference, MEAL_TIMING_PREFERENCES);
  const statedTiming = recordedTiming == null
    ? asEnum(body.meal_timing_preference, MEAL_TIMING_PREFERENCES) : null;
  const mealTiming = recordedTiming ?? statedTiming ?? DEFAULT_TIMING;
  origins.meal_timing_preference = recordedTiming ? 'recorded'
    : statedTiming ? 'stated' : 'default';

  const favouriteFoods = Array.isArray(nutrition.favourite_foods) && nutrition.favourite_foods.length
    ? nutrition.favourite_foods.join(', ').slice(0, MAX_NOTES) : null;
  origins.favourite_foods = favouriteFoods == null ? null : 'recorded';

  const mealPreparer = shortText(nutrition.meal_preparer, 120);
  origins.meal_preparer = mealPreparer == null ? null : 'recorded';

  const notes = digestiveNotes(nutrition.digestive_issues);
  origins.digestive_notes = notes == null ? null : 'recorded';

  const facts = {
    target_weight_kg: targetWeight,
    target_body_fat_pct: targetBodyFat,
    safe_weekly_rate_kg: safeRate,
    estimated_duration_weeks: durationWeeks,
    target_date: targetDate,
    workout_time: workoutTime,
    workout_duration_minutes: workoutDuration,
    food_culture: foodCulture,
    regional_cuisines: regionalCuisines,
    dietary_pattern: dietaryPattern,
    meal_timing_preference: mealTiming,
    favourite_foods: favouriteFoods,
    meal_preparer: mealPreparer,
    digestive_notes: notes,
  };

  for (const field of PLANNING_OPTIONAL) {
    if (facts[field] == null) missing.push(field);
  }

  return { ...facts, origins, missing, stale, conflicts };
}

module.exports = {
  FOOD_CULTURES,
  DIETARY_PATTERNS,
  MEAL_TIMING_PREFERENCES,
  normaliseActivityLevel,
  classifyDietaryPattern,
  resolveDietPlanningFacts,
};

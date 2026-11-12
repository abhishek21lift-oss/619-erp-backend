'use strict';

const {
  normaliseActivityLevel,
  classifyDietaryPattern,
  resolveDietPlanningFacts,
} = require('../modules/nutrition/diet-facts');

test('activity labels normalise; unknown is null, never a guess', () => {
  expect(normaliseActivityLevel('Sedentary')).toBe('sedentary');
  expect(normaliseActivityLevel('Lightly Active')).toBe('lightly_active');
  expect(normaliseActivityLevel('Very Active')).toBe('very_active');
  expect(normaliseActivityLevel('athlete-ish')).toBeNull();
});

test('dietary pattern classifies only unambiguous values', () => {
  expect(classifyDietaryPattern(['Vegetarian', 'Jain'])).toBe('vegetarian');
  expect(classifyDietaryPattern(['Vegan'])).toBe('vegan');
  expect(classifyDietaryPattern(['Non-Vegetarian'])).toBe('non_vegetarian');
  expect(classifyDietaryPattern(['Eggetarian'])).toBe('eggetarian');
  expect(classifyDietaryPattern(['Jain'])).toBeNull();
});

test('recorded culture wins; stated fills only a gap; otherwise mixed is default', () => {
  const recorded = resolveDietPlanningFacts(
    { client: {}, nutrition: { food_culture: 'indian' }, goals: [] },
    {},
  );
  expect(recorded.food_culture).toBe('indian');
  expect(recorded.origins.food_culture).toBe('recorded');

  const stated = resolveDietPlanningFacts(
    { client: {}, nutrition: {}, goals: [] },
    { food_culture: 'western' },
  );
  expect(stated.food_culture).toBe('western');
  expect(stated.origins.food_culture).toBe('stated');

  const fallback = resolveDietPlanningFacts({ client: {}, nutrition: {}, goals: [] }, {});
  expect(fallback.food_culture).toBe('mixed');
  expect(fallback.origins.food_culture).toBe('default');
});

test('target weight is numeric and separate from body fat', () => {
  const r = resolveDietPlanningFacts(
    { client: {}, nutrition: {}, goals: [{ target_weight: 72, target_body_fat: 18 }] },
    {},
  );
  expect(r.target_weight_kg).toBe(72);
  expect(r.target_body_fat_pct).toBe(18);
  expect(r.origins.target_weight_kg).toBe('recorded');
});

test('workout time parses; missing duration defaults to 60 and is labelled', () => {
  const r = resolveDietPlanningFacts(
    { client: { preferred_workout_time: '7:00 pm', session_minutes: null }, nutrition: {}, goals: [] },
    {},
  );
  expect(r.workout_time).toBe('19:00');
  expect(r.workout_duration_minutes).toBe(60);
  expect(r.origins.workout_duration_minutes).toBe('default');

  const stated = resolveDietPlanningFacts(
    { client: {}, nutrition: {}, goals: [] },
    { workout_time: '06:15', workout_duration_minutes: 90 },
  );
  expect(stated.workout_time).toBe('06:15');
  expect(stated.origins.workout_time).toBe('stated');
});

test('pattern is null when only unclassifiable preferences exist', () => {
  const r = resolveDietPlanningFacts(
    { client: {}, nutrition: { diet_preferences: ['Jain', 'Keto'] }, goals: [] },
    {},
  );
  expect(r.dietary_pattern).toBeNull();
  expect(r.missing).toContain('dietary_pattern');
});

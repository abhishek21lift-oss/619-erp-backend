'use strict';
// The diet prompt used to ask the model to calculate the targets. It now
// receives them, and the meal times, as facts it must distribute rather than
// decide — the same plan, checked against numbers the server owns.

const { buildDietSystemPrompt, DIET_PROMPT_VERSION } = require('../lib/ai/prompts/system');

const calculation = {
  version: '1.0.0', bmr_kcal: 1780, tdee_kcal: 2136, calorie_target: 1709,
  macros: { protein_g: 160, carbs_g: 150, fat_g: 60 }, fiber_g: 25, water_ml: 2750,
  warnings: [{ code: 'calorie_floor', message: 'Calorie target raised to the safe minimum.' }],
  target: { weight_kg: 72, delta_kg: 8, direction: 'loss', weekly_rate_kg: 0.6, timeline_weeks: 14 },
};
const schedule = [
  { slot: 'breakfast', label: 'Breakfast', time: '07:30', calories: 427 },
  { slot: 'pre_workout', label: 'Pre-workout', time: '05:30', calories: 171 },
];

test('v2 names the targets as authoritative and forbids recalculation', () => {
  const p = buildDietSystemPrompt('Sam', { calculation, schedule });

  expect(DIET_PROMPT_VERSION).toBe('2.0.0');
  expect(p).toContain('AUTHORITATIVE TARGETS');
  expect(p).toContain('1709');
  expect(p).toContain('Do not recalculate');
  expect(p).toContain('MEAL SCHEDULE');
  expect(p).toContain('05:30');
  expect(p).toContain('pre_workout');
  // The engine's warnings reach the model as notes, not as silent clamps.
  expect(p).toContain('Calorie target raised to the safe minimum.');
});

test('v2 carries the food culture and the reference food names', () => {
  const p = buildDietSystemPrompt('Sam', {
    calculation, schedule, foodCulture: 'indian', foodOptions: ['Roti', 'Moong dal'],
  });

  expect(p).toContain('Indian');
  expect(p).toContain('- Roti');
});

test('without options the prompt is still the legacy prompt', () => {
  const p = buildDietSystemPrompt('Sam');

  expect(p).not.toContain('AUTHORITATIVE TARGETS');
  expect(p).toContain('Calculate accurate TDEE');
});

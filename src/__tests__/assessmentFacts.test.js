'use strict';
// One fact, one owner. Alcohol is asked in Lifestyle; a Nutrition row written
// before that move still carries drinks-per-week. These pin which copy wins.

const { resolveAlcohol, resolveNutritionHabits } = require('../modules/progress/assessment-facts');

describe('alcohol has a single owner (Lifestyle)', () => {
  test('Lifestyle drinks win over a legacy Nutrition value', () => {
    expect(resolveAlcohol(
      { alcohol_status: 'weekly', drinks_per_week: 10 },
      { alcoholic_drinks_per_week: 2 },
    )).toEqual({ status: 'weekly', drinksPerWeek: 10 });
  });

  test('the legacy Nutrition value is read only when Lifestyle has none', () => {
    expect(resolveAlcohol(
      { alcohol_status: 'never', drinks_per_week: null },
      { alcoholic_drinks_per_week: 4 },
    )).toEqual({ status: 'never', drinksPerWeek: 4 });
  });

  test('no answer anywhere is null, not zero', () => {
    expect(resolveAlcohol({}, {})).toEqual({ status: null, drinksPerWeek: null });
    expect(resolveAlcohol()).toEqual({ status: null, drinksPerWeek: null });
  });

  test('zero drinks is an answer and is not replaced by the legacy value', () => {
    expect(resolveAlcohol(
      { alcohol_status: 'never', drinks_per_week: 0 },
      { alcoholic_drinks_per_week: 9 },
    )).toEqual({ status: 'never', drinksPerWeek: 0 });
  });

  test('a blank string is unanswered', () => {
    expect(resolveAlcohol(
      { alcohol_status: '', drinks_per_week: '' },
      { alcoholic_drinks_per_week: 3 },
    )).toEqual({ status: null, drinksPerWeek: 3 });
  });
});

describe('water and meals have a single owner (Nutrition)', () => {
  test('the latest Nutrition answers win over the Lifestyle copies', () => {
    expect(resolveNutritionHabits(
      { water_intake_liters: 1, meal_frequency: 2, breakfast_habit: 'never', late_night_eating: true },
      { water_intake_liters: '3.0', meals_per_day: 4, breakfast_regularity: 'daily', late_night_eating: false },
    )).toEqual({
      water_intake_liters: 3, meal_frequency: 4, breakfast_habit: 'daily', late_night_eating: false,
    });
  });

  test('an unanswered Nutrition field falls back to the Lifestyle copy', () => {
    expect(resolveNutritionHabits(
      { water_intake_liters: 2, meal_frequency: 3, breakfast_habit: 'sometimes', late_night_eating: null },
      { water_intake_liters: null, meals_per_day: null, breakfast_regularity: null, late_night_eating: null },
    )).toEqual({
      water_intake_liters: 2, meal_frequency: 3, breakfast_habit: 'sometimes', late_night_eating: null,
    });
  });

  test('zero and false are answers, not missing values', () => {
    expect(resolveNutritionHabits(
      { water_intake_liters: 2, meal_frequency: 3, breakfast_habit: 'daily', late_night_eating: true },
      { water_intake_liters: null, meals_per_day: null, breakfast_regularity: null, late_night_eating: false },
    )).toEqual({
      water_intake_liters: 2, meal_frequency: 3, breakfast_habit: 'daily', late_night_eating: false,
    });
  });
});

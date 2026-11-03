'use strict';
// One fact, one owner. Alcohol is asked in Lifestyle; a Nutrition row written
// before that move still carries drinks-per-week. These pin which copy wins.

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../lib/logger');
const {
  resolveAlcohol, resolveNutritionHabits, resolveMedicalConditions,
} = require('../modules/progress/assessment-facts');

const deprecatedReads = () => logger.info.mock.calls
  .filter(([payload]) => payload && payload.event === 'ownership.deprecated_read');

beforeEach(() => logger.info.mockClear());

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

describe('medical conditions have a single owner (PAR-Q)', () => {
  test('a submitted PAR-Q wins over the legacy Nutrition list', () => {
    expect(resolveMedicalConditions(
      {
        current_health: { known_disease: false },
        past_history: { heart_disease: true, asthma: false },
        parq_answers: [{ question_id: 7, answer: 'no' }],
      },
      { medical_conditions: ['Diabetes'] },
    )).toEqual(['Heart disease']);
    expect(deprecatedReads()).toHaveLength(0);
  });

  test('a yes on the questionnaire is a condition even with no history toggle set', () => {
    expect(resolveMedicalConditions(
      { parq_answers: [{ question_id: 7, answer: 'yes' }] },
      {},
    )).toEqual(['Asthma, diabetes, epilepsy or high blood pressure']);
  });

  test('the legacy Nutrition list is read and logged only when no PAR-Q exists', () => {
    expect(resolveMedicalConditions(null, { medical_conditions: ['Asthma'] }, { client_id: 'c1' }))
      .toEqual(['Asthma']);
    expect(deprecatedReads()).toHaveLength(1);
    expect(deprecatedReads()[0][0]).toEqual(expect.objectContaining({
      field: 'medical_conditions', owner: 'PAR-Q',
      source: 'pt_nutrition_assessments.medical_conditions', client_id: 'c1',
    }));
  });

  test('a PAR-Q that reports nothing is an answer, so the legacy list is not consulted', () => {
    expect(resolveMedicalConditions(
      { current_health: {}, past_history: {}, parq_answers: [] },
      { medical_conditions: ['Asthma'] },
    )).toEqual([]);
    expect(deprecatedReads()).toHaveLength(0);
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

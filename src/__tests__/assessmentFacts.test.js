'use strict';
// One fact, one owner. Alcohol is asked in Lifestyle; a Nutrition row written
// before that move still carries drinks-per-week. These pin which copy wins.

const { resolveAlcohol } = require('../modules/progress/assessment-facts');

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

'use strict';
// Missing data is not a good score. These pin the coverage floor and the
// component-level answers that used to award 100 for "not asked".

const lifestyle = require('../modules/progress/lifestyle-scoring');
const nutrition = require('../modules/progress/nutrition-scoring');

describe('lifestyle composite needs enough answers', () => {
  const six = (over = {}) => ({
    sleep: null, stress: null, hydration: null, activity: null, nutrition: null, recovery: null, ...over,
  });

  test('sleep alone is not an Excellent lifestyle', () => {
    const score = lifestyle.calcLifestyleScore(six({ sleep: 100, recovery: 100 }), 0);
    expect(score).toBeNull();
    expect(lifestyle.classifyLifestyleReadiness(score)).toBe('Insufficient data');
  });

  test('four of six components are enough to score', () => {
    const score = lifestyle.calcLifestyleScore(six({ sleep: 100, stress: 50, activity: 60, recovery: 80 }), 0);
    expect(score).toBe(73);
    expect(lifestyle.classifyLifestyleReadiness(score)).toBe('Good');
  });

  test('a blank form has no score', () => {
    expect(lifestyle.calcLifestyleScore(six(), 0)).toBeNull();
  });
});

describe('lifestyle meal pattern penalises one meal a day', () => {
  test('one meal is no longer a perfect 100', () => {
    expect(lifestyle.calcNutritionScore(1, 'daily', false)).toBe(70);
  });

  test('three meals stays at the top', () => {
    expect(lifestyle.calcNutritionScore(3, 'daily', false)).toBe(100);
  });
});

describe('nutrition components distinguish unanswered from answered', () => {
  test('digestive: null is unknown, [] is a stated "no issues"', () => {
    expect(nutrition.calcDigestiveHealthScore(null)).toBeNull();
    expect(nutrition.calcDigestiveHealthScore([])).toBe(100);
  });

  test('supplement: null is unknown; no supplements and an empty list score the same', () => {
    expect(nutrition.calcSupplementScore(null, [])).toBeNull();
    expect(nutrition.calcSupplementScore(false, [])).toBe(50);
    expect(nutrition.calcSupplementScore(true, [])).toBe(50);
    expect(nutrition.calcSupplementScore(true, [{ name: 'Whey Protein' }])).toBe(65);
  });

  test('protein: no favourites and no protein supplement is unknown, not Very Low', () => {
    expect(nutrition.assessProtein([], false, [])).toEqual({ assessment: null, score: null });
    expect(nutrition.assessProtein(['Chicken', 'Eggs', 'Dal'], false, [])).toEqual({ assessment: 'Adequate', score: 70 });
  });

  test('diet quality: a blank step is unknown, not 60', () => {
    expect(nutrition.calcDietQualityScore([], [], [], null, [], null, null)).toBeNull();
    expect(nutrition.calcDietQualityScore(['Sugar'], [], [], null, [], null, null)).toBe(64);
  });

  test('water alone cannot produce an overall nutrition score', () => {
    const score = nutrition.calcNutritionScore(
      { dietQuality: null, protein: null, hydration: 55, digestive: null, supplement: null }, 0,
    );
    expect(score).toBeNull();
    expect(nutrition.classifyNutritionReadiness(score)).toBe('Insufficient data');
  });

  test('three components are enough to score', () => {
    const score = nutrition.calcNutritionScore(
      { dietQuality: 60, protein: 70, hydration: 85, digestive: null, supplement: null }, 0,
    );
    expect(score).toBe(72);
  });
});

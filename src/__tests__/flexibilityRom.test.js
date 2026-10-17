'use strict';
const fitness = require('../modules/progress/fitness-scoring');

describe('Flexibility ROM norm benchmark', () => {
  test('returns null (Norm data unavailable) when no validated norms exist', () => {
    expect(fitness.classifyFlexibilityROM('Sit and Reach', 30, 30, 'Male')).toBeNull();
    expect(fitness.classifyFlexibilityROM('Hamstrings', 10, 25, 'Female')).toBeNull();
  });
  test('returns null for missing/invalid inputs', () => {
    expect(fitness.classifyFlexibilityROM('Sit and Reach', null, 30, 'Male')).toBeNull();
    expect(fitness.classifyFlexibilityROM('Sit and Reach', 30, null, 'Male')).toBeNull();
    expect(fitness.classifyFlexibilityROM('Sit and Reach', 30, 30, null)).toBeNull();
  });
});
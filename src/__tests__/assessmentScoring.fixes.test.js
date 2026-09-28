// Scoring fixes from the assessment modules audit 2026-09-28 (F-2, F-4, F-8,
// G-1, M-1, PO-1). The frontend twins are held to the same answers by the
// frontend's scripts/assert-scoring-parity.ts.
'use strict';

const fitness = require('../modules/progress/fitness-scoring');
const goal = require('../modules/progress/goal-scoring');
const mobility = require('../modules/progress/mobility-scoring');
const posture = require('../modules/progress/posture-scoring');

describe('Harvard step test (F-2) — published fitness-index bands', () => {
  test.each([[54, 'Poor'], [55, 'Below Average'], [64, 'Below Average'], [65, 'Average'], [79, 'Average'],
    [80, 'Good'], [89, 'Good'], [90, 'Excellent'], [120, 'Excellent']])('%p → %s', (pei, cat) => {
    expect(fitness.classifyHarvardPei(pei)).toBe(cat);
  });
});

describe('no invented categories (F-4, F-8)', () => {
  test('a lift without norms has no strength category', () => {
    expect(fitness.classifyStrength(100, 80, 'Lunges', 'Male')).toBeNull();
    expect(fitness.classifyStrength(100, 80, 'Squat', 'Male')).toBe('Average');
  });

  test('endurance tests without norms have no category; plank needs no sex', () => {
    expect(fitness.classifyEndurance('Wall Sit', 90, 'Male')).toBeNull();
    expect(fitness.classifyEndurance('Custom', 90, 'Female')).toBeNull();
    expect(fitness.classifyEndurance('Plank', 90, null)).toBe('Good');
  });

  test('an unknown sex no longer falls through to the female norms', () => {
    expect(fitness.classifyEndurance('Push Up Test', 25, null)).toBeNull();
    expect(fitness.classifyEndurance('Push Up Test', 25, 'Other')).toBeNull();
    expect(fitness.classifyEndurance('Push Up Test', 25, 'male')).toBe(fitness.classifyEndurance('Push Up Test', 25, 'Male'));
    expect(fitness.scoreBodyComposition(15, null)).toBeNull();
  });
});

describe('goal readiness (G-1)', () => {
  test('is out of the questions answered', () => {
    expect(goal.calcLifestyleReadinessScore({ can_train_4_6_days: true, sleep_7_8_hours: true, family_support: true })).toBe(100);
    expect(goal.calcLifestyleReadinessScore({ can_train_4_6_days: true, medical_restrictions: true })).toBe(50);
    expect(goal.calcLifestyleReadinessScore({})).toBeNull();
  });
});

describe('referrals (M-1, PO-1)', () => {
  test('pain on a movement screen refers', () => {
    expect(mobility.calcMobilityReferrals([{ region: 'Knee', score: 3, pain: true }], [{ test: 'Deep Squat', score: 2, pain: false }]))
      .toEqual(['Pain on Knee — do not load this pattern; refer to a physiotherapist.']);
    expect(mobility.calcMobilityReferrals(null, null)).toEqual([]);
  });

  test('suspected scoliosis refers', () => {
    expect(posture.calcPostureReferrals(null, null, ['Scoliosis'])).toHaveLength(1);
    expect(posture.calcPostureReferrals(['Forward Head'], null, null)).toEqual([]);
  });
});

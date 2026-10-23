'use strict';
const g = require('../modules/progress/goal-scoring');

describe('K11 measurable goal scoring', () => {
  it('keeps the weight benchmark and adds body-fat/lift benchmarks', () => {
    expect(g.calcSafeWeeklyRateFor('weight', 100, 'loss')).toBe(0.75);
    expect(g.calcSafeWeeklyRateFor('body_fat', 30, 'loss')).toBe(0.25);
    expect(g.calcSafeWeeklyRateFor('lift', 100, 'gain')).toBe(0.5);
    expect(g.calcSafeWeeklyRateFor('sessions', 2, 'gain')).toBeNull();
    expect(g.calcSafeWeeklyRateFor('custom', 10, 'gain')).toBeNull();
    expect(g.calcSafeWeeklyRateFor('lift', 100, 'maintain')).toBeNull();
  });

  it('describes an over-aggressive lift target with the strength benchmark', () => {
    const risks = g.buildRiskFactors({
      requiredRate: 1.5, safeRate: 0.5, lifestyleReadinessScore: null,
      medicalRestrictions: null, daysRemaining: 60, motivationLevel: null,
      commitmentLevel: null, metric: 'lift',
    });
    expect(risks.join(' ')).toContain('0.5%');
  });

  it('accepts a valid K11 block and strips unknown keys', () => {
    expect(g.sanitizeK11({
      measure: { metric: 'lift', exercise: 'Back Squat', current: 100, target: 120, unit: 'kg', junk: 'x' },
      client_agreement: true,
      client_expectation: 'Squat bodyweight',
      junk: true,
    })).toEqual({
      measure: { metric: 'lift', exercise: 'Back Squat', current: 100, target: 120, unit: 'kg' },
      client_agreement: true,
      client_expectation: 'Squat bodyweight',
    });
  });

  it('rejects an unknown metric and treats an absent block as null', () => {
    expect(g.sanitizeK11({ measure: { metric: 'vibes' } })).toBeUndefined();
    expect(g.sanitizeK11(null)).toBeNull();
  });

  it('rejects a missing or non-positive target', () => {
    expect(g.sanitizeK11({ measure: { metric: 'weight', current: 80 } })).toBeUndefined();
    expect(g.sanitizeK11({ measure: { metric: 'weight', target: 0 } })).toBeUndefined();
    expect(g.sanitizeK11({ measure: { metric: 'weight', target: -5 } })).toBeUndefined();
    expect(g.sanitizeK11({ measure: { metric: 'weight', target: '75' } })).toEqual({
      measure: { metric: 'weight', target: 75 },
    });
  });
});

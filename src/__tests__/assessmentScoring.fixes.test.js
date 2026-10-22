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

describe('flexibility composite bounds (F2a)', () => {
  test.each([
    [null, null], [NaN, null], [-1, null], [-0.1, null], [10.1, null], [25, null],
  ])('classifyFlexibilityScore(%p) → %p', (score, cat) => {
    expect(fitness.classifyFlexibilityScore(score)).toBe(cat);
  });
  test('0 is a legitimate "very limited" score (Poor), not missing', () => {
    expect(fitness.classifyFlexibilityScore(0)).toBe('Poor');
  });
  test('10 is the top of the scale (Excellent)', () => {
    expect(fitness.classifyFlexibilityScore(10)).toBe('Excellent');
  });
});

describe('body composition prerequisites (F14)', () => {
  test('returns null for missing or unsupported gender — no invented range', () => {
    expect(fitness.scoreBodyComposition(15, null)).toBeNull();
    expect(fitness.scoreBodyComposition(15, 'Other')).toBeNull();
  });
  test('still scores supported genders', () => {
    expect(fitness.scoreBodyComposition(15, 'Male')).toBe(100);
    expect(fitness.scoreBodyComposition(25, 'Female')).toBe(100);
  });
});

describe('health score direction and bands (F15)', () => {
  test('100 is normal BP + healthy BMI', () => {
    expect(fitness.scoreHealthRisk('Normal', 22)).toBe(100);
  });
  test('BMI band discontinuity: 24.9 → 100, 25.0 → 80 (normal BP)', () => {
    expect(fitness.scoreHealthRisk('Normal', 24.9)).toBe(100);
    expect(fitness.scoreHealthRisk('Normal', 25)).toBe(80);
  });
  test('BMI 30+ → 65 with normal BP', () => {
    expect(fitness.scoreHealthRisk('Normal', 30)).toBe(65);
  });
  test('underweight (<18.5) treated like overweight (60)', () => {
    expect(fitness.scoreHealthRisk('Normal', 17)).toBe(80);
  });
  test('BP-only input still scores', () => {
    expect(fitness.scoreHealthRisk('Hypertension Stage 1', null)).toBe(55);
  });
  test('both missing → null, never 0', () => {
    expect(fitness.scoreHealthRisk(null, null)).toBeNull();
  });
  test('Hypertension Stage 2 is the worst BP band (20)', () => {
    expect(fitness.scoreHealthRisk('Hypertension Stage 2', 22)).toBe(60);
  });
});

describe('vitals norms (BP, resting heart rate, SpO₂)', () => {
  test.each([
    [85, 55, 'Hypotension'],
    [89, 60, 'Hypotension'],
    [90, 60, 'Normal'],
    [119, 79, 'Normal'],
    [120, 79, 'Elevated'],
    [129, 79, 'Elevated'],
    [120, 80, 'Hypertension Stage 1'],
    [130, 79, 'Hypertension Stage 1'],
    [139, 89, 'Hypertension Stage 1'],
    [140, 89, 'Hypertension Stage 2'],
    [139, 90, 'Hypertension Stage 2'],
    [179, 119, 'Hypertension Stage 2'],
    [180, 119, 'Hypertensive Crisis'],
    [179, 120, 'Hypertensive Crisis'],
    [160, 58, 'Hypertension Stage 2'],
    [135, 55, 'Hypotension'],
    [125, null, 'Elevated'],
    [85, null, 'Hypotension'],
    [150, null, 'Hypertension Stage 2'],
    [185, null, 'Hypertensive Crisis'],
    [null, 125, 'Hypertensive Crisis'],
    [null, 70, null],
  ])('classifyBp(%p, %p) → %p', (systolic, diastolic, category) => {
    expect(fitness.classifyBp(systolic, diastolic)).toBe(category);
  });

  test.each([
    [39, 'Low'], [40, 'Low'], [59, 'Low'], [60, 'Normal'], [72, 'Normal'], [80, 'Normal'],
    [81, 'High Normal'], [100, 'High Normal'], [101, 'High'],
  ])('classifyRhr(%p) → %s', (rhr, category) => {
    expect(fitness.classifyRhr(rhr)).toBe(category);
  });

  test.each([[89, 'Critical'], [90, 'Mildly Low'], [94, 'Mildly Low'], [95, 'Normal'], [100, 'Normal']])(
    'classifySpo2(%p) → %s', (spo2, category) => {
      expect(fitness.classifySpo2(spo2)).toBe(category);
    },
  );

  const safety = (over = {}) => fitness.assessVitalsSafety({
    systolic: 118, diastolic: 70, restingHeartRate: 72, restingSpo2: 98, athlete: false, ...over,
  });

  test('stage 2, crisis and hypotension stop exertion', () => {
    expect(safety({ systolic: 160, diastolic: 95 }).level).toBe('stop');
    expect(safety({ systolic: 185, diastolic: 95 }).level).toBe('stop');
    expect(safety({ systolic: 85, diastolic: 55 }).level).toBe('stop');
  });

  test('stage 1 and elevated are caution, not stop', () => {
    expect(safety({ systolic: 135, diastolic: 85 }).level).toBe('caution');
    expect(safety({ systolic: 125, diastolic: 75 }).level).toBe('caution');
  });

  test('RHR and SpO₂ stops', () => {
    expect(safety({ restingHeartRate: 110 }).level).toBe('stop');
    expect(safety({ restingHeartRate: 38 }).level).toBe('stop');
    expect(safety({ restingSpo2: 88 }).level).toBe('stop');
    expect(safety({ restingSpo2: 92 }).level).toBe('caution');
  });

  test('an athlete\'s 40–50 bpm is context, not a flag', () => {
    expect(safety({ restingHeartRate: 45, athlete: true }).level).toBe('safe');
    expect(safety({ restingHeartRate: 45, athlete: false }).level).toBe('caution');
    expect(safety({ restingHeartRate: 45, athlete: true }).athleteLowRhr).toBe(true);
  });

  test('a normal reading is safe', () => {
    const result = safety();
    expect(result.level).toBe('safe');
    expect(result.requiresMedicalClearance).toBe(false);
    expect(result.repeatBp).toBe(false);
  });

  test('crisis is the worst health-risk BP band', () => {
    expect(fitness.scoreHealthRisk('Hypertensive Crisis', 22)).toBeLessThan(
      fitness.scoreHealthRisk('Hypertension Stage 2', 22),
    );
  });
});

describe('scoring formula version (F10)', () => {
  test('exposes a non-empty version identifier', () => {
    expect(typeof fitness.FITNESS_SCORING_VERSION).toBe('string');
    expect(fitness.FITNESS_SCORING_VERSION.length).toBeGreaterThan(0);
  });
});

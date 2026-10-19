'use strict';

const { compareAssessments, valueOf } = require('../modules/progress/progress-comparison');

function assessment(overrides = {}) {
  return {
    id: 'a1',
    assessment_date: '2026-01-10',
    assessment_type: 'initial',
    assessment_number: 1,
    weight: '80.0',
    height_cm: '180.0',
    bmi: '24.7',
    waist_cm: '100.0',
    hips_cm: '100.0',
    body_fat_pct: '30.0',
    muscle_mass_pct: '30.0',
    body_comp_method: 'BIA Machine',
    cardio_test_type: 'Cooper 12-Minute Run',
    vo2_max: '30.00',
    cardio_score_computed: 40,
    strength_exercise: 'Back Squat',
    strength_test_data: JSON.stringify({ test1: { weightKg: 60, reps: 10, formula: 'epley' } }),
    strength_score_computed: 40,
    endurance_test_type: 'Push Up Test',
    endurance_test_data: JSON.stringify({ test1: { reps: 20 }, test2: { durationSec: 60 } }),
    endurance_score_computed: 50,
    flexibility_test_data: JSON.stringify({ test1: { testType: 'Sit and Reach', left: 10, right: 12, score: 4 } }),
    mobility_score_computed: 45,
    bp_systolic: 130,
    bp_diastolic: 85,
    overall_fitness_score: 42,
    testing_conditions: 'Morning, fasted',
    ...overrides,
  };
}

describe('Module 5 seven-domain comparison', () => {
  it('compares all seven domains and respects metric direction', () => {
    const baseline = assessment();
    const latest = assessment({
      id: 'a2', assessment_date: '2026-06-10', assessment_number: 2,
      weight: '78.0', bmi: '24.1', waist_cm: '95.0', body_fat_pct: '28.0',
      muscle_mass_pct: '31.0', strength_score_computed: 35, bp_systolic: 135,
      neck_cm: '40',
    });
    const result = compareAssessments(baseline, latest);

    expect(result.domains.map((d) => d.key)).toEqual([
      'blood_pressure', 'anthropometric', 'body_composition', 'cardio',
      'strength', 'endurance', 'flexibility',
    ]);
    const waist = result.domains[1].metrics.find((m) => m.key === 'waist_cm');
    expect(waist).toMatchObject({
      baseline_value: 100, latest_value: 95, absolute_change: -5,
      percent_change: -5, outcome: 'improved', improved: true,
    });
    const weight = result.domains[1].metrics.find((m) => m.key === 'weight');
    expect(weight).toMatchObject({ absolute_change: -2, outcome: 'changed', improved: null });
    const strength = result.domains[4].metrics.find((m) => m.key === 'strength_score_computed');
    expect(strength.outcome).toBe('declined');
    const systolic = result.domains[0].metrics.find((m) => m.key === 'bp_systolic');
    expect(systolic.outcome).toBe('declined');
    expect(result.summary.improved).toBeGreaterThanOrEqual(3);
    expect(result.summary.declined).toBeGreaterThanOrEqual(2);
  });

  it('never treats a missing value as zero', () => {
    const baseline = assessment({ chest_cm: '100', neck_cm: null });
    const latest = assessment({ chest_cm: null, neck_cm: '40' });
    const result = compareAssessments(baseline, latest);
    const chest = result.domains[1].metrics.find((m) => m.key === 'chest_cm');
    const neck = result.domains[1].metrics.find((m) => m.key === 'neck_cm');
    expect(chest).toMatchObject({ baseline_value: 100, latest_value: null, absolute_change: null, outcome: 'not_remeasured' });
    expect(neck).toMatchObject({ baseline_value: null, latest_value: 40, absolute_change: null, outcome: 'new_measurement' });
    expect(result.summary.new_measurements).toBe(1);
    expect(result.summary.not_remeasured).toBe(1);
  });

  it('withholds deltas when the protocol changed', () => {
    const baseline = assessment();
    const latest = assessment({ id: 'a2', assessment_date: '2026-06-10', cardio_test_type: 'YMCA 3-Minute Step Test', vo2_max: '35.00' });
    const result = compareAssessments(baseline, latest);
    const vo2 = result.domains[3].metrics.find((m) => m.key === 'vo2_max');
    expect(vo2).toMatchObject({
      baseline_value: 30, latest_value: 35, absolute_change: null,
      percent_change: null, comparable: false, outcome: 'incomparable',
    });
    expect(vo2.incomparable_reason).toMatch(/Protocol changed/);
    expect(result.domains[3].comparable).toBe(false);
  });

  it('withholds body-composition deltas when the measurement method changed', () => {
    const baseline = assessment();
    const latest = assessment({ id: 'a2', assessment_date: '2026-06-10', body_comp_method: 'DEXA', body_fat_pct: '25.0' });
    const result = compareAssessments(baseline, latest);
    const fat = result.domains[2].metrics.find((m) => m.key === 'body_fat_pct');
    expect(fat.comparable).toBe(false);
    expect(fat.absolute_change).toBeNull();
    // Lean mass has no protocol gate and is still compared.
    const lean = result.domains[2].metrics.find((m) => m.key === 'lean_body_mass_kg');
    expect(lean.outcome).toBe('missing');
  });

  it('reads recorded strength and endurance test data without inventing values', () => {
    const a = assessment();
    expect(valueOf(a, 'strength_test1_1rm')).toBe(80);
    expect(valueOf(a, 'endurance_test1_reps')).toBe(20);
    expect(valueOf(a, 'endurance_test2_duration')).toBe(60);
    expect(valueOf(a, 'flexibility_test1_right')).toBe(12);
    expect(valueOf(a, 'strength_test2_1rm')).toBeNull();
  });

  it('returns an explicit no-data shape instead of throwing', () => {
    const result = compareAssessments({}, {});
    expect(result.summary.compared).toBe(0);
    expect(result.summary.missing).toBeGreaterThan(10);
  });

  it('marks testing-condition changes and keeps both notes', () => {
    const baseline = assessment({ testing_conditions: 'Morning, fasted' });
    const latest = assessment({ id: 'a2', assessment_date: '2026-06-10', testing_conditions: 'Evening, fed', trainer_notes: 'Good effort' });
    const result = compareAssessments(baseline, latest);
    expect(result.conditions.changed).toBe(true);
    expect(result.conditions.baseline).toBe('Morning, fasted');
    expect(result.conditions.latest).toBe('Evening, fed');
    expect(result.trainer_observations).toContain('Good effort');
  });
});

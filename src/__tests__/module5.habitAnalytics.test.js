'use strict';

const { buildHabitAnalytics, trendFor, METRICS } = require('../modules/progress/habit-analytics');

const END = '2026-10-19';
const logs = [
  { log_date: '2026-10-19', sleep_hours: '7.5', sleep_quality: 4, water_ml: 2000, steps: 8000, stress_level: 2, energy_level: 4, fatigue_level: 2, soreness_level: 2, recovery_level: 4, source: 'manual' },
  { log_date: '2026-10-18', sleep_hours: '6.0', sleep_quality: 2, water_ml: 1500, steps: 4000, stress_level: 4, energy_level: 2, fatigue_level: 4, soreness_level: 3, recovery_level: 2, source: 'manual' },
  { log_date: '2026-10-11', sleep_hours: '8.0', sleep_quality: 5, water_ml: 2500, steps: 10000, stress_level: 1, energy_level: 5, fatigue_level: 1, soreness_level: 1, recovery_level: 5, source: 'wearable' },
  { log_date: '2026-09-09', sleep_hours: '7.0', steps: 10000, source: 'manual' },
];

describe('Module 5 daily habit analytics', () => {
  it('computes a full daily checklist and completion without claiming optional values', () => {
    const result = buildHabitAnalytics({ logs, preferences: { step_target: 7000 }, endDate: END, days: 30 });
    expect(result.today.log.log_date).toBe(END);
    const sleep = result.today.checklist.find((c) => c.key === 'sleep');
    expect(sleep).toMatchObject({ done: true, detail: '7.5 h' });
    const water = result.today.checklist.find((c) => c.key === 'water');
    expect(water.target).toMatch(/Optional/);
    expect(result.today.completion).toBe(1);
  });

  it('averages only recorded values and reports sample sizes', () => {
    const result = buildHabitAnalytics({ logs, preferences: null, endDate: END, days: 30 });
    expect(result.averages.sleep_hours).toEqual({ average: 7.17, total: 21.5, samples: 3 });
    expect(result.averages.water_ml).toEqual({ average: 2000, total: 6000, samples: 3 });
    expect(result.averages.steps).toEqual({ average: 7333.33, total: 22000, samples: 3 });
    expect(result.data_quality.logged_days).toBe(3);
    expect(result.data_quality.expected_days).toBe(30);
    expect(result.data_quality.missing_days).toBe(27);
  });

  it('compares the window with the immediately preceding window', () => {
    const result = buildHabitAnalytics({ logs, preferences: null, endDate: END, days: 30 });
    const steps = result.trends.steps.d30;
    expect(steps.current_average).toBe(7333.33);
    expect(steps.previous_average).toBe(10000);
    expect(steps.absolute_change).toBe(-2667);
    expect(steps.percent_change).toBe(-26.7);
    expect(steps.samples).toBe(3);
  });

  it('returns a null percentage when the previous average is zero or absent', () => {
    const metric = METRICS.find((m) => m.key === 'steps');
    const trend = trendFor([{ log_date: END, steps: 100 }], metric, END, 7);
    expect(trend.previous_average).toBeNull();
    expect(trend.percent_change).toBeNull();
  });

  it('keeps a streak alive through yesterday and stops at a gap', () => {
    const result = buildHabitAnalytics({ logs, preferences: { sleep_target_min: 7, sleep_target_max: 9, step_target: 7000 }, endDate: END, days: 30 });
    expect(result.streaks.logging_days).toBe(2);
    expect(result.streaks.sleep_target_days).toBe(1);
    expect(result.streaks.step_target_days).toBe(1);
    expect(result.last_7_days.logged_days).toBe(2);
    expect(result.last_7_days.sleep_target_days).toBe(1);
  });

  it('labels wearable/imported data and warns about coverage', () => {
    const result = buildHabitAnalytics({ logs, preferences: null, endDate: END, days: 30 });
    expect(result.data_quality.sources).toEqual({ manual: 2, wearable: 1 });
    expect(result.data_quality.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['sleep_coverage', 'imported_data']),
    );
  });

  it('warns when recent entries cover only a fraction of the window', () => {
    const result = buildHabitAnalytics({
      logs: logs.map((l) => ({ ...l, log_date: END })),
      preferences: null, endDate: END, days: 30,
    });
    expect(result.data_quality.warnings.map((w) => w.code)).toContain('missing_days');
    expect(result.data_quality.warnings.find((w) => w.code === 'missing_days').message)
      .toContain('29 of 30 days');
  });

  it('returns an explicit empty shape, not a zero-filled week', () => {
    const result = buildHabitAnalytics({ logs: [], preferences: null, endDate: END, days: 7 });
    expect(result.today.log).toBeNull();
    expect(result.today.completion).toBe(0);
    expect(result.averages.sleep_hours).toEqual({ average: null, total: null, samples: 0 });
    expect(result.data_quality.warnings.map((w) => w.code)).toContain('no_logs');
  });
});

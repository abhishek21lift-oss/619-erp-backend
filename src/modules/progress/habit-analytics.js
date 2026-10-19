'use strict';
// src/modules/progress/habit-analytics.js
// Pure daily-journal aggregation. No database, no clock.
//
// The journal is self-reported unless a value says otherwise. A missing day is
// a missing day: averages divide by the number of recorded values, not by the
// length of the window, and every count carries its own sample size so a
// "7-day average" from two logs cannot be read as a full week.

const SLEEP_REFERENCE = {
  min_hours: 7,
  max_hours: 9,
  note: '7–9 hours is a general adult reference, not a personal prescription.',
};

const METRICS = [
  { key: 'sleep_hours', label: 'Sleep', unit: 'h', decimals: 1, higherIsBetter: null },
  { key: 'sleep_quality', label: 'Sleep quality', unit: '/5', decimals: 1, higherIsBetter: true },
  { key: 'water_ml', label: 'Water', unit: 'ml', decimals: 0, higherIsBetter: null },
  { key: 'steps', label: 'Steps', unit: 'steps', decimals: 0, higherIsBetter: true },
  { key: 'stress_level', label: 'Stress', unit: '/5', decimals: 1, higherIsBetter: false },
  { key: 'energy_level', label: 'Energy', unit: '/5', decimals: 1, higherIsBetter: true },
  { key: 'fatigue_level', label: 'Fatigue', unit: '/5', decimals: 1, higherIsBetter: false },
  { key: 'soreness_level', label: 'Soreness', unit: '/5', decimals: 1, higherIsBetter: false },
  { key: 'recovery_level', label: 'Recovery', unit: '/5', decimals: 1, higherIsBetter: true },
];

function isYmd(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).slice(0, 10);
  return isYmd(s) ? s : null;
}

function addDays(base, days) {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(n, decimals = 1) {
  if (n == null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function average(values) {
  const nums = values.map(num).filter((v) => v != null);
  return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length, 2) : null;
}

function sum(values) {
  return values.map(num).filter((v) => v != null).reduce((a, b) => a + b, 0);
}

function normalizeLogs(logs) {
  const byDate = new Map();
  for (const log of logs || []) {
    const d = ymd(log.log_date);
    if (!d) continue;
    byDate.set(d, { ...log, log_date: d });
  }
  return [...byDate.values()].sort((a, b) => a.log_date.localeCompare(b.log_date));
}

function windowLogs(logs, endDate, days) {
  const start = addDays(endDate, -(days - 1));
  return logs.filter((l) => l.log_date >= start && l.log_date <= endDate);
}

function metricWindow(logs, key) {
  const present = logs.map((l) => num(l[key])).filter((v) => v != null);
  return { average: average(present), total: present.length ? round(sum(present), 1) : null, samples: present.length };
}

/**
 * Current window vs the immediately preceding window of the same length.
 * `percent_change` is null when the previous average is 0 or absent.
 */
function trendFor(logs, metric, endDate, days) {
  const current = windowLogs(logs, endDate, days);
  const previousEnd = addDays(endDate, -days);
  const previous = windowLogs(logs, previousEnd, days);
  const a = metricWindow(previous, metric.key).average;
  const b = metricWindow(current, metric.key).average;
  return {
    key: metric.key,
    label: metric.label,
    unit: metric.unit,
    current_average: b,
    previous_average: a,
    absolute_change: a != null && b != null ? round(b - a, metric.decimals) : null,
    percent_change: a != null && b != null && a !== 0 ? round(((b - a) / Math.abs(a)) * 100, 1) : null,
    samples: metricWindow(current, metric.key).samples,
    previous_samples: metricWindow(previous, metric.key).samples,
    direction: metric.higherIsBetter,
    period_days: days,
  };
}

function consecutiveFrom(logs, endDate, predicate) {
  const byDate = new Map(logs.map((l) => [l.log_date, l]));
  // A streak that has not been logged yet today is still alive through
  // yesterday; otherwise every member's streak would read 0 until midnight.
  const today = byDate.get(endDate);
  let cursor = today && predicate(today) ? endDate : addDays(endDate, -1);
  let streak = 0;
  while (true) {
    const log = byDate.get(cursor);
    if (!log || !predicate(log)) break;
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function buildChecklist(log, preferences) {
  const sleepMin = num(preferences?.sleep_target_min) ?? SLEEP_REFERENCE.min_hours;
  const sleepMax = num(preferences?.sleep_target_max) ?? SLEEP_REFERENCE.max_hours;
  const stepTarget = num(preferences?.step_target);
  const waterTarget = num(preferences?.water_target_ml);
  const sleep = num(log?.sleep_hours);
  const steps = num(log?.steps);
  const water = num(log?.water_ml);
  return [
    {
      key: 'sleep', label: 'Sleep logged', done: sleep != null,
      detail: sleep == null ? 'Not logged yet' : `${sleep} h`,
      target: `${sleepMin}–${sleepMax} h general reference`,
      optional: false,
    },
    {
      key: 'checkin', label: 'Daily check-in', done: Boolean(log),
      detail: log ? 'Recorded' : 'Not recorded yet', optional: false,
    },
    {
      key: 'steps', label: 'Steps', done: steps != null,
      detail: steps == null ? 'Not logged' : `${steps.toLocaleString('en-IN')} steps`,
      target: stepTarget ? `${stepTarget.toLocaleString('en-IN')} target` : 'No personal target set',
      optional: true,
    },
    {
      key: 'water', label: 'Water', done: water != null,
      detail: water == null ? 'Not logged' : `${water} ml`,
      target: waterTarget ? `${waterTarget} ml personal target` : 'Optional — no universal target',
      optional: true,
    },
    {
      key: 'electrolytes', label: 'Electrolytes', done: log?.electrolytes === true,
      detail: log?.electrolytes == null ? 'Not recorded' : log.electrolytes ? 'Taken' : 'Not taken',
      target: 'Optional — only if you and your trainer decide it is needed',
      optional: true,
    },
  ];
}

function buildHabitAnalytics({ logs: rawLogs, preferences = null, endDate, days = 30 }) {
  if (!isYmd(endDate)) throw new Error('endDate must be YYYY-MM-DD');
  const logs = normalizeLogs(rawLogs);
  const todayLog = logs.find((l) => l.log_date === endDate) || null;
  const period = windowLogs(logs, endDate, days);
  const last7 = windowLogs(logs, endDate, 7);
  const previous30 = windowLogs(logs, addDays(endDate, -days), days);
  const sleepMin = num(preferences?.sleep_target_min) ?? SLEEP_REFERENCE.min_hours;
  const sleepMax = num(preferences?.sleep_target_max) ?? SLEEP_REFERENCE.max_hours;
  const stepTarget = num(preferences?.step_target);

  const metrics = METRICS.map((m) => metricWindow(period, m.key));
  const trends = Object.fromEntries(METRICS.map((m) => [m.key, {
    d7: trendFor(logs, m, endDate, 7),
    d30: trendFor(logs, m, endDate, 30),
  }]));

  const loggedDates = new Set(period.map((l) => l.log_date));
  const missingDates = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = addDays(endDate, -i);
    if (!loggedDates.has(d)) missingDates.push(d);
  }

  const sources = period.reduce((acc, l) => {
    const s = l.source || 'manual';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const warnings = [];
  if (!logs.length) warnings.push({ code: 'no_logs', message: 'No daily journal entries yet.' });
  else if (missingDates.length && logs[logs.length - 1].log_date < addDays(endDate, -2)) {
    warnings.push({ code: 'logging_gap', message: `Last journal entry was ${daysBetween(logs[logs.length - 1].log_date, endDate)} days ago.` });
  } else if (missingDates.length >= 3) {
    warnings.push({
      code: 'missing_days',
      message: `${missingDates.length} of ${days} days in this window have no journal entry.`,
    });
  }
  if (period.length && metricWindow(period, 'sleep_hours').samples < Math.ceil(days / 2)) {
    warnings.push({ code: 'sleep_coverage', message: `Sleep is recorded on ${metricWindow(period, 'sleep_hours').samples} of ${days} days.` });
  }
  if (period.length && metricWindow(period, 'steps').samples === 0) {
    warnings.push({ code: 'steps_missing', message: 'No step counts in this period — connect a wearable or enter them manually.' });
  }
  if (sources.imported || sources.wearable) {
    warnings.push({
      code: 'imported_data',
      message: 'Some values were imported or synced; they are labelled by source and were not verified by a trainer.',
    });
  }

  return {
    period: { end_date: endDate, days, start_date: addDays(endDate, -(days - 1)) },
    today: {
      log: todayLog,
      checklist: buildChecklist(todayLog, preferences),
      completion: (() => {
        const required = buildChecklist(todayLog, preferences).filter((c) => !c.optional);
        return required.length ? round(required.filter((c) => c.done).length / required.length, 2) : 0;
      })(),
    },
    averages: Object.fromEntries(METRICS.map((m, i) => [m.key, metrics[i]])),
    last_7_days: {
      logged_days: last7.length,
      sleep_average: metricWindow(last7, 'sleep_hours').average,
      sleep_samples: metricWindow(last7, 'sleep_hours').samples,
      sleep_target_days: last7.filter((l) => num(l.sleep_hours) != null && num(l.sleep_hours) >= sleepMin && num(l.sleep_hours) <= sleepMax).length,
      steps_average: metricWindow(last7, 'steps').average,
      step_samples: metricWindow(last7, 'steps').samples,
      step_target_days: stepTarget ? last7.filter((l) => num(l.steps) != null && num(l.steps) >= stepTarget).length : null,
    },
    trends,
    streaks: {
      logging_days: consecutiveFrom(logs, endDate, () => true),
      sleep_target_days: consecutiveFrom(logs, endDate, (l) => {
        const v = num(l.sleep_hours);
        return v != null && v >= sleepMin && v <= sleepMax;
      }),
      step_target_days: stepTarget ? consecutiveFrom(logs, endDate, (l) => num(l.steps) >= stepTarget) : null,
    },
    data_quality: {
      logged_days: period.length,
      expected_days: days,
      missing_days: missingDates.length,
      missing_dates: missingDates.slice(-10),
      sleep_samples: metricWindow(period, 'sleep_hours').samples,
      step_samples: metricWindow(period, 'steps').samples,
      water_samples: metricWindow(period, 'water_ml').samples,
      sources,
      warnings,
    },
    previous_30_days: {
      logged_days: previous30.length,
      sleep_average: metricWindow(previous30, 'sleep_hours').average,
      steps_average: metricWindow(previous30, 'steps').average,
    },
    preferences: {
      sleep_target_min: sleepMin,
      sleep_target_max: sleepMax,
      water_target_ml: num(preferences?.water_target_ml),
      step_target: stepTarget,
      reminder_enabled: preferences?.reminder_enabled ?? true,
      reminder_time: preferences?.reminder_time ?? null,
      wearable_provider: preferences?.wearable_provider ?? null,
    },
    reference: SLEEP_REFERENCE,
  };
}

module.exports = {
  SLEEP_REFERENCE, METRICS, buildHabitAnalytics, buildChecklist, trendFor,
  metricWindow, normalizeLogs, windowLogs, addDays, daysBetween,
};

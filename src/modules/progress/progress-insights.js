'use strict';
// src/modules/progress/progress-insights.js
// Deterministic trainer insights. No model call, no diagnosis, no invented data.
//
// Every insight names the recorded evidence and its period. Recommendations
// are suggestions for the trainer to review, never an automatic program change:
// `auto_apply` is always false and `requires_trainer_review` is always true.

function fmt(n, unit = '') {
  if (n == null) return '—';
  return `${n}${unit ? ` ${unit}` : ''}`;
}


function metric(comparison, key) {
  for (const domain of comparison?.domains || []) {
    const found = domain.metrics.find((m) => m.key === key);
    if (found) return found;
  }
  return null;
}

function base({ key, type, severity, title, detail, evidence, recommendation = null }) {
  return {
    insight_key: key,
    type,
    severity,
    title,
    detail,
    recommendation,
    evidence,
    requires_trainer_review: true,
    auto_apply: false,
  };
}

function buildInsights({ comparison = null, analytics = null, schedule = null, goal = null, workouts = null }) {
  const out = [];
  const period = comparison?.baseline?.assessment_date && comparison?.latest?.assessment_date
    ? `${comparison.baseline.assessment_date} to ${comparison.latest.assessment_date}`
    : null;

  // ── Assessment coverage ───────────────────────────────────
  if (schedule?.state === 'missing_baseline') {
    out.push(base({
      key: 'missing_baseline', type: 'recommendation', severity: 'attention',
      title: 'No baseline assessment on file',
      detail: 'A re-test date cannot be scheduled until the first seven-step assessment is completed.',
      evidence: { state: 'missing_baseline' },
      recommendation: 'Complete an initial fitness assessment with the client before scheduling a re-test.',
    }));
  } else if (schedule?.state === 'overdue') {
    out.push(base({
      key: 'assessment_overdue', type: 'recommendation', severity: 'high',
      title: 'Re-test is overdue',
      detail: `The scheduled re-test was ${schedule.scheduled_date} (${Math.abs(schedule.days_until)} days ago).`,
      evidence: { scheduled_date: schedule.scheduled_date, days_until: schedule.days_until },
      recommendation: 'Book the re-test and record the same seven-step battery where possible.',
    }));
  } else if (schedule?.state === 'due') {
    out.push(base({
      key: 'assessment_due', type: 'recommendation', severity: 'attention',
      title: 'Re-test is due today',
      detail: `The next seven-step assessment is scheduled for ${schedule.scheduled_date}.`,
      evidence: { scheduled_date: schedule.scheduled_date, cadence_months: schedule.cadence_months },
      recommendation: 'Confirm the client is available and repeat the same protocols.',
    }));
  }

  // ── Seven-domain changes ──────────────────────────────────
  if (comparison && period) {
    const bodyFat = metric(comparison, 'body_fat_pct');
    if (bodyFat?.comparable && bodyFat.absolute_change != null && Math.abs(bodyFat.absolute_change) >= 1) {
      out.push(base({
        key: 'body_fat_change', type: 'observation', severity: 'info',
        title: `Body fat ${bodyFat.absolute_change < 0 ? 'decreased' : 'increased'} ${Math.abs(bodyFat.absolute_change)} percentage points`,
        detail: `${fmt(bodyFat.baseline_value, '%')} to ${fmt(bodyFat.latest_value, '%')} between ${period}.`,
        evidence: { metric: 'body_fat_pct', baseline: bodyFat.baseline_value, latest: bodyFat.latest_value, period },
      }));
    }

    const waist = metric(comparison, 'waist_cm');
    if (waist?.comparable && waist.absolute_change != null && Math.abs(waist.absolute_change) >= 2) {
      out.push(base({
        key: 'waist_change', type: 'observation', severity: 'info',
        title: `Waist ${waist.absolute_change < 0 ? 'decreased' : 'increased'} ${Math.abs(waist.absolute_change)} cm`,
        detail: `${fmt(waist.baseline_value, 'cm')} to ${fmt(waist.latest_value, 'cm')} between ${period}.`,
        evidence: { metric: 'waist_cm', baseline: waist.baseline_value, latest: waist.latest_value, period },
      }));
    }

    const vo2 = metric(comparison, 'vo2_max');
    if (vo2?.comparable && vo2.absolute_change != null && Math.abs(vo2.absolute_change) >= 2) {
      out.push(base({
        key: 'vo2_change', type: 'observation', severity: 'info',
        title: `VO₂ max ${vo2.absolute_change > 0 ? 'increased' : 'decreased'} ${Math.abs(vo2.absolute_change)} mL/kg/min`,
        detail: `${fmt(vo2.baseline_value)} to ${fmt(vo2.latest_value)} between ${period}. Compare only because the cardio protocol matched.`,
        evidence: { metric: 'vo2_max', baseline: vo2.baseline_value, latest: vo2.latest_value, period },
      }));
    }

    const strength = metric(comparison, 'strength_score_computed');
    if (strength?.comparable && strength.absolute_change != null && Math.abs(strength.absolute_change) >= 5) {
      out.push(base({
        key: 'strength_change', type: 'observation', severity: 'info',
        title: `Strength score ${strength.absolute_change > 0 ? 'improved' : 'declined'} ${Math.abs(strength.absolute_change)} points`,
        detail: `${fmt(strength.baseline_value, '/100')} to ${fmt(strength.latest_value, '/100')} between ${period}.`,
        evidence: { metric: 'strength_score_computed', baseline: strength.baseline_value, latest: strength.latest_value, period },
      }));
    }

    const systolic = metric(comparison, 'bp_systolic');
    const diastolic = metric(comparison, 'bp_diastolic');
    if (systolic?.latest_value != null && diastolic?.latest_value != null) {
      const crisis = systolic.latest_value >= 180 || diastolic.latest_value >= 120;
      const stage2 = systolic.latest_value >= 140 || diastolic.latest_value >= 90;
      if (crisis) {
        out.push(base({
          key: 'bp_crisis_reading', type: 'observation', severity: 'high',
          title: 'Latest resting blood pressure is in the hypertensive crisis range',
          detail: `The latest recorded reading was ${systolic.latest_value}/${diastolic.latest_value} mmHg. This is a recorded reading, not a diagnosis.`,
          evidence: {
            metric: 'bp_systolic/bp_diastolic',
            latest: [systolic.latest_value, diastolic.latest_value],
            assessment_date: comparison.latest?.assessment_date,
          },
          recommendation: 'Stop exertion testing and advise urgent medical assessment. Follow the studio screening policy.',
        }));
      } else if (stage2) {
        out.push(base({
          key: 'bp_high_reading', type: 'observation', severity: 'high',
          title: 'Latest resting blood pressure reading is elevated',
          detail: `The latest recorded reading was ${systolic.latest_value}/${diastolic.latest_value} mmHg. This is a recorded reading, not a diagnosis.`,
          evidence: {
            metric: 'bp_systolic/bp_diastolic',
            latest: [systolic.latest_value, diastolic.latest_value],
            assessment_date: comparison.latest?.assessment_date,
          },
          recommendation: 'Follow the studio screening policy and advise the client to have the reading reviewed by a qualified clinician.',
        }));
      }
    }

    const spo2 = metric(comparison, 'resting_spo2');
    if (spo2?.latest_value != null && spo2.latest_value < 95) {
      out.push(base({
        key: 'spo2_low_reading', type: 'observation', severity: spo2.latest_value < 90 ? 'high' : 'attention',
        title: `Latest resting SpO₂ is ${spo2.latest_value < 90 ? 'critically low' : 'below the normal range'}`,
        detail: `The latest recorded reading was ${fmt(spo2.latest_value, '%')}. This is a recorded reading, not a diagnosis.`,
        evidence: { metric: 'resting_spo2', latest: spo2.latest_value, assessment_date: comparison.latest?.assessment_date },
        recommendation: spo2.latest_value < 90
          ? 'Do not proceed with exertion testing; seek medical assessment.'
          : 'Recheck after rest and monitor for breathlessness before exertion testing.',
      }));
    }

    const rhr = metric(comparison, 'resting_heart_rate');
    if (rhr?.latest_value != null && (rhr.latest_value < 40 || rhr.latest_value > 100)) {
      out.push(base({
        key: 'rhr_out_of_range', type: 'observation', severity: 'high',
        title: `Latest resting heart rate is ${rhr.latest_value < 40 ? 'below 40' : 'above 100'} bpm`,
        detail: `The latest recorded reading was ${fmt(rhr.latest_value, 'bpm')}. This is a recorded reading, not a diagnosis.`,
        evidence: { metric: 'resting_heart_rate', latest: rhr.latest_value, assessment_date: comparison.latest?.assessment_date },
        recommendation: 'Reassess at rest and follow the studio screening policy before exertion testing.',
      }));
    }

    const incomparable = (comparison.domains || []).filter((d) => !d.comparable);
    if (incomparable.length) {
      out.push(base({
        key: 'protocol_changed', type: 'observation', severity: 'attention',
        title: 'One or more protocols changed between assessments',
        detail: incomparable.map((d) => `${d.label}: ${d.incomparable_reason}`).join(' '),
        evidence: { domains: incomparable.map((d) => ({ key: d.key, reason: d.incomparable_reason })), period },
      }));
    }
  }

  // ── Journal data quality and trends ───────────────────────
  if (analytics) {
    const q = analytics.data_quality;
    if (q?.expected_days && q.missing_days >= 7) {
      out.push(base({
        key: 'journal_missing_days', type: 'observation', severity: 'attention',
        title: `${q.missing_days} journal days are missing`,
        detail: `The last ${q.expected_days} days contain ${q.logged_days} entries, so averages cover only recorded days.`,
        evidence: { logged_days: q.logged_days, expected_days: q.expected_days, missing_dates: q.missing_dates },
      }));
    }

    const sleep30 = analytics.trends?.sleep_hours?.d30;
    if (sleep30?.current_average != null && sleep30.samples >= 7 && sleep30.current_average < 7) {
      out.push(base({
        key: 'sleep_below_reference', type: 'observation', severity: 'attention',
        title: 'Average sleep is below the general 7–9 hour reference',
        detail: `Recorded average was ${sleep30.current_average} h across ${sleep30.samples} logged days in the last 30 days. Sleeping 7–9 hours is a general reference, not a personal prescription.`,
        evidence: { average: sleep30.current_average, samples: sleep30.samples, period_days: 30, reference: '7–9 hours (general adult reference)' },
      }));
    }

    const steps30 = analytics.trends?.steps?.d30;
    if (steps30?.current_average != null && steps30.samples >= 7 && steps30.current_average < 5000) {
      out.push(base({
        key: 'steps_low', type: 'observation', severity: 'info',
        title: 'Average daily steps are below 5,000',
        detail: `Recorded average was ${Math.round(steps30.current_average).toLocaleString('en-IN')} steps across ${steps30.samples} days in the last 30 days.`,
        evidence: { average: steps30.current_average, samples: steps30.samples, period_days: 30 },
      }));
    }

    if (steps30?.percent_change != null && steps30.percent_change <= -20 && steps30.samples >= 7) {
      out.push(base({
        key: 'steps_declining', type: 'observation', severity: 'attention',
        title: `Daily steps are down ${Math.abs(steps30.percent_change)}% versus the previous 30 days`,
        detail: `${Math.round(steps30.previous_average).toLocaleString('en-IN')} to ${Math.round(steps30.current_average).toLocaleString('en-IN')} steps per recorded day.`,
        evidence: { previous_average: steps30.previous_average, current_average: steps30.current_average, percent_change: steps30.percent_change },
      }));
    }

    const stress = analytics.trends?.stress_level?.d30;
    if (stress?.current_average != null && stress.samples >= 5 && stress.current_average >= 4) {
      out.push(base({
        key: 'stress_high', type: 'observation', severity: 'attention',
        title: 'Self-reported stress is high',
        detail: `Average stress was ${stress.current_average}/5 across ${stress.samples} entries in the last 30 days. This is self-reported, not a clinical assessment.`,
        evidence: { average: stress.current_average, samples: stress.samples, period_days: 30 },
      }));
    }

    const recovery = analytics.trends?.recovery_level?.d30;
    if (recovery?.current_average != null && recovery.samples >= 5 && recovery.current_average <= 2) {
      out.push(base({
        key: 'recovery_low', type: 'observation', severity: 'attention',
        title: 'Self-reported recovery is low',
        detail: `Average recovery was ${recovery.current_average}/5 across ${recovery.samples} entries in the last 30 days.`,
        evidence: { average: recovery.current_average, samples: recovery.samples, period_days: 30 },
        recommendation: 'Review training load, sleep and soreness with the client before progressing the programme.',
      }));
    }

    if (q?.sources && (q.sources.wearable || q.sources.imported)) {
      out.push(base({
        key: 'imported_journal_values', type: 'observation', severity: 'info',
        title: 'Some journal values were imported',
        detail: 'Imported or wearable values are labelled in the journal and were not verified by a trainer.',
        evidence: { sources: q.sources },
      }));
    }
  }

  // ── Goal and session adherence ────────────────────────────
  if (goal?.progress_percent != null) {
    out.push(base({
      key: 'goal_progress', type: 'observation', severity: 'info',
      title: `Goal progress is ${goal.progress_percent}%`,
      detail: goal.summary || 'Computed from the active goal and recorded assessments.',
      evidence: { goal_type: goal.goal_type, progress_percent: goal.progress_percent, target: goal.target, current: goal.current, target_date: goal.target_date },
    }));
  }

  if (workouts?.adherence_percent != null) {
    out.push(base({
      key: 'workout_adherence', type: 'observation', severity: workouts.adherence_percent < 60 ? 'attention' : 'info',
      title: `Workout adherence is ${workouts.adherence_percent}% in the last ${workouts.period_days} days`,
      detail: `${workouts.completed} completed sessions against ${workouts.planned} planned sessions.`,
      evidence: { completed: workouts.completed, planned: workouts.planned, period_days: workouts.period_days },
    }));
  }

  return out;
}

module.exports = { buildInsights };

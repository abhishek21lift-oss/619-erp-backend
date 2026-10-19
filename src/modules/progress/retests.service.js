'use strict';
// src/modules/progress/retests.service.js
// Module 5 orchestration for re-test settings, scheduling and comparison.
// No HTTP, no template text.

const repo = require('./retests.repo');
const scheduling = require('./retest-scheduling');
const comparison = require('./progress-comparison');
const { dbDate, appTimeZone } = require('../../lib/appTime');

const DEFAULT_SETTINGS = { cadence_months: 4, reminder_days: [30, 14, 7], is_enabled: true };

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function dateOnly(value) {
  return value ? dbDate(value) : null;
}

function normalizeAssessment(row) {
  if (!row) return null;
  return { ...row, assessment_date: dateOnly(row.assessment_date), testing_conditions: row.testing_conditions || null };
}

function normalizeSchedule(row) {
  if (!row) return null;
  return {
    ...row,
    scheduled_date: dateOnly(row.scheduled_date),
    rescheduled_from: row.rescheduled_from ? dateOnly(row.rescheduled_from) : null,
    completed_at: row.completed_at || null,
    cancelled_at: row.cancelled_at || null,
  };
}

async function timezoneFor(orgId) {
  const configured = await repo.orgTimezone(orgId);
  return configured || appTimeZone();
}

async function getSettings(orgId) {
  const row = await repo.getSettings(orgId);
  return row ? {
    cadence_months: row.cadence_months,
    reminder_days: row.reminder_days || DEFAULT_SETTINGS.reminder_days,
    is_enabled: row.is_enabled,
    updated_at: row.updated_at,
  } : { ...DEFAULT_SETTINGS, updated_at: null };
}

async function saveSettings(orgId, body, userId) {
  const cadence = scheduling.normalizeCadence(body.cadence_months ?? DEFAULT_SETTINGS.cadence_months);
  const reminderDays = scheduling.normalizeReminderDays(body.reminder_days ?? DEFAULT_SETTINGS.reminder_days);
  const enabled = body.is_enabled !== false;
  const row = await repo.upsertSettings(orgId, {
    cadenceMonths: cadence, reminderDays, isEnabled: enabled,
  }, userId);
  return {
    cadence_months: row.cadence_months,
    reminder_days: row.reminder_days,
    is_enabled: row.is_enabled,
    updated_at: row.updated_at,
  };
}

/**
 * A completed assessment closes the open cycle and opens the next one from
 * that assessment's date. Idempotent for the same assessment id; a backdated
 * assessment earlier than the current baseline does not move the chain.
 */
async function syncAfterAssessment({ orgId, clientId, assessment, userId = null }) {
  const row = normalizeAssessment(assessment);
  if (!row?.assessment_date) return { schedule: null, completed_previous: null };
  const settings = await getSettings(orgId);
  const active = normalizeSchedule(await repo.activeSchedule(orgId, clientId));

  if (active) {
    if (active.baseline_assessment_id === row.id) return { schedule: active, completed_previous: null };
    const currentBaseline = active.baseline_assessment_id
      ? normalizeAssessment(await repo.getAssessment(orgId, clientId, active.baseline_assessment_id))
      : null;
    if (currentBaseline?.assessment_date && row.assessment_date < currentBaseline.assessment_date) {
      return { schedule: active, completed_previous: null };
    }
    await repo.completeSchedule(orgId, active.id, row.id, userId || null);
  }

  const scheduledDate = scheduling.scheduleFromBaseline(row.assessment_date, settings.cadence_months);
  const created = await repo.createSchedule({
    orgId, clientId, baselineAssessmentId: row.id, scheduledDate,
    cadenceMonths: settings.cadence_months, source: 'auto', createdBy: userId,
  });
  return { schedule: normalizeSchedule(created), completed_previous: active?.id || null };
}

async function overview(orgId, clientId) {
  const timezone = await timezoneFor(orgId);
  const today = scheduling.todayInZone(timezone);
  const [settings, rawAssessments, rawActive, rawHistory] = await Promise.all([
    getSettings(orgId), repo.listAssessments(orgId, clientId),
    repo.activeSchedule(orgId, clientId), repo.listSchedules(orgId, clientId, 50),
  ]);
  const assessments = rawAssessments.map(normalizeAssessment);
  const baseline = assessments[0] || null;
  const latest = assessments[assessments.length - 1] || null;

  const schedule = normalizeSchedule(rawActive);
  if (!baseline) {
    return {
      client_id: clientId, today, timezone, settings,
      assessment_count: 0, baseline: null, latest: null,
      schedule: null,
      state: { state: 'missing_baseline', days_until: null, label: 'No baseline assessment' },
      history: rawHistory.map(normalizeSchedule),
      prompt: 'Complete an initial fitness assessment to start the re-test schedule.',
    };
  }
  if (!schedule) {
    // Existing client whose last assessment predates Module 5. Do not invent a
    // date on read; the trainer can start the schedule explicitly.
    return {
      client_id: clientId, today, timezone, settings,
      assessment_count: assessments.length, baseline, latest,
      schedule: null,
      state: { state: 'not_scheduled', days_until: null, label: 'No re-test scheduled' },
      history: rawHistory.map(normalizeSchedule),
      prompt: 'Create the next re-test from the latest completed assessment.',
    };
  }

  const state = scheduling.deriveState({
    status: schedule.status, scheduledDate: schedule.scheduled_date, today,
  });
  await repo.syncStatus(orgId, schedule.id, state.state === 'rescheduled' ? 'rescheduled' : state.state);

  return {
    client_id: clientId, today, timezone, settings,
    assessment_count: assessments.length, baseline, latest,
    schedule: {
      ...schedule,
      state: state.state,
      state_label: state.label,
      days_until: state.days_until,
      next_reminder: scheduling.nextReminder({
        scheduledDate: schedule.scheduled_date, today, reminderDays: settings.reminder_days,
      }),
    },
    state,
    history: rawHistory.map(normalizeSchedule).map((h) => (
      h.id === schedule.id ? { ...h, status: state.state } : h
    )),
  };
}

async function comparisonFor(orgId, clientId, { baselineId, latestId } = {}) {
  const rows = (await repo.listAssessments(orgId, clientId)).map(normalizeAssessment);
  if (!rows.length) {
    return {
      baseline: null, latest: null, previous: null, domains: [], summary: null,
      conditions: null, trainer_observations: [], generated_at: new Date().toISOString(),
      message: 'No assessments recorded yet.',
    };
  }
  const find = (id) => rows.find((r) => r.id === id) || null;
  const baseline = baselineId ? find(baselineId) : rows[0];
  const latest = latestId ? find(latestId) : rows[rows.length - 1];
  if (!baseline || !latest) throw httpError(404, 'NOT_FOUND', 'Assessment not found for this client.');
  if (baseline.id === latest.id) throw httpError(400, 'SAME_ASSESSMENT', 'Choose two different assessments to compare.');
  const latestIndex = rows.findIndex((r) => r.id === latest.id);
  const previous = latestIndex > 0 ? rows[latestIndex - 1] : null;
  const result = comparison.compareAssessments(baseline, latest, previous);
  // "Since last test" is a different question from "since baseline", and a
  // client can improve on both without the two numbers being interchangeable.
  // Null when there is no third distinct assessment.
  if (previous && previous.id !== baseline.id && previous.id !== latest.id) {
    result.previous_comparison = comparison.compareAssessments(previous, latest);
  } else {
    result.previous_comparison = null;
  }
  return { ...result, generated_at: new Date().toISOString() };
}

async function startSchedule(orgId, clientId, { scheduledDate, notes, createdBy } = {}) {
  const assessments = await repo.listAssessments(orgId, clientId);
  if (!assessments.length) throw httpError(409, 'BASELINE_REQUIRED', 'Complete an initial assessment first.');
  const latest = normalizeAssessment(assessments[assessments.length - 1]);
  const active = await repo.activeSchedule(orgId, clientId);
  if (active) throw httpError(409, 'SCHEDULE_EXISTS', 'This client already has an open re-test.');
  const settings = await getSettings(orgId);
  const timezone = await timezoneFor(orgId);
  const today = scheduling.todayInZone(timezone);
  const date = scheduledDate || scheduling.scheduleFromBaseline(latest.assessment_date, settings.cadence_months);
  if (date < today) throw httpError(400, 'DATE_IN_PAST', 'The re-test date cannot be in the past.');
  const row = await repo.createSchedule({
    orgId, clientId, baselineAssessmentId: latest.id, scheduledDate: date,
    cadenceMonths: settings.cadence_months, source: 'manual', notes, createdBy,
  });
  return normalizeSchedule(row);
}

async function reschedule(orgId, clientId, scheduleId, { scheduledDate, reason, notes, updatedBy } = {}) {
  const timezone = await timezoneFor(orgId);
  const today = scheduling.todayInZone(timezone);
  if (!scheduledDate || scheduledDate < today) {
    throw httpError(400, 'DATE_IN_PAST', 'The new re-test date must be today or later.');
  }
  const row = await repo.reschedule(orgId, clientId, scheduleId, { scheduledDate, reason, notes }, updatedBy);
  if (!row) throw httpError(404, 'NOT_FOUND', 'Open re-test not found.');
  return normalizeSchedule(row);
}

async function cancel(orgId, clientId, scheduleId, reason, userId = null) {
  const row = await repo.cancel(orgId, clientId, scheduleId, reason, userId);
  if (!row) throw httpError(404, 'NOT_FOUND', 'Open re-test not found.');
  return normalizeSchedule(row);
}

async function complete(orgId, clientId, scheduleId, assessmentId, userId = null) {
  const schedule = await repo.getSchedule(orgId, clientId, scheduleId);
  if (!schedule) throw httpError(404, 'NOT_FOUND', 'Re-test not found.');
  const assessment = await repo.getAssessment(orgId, clientId, assessmentId);
  if (!assessment) throw httpError(404, 'NOT_FOUND', 'Assessment not found for this client.');
  // The API must enforce what the UI already does: a cycle is closed by the
  // client's latest test. An older id would open the next cycle from a date
  // the chain has already passed.
  const assessments = await repo.listAssessments(orgId, clientId);
  const latest = assessments[assessments.length - 1];
  if (!latest || latest.id !== assessmentId) {
    throw httpError(409, 'NOT_LATEST_ASSESSMENT', "Complete the re-test with the client's latest assessment.");
  }
  if (schedule.baseline_assessment_id && String(schedule.baseline_assessment_id) === String(assessmentId)) {
    throw httpError(409, 'BASELINE_IS_NOT_RETEST', 'The baseline test cannot close its own re-test cycle. Record the new test first.');
  }
  const row = await repo.completeSchedule(orgId, scheduleId, assessmentId, userId);
  if (!row) throw httpError(409, 'NOT_OPEN', 'This re-test is already closed.');
  // Closing a cycle is also when the next one opens; otherwise a manual
  // completion would leave the client with no re-test at all.
  await syncAfterAssessment({ orgId, clientId, assessment, userId });
  return normalizeSchedule(row);
}

module.exports = {
  DEFAULT_SETTINGS, syncAfterAssessment, overview, comparisonFor, getSettings, saveSettings,
  startSchedule, reschedule, cancel, complete, timezoneFor, normalizeAssessment, normalizeSchedule,
};

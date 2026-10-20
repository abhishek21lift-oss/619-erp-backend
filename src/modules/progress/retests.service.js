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
  const scheduledDate = scheduling.scheduleFromBaseline(row.assessment_date, settings.cadence_months);

  // Close the old cycle and open the next one in one transaction. If the
  // INSERT fails, the close is rolled back and the client keeps the open
  // cycle; retrying the same assessment is idempotent.
  const result = await repo.advanceCycle({
    orgId, clientId, assessmentId: row.id, assessmentDate: row.assessment_date,
    scheduledDate, cadenceMonths: settings.cadence_months, userId: userId || null,
  });
  return {
    schedule: normalizeSchedule(result.schedule),
    completed_previous: result.completed_previous || null,
  };
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

const ROSTER_STATES = ['missing_baseline', 'not_scheduled', 'upcoming', 'due', 'overdue', 'rescheduled'];
const STATE_ORDER = { overdue: 0, due: 1, upcoming: 2, rescheduled: 3, not_scheduled: 4, missing_baseline: 5 };

/**
 * Cross-client roster for the trainer hub. State is derived here, not in SQL,
 * because "today" is the studio's local day and a UTC CURRENT_DATE would move
 * a client between due and overdue at the wrong hour.
 */
async function rosterOverview(orgId, { search = '', status = 'all', page = 1, limit = 20 } = {}) {
  const timezone = await timezoneFor(orgId);
  const today = scheduling.todayInZone(timezone);
  // shortcut: loads the whole org then filters/paginates here. Measured 2026-10-20
  // at 2,001 clients / 8,008 assessments: ~230-330 ms, ~3.5 MB heap. Move the
  // state filter and counts into SQL if a studio outgrows a few thousand clients.
  const rows = await repo.rosterForOverview(orgId);

  const clients = rows.map((row) => {
    const assessmentCount = Number(row.assessment_count) || 0;
    const scheduledDate = row.scheduled_date ? dateOnly(row.scheduled_date) : null;
    let state;
    if (!assessmentCount) {
      state = { state: 'missing_baseline', days_until: null, label: 'No baseline assessment' };
    } else if (!scheduledDate) {
      state = { state: 'not_scheduled', days_until: null, label: 'No re-test scheduled' };
    } else {
      state = scheduling.deriveState({
        status: row.schedule_status, scheduledDate, today,
      });
    }
    return {
      client_id: row.client_id,
      name: row.name,
      email: row.email,
      mobile: row.mobile,
      client_status: row.client_status,
      trainer_name: row.trainer_name,
      assessment_count: assessmentCount,
      baseline_date: row.baseline_date ? dateOnly(row.baseline_date) : null,
      latest_date: row.latest_date ? dateOnly(row.latest_date) : null,
      latest_score: row.latest_score == null ? null : Number(row.latest_score),
      schedule_id: row.schedule_id || null,
      scheduled_date: scheduledDate,
      cadence_months: row.cadence_months || null,
      schedule_status: row.schedule_status || null,
      rescheduled_from: row.rescheduled_from ? dateOnly(row.rescheduled_from) : null,
      state,
    };
  });

  const term = String(search || '').trim().toLowerCase();
  const searched = term
    ? clients.filter((c) => [c.name, c.email, c.mobile]
      .some((v) => String(v || '').toLowerCase().includes(term)))
    : clients;

  const counts = { total: searched.length };
  for (const key of ROSTER_STATES) counts[key] = 0;
  for (const c of searched) counts[c.state.state] += 1;

  const filtered = status && status !== 'all'
    ? searched.filter((c) => c.state.state === status)
    : searched;
  filtered.sort((a, b) => (
    (STATE_ORDER[a.state.state] ?? 99) - (STATE_ORDER[b.state.state] ?? 99)
    || String(a.scheduled_date || '9999-12-31').localeCompare(String(b.scheduled_date || '9999-12-31'))
    || a.name.localeCompare(b.name)
  ));

  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const currentPage = Math.max(Number(page) || 1, 1);
  const total = filtered.length;
  return {
    today,
    timezone,
    counts,
    clients: filtered.slice((currentPage - 1) * size, currentPage * size),
    page: currentPage,
    limit: size,
    total,
    pages: Math.max(Math.ceil(total / size), 1),
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
  // Closing a cycle is also when the next one opens. Both writes share one
  // transaction, so a creation failure leaves the cycle open and retryable
  // instead of stranding the client with no scheduled re-test.
  const normalized = normalizeAssessment(assessment);
  const settings = await getSettings(orgId);
  const result = await repo.advanceCycle({
    orgId, clientId, assessmentId, assessmentDate: normalized.assessment_date,
    scheduledDate: scheduling.scheduleFromBaseline(normalized.assessment_date, settings.cadence_months),
    cadenceMonths: settings.cadence_months,
    userId, expectedScheduleId: scheduleId,
  });
  if (result.not_open || !result.completed_schedule) {
    throw httpError(409, 'NOT_OPEN', 'This re-test is already closed.');
  }
  return normalizeSchedule(result.completed_schedule);
}

module.exports = {
  DEFAULT_SETTINGS, syncAfterAssessment, overview, rosterOverview, comparisonFor,
  getSettings, saveSettings, startSchedule, reschedule, cancel, complete,
  timezoneFor, normalizeAssessment, normalizeSchedule, ROSTER_STATES,
};

'use strict';
// src/modules/progress/retest-scheduling.js
// Pure date rules for the re-test scheduler. No database, no clock.
//
// The two bugs this module exists to prevent:
//   • addMonths on 31 Jan lands in March in JavaScript's Date rollover; a
//     4-month cycle must land on 31 May, and a shorter target month clamps.
//   • "days until due" computed from Date objects in the server's zone is off
//     by one around midnight. Everything here is YYYY-MM-DD and UTC midnight,
//     and the caller supplies the studio-local today.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function isYmd(value) {
  if (typeof value !== 'string' || !YMD.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parseYmd(ymd) {
  if (!isYmd(ymd)) throw new Error(`Invalid YYYY-MM-DD date: ${ymd}`);
  return new Date(`${ymd}T00:00:00Z`);
}

function formatYmd(date) {
  return date.toISOString().slice(0, 10);
}

/** Calendar days from `fromYmd` to `toYmd` (positive when to is later). */
function daysBetween(fromYmd, toYmd) {
  const a = parseYmd(fromYmd);
  const b = parseYmd(toYmd);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Add whole months, clamping the day to the target month's last day.
 * 2026-01-31 + 4 months -> 2026-05-31; 2026-11-30 + 4 -> 2027-03-30.
 */
function addMonthsClamped(ymd, months) {
  const d = parseYmd(ymd);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return formatYmd(target);
}

/** The ISO timestamp of midnight in `timeZone` on `date`, as YYYY-MM-DD. */
function todayInZone(timeZone, date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata',
    }).format(date);
  }
}

function normalizeCadence(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 4 || n > 6) {
    const err = new Error('Re-test cadence must be 4, 5 or 6 months');
    err.status = 400;
    throw err;
  }
  return n;
}

function normalizeReminderDays(value) {
  const list = Array.isArray(value) ? value : [30, 14, 7];
  const clean = [...new Set(list.map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 120);
  if (!clean.length) {
    const err = new Error('At least one reminder day between 1 and 120 is required');
    err.status = 400;
    throw err;
  }
  return clean.sort((a, b) => b - a);
}

/** The date the next test is due, from the completed baseline. */
function scheduleFromBaseline(baselineDate, cadenceMonths) {
  return addMonthsClamped(baselineDate, normalizeCadence(cadenceMonths));
}

/**
 * Effective state, derived from the stored row and the studio's today.
 * Completed and cancelled are terminal. A rescheduled future row keeps the
 * 'rescheduled' state so the UI can say the date moved; once it arrives it is
 * due, then overdue.
 */
function deriveState({ status = 'upcoming', scheduledDate, today }) {
  if (!scheduledDate) {
    return { state: 'missing_baseline', days_until: null, label: 'No baseline assessment' };
  }
  if (status === 'completed') return { state: 'completed', days_until: null, label: 'Completed' };
  if (status === 'cancelled') return { state: 'cancelled', days_until: null, label: 'Cancelled' };
  const days = daysBetween(today, scheduledDate);
  if (days > 0) {
    return {
      state: status === 'rescheduled' ? 'rescheduled' : 'upcoming',
      days_until: days,
      label: status === 'rescheduled' ? `Rescheduled · due in ${days} day${days === 1 ? '' : 's'}` : `Due in ${days} day${days === 1 ? '' : 's'}`,
    };
  }
  if (days === 0) return { state: 'due', days_until: 0, label: 'Due today' };
  return { state: 'overdue', days_until: days, label: `Overdue by ${Math.abs(days)} day${days === -1 ? '' : 's'}` };
}

/**
 * Which reminder, if any, belongs to today.
 *
 * The most recent threshold that has been crossed is selected, not only the
 * exact day. A sweep that was down on day 30 still sends on day 29 (or day 15),
 * because the ledger key is the stage rather than the calendar day. Due fires
 * on the day; overdue fires on every sweep and the ledger makes it once.
 */
function reminderFor({ scheduledDate, today, reminderDays = [30, 14, 7] }) {
  if (!scheduledDate) return null;
  const days = daysBetween(today, scheduledDate);
  if (days > 0) {
    const stage = normalizeReminderDays(reminderDays)
      .filter((d) => d >= days)
      .sort((a, b) => a - b)[0];
    return stage == null ? null : { kind: 'reminder', stage_days: stage };
  }
  if (days === 0) return { kind: 'due', stage_days: 0 };
  return { kind: 'overdue', stage_days: -1 };
}

/** Snapshot of the next reminder, for the UI countdown. */
function nextReminder({ scheduledDate, today, reminderDays = [30, 14, 7] }) {
  if (!scheduledDate) return null;
  const days = daysBetween(today, scheduledDate);
  const stage = normalizeReminderDays(reminderDays)
    .filter((d) => d < days)
    .sort((a, b) => b - a)[0];
  if (stage == null) return null;
  return {
    stage_days: stage,
    in_days: days - stage,
    on_date: formatYmd(new Date(parseYmd(today).getTime() + (days - stage) * 86400000)),
  };
}

module.exports = {
  isYmd, addMonthsClamped, daysBetween, todayInZone, normalizeCadence, normalizeReminderDays,
  scheduleFromBaseline, deriveState, reminderFor, nextReminder,
};

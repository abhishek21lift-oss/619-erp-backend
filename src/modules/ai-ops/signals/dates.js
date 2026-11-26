'use strict';

// Date helpers shared by signal collectors. Everything works on YMD strings
// from the database (`::TEXT` casts) and UTC midnights, so a server in any
// timezone counts the same days as the studio.

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isYmd(value) {
  if (typeof value !== 'string' || !YMD.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function utcDay(value) {
  if (isYmd(value)) return Date.parse(`${value}T00:00:00.000Z`);
  if (value instanceof Date) {
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dayDiff(fromYmd, toYmd) {
  const from = utcDay(fromYmd);
  const to = utcDay(toYmd);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86400000);
}

function formatDay(ymd) {
  if (!isYmd(ymd)) return null;
  const date = new Date(`${ymd}T00:00:00.000Z`);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function addDays(ymd, days) {
  const base = utcDay(ymd);
  if (base === null) return null;
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

module.exports = { isYmd, dayDiff, formatDay, addDays };

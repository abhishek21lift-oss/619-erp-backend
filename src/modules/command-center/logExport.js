'use strict';
// The durable error log, as a file.
//
// The History tab pages because a screen is a bad place to read twenty thousand
// lines. An operator handing an incident to somebody else — or diffing two
// failures — needs the window itself, and this module builds it.
//
// ── Two things a CSV of log messages must get right ────────────────────────
//
//   1. Injection. A message can begin with `=` and be opened in Excel, where it
//      becomes a formula. The log is written by our own code, but it carries
//      attacker-influenced strings (emails, names, query values), so this is a
//      trust boundary and not a formality.
//   2. Disclosure of the cap. A silently truncated incident is worse than a
//      large file, because the half that is missing is the half nobody knows to
//      ask for.
//
// The query is newest-first with a LIMIT so the cap drops the OLDEST rows; the
// file is then reversed so it reads in the order things happened.

const pool = require('../../db/pool');

const MAX_ROWS = 20_000;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 720;

/** Excel, LibreOffice and Sheets all evaluate a cell that starts with these. */
const RISKY_LEAD = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (RISKY_LEAD.test(s)) s = `'${s}`;
  // RFC 4180: quote when the value contains a delimiter, a quote or a newline,
  // and double the quotes inside it.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = ['time', 'level', 'level_label', 'source', 'hostname', 'pid', 'message', 'context'];

async function build({ hours, minLevel, source, q } = {}) {
  const windowHours = Math.min(Math.max(Number(hours) || DEFAULT_HOURS, 1), MAX_HOURS);

  const where = ['level >= $1', `logged_at > NOW() - ($2 || ' hours')::interval`];
  const params = [minLevel, String(windowHours)];

  if (source === 'api' || source === 'worker') {
    params.push(source);
    where.push(`source = $${params.length}`);
  }
  if (q) {
    params.push(`%${String(q)}%`);
    where.push(`msg ILIKE $${params.length}`);
  }
  params.push(MAX_ROWS);

  const { rows } = await pool.query(
    `SELECT logged_at, level, level_label, source, hostname, pid, msg, context
       FROM system_logs
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT $${params.length}`,
    params,
  );

  const lines = [
    HEADER.join(','),
    ...rows.reverse().map((row) => [
      row.logged_at instanceof Date ? row.logged_at.toISOString() : row.logged_at,
      row.level,
      row.level_label ?? row.level,
      row.source,
      row.hostname,
      row.pid,
      row.msg,
      row.context == null ? '' : JSON.stringify(row.context),
    ].map(cell).join(',')),
  ];

  return {
    csv: `${lines.join('\r\n')}\r\n`,
    row_count: rows.length,
    truncated: rows.length === MAX_ROWS,
    window_hours: windowHours,
    filename: `command-center-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
  };
}

module.exports = { build, cell, MAX_ROWS, DEFAULT_HOURS, MAX_HOURS };

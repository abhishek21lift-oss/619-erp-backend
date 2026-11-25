'use strict';

// A no-show is worth a check-in, but only while it is fresh and only once per
// client. The SQL returns the latest no-show per client; the mapper repeats
// that guard so a caller cannot accidentally double-emit.

const pool = require('../../../db/pool');
const { dayDiff, formatDay } = require('./dates');

const WINDOW_DAYS = 14;

function reasonsFromNoShows(rows, today) {
  const latest = new Map();
  for (const row of rows || []) {
    if (!row || !row.client_id || !row.session_date) continue;
    const current = latest.get(row.client_id);
    if (!current || row.session_date > current.session_date) latest.set(row.client_id, row);
  }

  const out = [];
  for (const row of latest.values()) {
    const days = dayDiff(row.session_date, today);
    if (days === null || days < 0 || days > WINDOW_DAYS) continue;
    out.push({
      subject: { type: 'client', id: row.client_id, name: row.name, photo_url: row.photo_url ?? null },
      reason: {
        code: 'no_show_recent',
        label: `No-show on ${formatDay(row.session_date)}`,
        evidence: { session_id: row.session_id, session_date: row.session_date },
        due_at: null,
      },
    });
  }
  return out;
}

async function collect({ orgId, today }) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.id)
            s.id AS session_id,
            s.session_date::TEXT AS session_date,
            c.id AS client_id, c.name, c.photo_url
       FROM pt_sessions s
       JOIN pt_clients c ON c.id = s.client_id
      WHERE s.organization_id = $1
        AND c.organization_id = $1
        AND c.deleted_at IS NULL
        AND s.deleted_at IS NULL
        AND s.status = 'no_show'
        AND s.session_date >= CURRENT_DATE - INTERVAL '14 days'
      ORDER BY c.id, s.session_date DESC, s.id DESC`,
    [orgId],
  );
  return reasonsFromNoShows(rows, today);
}

module.exports = { collect, reasonsFromNoShows, WINDOW_DAYS };

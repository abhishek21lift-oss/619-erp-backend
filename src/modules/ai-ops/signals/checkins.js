'use strict';

// Weekly check-ins are the cheapest engagement signal the studio already
// collects. The reference date is the last check-in, or the client's creation
// date when they have never checked in, so a brand-new client is not chased on
// day one.

const pool = require('../../../db/pool');
const { dayDiff } = require('./dates');

function ymd(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function reasonsFromCheckins(rows, today) {
  const out = [];
  for (const row of rows || []) {
    if (!row || !row.client_id) continue;
    const last = ymd(row.last_checkin);
    const reference = last || ymd(row.created_at);
    if (!reference) continue;

    const days = dayDiff(reference, today);
    if (days === null || days < 0) continue;

    let code = null;
    if (days >= 14) code = 'checkin_missing_14';
    else if (days >= 7) code = 'checkin_missing_7';
    if (!code) continue;

    out.push({
      subject: { type: 'client', id: row.client_id, name: row.name, photo_url: row.photo_url ?? null },
      reason: {
        code,
        label: last ? `No check-in for ${days} days` : 'No check-in yet',
        evidence: { last_checkin: last },
        due_at: null,
      },
    });
  }
  return out;
}

async function collect({ orgId, today }) {
  const { rows } = await pool.query(
    `SELECT c.id AS client_id, c.name, c.photo_url,
            c.created_at::TEXT AS created_at,
            MAX(w.week_start_date)::TEXT AS last_checkin
       FROM pt_clients c
       LEFT JOIN weekly_checkins w
         ON w.client_id = c.id AND w.organization_id = c.organization_id
      WHERE c.organization_id = $1
        AND c.deleted_at IS NULL
        AND c.status IN ('active','frozen')
      GROUP BY c.id`,
    [orgId],
  );
  return reasonsFromCheckins(rows, today);
}

module.exports = { collect, reasonsFromCheckins };

'use strict';

// A form check older than a day is work the trainer owes the client. The SQL
// returns the oldest pending check per client; the mapper repeats the guard so
// a reviewed check can never be emitted from a stale row.

const pool = require('../../../db/pool');

const SLA_HOURS = 24;

function reasonsFromFormChecks(rows, today, now = new Date()) {
  const oldest = new Map();
  for (const row of rows || []) {
    if (!row || !row.client_id || !row.form_check_id) continue;
    if (row.form_check_status && row.form_check_status !== 'pending') continue;
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created)) continue;
    const current = oldest.get(row.client_id);
    if (!current || created < Date.parse(current.created_at)) oldest.set(row.client_id, row);
  }

  const out = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  for (const row of oldest.values()) {
    const created = Date.parse(row.created_at);
    const hours = Math.floor((nowMs - created) / 3600000);
    if (!Number.isFinite(hours) || hours < SLA_HOURS) continue;

    out.push({
      subject: { type: 'client', id: row.client_id, name: row.name, photo_url: row.photo_url ?? null },
      reason: {
        code: 'form_check_pending',
        label: `Form check waiting ${hours} hours`,
        evidence: { form_check_id: row.form_check_id, created_at: row.created_at },
        due_at: new Date(created + SLA_HOURS * 3600000).toISOString(),
      },
    });
  }
  return out;
}

async function collect({ orgId, today }) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.id)
            fc.id AS form_check_id, fc.created_at::TEXT AS created_at,
            fc.status AS form_check_status,
            c.id AS client_id, c.name, c.photo_url
       FROM pt_form_checks fc
       JOIN pt_clients c ON c.id = fc.client_id
      WHERE fc.organization_id = $1
        AND c.organization_id = $1
        AND c.deleted_at IS NULL
        AND fc.status = 'pending'
        AND fc.created_at < NOW() - INTERVAL '24 hours'
      ORDER BY c.id, fc.created_at ASC, fc.id ASC`,
    [orgId],
  );
  return reasonsFromFormChecks(rows, today);
}

module.exports = { collect, reasonsFromFormChecks, SLA_HOURS };

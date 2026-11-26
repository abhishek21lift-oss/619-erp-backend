'use strict';

// All SQL for the AI Ops Queue lives here. Two rules are load-bearing:
//   - every tenant-table statement names organization_id and binds it;
//   - UPDATEs build SET from a fixed allow-list, never from a caller-provided
//     column name.
// The service decides *what* to change; this module decides *how* to say it.

const pool = require('../../db/pool');

const ITEM_COLUMNS = new Set([
  'status', 'priority_score', 'priority_band', 'reasons', 'next_due_at',
  'recommended_action', 'draft', 'closed_reasons', 'closed_score',
  'snoozed_until', 'dismissed_reason', 'last_contacted_at', 'last_actioned_at',
  'last_error', 'resolved_at',
]);

function json(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function run(client, sql, params) {
  return client ? client.query(sql, params) : pool.query(sql, params);
}

function patchEntries(patch) {
  return Object.entries(patch || {}).filter(
    ([column, value]) => ITEM_COLUMNS.has(column) && value !== undefined,
  );
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error wins */ }
    throw err;
  } finally {
    client.release();
  }
}

async function orgName(orgId) {
  const { rows } = await pool.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
  return rows[0]?.name ?? null;
}

async function findItems(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM ai_ops_items
      WHERE organization_id = $1
      ORDER BY priority_score DESC, created_at ASC`,
    [orgId],
  );
  return rows;
}

const SUBJECT_SELECT = `
  SELECT i.*,
         CASE WHEN i.client_id IS NOT NULL THEN 'client' ELSE 'lead' END AS subject_type,
         COALESCE(c.name, l.name) AS subject_name,
         c.photo_url AS photo_url,
         c.mobile AS mobile,
         c.whatsapp_opt_out AS whatsapp_opt_out,
         l.mobile AS lead_mobile
    FROM ai_ops_items i
    LEFT JOIN pt_clients c
      ON c.id = i.client_id AND c.organization_id = i.organization_id
    LEFT JOIN pt_leads l
      ON l.id = i.lead_id AND l.organization_id = i.organization_id`;

async function findOpenItems(orgId) {
  const { rows } = await pool.query(
    `${SUBJECT_SELECT}
      WHERE i.organization_id = $1 AND i.status = 'open'
      ORDER BY i.priority_score DESC, i.next_due_at ASC NULLS LAST, i.created_at ASC`,
    [orgId],
  );
  return rows;
}

async function findItem(orgId, id) {
  const { rows } = await pool.query(
    `${SUBJECT_SELECT}
      WHERE i.organization_id = $1 AND i.id = $2`,
    [orgId, id],
  );
  return rows[0] || null;
}

async function findEvents(orgId, itemId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, event_type, actor_user_id, actor_role, payload, created_at
       FROM ai_ops_events
      WHERE organization_id = $1 AND item_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [orgId, itemId, limit],
  );
  return rows;
}

async function latestBrief(orgId, todayYmd) {
  const { rows } = await pool.query(
    `SELECT payload, created_at
       FROM ai_ops_events
      WHERE organization_id = $1
        AND event_type = 'brief_generated'
        AND created_at >= $2::date
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId, todayYmd],
  );
  return rows[0] || null;
}

async function latestBriefAt(orgId) {
  const { rows } = await pool.query(
    `SELECT created_at
       FROM ai_ops_events
      WHERE organization_id = $1 AND event_type = 'brief_generated'
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId],
  );
  return rows[0]?.created_at ?? null;
}

async function insertItem(orgId, values) {
  const { rows } = await pool.query(
    `INSERT INTO ai_ops_items
       (organization_id, client_id, lead_id, dedupe_key, status, priority_score,
        priority_band, reasons, next_due_at, recommended_action, draft,
        closed_reasons, closed_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (organization_id, dedupe_key) DO NOTHING
     RETURNING *`,
    [
      orgId, values.client_id ?? null, values.lead_id ?? null, values.dedupe_key,
      values.status ?? 'open', values.priority_score ?? 0, values.priority_band ?? 'low',
      json(values.reasons ?? []), values.next_due_at ?? null,
      json(values.recommended_action ?? null), json(values.draft ?? null),
      json(values.closed_reasons ?? []), values.closed_score ?? 0,
    ],
  );
  return rows[0] || null;
}

async function findByDedupeKey(orgId, dedupeKey) {
  const { rows } = await pool.query(
    'SELECT * FROM ai_ops_items WHERE organization_id = $1 AND dedupe_key = $2',
    [orgId, dedupeKey],
  );
  return rows[0] || null;
}

async function updateItem(orgId, id, expectedStatus, patch) {
  const entries = patchEntries(patch);
  if (!entries.length) return null;

  const sets = entries.map(([column], index) => `${column} = $${index + 4}`);
  const { rows } = await pool.query(
    `UPDATE ai_ops_items
        SET ${sets.join(', ')}
      WHERE organization_id = $1 AND id = $2 AND status = $3
      RETURNING *`,
    [orgId, id, expectedStatus, ...entries.map(([, value]) => value)],
  );
  return rows[0] || null;
}

async function reopenClosedItem(orgId, id, expectedStatus, patch) {
  const entries = patchEntries(patch);
  const sets = ['status = \'open\'', 'resolved_at = NULL', 'snoozed_until = NULL'];
  const params = [orgId, id, expectedStatus];
  for (const [column, value] of entries) {
    if (column === 'status' || column === 'resolved_at' || column === 'snoozed_until') continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  const { rows } = await pool.query(
    `UPDATE ai_ops_items
        SET ${sets.join(', ')}
      WHERE organization_id = $1 AND id = $2 AND status = $3
      RETURNING *`,
    params,
  );
  return rows[0] || null;
}

async function reopenActionedItem(orgId, id, patch) {
  const entries = patchEntries(patch).filter(([column]) => column !== 'status');
  const sets = ['status = \'open\'', 'resolved_at = NULL', 'snoozed_until = NULL'];
  const params = [orgId, id];
  for (const [column, value] of entries) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  const { rows } = await pool.query(
    `UPDATE ai_ops_items
        SET ${sets.join(', ')}
      WHERE organization_id = $1
        AND id = $2
        AND status = 'actioned'
        AND last_actioned_at < NOW() - INTERVAL '7 days'
      RETURNING *`,
    params,
  );
  return rows[0] || null;
}

async function resolveMissingItem(orgId, id) {
  const { rows } = await pool.query(
    `UPDATE ai_ops_items
        SET status = 'resolved', resolved_at = NOW(), snoozed_until = NULL
      WHERE organization_id = $1
        AND id = $2
        AND status IN ('open','snoozed','actioned')
      RETURNING *`,
    [orgId, id],
  );
  return rows[0] || null;
}

async function claimItem(orgId, id, patch, client) {
  const entries = patchEntries(patch);
  if (!entries.length) return null;

  const sets = entries.map(([column], index) => `${column} = $${index + 3}`);
  const { rows } = await run(
    client,
    `UPDATE ai_ops_items
        SET ${sets.join(', ')}
      WHERE organization_id = $1
        AND id = $2
        AND status IN ('open','snoozed')
      RETURNING *`,
    [orgId, id, ...entries.map(([, value]) => value)],
  );
  return rows[0] || null;
}

async function insertEvent(orgId, event, client) {
  const { rows } = await run(
    client,
    `INSERT INTO ai_ops_events
       (organization_id, item_id, event_type, actor_user_id, actor_role, payload)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id`,
    [
      orgId, event.itemId ?? null, event.eventType,
      event.actorUserId ?? null, event.actorRole ?? null, json(event.payload ?? {}),
    ],
  );
  return rows[0]?.id ?? null;
}

async function insertCommunicationLog(orgId, values, client) {
  const { rows } = await run(
    client,
    `INSERT INTO communication_logs
       (organization_id, recipient_type, recipient_id, recipient_name, recipient_phone,
        channel, direction, template, message, status, provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      orgId, values.recipientType, values.recipientId, values.recipientName ?? null,
      values.recipientPhone ?? null, 'whatsapp', 'outgoing', 'ai_ops',
      values.message, 'queued', values.provider ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

async function markCommunicationSent(orgId, id, values) {
  await pool.query(
    `UPDATE communication_logs
        SET status = 'sent', external_id = $3, provider = $4, sent_at = $5
      WHERE organization_id = $1 AND id = $2`,
    [orgId, id, values.external_id ?? null, values.provider ?? null, values.sent_at ?? new Date()],
  );
}

async function markCommunicationFailed(orgId, id, values) {
  await pool.query(
    `UPDATE communication_logs
        SET status = 'failed', failure_reason = $3, provider = $4
      WHERE organization_id = $1 AND id = $2`,
    [orgId, id, values.failure_reason ?? null, values.provider ?? null],
  );
}

async function findClientForSend(orgId, id) {
  const { rows } = await pool.query(
    `SELECT id, name, mobile, whatsapp_opt_out
       FROM pt_clients
      WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [orgId, id],
  );
  return rows[0] || null;
}

async function findLeadForSend(orgId, id) {
  const { rows } = await pool.query(
    `SELECT id, name, mobile
       FROM pt_leads
      WHERE organization_id = $1 AND id = $2`,
    [orgId, id],
  );
  return rows[0] || null;
}

module.exports = {
  withTransaction,
  orgName,
  findItems,
  findOpenItems,
  findItem,
  findEvents,
  latestBrief,
  latestBriefAt,
  insertItem,
  findByDedupeKey,
  updateItem,
  reopenClosedItem,
  reopenActionedItem,
  resolveMissingItem,
  claimItem,
  insertEvent,
  insertCommunicationLog,
  markCommunicationSent,
  markCommunicationFailed,
  findClientForSend,
  findLeadForSend,
};

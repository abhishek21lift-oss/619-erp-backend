'use strict';
// The member's single AI thread.
//
// ── Why one thread, resolved without an id ─────────────────────────────────
//
// The member app has no conversation list: one member, one assistant thread.
// Resolving it from (organization_id, user_id) means the request carries no
// conversation id at all, so there is nothing to tamper with. The partial
// unique index in migration 292 makes that a database guarantee rather than a
// hope: two first messages arriving together cannot create two threads.
//
// ── Why the user turn is written before the model ──────────────────────────
//
// A failed or aborted answer must not lose what the member typed. The caller
// appends the user turn, runs the model, and appends the assistant turn only
// after a complete answer. History is replayed oldest-first and bounded by the
// caller, so a long conversation cannot grow the prompt without limit.

const pool = require('../../db/pool');

const MEMBER_THREAD_SQL = `
  SELECT id FROM ai_conversations
   WHERE organization_id = $1
     AND user_id = $2
     AND context->>'feature' = 'member_ai'
   ORDER BY updated_at DESC
   LIMIT 1`;

/** The member's thread id, or null when they have never chatted. */
async function findThread(orgId, userId) {
  const { rows } = await pool.query(MEMBER_THREAD_SQL, [orgId, userId]);
  return rows[0]?.id ?? null;
}

/**
 * Resolve or create the member's thread.
 *
 * The insert uses `ON CONFLICT DO NOTHING` with no target so it tolerates any
 * unique violation, including the partial index. Losing that race is normal:
 * the winner's row is then read back by the second select.
 */
async function ensureThread(orgId, userId, clientId, title) {
  const existing = await findThread(orgId, userId);
  if (existing) return existing;

  const inserted = await pool.query(
    `INSERT INTO ai_conversations (user_id, client_id, title, organization_id, context)
     VALUES ($1, $2, $3, $4, '{"feature":"member_ai"}'::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, clientId, title, orgId],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  return findThread(orgId, userId);
}

/**
 * The newest `limit` turns, oldest-first for the model.
 *
 * The query walks backwards so the index does the bounding; the reverse in JS
 * turns the result into conversation order. `id` is the tie-breaker because
 * two turns can share a timestamp at millisecond resolution.
 */
async function recentMessages(conversationId, limit) {
  const { rows } = await pool.query(
    `SELECT role, content, created_at
       FROM ai_messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

/** Append one turn and bump the thread so retention sees activity. */
async function appendMessage(conversationId, role, content) {
  await pool.query(
    `INSERT INTO ai_messages (conversation_id, role, content)
     VALUES ($1, $2, $3)`,
    [conversationId, role, content],
  );
  await pool.query(
    'UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1',
    [conversationId],
  );
}

/**
 * Delete this member's turns, keeping the conversation row.
 *
 * Scoped by the same (organization_id, user_id) pair that resolves the thread,
 * so a caller can never clear somebody else's history by supplying an id.
 */
async function clearHistory(orgId, userId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ai_messages
      WHERE conversation_id IN (
        SELECT id FROM ai_conversations
         WHERE organization_id = $1
           AND user_id = $2
           AND context->>'feature' = 'member_ai')`,
    [orgId, userId],
  );
  return rowCount || 0;
}

module.exports = {
  ensureThread,
  findThread,
  recentMessages,
  appendMessage,
  clearHistory,
};

// src/lib/ai/retention.js
//
// Delete AI conversations past their retention window.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Nothing ever deleted from ai_conversations. Every chat turn inserts rows and
// every generator opens one, and ai_messages cascades from it — so the table
// and every client detail quoted inside it grew forever. That is a privacy
// problem, not only a storage one: the text includes injuries, PAR-Q answers,
// weights and payment figures, and there was no way for a studio to have an
// old conversation removed short of a manual DELETE.
//
// ── Why deleting is safe ───────────────────────────────────────────────────
//
// Nothing reads a conversation except the AI Coach history list, which is
// already ordered by recency and windowed in the UI. Cost and quota live in
// ai_usage_log — a separate table this sweep never touches — so pruning
// conversations cannot change any billing figure.
//
// ── The window ─────────────────────────────────────────────────────────────
//
// ai_conversations.updated_at is bumped on every turn, so the window measures
// IDLE age, not age since creation: a conversation still in use is never
// pruned. 180 days keeps half a year of coaching history and is generous for a
// feature whose value is mostly the current block.

'use strict';

const pool = require('../../db/pool');
const logger = require('../logger');

const DEFAULT_RETENTION_DAYS = 180;

// Bounds one sweep. A database that has never been pruned has a backlog, and an
// unbounded DELETE would hold row locks across the table in one statement.
// Hourly sweeps drain it in small steps — the same reasoning as
// lib/refreshTokenRetention.js.
const DEFAULT_BATCH = 1000;

/**
 * Delete conversations idle for longer than the retention window.
 *
 * Never throws: this runs on a timer with no caller to handle a rejection.
 *
 * @returns {Promise<number>} conversations removed this sweep.
 */
async function prune({ days, batch } = {}) {
  // Parsed explicitly rather than with `Number(x) || DEFAULT`, which treats 0
  // as "unset". The floor of 1 is load-bearing: a negative window inverts the
  // comparison and would delete LIVE conversations.
  const configured = days ?? process.env.AI_CONVERSATION_RETENTION_DAYS;
  const parsed = Number(configured);
  const retentionDays = Math.max(
    1,
    configured === undefined || configured === null || configured === '' || Number.isNaN(parsed)
      ? DEFAULT_RETENTION_DAYS
      : Math.trunc(parsed)
  );

  const parsedBatch = Number(batch);
  const limit = Math.max(1, Number.isNaN(parsedBatch) || !batch ? DEFAULT_BATCH : Math.trunc(parsedBatch));

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ai_conversations
        WHERE id IN (
          SELECT id FROM ai_conversations
           WHERE updated_at < NOW() - ($1 || ' days')::interval
           LIMIT $2
        )`,
      [String(retentionDays), limit]
    );
    const removed = rowCount ?? 0;
    if (removed > 0) {
      logger.info({ removed, retentionDays }, 'ai conversation retention sweep');
    }
    return removed;
  } catch (err) {
    logger.warn({ err: err.message }, 'ai conversation retention sweep failed');
    return 0;
  }
}

/**
 * Remove every conversation recorded against one client.
 *
 * Exported for an explicit erasure flow (a studio purging a client at their
 * request). Deliberately NOT called from the archive path: archiving a client
 * is reversible, and silently destroying the trainer's notes would be a worse
 * surprise than keeping them until the retention window closes.
 *
 * @returns {Promise<number>} conversations removed.
 */
async function purgeForClient(clientId) {
  if (!clientId) return 0;
  const { rowCount } = await pool.query(
    'DELETE FROM ai_conversations WHERE client_id = $1',
    [String(clientId)]
  );
  const removed = rowCount ?? 0;
  if (removed > 0) logger.info({ removed, clientId }, 'ai conversations purged for client');
  return removed;
}

module.exports = { prune, purgeForClient, DEFAULT_RETENTION_DAYS, DEFAULT_BATCH };

// src/lib/whatsappWebhookRetention.js
//
// Delete WhatsApp webhook ledger rows past their retention window.
//
// whatsapp_webhook_events is the idempotency ledger for the gateway webhook:
// every verified event is claimed there under a unique event_id, and a
// redelivery is answered "duplicate" without being applied. The gateway's
// outbox retries six times with exponential backoff (max 64s), so a
// redelivery arrives within minutes, not months. Nothing ever deleted a row,
// though, so the table kept every event the product has ever received.
//
// ── Why deleting old rows is safe ──────────────────────────────────────────
//
// Past the window a redelivery is no longer possible: the outbox is bounded
// and its retry schedule is minutes. Even if a very old event were replayed,
// the handlers are monotonic — instance updates carry the last_event_at guard
// and message receipts only move forward — so it would change nothing. The
// rows are diagnosis history, and 30 days matches LOG_RETENTION_DAYS.
//
// Hourly, bounded batches, never throws: the same shape as
// refreshTokenRetention, for the same reasons.

'use strict';

const pool = require('../db/pool');
const logger = require('./logger');

const DEFAULT_RETENTION_DAYS = 30;

// Bounds one sweep. A database that has never been pruned has a backlog, and
// an unbounded DELETE would take row locks across the whole table in a single
// statement. Hourly sweeps drain it while each statement stays small.
const DEFAULT_BATCH = 5000;

/**
 * Delete ledger rows older than the retention window.
 *
 * Never throws: this runs on a timer with no caller to handle a rejection, and
 * a failure to prune is not a reason to take the process down.
 *
 * @returns {Promise<number>} rows removed this sweep.
 */
async function prune({ days, batch } = {}) {
  // Parsed explicitly rather than with `Number(x) || DEFAULT`, which treats 0
  // as "unset" and silently substitutes the default.
  //
  // The floor of 1 is the part that matters for safety. A negative window
  // inverts the comparison: `NOW() - '-5 days'::interval` is NOW() PLUS five
  // days, so the DELETE would match events that have not arrived yet — the
  // ledger stops deduplicating and every redelivery is applied again.
  const configured = days ?? process.env.WA_WEBHOOK_EVENT_RETENTION_DAYS;
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
      `DELETE FROM whatsapp_webhook_events
        WHERE event_id IN (
          SELECT event_id FROM whatsapp_webhook_events
           WHERE received_at < NOW() - ($1 || ' days')::interval
           LIMIT $2
        )`,
      [String(retentionDays), limit]
    );
    const removed = rowCount ?? 0;
    if (removed > 0) {
      logger.info({ removed, retentionDays }, 'whatsapp webhook retention sweep');
    }
    return removed;
  } catch (err) {
    logger.warn({ err: err.message }, 'whatsapp webhook retention sweep failed');
    return 0;
  }
}

module.exports = { prune, DEFAULT_RETENTION_DAYS, DEFAULT_BATCH };

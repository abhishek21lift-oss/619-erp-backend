'use strict';
// The once-a-day nudge for feedback that is still pending.
//
// The request is created the moment the trainer marks the session completed,
// and the client is notified then. Most people answer within a day; this sweep
// is for the ones who did not. One reminder per request, ever — the
// notification's (user_id, type, ref_id) check is the dedupe, so running the
// sweep hourly or twice after a redeploy still sends one.
//
// A client who never activated a login has no user row; pendingOlderThan's
// LEFT JOIN yields no user_id and that request is skipped, not sent to a
// guessed address.

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const feedback = require('./feedback.service');

const REMIND_AFTER_HOURS = 24;

async function runFeedbackReminders() {
  let rows;
  try {
    rows = await feedback.pendingOlderThan(REMIND_AFTER_HOURS);
  } catch (err) {
    logger.error({ err: err.message }, 'feedback reminder scan failed');
    throw err;
  }

  let sent = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const created = await feedback.remind(pool, row);
      if (created) sent += 1;
      else skipped += 1;
    } catch (err) {
      // One bad row must not stop the rest of the sweep.
      skipped += 1;
      logger.warn({ err: err.message, feedbackId: row.id }, 'feedback reminder failed');
    }
  }

  return { scanned: rows.length, sent, skipped };
}

module.exports = { runFeedbackReminders, REMIND_AFTER_HOURS };

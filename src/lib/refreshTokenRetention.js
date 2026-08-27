// src/lib/refreshTokenRetention.js
//
// Delete refresh tokens that are dead and past their retention window.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Nothing ever deleted from refresh_tokens. Every sign-in inserts a row, and
// every /auth/refresh rotates — revoking the old row and inserting a new one —
// so the table grows once per refresh, forever. Measured on production before
// this was written:
//
//     4,914 rows, 4,885 of them dead (4,239 expired, 4,470 revoked), 8 users,
//     oldest 2026-06-25
//
// 99.4% of the table was rows that nothing would ever read again, accumulated
// in two months by eight accounts. The growth is per-refresh, not per-user, so
// it does not level off: a thousand active users would add hundreds of
// thousands of rows a month to a table every sign-in and every refresh reads.
//
// ── Why deleting them is safe ──────────────────────────────────────────────
//
// Two things had to be true, and both were checked rather than assumed:
//
// 1. Nothing reads a dead row. All three readers — super-admin security,
//    the Command Centre security collector, and the per-user session count —
//    filter on `revoked_at IS NULL AND expires_at > now()`. So does the
//    refresh path itself. Pruning changes no number any of them report.
//
// 2. There is no refresh-token reuse detection to break. /auth/refresh
//    rotates (revoke old, issue new) but does not treat the replay of a
//    revoked token as a signal to kill the session family — a replayed token
//    simply fails the `revoked_at IS NULL` check and 401s. Implementations
//    that DO detect reuse must retain revoked rows to do it; this one does
//    not, so retention buys nothing there. If reuse detection is added later,
//    raise the window rather than removing this sweep, and note that the
//    window bounds how far back detection can see.
//
// ── The window ─────────────────────────────────────────────────────────────
//
// A refresh token's own TTL is 7 days (REFRESH_TOKEN_TTL_MS in routes/auth.js),
// so a row is dead at most 7 days after it was issued. The default keeps dead
// rows a further 7 days — enough to investigate last week's incident, and it
// caps the table at roughly "live tokens plus one week" instead of unbounded.
// Matching LOG_RETENTION_DAYS' 30 would keep four times more for no use.

'use strict';

const pool = require('../db/pool');
const logger = require('./logger');

const DEFAULT_RETENTION_DAYS = 7;

// Bounds one sweep. The first run on a database that has never been pruned has
// a large backlog, and an unbounded DELETE would take row locks across the
// whole table in a single statement. Hourly sweeps drain a backlog quickly
// while each individual statement stays small — the same reasoning behind
// logCapture's hourly rather than daily schedule.
const DEFAULT_BATCH = 5000;

/**
 * Delete dead refresh tokens older than the retention window.
 *
 * Never throws: this runs on a timer with no caller to handle a rejection, and
 * a failure to prune is not a reason to take the process down.
 *
 * @returns {Promise<number>} rows removed this sweep.
 */
async function prune({ days, batch } = {}) {
  // Parsed explicitly rather than with `Number(x) || DEFAULT`, which treats 0
  // as "unset" and silently substitutes the default — an operator who sets the
  // window to 0 should not quietly get 7.
  //
  // The floor of 1 is the part that matters for safety. A negative window
  // inverts the comparison: `NOW() - '-5 days'::interval` is NOW() PLUS five
  // days, so the DELETE would match tokens that expire within the next five
  // days — live sessions. Clamping means no configuration value, however
  // malformed, can widen this sweep beyond rows that are already dead.
  const configured = days ?? process.env.REFRESH_TOKEN_RETENTION_DAYS;
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
    // A row qualifies once it is dead AND has been dead for the window.
    // revoked_at is checked against its own timestamp rather than expires_at:
    // a token revoked on day 1 of a 7-day TTL is dead immediately, and waiting
    // for its nominal expiry would keep it around six days longer for nothing.
    const { rowCount } = await pool.query(
      `DELETE FROM refresh_tokens
        WHERE id IN (
          SELECT id FROM refresh_tokens
           WHERE expires_at < NOW() - ($1 || ' days')::interval
              OR (revoked_at IS NOT NULL
                  AND revoked_at < NOW() - ($1 || ' days')::interval)
           LIMIT $2
        )`,
      [String(retentionDays), limit]
    );
    const removed = rowCount ?? 0;
    if (removed > 0) {
      logger.info({ removed, retentionDays }, 'refresh token retention sweep');
    }
    return removed;
  } catch (err) {
    logger.warn({ err: err.message }, 'refresh token retention sweep failed');
    return 0;
  }
}

module.exports = { prune, DEFAULT_RETENTION_DAYS, DEFAULT_BATCH };

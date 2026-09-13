// src/modules/command-center/alerts.service.js
//
// Turns a stream of collector observations into a small number of alerts with
// a lifetime.
//
// ── The problem this solves is noise, not detection ─────────────────────────
//
// The collectors already detect. Each grades itself and writes a sentence
// explaining any non-green status, and Phase 2 spent its effort on making those
// grades honest. So the tempting version of this file is four lines: on every
// tick, insert a row for every card that is not healthy.
//
// That version is worse than nothing. SMTP on this platform has been broken
// continuously since launch. At a 60s tick it would produce 1,440 identical
// rows a day, the Alert Center would open on a wall of them, and an operator
// would stop reading it inside a week — taking the genuine alerts with it.
//
// So everything here is about the LIFECYCLE:
//
//   dedup      one live alert per condition, enforced by a partial unique index
//              rather than by remembering to check first (migration 150)
//   damping    a condition must persist before it opens, and clear before it
//              closes, so a metric sitting on a threshold does not flap
//   escalation warning -> critical updates the alert and re-announces; the
//              reverse updates quietly
//   auto-close a condition that fixes itself closes itself, marked `auto`
//   notify-once  a column, not a promise
//
// ── unavailable is not an alert ─────────────────────────────────────────────
//
// Same rule the console renders by: `unavailable` means the probe could not run
// (Redis not configured, no Docker socket), which is a gap in observability,
// not an outage. Alerting on it would page someone about a box that was never
// wired up. Only warning, timeout and critical open alerts.
'use strict';

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { logActivity } = require('../../lib/activityLog');
const { STATUS } = require('./registry');
const snapshot = require('./snapshot.service');

/** Statuses that constitute a problem. Deliberately excludes UNAVAILABLE. */
const ALERTING = new Set([STATUS.WARNING, STATUS.TIMEOUT, STATUS.CRITICAL]);

/** Ranked so an escalation can be told from a de-escalation. */
const SEVERITY_RANK = { warning: 1, timeout: 2, critical: 3 };

/**
 * Flap damping.
 *
 * Asymmetric on purpose. Opening is cheap to delay by one tick and expensive to
 * get wrong (a 3s probe timeout during a deploy is not an incident). Closing
 * wants more evidence than opening, because an alert that closes on the first
 * green reading and reopens on the next is worse than one that lingers a
 * minute — it re-notifies each time.
 */
const CONSECUTIVE_TO_OPEN = 2;
const CONSECUTIVE_TO_CLEAR = 3;

/**
 * Consecutive-observation counters, per fingerprint: { bad, good }.
 *
 * In memory rather than in the table because this is transient observation
 * state, not history — and losing it on restart is correct, not a bug: a fresh
 * process has made no observations. Open alerts live in Postgres and survive.
 */
const streaks = new Map();

function streakFor(fp) {
  let s = streaks.get(fp);
  if (!s) { s = { bad: 0, good: 0 }; streaks.set(fp, s); }
  return s;
}

/** Human titles. Falls back to the collector name for one registered later. */
const TITLES = {
  runtime: 'Runtime under pressure',
  database: 'Database problem',
  redis: 'Redis problem',
  queues: 'Job queue problem',
  http: 'API requests degraded',
  ai: 'AI routing problem',
  security: 'Security posture problem',
  smtp: 'Email delivery problem',
};

function titleFor(source) {
  return TITLES[source] ?? `${source} problem`;
}

// ── Channels ────────────────────────────────────────────────────────────────

/**
 * Announce an alert.
 *
 * ── The rule that shapes this function ──────────────────────────────────────
 *
 * A channel must never be used to deliver an alert about that channel's own
 * subsystem. Emailing "SMTP is down" is not merely futile — the send fails, and
 * on a platform where a failed send is itself observable it can feed the very
 * condition it was reporting.
 *
 * So in-app is the primary channel and is always attempted: it is a single
 * INSERT on the same pool everything else already needs, so it works whenever
 * anything works, and if Postgres is gone no alerting mechanism would have
 * helped. Email is best-effort on top, and is skipped for smtp alerts.
 *
 * Never throws. A channel failure must not roll back the alert — the row in the
 * table is the durable record, and the console reads it regardless.
 */
async function notify(alert) {
  const results = { inapp: 0, email: 'skipped' };

  try {
    // Every active platform operator. Same lookup the subscription paths use.
    const { rows } = await pool.query(
      `SELECT id FROM users
        WHERE role = 'super_admin' AND is_active = TRUE AND deleted_at IS NULL`,
    );
    for (const u of rows) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, ref_id, link)
         VALUES ($1, 'system_alert', $2, $3, $4, '/platform')`,
        [u.id, alert.title, alert.reason, alert.id],
      );
      results.inapp += 1;
    }
  } catch (err) {
    logger.warn({ err: err.message, alert: alert.id }, 'alert in-app notify failed');
  }

  // The self-reference guard. An alert ABOUT mail does not go BY mail.
  if (alert.source === 'smtp') {
    results.email = 'suppressed: the alert is about email delivery';
    return results;
  }

  try {
    const email = require('../../lib/email');
    if (!email.isConfigured()) {
      results.email = 'not configured';
      return results;
    }
    const { rows } = await pool.query(
      `SELECT email FROM users
        WHERE role = 'super_admin' AND is_active = TRUE AND deleted_at IS NULL
          AND email IS NOT NULL`,
    );
    for (const u of rows) {
      await email.sendRaw(
        {
          to: u.email,
          subject: `[${alert.severity.toUpperCase()}] ${alert.title}`,
          html: `<p><strong>${alert.title}</strong></p><p>${alert.reason ?? ''}</p>`
            + `<p>Source: ${alert.source}</p>`,
        },
        { to: u.email, subject: alert.title, kind: 'system_alert' },
      );
    }
    results.email = `sent to ${rows.length}`;
  } catch (err) {
    // Expected on this deployment today — SMTP has never delivered. Warn, do
    // not fail: the in-app notification already landed.
    logger.warn({ err: err.message, alert: alert.id }, 'alert email notify failed');
    results.email = `failed: ${err.message}`;
  }

  return results;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Resolve the live alert for a fingerprint, if there is one.
 * @returns the resolved row, or null when there was nothing open.
 */
async function autoResolve(fingerprint) {
  const { rows } = await pool.query(
    `UPDATE system_alerts
        SET status = 'resolved', resolved_at = NOW(), resolution = 'auto'
      WHERE fingerprint = $1 AND status <> 'resolved'
      RETURNING *`,
    [fingerprint],
  );
  return rows[0] ?? null;
}

/**
 * Claim the right to announce an alert, atomically.
 *
 * ── The race this closes ───────────────────────────────────────────────────
 *
 * The old sequence was read, act, stamp:
 *
 *     SELECT notified_at ...            -- both passes see NULL
 *     await notify(row)                 -- both email every super admin
 *     UPDATE SET notified_at = NOW()    -- both stamp it, second is a no-op
 *
 * and there are three callers who can be in it at once: the 60s interval in
 * server.js, an operator pressing "Evaluate alerts now", and — once a second
 * API instance exists — the other container's interval. The window is not
 * narrow, either: `notify` writes one row per super admin and then opens an
 * SMTP connection per super admin, so the read-to-stamp gap is however long
 * the mail provider takes.
 *
 * The comment in server.js says overlapping ticks are safe because migration
 * 150's partial unique index cannot double-OPEN an alert. That is true, and it
 * is about a different column. Nothing made the ANNOUNCEMENT once-only.
 *
 * A conditional UPDATE is the fix, and it is the whole fix: Postgres takes a
 * row lock, so exactly one of any number of concurrent passes sees
 * `notified_at IS NULL` still true and gets a row back. The losers get zero
 * rows and say nothing.
 *
 * ── Claim-then-send, deliberately ──────────────────────────────────────────
 *
 * The stamp is written BEFORE the channels are attempted, which makes this
 * at-most-once rather than at-least-once. If the process dies between the
 * claim and the send, that alert is never announced.
 *
 * That is the right way round for this system. `notify` never throws — a
 * failed channel is already logged and recorded — and the alert row itself is
 * durable and on screen in the Alert Center regardless. So the cost of a lost
 * announcement is one missed email about a condition the console is already
 * showing; the cost of a duplicate is every platform operator being paged
 * twice for one incident, which is how people start filtering the alerts.
 *
 * @returns {Promise<boolean>} true when THIS caller may announce.
 */
async function claimNotification(alertId) {
  try {
    const { rows } = await pool.query(
      `UPDATE system_alerts
          SET notified_at = NOW()
        WHERE id = $1 AND notified_at IS NULL
        RETURNING id`,
      [alertId],
    );
    return rows.length > 0;
  } catch (err) {
    // Failing to claim means NOT announcing. An alert that cannot be stamped
    // would otherwise be announced on every tick for the life of the incident.
    logger.warn({ err: err.message, alert: alertId }, 'alert notification claim failed');
    return false;
  }
}

/**
 * The evaluation currently in flight, if any.
 *
 * Same reasoning as the collector registry: the interval and the operator's
 * "Evaluate alerts now" button can land together, and two passes over the same
 * cards do no useful work the first was not already doing. The claim above
 * makes a concurrent pass SAFE; this makes it unnecessary.
 */
let inflightEvaluation = null;

/**
 * One evaluation pass.
 *
 * Reads the snapshot the console already reads — no second set of probes, and
 * therefore no way for the Alert Center and the cards to disagree about what is
 * happening. Uses the cached snapshot deliberately: TTLs top out at 30s and the
 * tick is 60s, so this costs at most one extra probe per collector per minute.
 *
 * Never throws. It runs on an interval; a rejection would be an unhandled
 * rejection every minute for the life of the process.
 *
 * @returns {Promise<{opened, escalated, ongoing, resolved, evaluated}>}
 */
async function evaluate({ fresh = false } = {}) {
  // A `fresh` caller may not ride a non-fresh pass: "evaluate now" is an
  // operator asking for current readings, and handing them the tick's cached
  // ones would be answering a different question.
  if (inflightEvaluation && !fresh) return inflightEvaluation;

  const run = evaluateOnce({ fresh });
  if (!inflightEvaluation) {
    inflightEvaluation = run;
    const clear = () => { if (inflightEvaluation === run) inflightEvaluation = null; };
    run.then(clear, clear);
  }
  return run;
}

async function evaluateOnce({ fresh = false } = {}) {
  const out = { opened: [], escalated: [], ongoing: 0, resolved: [], evaluated: 0 };

  let snap;
  try {
    snap = await snapshot.collect({ fresh });
  } catch (err) {
    logger.error({ err: err.message }, 'alert evaluation could not collect');
    return out;
  }

  for (const card of Object.values(snap.cards)) {
    out.evaluated += 1;
    const fp = card.name;
    const streak = streakFor(fp);

    if (ALERTING.has(card.status)) {
      streak.good = 0;
      streak.bad += 1;
      if (streak.bad < CONSECUTIVE_TO_OPEN) continue;

      try {
        const before = await pool.query(
          `SELECT id, severity, notified_at FROM system_alerts
            WHERE fingerprint = $1 AND status <> 'resolved'`,
          [fp],
        );
        const prior = before.rows[0] ?? null;
        const escalated = prior
          && (SEVERITY_RANK[card.status] ?? 0) > (SEVERITY_RANK[prior.severity] ?? 0);

        const row = await upsertObservation(card, prior, escalated);

        if (!prior) out.opened.push(row);
        else if (escalated) out.escalated.push(row);
        else out.ongoing += 1;

        // Notify only when the row has never been announced, or an escalation
        // cleared the stamp — and CLAIM the right to do so before doing it.
        if (!row.notified_at && await claimNotification(row.id)) {
          const channels = await notify(row);
          logger.info({ alert: row.id, source: row.source, severity: row.severity, channels },
            'system alert announced');
        }
      } catch (err) {
        logger.error({ err: err.message, source: fp }, 'alert upsert failed');
      }
      continue;
    }

    // Healthy, or unavailable — neither is a problem to alert on.
    streak.bad = 0;
    streak.good += 1;
    if (streak.good < CONSECUTIVE_TO_CLEAR) continue;

    try {
      const closed = await autoResolve(fp);
      if (closed) {
        out.resolved.push(closed);
        logger.info({ alert: closed.id, source: fp }, 'system alert auto-resolved');
      }
    } catch (err) {
      logger.error({ err: err.message, source: fp }, 'alert auto-resolve failed');
    }
  }

  return out;
}

/**
 * The upsert, split out so `evaluate` can pass the prior severity it just read.
 *
 * Two statements rather than one because "did this escalate" needs the old
 * severity, and the upsert has already overwritten it by the time RETURNING
 * runs. The partial unique index still does the dedup work: the INSERT path
 * cannot double-insert, and the UPDATE path is idempotent.
 */
async function upsertObservation(card, prior, escalated) {
  if (!prior) {
    const { rows } = await pool.query(
      `INSERT INTO system_alerts (fingerprint, source, severity, title, reason, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (fingerprint) WHERE status <> 'resolved'
       DO UPDATE SET last_seen_at = NOW(),
                     occurrences  = system_alerts.occurrences + 1,
                     reason       = EXCLUDED.reason
       RETURNING *`,
      [card.name, card.name, card.status, titleFor(card.name), card.reason, JSON.stringify(card)],
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `UPDATE system_alerts
        SET last_seen_at = NOW(),
            occurrences  = occurrences + 1,
            reason       = $2,
            severity     = $3,
            notified_at  = CASE WHEN $4::boolean THEN NULL ELSE notified_at END
      WHERE id = $1
      RETURNING *`,
    [prior.id, card.reason, card.status, Boolean(escalated)],
  );
  return rows[0];
}

// ── Reads and the human lifecycle ───────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {'live'|'resolved'|'all'} [opts.scope='live']
 * @param {number} [opts.limit=100]
 */
async function list({ scope = 'live', limit = 100 } = {}) {
  const where = scope === 'live' ? "WHERE status <> 'resolved'"
    : scope === 'resolved' ? "WHERE status = 'resolved'"
      : '';
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);

  const { rows } = await pool.query(
    `SELECT * FROM system_alerts
       ${where}
     ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'timeout' THEN 1 ELSE 2 END,
       last_seen_at DESC
     LIMIT $1`,
    [capped],
  );

  // ::int on every count, deliberately. COUNT() is bigint, and node-postgres
  // hands bigint back as a STRING to avoid silent precision loss. Without the
  // cast the badge renders "0" as truthy-looking text and every numeric
  // comparison in the client is a string comparison. There will never be two
  // billion open alerts.
  //
  // TWO statements, not one. The counters split cleanly into "alerts that are
  // not resolved" and "alerts resolved in the last day", and each half has an
  // index that answers it outright:
  //
  //     live      system_alerts_live_fingerprint_unique      5 buffers  0.2 ms
  //     resolved  system_alerts_resolved_recent_idx (178)
  //
  // Written as ONE query with `status <> 'resolved' OR resolved_at > …` it is
  // worse than either half and worse than the bug: an OR across two columns
  // cannot use either index, so the planner falls back to the sequential scan
  // the bound was meant to remove. That was measured at 194ms against 2,360
  // rows, versus 388 buffers for the unbounded original. The bound has to be
  // one the index can express, or it is just a slower way to read everything.
  //
  // What was wrong: this aggregate had no WHERE clause at all. Three of its
  // four counters describe live alerts and the fourth says "24 hours" in its
  // own name, yet the scan behind them walked every alert ever raised. The
  // LIMIT above bounds the ROWS; it never bounded this.
  //
  // `status <> 'resolved'` is deliberately left unqualified by time. An alert
  // open for six months is exactly the one an operator must still see counted,
  // so that arm is bounded by the workflow — someone resolves it — rather than
  // by the clock.
  const { rows: live } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open')::int              AS open,
       COUNT(*) FILTER (WHERE status = 'acknowledged')::int      AS acknowledged,
       COUNT(*) FILTER (WHERE severity = 'critical')::int        AS critical
     FROM system_alerts
     WHERE status <> 'resolved'`,
  );

  const { rows: recent } = await pool.query(
    `SELECT COUNT(*)::int AS resolved_24h
       FROM system_alerts
      WHERE status = 'resolved'
        AND resolved_at > NOW() - INTERVAL '24 hours'`,
  );

  return { alerts: rows, stats: { ...live[0], ...recent[0] } };
}

/**
 * Acknowledge: a human has seen it and is dealing with it.
 *
 * Deliberately does NOT stop the alert tracking the condition. Acknowledging is
 * a statement about the operator, not about the system — occurrences keep
 * counting and auto-resolve still applies, so an acknowledged alert that fixes
 * itself still closes itself.
 */
async function acknowledge(id, req) {
  const { rows } = await pool.query(
    `UPDATE system_alerts
        SET status = 'acknowledged',
            acknowledged_at = NOW(),
            acknowledged_by = $2,
            acknowledged_by_name = $3
      WHERE id = $1 AND status = 'open'
      RETURNING *`,
    [id, req.user?.id ?? null, req.user?.name ?? null],
  );
  if (!rows[0]) {
    const err = new Error('No open alert with that id');
    err.status = 404;
    throw err;
  }
  await logActivity(req, 'command_center.alert.acknowledge', 'system_alert', id, {
    source: rows[0].source, severity: rows[0].severity,
  }).catch(() => {});
  return rows[0];
}

/** Close by hand. Recorded as `manual` so it can be told from a self-fix. */
async function resolve(id, req) {
  const { rows } = await pool.query(
    `UPDATE system_alerts
        SET status = 'resolved', resolved_at = NOW(), resolution = 'manual'
      WHERE id = $1 AND status <> 'resolved'
      RETURNING *`,
    [id],
  );
  if (!rows[0]) {
    const err = new Error('No live alert with that id');
    err.status = 404;
    throw err;
  }
  // The condition may still be true — a manual resolve does not fix anything.
  // Clearing the streak means the next bad observation starts counting from
  // zero and re-opens honestly, rather than the alert springing back instantly.
  streaks.delete(rows[0].fingerprint);

  await logActivity(req, 'command_center.alert.resolve', 'system_alert', id, {
    source: rows[0].source, severity: rows[0].severity, occurrences: rows[0].occurrences,
  }).catch(() => {});
  return rows[0];
}

/** Tests only. */
function _resetStreaks() { streaks.clear(); }

module.exports = {
  evaluate, list, acknowledge, resolve, notify, claimNotification,
  ALERTING, CONSECUTIVE_TO_OPEN, CONSECUTIVE_TO_CLEAR, SEVERITY_RANK, titleFor,
  _resetStreaks,
};

'use strict';
// Post-session feedback: one request per completed PT session.
//
// Identity rules, same shape as client-portal:
//   · the member's client id and organization come from req.user, never the
//     request;
//   · every studio query names organization_id, so a filter cannot widen it;
//   · only the owning client can turn a pending row into a submitted one, and
//     the UPDATE's `status = 'pending'` decides the race.
//
// Aggregates read submitted rows only. A pending request is not a bad rating.

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const { scoreFeedback, weightsFromEnv } = require('../../lib/sessionFeedback');

const LOW_RATING = 3;

const LIST_COLUMNS = `
  f.id, f.session_id, f.client_id, f.trainer_id, f.completed_at, f.status,
  f.trainer_behaviour, f.form_technique, f.workout_intensity,
  f.motivation_guidance, f.overall_stars, f.additional_feedback,
  f.score, f.submitted_at,
  s.title AS session_title, s.session_date,
  s.start_time::text AS start_time,
  c.name AS client_name,
  t.name AS trainer_name`;

const FROM_JOINS = `
  FROM pt_session_feedback f
  JOIN pt_sessions s ON s.id = f.session_id
  JOIN pt_clients c ON c.id = f.client_id
  LEFT JOIN trainers t ON t.id = f.trainer_id`;

/**
 * Create the pending request for a completed session.
 *
 * ON CONFLICT is the one-request rule: completion retried, or two completion
 * handlers racing, still leave one row. Returns the row when this call created
 * it, and null when a request already existed — the caller uses that to decide
 * whether to notify.
 */
async function createRequest(db, { orgId, sessionId, clientId, trainerId, completedAt }) {
  const { rows } = await db.query(
    `INSERT INTO pt_session_feedback
       (organization_id, session_id, client_id, trainer_id, completed_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING id, session_id, client_id`,
    [orgId, sessionId, clientId, trainerId || null, completedAt]
  );
  return rows[0] || null;
}

/**
 * The client's in-app "rate this session" notification, once per request.
 *
 * The user row is found from pt_client_id, not passed in: a member account is
 * optional (a client may never have activated a login), and a notification to
 * a guessed user id would be worse than no notification.
 */
async function notifyMemberOfRequest(db, { clientId, orgId, feedbackId, sessionTitle }) {
  const title = 'How was your session?';
  const body = sessionTitle
    ? `Rate "${sessionTitle}" — it takes four taps.`
    : 'Rate your last session — it takes four taps.';
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, type, title, body, ref_id)
     SELECT u.id, 'session_feedback_request', $1, $2, $3
       FROM users u
      WHERE u.pt_client_id = $4 AND u.organization_id = $5
        AND u.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = u.id AND n.type = 'session_feedback_request' AND n.ref_id = $3
        )
     RETURNING id`,
    [title, body, feedbackId, clientId, orgId]
  );
  return rows[0] || null;
}

/** Tell the studio's trainer that a session came in at or below 3/5. */
async function notifyLowRating(db, { orgId, feedbackId, score }) {
  const title = 'Low session rating';
  const body = `A client rated a session ${Number(score).toFixed(2)}/5. Review the feedback and follow up.`;
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, type, title, body, ref_id)
     SELECT u.id, 'session_feedback_low', $1, $2, $3
       FROM users u
      WHERE u.organization_id = $4 AND u.role = 'trainer'
        AND u.is_active = TRUE AND u.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = u.id AND n.type = 'session_feedback_low' AND n.ref_id = $3
        )
     RETURNING id`,
    [title, body, feedbackId, orgId]
  );
  return rows.length;
}

/** The signed-in client's own requests. No client id is accepted from outside. */
async function listForClient({ clientId, orgId, status = 'all' }) {
  const params = [clientId, orgId];
  let statusClause = '';
  if (status !== 'all') {
    params.push(status);
    statusClause = `AND f.status = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS}
     ${FROM_JOINS}
     WHERE f.client_id = $1 AND f.organization_id = $2 ${statusClause}
     ORDER BY (f.status = 'pending') DESC, f.completed_at DESC
     LIMIT 100`,
    params
  );
  return rows;
}

/**
 * Submit the client's answers. Returns `{ row }`, `{ duplicate: true }` or
 * `{ notFound: true }`; the route turns those into 200/409/404.
 */
async function submitFeedback({ feedbackId, clientId, orgId, answers }) {
  const score = scoreFeedback(answers, weightsFromEnv());
  const text = answers.additional_feedback ? String(answers.additional_feedback).trim() || null : null;

  const { rows } = await pool.query(
    `UPDATE pt_session_feedback f
        SET status = 'submitted',
            trainer_behaviour = $4,
            form_technique = $5,
            workout_intensity = $6,
            motivation_guidance = $7,
            overall_stars = $8,
            additional_feedback = $9,
            score = $10,
            submitted_at = NOW(),
            updated_at = NOW()
      WHERE f.id = $1 AND f.client_id = $2 AND f.organization_id = $3
        AND f.status = 'pending'
      RETURNING f.id, f.session_id, f.status, f.score, f.submitted_at`,
    [
      feedbackId, clientId, orgId,
      answers.trainer_behaviour, answers.form_technique, answers.workout_intensity,
      answers.motivation_guidance, answers.overall_stars, text, score,
    ]
  );

  if (!rows[0]) {
    // The UPDATE found nothing. Either the row does not belong to this client
    // (404 — the same answer as "no such request") or it was already
    // submitted (409). The second read is scoped identically, so it cannot
    // disclose another client's row.
    const existing = await pool.query(
      `SELECT status FROM pt_session_feedback
        WHERE id = $1 AND client_id = $2 AND organization_id = $3`,
      [feedbackId, clientId, orgId]
    );
    if (existing.rows[0]) return { duplicate: true };
    return { notFound: true };
  }

  const row = rows[0];
  if (Number(row.score) <= LOW_RATING) {
    await notifyLowRating(pool, { orgId, feedbackId: row.id, score: row.score })
      .catch((err) => logger.error({ err: err.message, feedbackId: row.id }, 'Low-rating notification failed'));
  }
  return { row };
}

/** The studio's filtered list. Every query starts with the caller's organization. */
async function listForTrainer(orgId, filters = {}) {
  const params = [orgId];
  const where = ['f.organization_id = $1'];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  if (filters.trainer_id) add('f.trainer_id = ?', filters.trainer_id);
  if (filters.client_id) add('f.client_id = ?', filters.client_id);
  if (filters.from) add('f.completed_at >= ?::date', filters.from);
  if (filters.to) add("f.completed_at < (?::date + INTERVAL '1 day')", filters.to);
  if (filters.min_score != null) add('f.score >= ?', filters.min_score);
  if (filters.max_score != null) add('f.score <= ?', filters.max_score);
  if (filters.flagged) where.push(`f.score <= ${LOW_RATING}`);

  const status = filters.status || 'submitted';
  if (status !== 'all') add('f.status = ?', status);

  const whereSql = where.join(' AND ');
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const count = await pool.query(
    `SELECT COUNT(*)::int AS total FROM pt_session_feedback f WHERE ${whereSql}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS}
     ${FROM_JOINS}
     WHERE ${whereSql}
     ORDER BY f.completed_at DESC
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params
  );
  return { rows, total: count.rows[0]?.total || 0 };
}

/** Trainer analytics. Submitted only; an empty studio is zeroes, not an error. */
async function summaryForTrainer(orgId) {
  const [totals, distribution, trend, pending] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE f.status = 'submitted')::int AS rated_count,
              ROUND(AVG(f.score) FILTER (WHERE f.status = 'submitted')::numeric, 2)::float AS average_score,
              COUNT(*) FILTER (WHERE f.status = 'submitted' AND f.score >= 4.5)::int AS five_star_count,
              COUNT(*) FILTER (WHERE f.status = 'submitted' AND f.score <= ${LOW_RATING})::int AS low_rating_count
         FROM pt_session_feedback f
        WHERE f.organization_id = $1`,
      [orgId]
    ),
    pool.query(
      `SELECT ROUND(score)::int AS stars, COUNT(*)::int AS count
         FROM pt_session_feedback f
        WHERE f.organization_id = $1 AND f.status = 'submitted'
        GROUP BY ROUND(score)
        ORDER BY stars`,
      [orgId]
    ),
    pool.query(
      `SELECT to_char(date_trunc('month', submitted_at), 'YYYY-MM') AS month,
              ROUND(AVG(score)::numeric, 2)::float AS average,
              COUNT(*)::int AS count
         FROM pt_session_feedback f
        WHERE f.organization_id = $1 AND f.status = 'submitted'
        GROUP BY date_trunc('month', submitted_at)
        ORDER BY date_trunc('month', submitted_at) DESC
        LIMIT 12`,
      [orgId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS pending
         FROM pt_session_feedback f
        WHERE f.organization_id = $1 AND f.status = 'pending'`,
      [orgId]
    ),
  ]);

  const t = totals.rows[0] || {};
  const buckets = new Map(distribution.rows.map((r) => [Number(r.stars), Number(r.count)]));
  return {
    rated_count: Number(t.rated_count || 0),
    average_score: t.average_score == null ? null : Number(t.average_score),
    five_star_count: Number(t.five_star_count || 0),
    low_rating_count: Number(t.low_rating_count || 0),
    pending_count: Number(pending.rows[0]?.pending || 0),
    distribution: [1, 2, 3, 4, 5].map((stars) => ({ stars, count: buckets.get(stars) || 0 })),
    trend: trend.rows.map((r) => ({
      month: r.month, average: Number(r.average), count: Number(r.count),
    })),
  };
}

/** One row, inside the caller's studio. */
async function getForTrainer(orgId, feedbackId) {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS}
     ${FROM_JOINS}
     WHERE f.organization_id = $1 AND f.id = $2`,
    [orgId, feedbackId]
  );
  return rows[0] || null;
}

/** Pending requests older than `hours`, for the reminder sweep. */
async function pendingOlderThan(hours) {
  const { rows } = await pool.query(
    `SELECT f.id, f.organization_id, f.session_id, f.client_id,
            s.title AS session_title, s.session_date, u.id AS user_id
       FROM pt_session_feedback f
       JOIN pt_sessions s ON s.id = f.session_id
       LEFT JOIN users u ON u.pt_client_id = f.client_id AND u.deleted_at IS NULL
      WHERE f.status = 'pending'
        AND f.completed_at < NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY f.completed_at ASC
      LIMIT 500`,
    [hours]
  );
  return rows;
}

/** One reminder per pending request; the notification's ref_id is the dedupe. */
async function remind(db, row) {
  if (!row.user_id) return 0;
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, type, title, body, ref_id)
     SELECT $1, 'session_feedback_reminder', $2, $3, $4
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
         WHERE user_id = $1 AND type = 'session_feedback_reminder' AND ref_id = $4
      )
     RETURNING id`,
    [
      row.user_id,
      'A session is still waiting for your rating',
      row.session_title ? `Rate "${row.session_title}" — your trainer reads every answer.` : 'Rate your last session — your trainer reads every answer.',
      row.id,
    ]
  );
  return rows.length;
}

module.exports = {
  LOW_RATING,
  createRequest,
  notifyMemberOfRequest,
  notifyLowRating,
  listForClient,
  submitFeedback,
  listForTrainer,
  summaryForTrainer,
  getForTrainer,
  pendingOlderThan,
  remind,
};

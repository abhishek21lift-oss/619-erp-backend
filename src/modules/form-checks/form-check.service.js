'use strict';
// src/modules/form-checks/form-check.service.js
// Reads and writes for asynchronous form review. Both sides live here so the
// member's history and the trainer's queue read the same rows through one
// definition of "in this organization".
//
// Every function takes the org id the route resolved from the session. The
// member's client id is likewise passed in from req.user.pt_client_id, never
// from the request body or query.

const pool = require('../../db/pool');

/** The member's own checks, newest first, each with the trainer's comments. */
async function listForClient(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT f.id, f.exercise, f.note, f.video_url, f.status,
            f.created_at, f.reviewed_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', c.id,
                  'at_seconds', c.at_seconds,
                  'body', c.body,
                  'created_at', c.created_at
                ) ORDER BY c.at_seconds, c.created_at
              ) FILTER (WHERE c.id IS NOT NULL),
              '[]'
            ) AS comments
       FROM pt_form_checks f
       LEFT JOIN pt_form_check_comments c ON c.form_check_id = f.id
      WHERE f.client_id = $1 AND f.organization_id = $2
      GROUP BY f.id
      ORDER BY f.created_at DESC
      LIMIT 50`,
    [clientId, orgId]
  );
  return rows;
}

/** Videos this member sent in the last day — the upload cap is counted here. */
async function uploadsToday(clientId, orgId) {
  const { rows: [{ count }] } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM pt_form_checks
      WHERE client_id = $1 AND organization_id = $2
        AND created_at > NOW() - INTERVAL '1 day'`,
    [clientId, orgId]
  );
  return count;
}

/** Insert a checked, already-stored upload and return it with empty comments. */
async function createForClient({ id, orgId, clientId, exercise, note, videoUrl }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO pt_form_checks (id, organization_id, client_id, exercise, note, video_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, exercise, note, video_url, status, created_at, reviewed_at`,
    [id, orgId, clientId, exercise, note || null, videoUrl]
  );
  return { ...row, comments: [] };
}

/**
 * The trainer's queue. `status` is 'pending' | 'reviewed' | 'all'; the route
 * has already rejected anything else.
 */
async function listQueue(orgId, status) {
  const params = [orgId];
  let statusClause = '';
  if (status !== 'all') {
    params.push(status);
    statusClause = ` AND f.status = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT f.id, f.client_id, c.name AS client_name, f.exercise, f.note,
            f.video_url, f.status, f.created_at, f.reviewed_at,
            COUNT(cm.id)::int AS comment_count
       FROM pt_form_checks f
       JOIN pt_clients c ON c.id = f.client_id AND c.deleted_at IS NULL
       LEFT JOIN pt_form_check_comments cm ON cm.form_check_id = f.id
      WHERE f.organization_id = $1${statusClause}
      GROUP BY f.id, c.name
      ORDER BY f.created_at DESC
      LIMIT 100`,
    params
  );
  return rows;
}

/** One check and every comment in video order; null when it is not this org's. */
async function detailForTrainer(orgId, id) {
  const { rows: [row] } = await pool.query(
    `SELECT f.id, f.client_id, c.name AS client_name, f.exercise, f.note,
            f.video_url, f.status, f.created_at, f.reviewed_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', cm.id,
                  'at_seconds', cm.at_seconds,
                  'body', cm.body,
                  'created_at', cm.created_at
                ) ORDER BY cm.at_seconds, cm.created_at
              ) FILTER (WHERE cm.id IS NOT NULL),
              '[]'
            ) AS comments
       FROM pt_form_checks f
       JOIN pt_clients c ON c.id = f.client_id AND c.deleted_at IS NULL
       LEFT JOIN pt_form_check_comments cm ON cm.form_check_id = f.id
      WHERE f.id = $1 AND f.organization_id = $2
      GROUP BY f.id, c.name`,
    [id, orgId]
  );
  return row || null;
}

/**
 * Add one timestamped comment. The INSERT only fires when the check is in
 * this organization, so a cross-tenant id inserts nothing and returns null.
 */
async function addComment(orgId, checkId, atSeconds, body) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO pt_form_check_comments (organization_id, form_check_id, at_seconds, body)
     SELECT $1, $2, $3, $4
      WHERE EXISTS (
        SELECT 1 FROM pt_form_checks WHERE id = $2 AND organization_id = $1
      )
     RETURNING id, at_seconds, body, created_at`,
    [orgId, checkId, atSeconds, body]
  );
  return row || null;
}

/** Mark reviewed; null when the check is not in this organization. */
async function markReviewed(orgId, id) {
  const { rows: [row] } = await pool.query(
    `UPDATE pt_form_checks
        SET status = 'reviewed',
            reviewed_at = COALESCE(reviewed_at, NOW())
      WHERE id = $1 AND organization_id = $2
      RETURNING id, client_id, exercise, note, video_url, status, created_at, reviewed_at`,
    [id, orgId]
  );
  return row || null;
}

module.exports = {
  listForClient,
  uploadsToday,
  createForClient,
  listQueue,
  detailForTrainer,
  addComment,
  markReviewed,
};

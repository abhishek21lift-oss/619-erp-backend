'use strict';
// Data access for the client's own booking surface (client-booking.routes.js).
// The adapter holds the HTTP rules; every statement and its tenant predicates
// live here.

const pool = require('../../db/pool');

const SESSION_COLUMNS = `id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
  to_char(start_time, 'HH24:MI') AS start_time,
  to_char(end_time, 'HH24:MI') AS end_time,
  duration_minutes, status`;

/** The trainer this client belongs to, or null when there is no such client. */
async function trainerForClient(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT trainer_id FROM pt_clients
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [clientId, orgId],
  );
  return rows[0] ? rows[0].trainer_id : null;
}

/** Every scheduled session this client still has ahead of them. */
async function upcomingForClient(clientId, orgId, fromDate) {
  const { rows } = await pool.query(
    `SELECT ${SESSION_COLUMNS} FROM pt_sessions
      WHERE client_id = $1 AND organization_id = $2
        AND deleted_at IS NULL AND status = 'scheduled'
        AND session_date >= $3
      ORDER BY session_date, start_time`,
    [clientId, orgId, fromDate],
  );
  return rows;
}

/** One session, only if it belongs to this client in this studio. */
async function byIdForClient(id, clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT ${SESSION_COLUMNS} FROM pt_sessions
      WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND deleted_at IS NULL`,
    [id, clientId, orgId],
  );
  return rows[0] || null;
}

/** Book a new session. The partial unique index turns a lost race into 23505. */
async function insertSession({
  clientId, trainerId, date, start, end, slotMinutes, userId, orgId,
}) {
  const { rows } = await pool.query(
    `INSERT INTO pt_sessions
       (client_id, trainer_id, title, session_date, start_time, end_time,
        duration_minutes, created_by, session_type, organization_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SESSION_COLUMNS}`,
    [clientId, trainerId, 'PT Session', date, start, end, slotMinutes, userId, '1-on-1', orgId],
  );
  return rows[0];
}

/** Move a scheduled session. The status guard makes a concurrent cancel win. */
async function moveSession({
  id, clientId, orgId, date, start, end, slotMinutes,
}) {
  const { rows } = await pool.query(
    `UPDATE pt_sessions
        SET session_date = $1, start_time = $2, end_time = $3,
            duration_minutes = $4, updated_at = NOW()
      WHERE id = $5 AND client_id = $6 AND organization_id = $7
        AND status = 'scheduled' AND deleted_at IS NULL
      RETURNING ${SESSION_COLUMNS}`,
    [date, start, end, slotMinutes, id, clientId, orgId],
  );
  return rows[0] || null;
}

/** Cancel a scheduled session. */
async function cancelSession(id, clientId, orgId) {
  await pool.query(
    `UPDATE pt_sessions SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND client_id = $2 AND organization_id = $3 AND status = 'scheduled'`,
    [id, clientId, orgId],
  );
}

module.exports = {
  trainerForClient, upcomingForClient, byIdForClient, insertSession, moveSession, cancelSession,
};

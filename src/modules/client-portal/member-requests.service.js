'use strict';
// Pause and account-deletion requests.
//
// Both are the same shape as a renewal request: an unread notification to
// every trainer in the studio, and nothing else. No new table, no queue, no
// state machine — the trainer reads it, acts in the back office, and the
// member sees "requested on <date>" until then. That means there is no durable
// status here, which is the accepted cost of not inventing a second workflow
// beside the one the studio already uses.
//
// The client and studio are always the session's, never the request's.

const pool = require('../../db/pool');
const { today } = require('../../lib/appTime');

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_REASON = 300;

/** A real calendar date in `YYYY-MM-DD`, or null. */
function realDate(value) {
  const v = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const parsed = new Date(`${v}T00:00:00Z`);
  // Date parses 2026-02-31 as 3 March; a round trip is what rejects it.
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v ? null : v;
}

/**
 * Insert one unread notification per active trainer, unless that trainer
 * already has an unread one of this type for this member. `rowCount` is the
 * answer to "did this actually ask anybody new?".
 */
async function notifyTrainersOnce({ clientId, orgId, type, titleSuffix, body }) {
  const { rowCount } = await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link)
     SELECT u.id, $3, COALESCE(c.name, 'A member') || $4, $5, '/pt-os/clients/' || c.id
       FROM pt_clients c
       JOIN users u ON u.organization_id = c.organization_id AND u.role = 'trainer'
                   AND u.is_active = TRUE AND u.deleted_at IS NULL
      WHERE c.id = $1 AND c.organization_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = u.id AND n.type = $3 AND n.is_read = FALSE
             AND n.link = '/pt-os/clients/' || c.id)`,
    [clientId, orgId, type, titleSuffix, body],
  );
  return { sent: rowCount > 0 };
}

/** When the still-unread request was made, or null. */
async function pendingAt(clientId, orgId, type) {
  const { rows } = await pool.query(
    `SELECT MAX(n.created_at) AS at
       FROM notifications n
       JOIN users u ON u.id = n.user_id AND u.organization_id = $2 AND u.role = 'trainer'
      WHERE n.type = $3 AND n.link = '/pt-os/clients/' || $1 AND n.is_read = FALSE`,
    [clientId, orgId, type],
  );
  return { requested_at: rows[0]?.at || null };
}

async function requestPause(clientId, orgId, input = {}) {
  const start = realDate(input.start_date);
  if (!start) throw new RequestError('Choose the first day of your pause.');
  if (start < today()) throw new RequestError('A pause cannot start in the past.');

  const rawEnd = String(input.end_date ?? '').trim();
  const end = rawEnd ? realDate(rawEnd) : null;
  if (rawEnd && !end) throw new RequestError('Choose a valid last day, or leave it empty.');
  if (end && end <= start) throw new RequestError('The last day must be after the first day.');

  const reason = String(input.reason ?? '').trim();
  if (reason.length > MAX_REASON) {
    throw new RequestError(`Keep the reason under ${MAX_REASON} characters.`);
  }

  const body = `Pause from ${start}${end ? ` until ${end}` : ''}.${reason ? ` Reason: ${reason}` : ''}`;
  return notifyTrainersOnce({
    clientId,
    orgId,
    type: 'pause_request',
    titleSuffix: ' wants to pause their plan',
    body,
  });
}

function myPause(clientId, orgId) {
  return pendingAt(clientId, orgId, 'pause_request');
}

async function requestDeletion(clientId, orgId) {
  return notifyTrainersOnce({
    clientId,
    orgId,
    type: 'deletion_request',
    titleSuffix: ' asked to delete their account',
    body: 'Account deletion requested from the member app.',
  });
}

function myDeletion(clientId, orgId) {
  return pendingAt(clientId, orgId, 'deletion_request');
}

module.exports = { RequestError, requestPause, myPause, requestDeletion, myDeletion };

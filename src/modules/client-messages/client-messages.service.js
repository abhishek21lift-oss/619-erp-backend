'use strict';
// Member ↔ studio messaging (table: client_messages, migration 211).
//
// One conversation per client, between the member and their studio. With one
// trainer per studio (migration 208) the studio side IS that trainer.
//
// Every function takes the org id and client id the ROUTE resolved: for a
// member, from their session (selfOf); for the trainer, a client id checked
// against their own studio by studioClient() first. Nothing here trusts an id
// it was not handed by one of those two.

const pool = require('../../db/pool');
const logger = require('../../lib/logger');

const MAX_BODY = 2000;
const PAGE = 60;
/** A member may send this many messages in an hour — generous for a person, a wall for a script. */
const MEMBER_HOURLY_LIMIT = 30;

class MessageInputError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message); this.status = status; this.code = code;
  }
}

/** Trimmed, non-empty, bounded. Line breaks are kept; runs of blank lines are not. */
function normaliseBody(raw) {
  const body = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) throw new MessageInputError('Write a message first.');
  if (body.length > MAX_BODY) throw new MessageInputError(`Keep it under ${MAX_BODY} characters.`);
  return body;
}

const COLS = 'id, sender, body, read_at, created_at';

/**
 * The newest page of a thread, returned oldest-first for display. `before`
 * (an ISO timestamp) pages further back.
 */
async function thread(orgId, clientId, { before = null, limit = PAGE } = {}) {
  const n = Math.min(Math.max(Number(limit) || PAGE, 1), 200);
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM client_messages
      WHERE organization_id = $1 AND client_id = $2
        AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)
      ORDER BY created_at DESC
      LIMIT $4`,
    [orgId, clientId, before, n],
  );
  return rows.reverse();
}

/** Mark the other side's messages read, now that `reader` has opened the thread. */
async function markRead(orgId, clientId, reader) {
  const other = reader === 'member' ? 'studio' : 'member';
  const { rowCount } = await pool.query(
    `UPDATE client_messages SET read_at = NOW()
      WHERE organization_id = $1 AND client_id = $2 AND sender = $3 AND read_at IS NULL`,
    [orgId, clientId, other],
  );
  return rowCount;
}

async function insert(orgId, clientId, sender, userId, body) {
  const { rows } = await pool.query(
    `INSERT INTO client_messages (organization_id, client_id, sender, sender_user_id, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLS}`,
    [orgId, clientId, sender, userId, body],
  );
  return rows[0];
}

/**
 * An in-app notification, at most one unread per thread per recipient: a
 * burst of ten messages is one "new message", not ten. Never fails the send.
 */
async function notifyOnce(userId, title, body, link) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT $1, 'message', $2, $3, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM notifications
           WHERE user_id = $1 AND type = 'message' AND link = $4 AND is_read = FALSE)`,
      [userId, title, body.length > 140 ? `${body.slice(0, 137)}…` : body, link],
    );
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'client-messages: notification insert failed');
  }
}

// ── The member's side ──────────────────────────────────────────────────────

/** The member's thread, and who they are talking to. Opening it marks the studio's messages read. */
async function memberThread(clientId, orgId, opts) {
  const [messages, studio] = await Promise.all([
    thread(orgId, clientId, opts),
    pool.query(
      `SELECT o.name AS studio_name, COALESCE(t.name, u.name) AS trainer_name
         FROM organizations o
         LEFT JOIN LATERAL (
           SELECT id, name FROM users
            WHERE organization_id = o.id AND role = 'trainer' AND is_active = TRUE AND deleted_at IS NULL
            ORDER BY created_at LIMIT 1) u ON TRUE
         LEFT JOIN pt_clients c ON c.id = $2 AND c.organization_id = o.id
         LEFT JOIN trainers t ON t.id = c.trainer_id
        WHERE o.id = $1`,
      [orgId, clientId],
    ),
  ]);
  if (!opts?.before) await markRead(orgId, clientId, 'member');
  return { messages, with: studio.rows[0] || { studio_name: null, trainer_name: null } };
}

async function memberUnread(clientId, orgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM client_messages
      WHERE organization_id = $1 AND client_id = $2 AND sender = 'studio' AND read_at IS NULL`,
    [orgId, clientId],
  );
  return rows[0].n;
}

async function memberSend(clientId, orgId, userId, raw) {
  const body = normaliseBody(raw);
  const { rows: [recent] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM client_messages
      WHERE organization_id = $1 AND client_id = $2 AND sender = 'member'
        AND created_at > NOW() - INTERVAL '1 hour'`,
    [orgId, clientId],
  );
  if (recent.n >= MEMBER_HOURLY_LIMIT) {
    throw new MessageInputError('That is a lot of messages in an hour — give your trainer a moment to reply.', 429, 'RATE_LIMITED');
  }

  const msg = await insert(orgId, clientId, 'member', userId, body);

  const { rows: people } = await pool.query(
    `SELECT u.id, c.name AS client_name
       FROM pt_clients c
       JOIN users u ON u.organization_id = c.organization_id
                   AND u.role = 'trainer' AND u.is_active = TRUE AND u.deleted_at IS NULL
      WHERE c.id = $1 AND c.organization_id = $2`,
    [clientId, orgId],
  );
  await Promise.all(people.map((p) => notifyOnce(
    p.id, `New message from ${p.client_name}`, body, `/messages?client=${encodeURIComponent(clientId)}`,
  )));
  return msg;
}

// ── The studio's side ──────────────────────────────────────────────────────

/** The client, if it is a live client of this studio; null otherwise (the route answers 404). */
async function studioClient(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.photo_url, c.client_id AS member_code,
            (SELECT u.id FROM users u
              WHERE u.pt_client_id = c.id AND u.role = 'member' AND u.is_active = TRUE AND u.deleted_at IS NULL
              LIMIT 1) AS member_user_id
       FROM pt_clients c
      WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL`,
    [String(clientId), orgId],
  );
  return rows[0] || null;
}

/**
 * The trainer's inbox: every client with a conversation, latest message and
 * how many of theirs are unread, most recent first.
 */
async function inbox(orgId, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `WITH last AS (
       SELECT DISTINCT ON (m.client_id) m.client_id, m.sender, m.body, m.created_at
         FROM client_messages m
        WHERE m.organization_id = $1
        ORDER BY m.client_id, m.created_at DESC
     ), unread AS (
       SELECT client_id, COUNT(*)::int AS n FROM client_messages
        WHERE organization_id = $1 AND sender = 'member' AND read_at IS NULL
        GROUP BY client_id
     )
     SELECT l.client_id, c.name AS client_name, c.photo_url, c.client_id AS member_code,
            l.sender AS last_sender, l.body AS last_body, l.created_at AS last_at,
            COALESCE(u.n, 0) AS unread,
            EXISTS (SELECT 1 FROM users mu
                     WHERE mu.pt_client_id = c.id AND mu.role = 'member'
                       AND mu.is_active = TRUE AND mu.deleted_at IS NULL) AS has_login
       FROM last l
       JOIN pt_clients c ON c.id = l.client_id AND c.organization_id = $1 AND c.deleted_at IS NULL
       LEFT JOIN unread u ON u.client_id = l.client_id
      ORDER BY l.created_at DESC
      LIMIT $2`,
    [orgId, Math.min(Math.max(Number(limit) || 100, 1), 200)],
  );
  return rows;
}

async function studioUnread(orgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM client_messages
      WHERE organization_id = $1 AND sender = 'member' AND read_at IS NULL`,
    [orgId],
  );
  return rows[0].n;
}

async function studioThread(orgId, client, opts) {
  const messages = await thread(orgId, client.id, opts);
  if (!opts?.before) await markRead(orgId, client.id, 'studio');
  return {
    messages,
    client: {
      id: client.id, name: client.name, photo_url: client.photo_url,
      member_code: client.member_code, has_login: Boolean(client.member_user_id),
    },
  };
}

async function studioSend(orgId, client, userId, raw, senderName) {
  const body = normaliseBody(raw);
  const msg = await insert(orgId, client.id, 'studio', userId, body);
  await notifyOnce(client.member_user_id, `New message from ${senderName || 'your trainer'}`, body, '/member/messages');
  return msg;
}

module.exports = {
  normaliseBody, MessageInputError, MAX_BODY, MEMBER_HOURLY_LIMIT,
  memberThread, memberUnread, memberSend,
  studioClient, inbox, studioUnread, studioThread, studioSend,
};

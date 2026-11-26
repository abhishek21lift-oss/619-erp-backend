'use strict';
// src/modules/client-messages/client-messages.inbound.js
//
// Inbound WhatsApp -> the member's existing thread.
//
// The webhook runs this inside its idempotency transaction, so everything here
// takes the caller's pg client and issues no transaction control of its own.
// Two rules shape the whole module:
//
//   1. A message from a number the studio cannot resolve is RETAINED, not
//      dropped and not guessed at. "Why did nobody answer?" has an answer in
//      whatsapp_unmatched_messages; a wrong guess would put a stranger's
//      message in a client's thread.
//   2. Notifications are returned as descriptors, never inserted here. They
//      are best-effort and run after COMMIT: a failed notification insert
//      inside the transaction would abort the message it was announcing.
//
// Nothing in this file logs a phone number or a body.

const TYPES = new Set([
  'text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'other',
]);

/** A body is never empty: the column rejects it, and the trainer needs a hint. */
const PLACEHOLDER = Object.freeze({
  text: '[Message]',
  image: '[Photo]',
  video: '[Video]',
  audio: '[Voice message]',
  document: '[Document]',
  sticker: '[Sticker]',
  location: '[Location]',
  contact: '[Contact]',
  other: '[Message]',
});

const MAX_BODY = 2000;

/**
 * A national number is at least 10 digits once the country code is included in
 * practice; anything shorter cannot be matched safely and is treated as
 * unknown without a lookup. The resolve query compares only the last ten
 * digits, so a leading country code does not matter.
 */
const MIN_PHONE_DIGITS = 10;

function digitsOf(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

/**
 * Cap by CODE POINTS, not UTF-16 units: slicing a surrogate pair produces a
 * lone surrogate, which Postgres rejects as invalid UTF-8. The column's limit
 * counts characters, so this does too.
 */
function capBody(body) {
  const characters = Array.from(body);
  if (characters.length <= MAX_BODY) return body;
  return `${characters.slice(0, MAX_BODY - 1).join('')}…`;
}

function normalisePayload(payload = {}) {
  const messageType = TYPES.has(payload.message_type) ? payload.message_type : 'other';
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const body = text.length > 0 ? text : PLACEHOLDER[messageType];
  return { messageType, body: capBody(body) };
}

const RESOLVE_SQL = `
  SELECT DISTINCT c.id, c.name
    FROM pt_clients c
   WHERE c.organization_id = $1
     AND c.deleted_at IS NULL
     AND (
       right(regexp_replace(COALESCE(NULLIF(btrim(c.whatsapp), ''), ''), '\\D', '', 'g'), 10) = right($2, 10)
       OR right(regexp_replace(COALESCE(NULLIF(btrim(c.mobile), ''), ''), '\\D', '', 'g'), 10) = right($2, 10)
     )
`;

const UNMATCHED_SQL = `
  INSERT INTO whatsapp_unmatched_messages
    (organization_id, provider_message_id, from_phone, push_name, message_type, body, received_at, reason)
  VALUES ($1,$2,$3,$4,$5,$6,
          LEAST(COALESCE($7::timestamptz, NOW()), NOW()), $8)
  ON CONFLICT (organization_id, provider_message_id) DO NOTHING
`;

const THREAD_SQL = `
  INSERT INTO client_messages
    (organization_id, client_id, sender, sender_user_id, body, channel,
     message_type, external_id, created_at)
  VALUES ($1,$2,'member',NULL,$3,'whatsapp',$4,$5,
          LEAST(COALESCE($6::timestamptz, NOW()), NOW()))
  ON CONFLICT (organization_id, external_id)
    WHERE external_id IS NOT NULL DO NOTHING
  RETURNING id
`;

// The same recipient rule memberSend uses: every active trainer in the studio.
const TRAINERS_SQL = `
  SELECT u.id, c.name AS client_name
    FROM pt_clients c
    JOIN users u ON u.organization_id = c.organization_id
                AND u.role = 'trainer' AND u.is_active = TRUE AND u.deleted_at IS NULL
   WHERE c.id = $1 AND c.organization_id = $2
`;

function none(subject = null) {
  return { applied: 0, subject, notifications: [] };
}

/**
 * Store one inbound WhatsApp message, or retain why it could not be stored.
 *
 * @returns {Promise<{ applied: number, subject: string | null,
 *   notifications: { userId: string, title: string, body: string, link: string }[] }>}
 */
async function applyInboundMessage({ tenantId, payload, occurredAt, client }) {
  const providerMessageId = payload?.provider_message_id;
  if (!providerMessageId) return none();

  const { messageType, body } = normalisePayload(payload);
  const fromPhone = digitsOf(payload?.from_phone);
  const receivedAt = payload?.received_at || occurredAt || null;

  // Too short to be a phone: retain as unknown without asking the database a
  // question that can only return nothing.
  let matches = [];
  if (fromPhone.length >= MIN_PHONE_DIGITS) {
    const resolved = await client.query(RESOLVE_SQL, [tenantId, fromPhone]);
    matches = resolved.rows || [];
  }

  if (matches.length !== 1) {
    await client.query(UNMATCHED_SQL, [
      tenantId,
      providerMessageId,
      fromPhone,
      payload?.push_name ?? null,
      messageType,
      body,
      receivedAt,
      matches.length === 0 ? 'unknown_phone' : 'ambiguous_phone',
    ]);
    return none(providerMessageId);
  }

  const [row] = matches;
  const inserted = await client.query(THREAD_SQL, [
    tenantId,
    row.id,
    body,
    messageType,
    providerMessageId,
    receivedAt,
  ]);

  // A duplicate provider id under a new event id loses the partial unique
  // index race and inserts nothing. No notification: the first delivery
  // already produced one.
  if (inserted.rowCount === 0) return none(providerMessageId);

  const { rows: trainers } = await client.query(TRAINERS_SQL, [row.id, tenantId]);
  const notifications = (trainers || []).map((trainer) => ({
    userId: trainer.id,
    title: `New WhatsApp message from ${row.name}`,
    body,
    link: `/pt-os/messages?client=${encodeURIComponent(row.id)}`,
  }));

  return { applied: 1, subject: providerMessageId, notifications };
}

module.exports = {
  applyInboundMessage,
  // Exported for the webhook's unit tests and for a future linking flow.
  normalisePayload,
};

'use strict';
// Remote signing links — token issuing, lookup, and single use.
//
// The token rules are the same as clientInvitations.js on purpose: single-use,
// hashed at rest, time-limited, and indistinguishable in failure. The raw token
// is returned once and never persisted; only SHA-256(raw) is stored.
//
// A form link is NOT a login. It lets one client, on their own phone, fill and
// sign the PAR-Q and informed consent before they have an account or a PT
// package. That is why it lives in its own table and its own module.

const pool = require('../db/pool');
const { issueToken, hashToken } = require('./clientInvitations');

/** How long a signing link is good for. A week: long enough to sign after
 *  work, short enough that a forwarded message does not stay live forever. */
const EXPIRY_HOURS = parseInt(process.env.FORM_LINK_EXPIRY_HOURS, 10) || 168;

/**
 * Create a link and return its RAW token.
 *
 * Any link still live for this client is expired first. Without that, a
 * re-send after "the first message may have gone to the wrong number" would
 * leave the old link working — the opposite of the intent.
 */
async function create({ clientId, organizationId, createdBy, client = pool }) {
  await client.query(
    `UPDATE pt_form_links
        SET expires_at = NOW()
      WHERE client_id = $1 AND organization_id = $2
        AND used_at IS NULL AND expires_at > NOW()`,
    [clientId, organizationId]
  );
  const { raw, hash } = issueToken();
  const { rows } = await client.query(
    `INSERT INTO pt_form_links
       (organization_id, client_id, token_hash, expires_at, created_by)
     VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5)
     RETURNING id, expires_at`,
    [organizationId, clientId, hash, String(EXPIRY_HOURS), createdBy || null]
  );
  return { id: rows[0].id, token: raw, expiresAt: rows[0].expires_at };
}

/**
 * The live link for a raw token, with the client identity the public form
 * fills in server-side.
 *
 * One query so expiry, use and existence all fail the same way: a caller
 * probing tokens learns nothing from which one it was.
 */
async function resolve(raw, { client = pool } = {}) {
  if (!raw || typeof raw !== 'string') return null;
  const { rows } = await client.query(
    `SELECT l.id, l.client_id, l.organization_id, l.expires_at, l.created_by,
            c.name AS client_name, c.email, c.mobile, c.gender, c.dob, c.address,
            c.emergency_contact, c.emergency_phone, c.occupation,
            c.trainer_id, c.trainer_name,
            o.name AS studio_name
       FROM pt_form_links l
       JOIN pt_clients c
         ON c.id = l.client_id AND c.organization_id = l.organization_id
       LEFT JOIN organizations o ON o.id = l.organization_id
      WHERE l.token_hash = $1
        AND l.used_at IS NULL
        AND l.expires_at > NOW()
        AND c.deleted_at IS NULL`,
    [hashToken(raw)]
  );
  return rows[0] || null;
}

/**
 * Spend the link. Guarded on used_at so two concurrent submissions cannot
 * both write a screening; the loser rolls its transaction back.
 */
async function markUsed(id, { client = pool } = {}) {
  const { rows } = await client.query(
    `UPDATE pt_form_links SET used_at = NOW()
      WHERE id = $1 AND used_at IS NULL RETURNING id`,
    [id]
  );
  return Boolean(rows[0]);
}

module.exports = { EXPIRY_HOURS, create, resolve, markUsed };

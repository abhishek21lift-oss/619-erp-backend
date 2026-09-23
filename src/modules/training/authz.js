// Who may touch whose training data.
//
// ── Why this is a module and not an `if` in each route ─────────────────────
//
// There are three boundaries here and they are not the same shape:
//
//   ORGANISATION  a studio never sees another studio's anything. Enforced in
//                 SQL on every query, and again by RLS underneath.
//   TRAINER       the trainer owns the studio and sees every client in it —
//                 and only in it. There is no narrower staff role: the
//                 assistant-coach rule that once limited a trainer to their
//                 "assigned" clients went with the Trainer → Members model.
//   MEMBER        a gym client with a login may act on their OWN client row
//                 and nothing else.
//   CHILD ROWS    a set belongs to a performance belongs to a session belongs
//                 to a client. None of those child tables carry an
//                 organization_id, so reaching one safely means walking back
//                 up to the client and checking THAT.
//
// The last is where this kind of code usually goes wrong. `UPDATE
// set_performances WHERE id = $1` looks scoped — it names one row — and is
// completely unscoped: any authenticated trainer in any studio can pass any
// id. Every write therefore joins back to the client before it touches
// anything, and the tests assert it by attacking across the boundary rather
// than by reading the SQL.
//
// Reads return false for "not yours" rather than throwing, so a route can
// answer 404 and reveal nothing about whether the row exists elsewhere.
'use strict';

const pool = require('../../db/pool');
const { orgWhere } = require('../../lib/tenant-db');

/**
 * True when this request may act on this client at all.
 *
 *   trainer  — the client must be a live row in the trainer's own studio.
 *   member   — the client must be their own record (pt_client_id, loaded from
 *              the database by auth.js, never from the request).
 *   anything else — no. A role this module does not name gets nothing,
 *              rather than falling through to an org-only check the way a
 *              member once did.
 */
async function canAccessClient(req, clientId) {
  if (!clientId) return false;
  const role = req.user?.role;
  if (role === 'member') {
    const own = req.user.pt_client_id || null;
    return Boolean(own) && own === clientId;
  }
  if (role !== 'trainer' || !req.user.organization_id) return false;
  const params = [clientId];
  const org = orgWhere(req, params, 'c.organization_id');
  const { rowCount } = await pool.query(
    `SELECT 1 FROM pt_clients c
      WHERE c.id = $1 AND c.deleted_at IS NULL${org}`,
    params
  );
  return rowCount > 0;
}

// `loadOwned` was here: the row-level guard every /api/training handler called
// before touching a program or a template. Its whole allow-list —
// training_programs, workout_templates, training_assignments — now lives in the
// `archive` schema (193 and 195), so the function could only ever have raised
// "relation does not exist". It went with the routes that called it.
//
// trainerWhere and seesAllClients went with the staff roles: with one trainer
// per studio there is no subset of the studio's clients to narrow to.

module.exports = { canAccessClient };

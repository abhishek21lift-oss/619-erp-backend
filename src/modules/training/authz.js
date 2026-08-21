// Who may touch whose training data.
//
// ── Why this is a module and not an `if` in each route ─────────────────────
//
// There are three boundaries here and they are not the same shape:
//
//   ORGANISATION  a studio never sees another studio's anything. Enforced in
//                 SQL on every query, and again by RLS underneath.
//   TRAINER       a trainer who is not an admin or manager sees only the
//                 clients assigned to them. A property of the CLIENT, so it
//                 is applied once against pt_clients rather than repeated on
//                 each child table.
//   MEMBER        a gym client with a login may act on their OWN client row
//                 and nothing else. This one was missing, and its absence did
//                 not read as a gap: a member is neither an all-clients role
//                 nor a trainer, so they fell through both tests into the
//                 unconstrained default.
//   CHILD ROWS    a set belongs to a performance belongs to a session belongs
//                 to a client. None of those child tables carry an
//                 organization_id, so reaching one safely means walking back
//                 up to the client and checking THAT.
//
// The third is where this kind of code usually goes wrong. `UPDATE
// set_performances WHERE id = $1` looks scoped — it names one row — and is
// completely unscoped: any authenticated trainer in any studio can pass any
// id. Every write below therefore joins back to the client before it touches
// anything, and the tests assert it by attacking across the boundary rather
// than by reading the SQL.
//
// Reads return null for "not yours" rather than throwing, so a route can
// answer 404 and reveal nothing about whether the row exists elsewhere.
'use strict';

const pool = require('../../db/pool');
const { tenantScope } = require('../../lib/tenant-db');

/** Roles that see every client in their studio. */
const ALL_CLIENT_ROLES = ['admin', 'manager', 'super_admin'];

function seesAllClients(req) {
  return ALL_CLIENT_ROLES.includes(req.user?.role);
}

/**
 * ` AND <col> = $N`, pushing the org id onto `params`.
 *
 * Returns '' for a platform super admin operating platform-wide — the same
 * contract orgWhere() has in pt-os.routes.js, so a reader who knows one knows
 * the other.
 */
function orgWhere(req, params, col = 'organization_id') {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return '';
  params.push(scope.orgId);
  return ` AND ${col} = $${params.length}`;
}

/**
 * ` AND c.trainer_id = $N` for a trainer who owns only their own clients.
 *
 * `col` names the pt_clients alias in the caller's query, because this clause
 * is about the client's trainer and not about whoever happens to be on the
 * session row. A session logged by a covering trainer still belongs to the
 * client's own trainer.
 */
function trainerWhere(req, params, col = 'c.trainer_id') {
  // A member is neither an all-clients role nor a trainer, so without this it
  // fell through to '' — no narrowing at all. Matching nothing is the correct
  // answer here: this clause constrains by TRAINER, and a member has no
  // trainer relationship to constrain by. A member-facing list must scope on
  // the client id itself rather than reach for this.
  if (req.user?.role === 'member') return ' AND FALSE';
  if (seesAllClients(req) || !req.user?.trainer_id) return '';
  params.push(req.user.trainer_id);
  return ` AND ${col} = $${params.length}`;
}

/**
 * True when this request may act on this client at all.
 *
 * The member branch is the boundary the header above did not name, and its
 * absence was a latent hole rather than a live one: `trainerWhere` returns ''
 * when the caller has no trainer_id, and a member has none — so for a member
 * this degraded to an ORG-ONLY check and any client in the studio passed.
 *
 * Every current caller sits behind requireRole('admin','manager','trainer'),
 * so no member can reach one today. This closes it anyway, because the next
 * caller added without that gate would inherit the hole silently, and "safe
 * because of something in another file" is how the twelve untenanted tables
 * happened.
 */
async function canAccessClient(req, clientId) {
  if (!clientId) return false;
  if (req.user?.role === 'member') {
    const own = req.user.pt_client_id || req.user.client_id || null;
    return Boolean(own) && own === clientId;
  }
  const params = [clientId];
  const org = orgWhere(req, params);
  const trainer = trainerWhere(req, params);
  const { rowCount } = await pool.query(
    `SELECT 1 FROM pt_clients c
      WHERE c.id = $1 AND c.deleted_at IS NULL${org}${trainer}`,
    params
  );
  return rowCount > 0;
}

/**
 * The session, if this request may see it. Otherwise null.
 *
 * Joins to pt_clients so the trainer rule is applied against the CLIENT's
 * trainer, and checks the org on both the session and the client — a row
 * whose two org columns disagree is corrupt, and should be unreachable rather
 * than reachable through whichever one the query happened to name.
 */
async function loadSession(req, sessionId, client = pool) {
  if (!sessionId) return null;
  const params = [sessionId];
  const org = orgWhere(req, params, 's.organization_id');
  const trainer = trainerWhere(req, params);
  const { rows } = await client.query(
    `SELECT s.* FROM training_sessions s
       JOIN pt_clients c ON c.id = s.client_id
      WHERE s.id = $1 AND s.deleted_at IS NULL AND c.deleted_at IS NULL${org}${trainer}`,
    params
  );
  return rows[0] ?? null;
}

/**
 * An exercise performance, reached through its session.
 *
 * This is the walk-up-the-tree the header describes: performances carry no
 * organization_id, so the only safe route to one is through the session that
 * owns it and the client that owns THAT.
 */
async function loadPerformance(req, performanceId, client = pool) {
  if (!performanceId) return null;
  const params = [performanceId];
  const org = orgWhere(req, params, 's.organization_id');
  const trainer = trainerWhere(req, params);
  const { rows } = await client.query(
    `SELECT ep.*, s.client_id, s.organization_id, s.status AS session_status
       FROM exercise_performances ep
       JOIN training_sessions s ON s.id = ep.session_id
       JOIN pt_clients c        ON c.id = s.client_id
      WHERE ep.id = $1 AND s.deleted_at IS NULL AND c.deleted_at IS NULL${org}${trainer}`,
    params
  );
  return rows[0] ?? null;
}

/** A set, reached through performance → session → client. */
async function loadSet(req, setId, client = pool) {
  if (!setId) return null;
  const params = [setId];
  const org = orgWhere(req, params, 's.organization_id');
  const trainer = trainerWhere(req, params);
  const { rows } = await client.query(
    `SELECT sp.*, s.id AS session_id, s.client_id
       FROM set_performances sp
       JOIN exercise_performances ep ON ep.id = sp.exercise_performance_id
       JOIN training_sessions s      ON s.id = ep.session_id
       JOIN pt_clients c             ON c.id = s.client_id
      WHERE sp.id = $1 AND s.deleted_at IS NULL AND c.deleted_at IS NULL${org}${trainer}`,
    params
  );
  return rows[0] ?? null;
}

/** A cardio effort, reached the same way. */
async function loadCardio(req, cardioId, client = pool) {
  if (!cardioId) return null;
  const params = [cardioId];
  const org = orgWhere(req, params, 's.organization_id');
  const trainer = trainerWhere(req, params);
  const { rows } = await client.query(
    `SELECT cp.*, s.id AS session_id, s.client_id
       FROM cardio_performances cp
       JOIN exercise_performances ep ON ep.id = cp.exercise_performance_id
       JOIN training_sessions s      ON s.id = ep.session_id
       JOIN pt_clients c             ON c.id = s.client_id
      WHERE cp.id = $1 AND s.deleted_at IS NULL AND c.deleted_at IS NULL${org}${trainer}`,
    params
  );
  return rows[0] ?? null;
}

/**
 * A program or template, by org alone.
 *
 * No trainer clause: a studio's programme library is shared, and a trainer
 * building from a colleague's template is the normal case rather than a leak.
 * The CLIENT-bound rows (assignments, sessions) are where the trainer rule
 * bites, which is where a client's private history actually lives.
 */
async function loadOwned(req, table, id, client = pool) {
  const ALLOWED = ['training_programs', 'workout_templates', 'training_assignments'];
  if (!ALLOWED.includes(table)) throw new Error(`loadOwned: unsupported table ${table}`);
  if (!id) return null;
  const params = [id];
  const org = orgWhere(req, params);
  const softDelete = table === 'training_assignments' ? '' : ' AND deleted_at IS NULL';
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1${softDelete}${org}`,
    params
  );
  return rows[0] ?? null;
}

module.exports = {
  ALL_CLIENT_ROLES, seesAllClients,
  orgWhere, trainerWhere,
  canAccessClient, loadSession, loadPerformance, loadSet, loadCardio, loadOwned,
};

'use strict';
// Which client may this Copilot request name?
//
// Two filters, applied in this order and never merged:
//
//   1. findVisibleClient() — the shared tenant gate. A client in another
//      studio, or a deleted client, yields null and no further read happens.
//   2. The configured access policy. `organization_wide` accepts the shared
//      gate's answer; `assigned_clients_only` additionally requires
//      pt_clients.trainer_id to match the caller's users.trainer_id.
//
// Keeping the tenant check in the shared primitive is deliberate: when
// per-trainer restrictions are eventually adopted for the rest of the app,
// this module must not be the only place that knows about them.

const pool = require('../../../db/pool');
const { findVisibleClient } = require('../../pt-os/client-read.service');

const DEFAULT_LIST_LIMIT = 100;

/**
 * One client the caller may use as Copilot context, or null.
 *
 * Null is the single answer for "does not exist", "deleted", "another studio"
 * and "not assigned to you", so the caller cannot distinguish them.
 */
async function resolveSelectedClient(ctx, clientId) {
  if (!clientId) return null;

  const visible = await findVisibleClient(ctx.organizationId, clientId);
  if (!visible) return null;
  if (ctx.policy !== 'assigned_clients_only') return visible;

  // A caller with no trainer id has no assignments; do not let a NULL bind
  // turn into "match everyone".
  if (!ctx.trainerId) return null;

  const { rows } = await pool.query(
    `SELECT id, name
       FROM pt_clients
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        AND trainer_id = $3`,
    [clientId, ctx.organizationId, ctx.trainerId]
  );
  return rows[0] || null;
}

/** Bounded id/name list for the workspace's client picker. */
async function listVisibleClients(ctx, { limit = DEFAULT_LIST_LIMIT } = {}) {
  const requested = Number(limit);
  const capped = Math.min(
    Math.max(Number.isFinite(requested) ? requested : DEFAULT_LIST_LIMIT, 1),
    DEFAULT_LIST_LIMIT
  );

  const params = [ctx.organizationId];
  let trainerClause = '';
  if (ctx.policy === 'assigned_clients_only') {
    if (!ctx.trainerId) return [];
    params.push(ctx.trainerId);
    trainerClause = ` AND trainer_id = $${params.length}`;
  }
  params.push(capped);

  const { rows } = await pool.query(
    `SELECT id, name
       FROM pt_clients
      WHERE organization_id = $1 AND deleted_at IS NULL${trainerClause}
      ORDER BY name ASC, id ASC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

module.exports = { resolveSelectedClient, listVisibleClients };

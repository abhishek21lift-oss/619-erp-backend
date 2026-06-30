'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { PermissionValidator } = require('../middleware/PermissionValidator');

// ─── Tool implementations ────────────────────────────────────────────────────

async function search({ query, limit = 10 }, context) {
  const like  = `%${query}%`;
  const params = [like];
  let p = 2;
  const conditions = [
    `(c.first_name ILIKE $1 OR c.last_name ILIKE $1 OR c.mobile ILIKE $1 OR c.email ILIKE $1)`,
    `c.deleted_at IS NULL`,
  ];

  if (context.isTrainer() && context.trainerId) {
    conditions.push(`c.trainer_id = $${p++}`); params.push(context.trainerId);
  }

  const { rows } = await pool.query(
    `SELECT c.id,
            c.first_name || ' ' || c.last_name AS name,
            c.mobile, c.email, c.status, c.trainer_name,
            c.pt_end_date, c.balance
     FROM pt_clients c
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.first_name, c.last_name
     LIMIT $${p}`,
    [...params, limit]
  );
  return { query, count: rows.length, clients: rows };
}

async function getProfile({ client_id }, context) {
  const { rows } = await pool.query(
    `SELECT c.*,
            (SELECT json_agg(g ORDER BY g.created_at DESC) FROM pt_goals g WHERE g.client_id = c.id AND g.status = 'active') AS active_goals,
            (SELECT json_agg(a ORDER BY a.created_at DESC LIMIT 3) FROM pt_assessments a WHERE a.client_id = c.id) AS recent_assessments
     FROM pt_clients c
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [client_id]
  );
  if (!rows[0]) throw new Error('Client not found');

  const client = rows[0];
  if (context.isTrainer()) {
    PermissionValidator.requireTrainerOwnership(context, client.trainer_id);
  }

  return client;
}

async function getHealthConditions({ client_id }, context) {
  const { rows: [client] } = await pool.query(
    `SELECT id, first_name || ' ' || last_name AS name,
            medical_conditions, injuries, medications, allergies
     FROM pt_clients WHERE id = $1 AND deleted_at IS NULL`,
    [client_id]
  );
  if (!client) throw new Error('Client not found');
  if (context.isTrainer()) PermissionValidator.requireTrainerOwnership(context, client.trainer_id);
  return client;
}

async function searchByCondition({ condition, limit = 20 }, context) {
  const like = `%${condition}%`;
  const params = [like];
  let p = 2;
  const extra = [];
  if (context.isTrainer() && context.trainerId) {
    extra.push(`c.trainer_id = $${p++}`); params.push(context.trainerId);
  }

  const { rows } = await pool.query(
    `SELECT c.id, c.first_name || ' ' || c.last_name AS name,
            c.mobile, c.medical_conditions, c.injuries, c.trainer_name
     FROM pt_clients c
     WHERE c.deleted_at IS NULL
       AND (c.medical_conditions ILIKE $1 OR c.injuries ILIKE $1 OR c.allergies ILIKE $1)
       ${extra.length ? 'AND ' + extra.join(' AND ') : ''}
     ORDER BY c.first_name
     LIMIT $${p}`,
    [...params, limit]
  );
  return { condition, count: rows.length, clients: rows };
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('client.search',
    search,
    z.object({
      query: z.string().min(1).max(100),
      limit: z.number().int().max(50).optional(),
    }),
    ['admin','manager','trainer','staff','reception','receptionist'],
    false
  )
  .register('client.getProfile',
    getProfile,
    z.object({ client_id: z.union([z.string(), z.number()]) }),
    ['admin','manager','trainer','staff'],
    false
  )
  .register('client.getHealthConditions',
    getHealthConditions,
    z.object({ client_id: z.union([z.string(), z.number()]) }),
    ['admin','manager','trainer'],
    false
  )
  .register('client.searchByCondition',
    searchByCondition,
    z.object({
      condition: z.string().min(1).max(100),
      limit: z.number().int().max(100).optional(),
    }),
    ['admin','manager','trainer'],
    false
  );

module.exports = { search, getProfile, getHealthConditions, searchByCondition };

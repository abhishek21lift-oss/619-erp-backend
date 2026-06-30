'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { PermissionValidator } = require('../middleware/PermissionValidator');

// ─── Tool implementations ────────────────────────────────────────────────────

async function listTrainers({ limit = 50 }, context) {
  const { rows } = await pool.query(
    `SELECT t.id, t.first_name || ' ' || t.last_name AS name,
            t.specialization, t.mobile, t.email, t.status,
            COUNT(DISTINCT c.id) AS client_count
     FROM pt_trainers t
     LEFT JOIN pt_clients c ON c.trainer_id = t.id AND c.deleted_at IS NULL AND c.status = 'active'
     WHERE t.deleted_at IS NULL
     GROUP BY t.id
     ORDER BY t.first_name
     LIMIT $1`,
    [limit]
  );
  return { count: rows.length, trainers: rows };
}

async function getTrainerStats({ trainer_id, from, to }, context) {
  const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toDate   = to   || new Date().toISOString().slice(0, 10);

  const [trainer, sessions, revenue, clients] = await Promise.all([
    pool.query(
      `SELECT id, first_name || ' ' || last_name AS name, specialization, mobile, email
       FROM pt_trainers WHERE id = $1 AND deleted_at IS NULL`,
      [trainer_id]
    ),
    pool.query(
      `SELECT COUNT(*) AS total_sessions,
              COUNT(DISTINCT client_id) AS active_clients
       FROM pt_sessions WHERE trainer_id = $1 AND date BETWEEN $2 AND $3`,
      [trainer_id, fromDate, toDate]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total_revenue, COUNT(*) AS payments
       FROM pt_payments WHERE trainer_id = $1 AND date BETWEEN $2 AND $3`,
      [trainer_id, fromDate, toDate]
    ),
    pool.query(
      `SELECT COUNT(*) AS total_clients,
              COUNT(*) FILTER (WHERE status = 'active') AS active_clients
       FROM pt_clients WHERE trainer_id = $1 AND deleted_at IS NULL`,
      [trainer_id]
    ),
  ]);

  if (!trainer.rows[0]) throw new Error('Trainer not found');

  return {
    trainer:  trainer.rows[0],
    period:   { from: fromDate, to: toDate },
    sessions: sessions.rows[0],
    revenue:  revenue.rows[0],
    clients:  clients.rows[0],
  };
}

async function assignTrainer({ client_id, trainer_id }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager');

  const [{ rows: [client] }, { rows: [trainer] }] = await Promise.all([
    pool.query(`SELECT id, first_name || ' ' || last_name AS name FROM pt_clients WHERE id=$1 AND deleted_at IS NULL`, [client_id]),
    pool.query(`SELECT id, first_name || ' ' || last_name AS name FROM pt_trainers WHERE id=$1 AND deleted_at IS NULL`, [trainer_id]),
  ]);
  if (!client)  throw new Error('Client not found');
  if (!trainer) throw new Error('Trainer not found');

  await pool.query(
    `UPDATE pt_clients SET trainer_id = $1, trainer_name = $2, updated_at = NOW() WHERE id = $3`,
    [trainer_id, trainer.name, client_id]
  );

  return { success: true, client_name: client.name, trainer_name: trainer.name };
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('trainer.list',
    listTrainers,
    z.object({ limit: z.number().int().max(100).optional() }),
    ['admin','manager','trainer','staff'],
    false
  )
  .register('trainer.getStats',
    getTrainerStats,
    z.object({
      trainer_id: z.union([z.string(), z.number()]),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    ['admin','manager'],
    false
  )
  .register('trainer.assign',
    assignTrainer,
    z.object({
      client_id:  z.union([z.string(), z.number()]),
      trainer_id: z.union([z.string(), z.number()]),
    }),
    ['admin','manager'],
    true  // write action
  );

module.exports = { listTrainers, getTrainerStats, assignTrainer };

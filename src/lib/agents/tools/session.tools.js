'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { PermissionValidator } = require('../middleware/PermissionValidator');

// ─── Tool implementations ────────────────────────────────────────────────────

async function listSessions({ date, client_id, trainer_id, from, to, limit = 50 }, context) {
  const conditions = [];
  const params     = [];
  let p = 1;

  if (context.isTrainer() && context.trainerId) {
    conditions.push(`s.trainer_id = $${p++}`); params.push(context.trainerId);
  } else if (trainer_id) {
    conditions.push(`s.trainer_id = $${p++}`); params.push(trainer_id);
  }
  if (client_id) { conditions.push(`s.client_id = $${p++}`); params.push(client_id); }
  if (date)      { conditions.push(`s.date = $${p++}`);     params.push(date); }
  if (from)      { conditions.push(`s.date >= $${p++}`);    params.push(from); }
  if (to)        { conditions.push(`s.date <= $${p++}`);    params.push(to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT s.id, s.client_id, s.trainer_id,
            c.first_name || ' ' || c.last_name AS client_name,
            t.first_name || ' ' || t.last_name AS trainer_name,
            s.date, s.time, s.duration_mins, s.status, s.notes
     FROM pt_sessions s
     LEFT JOIN pt_clients c ON c.id = s.client_id
     LEFT JOIN pt_trainers t ON t.id = s.trainer_id
     ${where}
     ORDER BY s.date ASC, s.time ASC
     LIMIT $${p}`,
    [...params, limit]
  );
  return { count: rows.length, sessions: rows };
}

async function bookSession({ client_id, trainer_id, date, time, duration_mins = 60, notes }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager', 'trainer', 'staff', 'reception', 'receptionist');

  const [{ rows: [client] }, { rows: [trainer] }] = await Promise.all([
    pool.query(`SELECT id, first_name || ' ' || last_name AS name, trainer_id FROM pt_clients WHERE id=$1 AND deleted_at IS NULL`, [client_id]),
    pool.query(`SELECT id, first_name || ' ' || last_name AS name FROM pt_trainers WHERE id=$1 AND deleted_at IS NULL`, [trainer_id]),
  ]);
  if (!client)  throw new Error('Client not found');
  if (!trainer) throw new Error('Trainer not found');
  if (context.isTrainer()) PermissionValidator.requireTrainerOwnership(context, client.trainer_id);

  const { rows } = await pool.query(
    `INSERT INTO pt_sessions (client_id, trainer_id, date, time, duration_mins, status, notes)
     VALUES ($1,$2,$3,$4,$5,'scheduled',$6)
     RETURNING id, date, time, duration_mins`,
    [client_id, trainer_id, date, time || null, duration_mins, notes || null]
  );

  return {
    success:      true,
    session:      rows[0],
    client_name:  client.name,
    trainer_name: trainer.name,
  };
}

async function cancelSession({ session_id, reason }, context) {
  PermissionValidator.requireRole(context, 'admin', 'manager', 'trainer', 'staff');

  const { rows: [session] } = await pool.query(
    `SELECT s.*, c.first_name || ' ' || c.last_name AS client_name,
            t.first_name || ' ' || t.last_name AS trainer_name
     FROM pt_sessions s
     LEFT JOIN pt_clients  c ON c.id = s.client_id
     LEFT JOIN pt_trainers t ON t.id = s.trainer_id
     WHERE s.id = $1`,
    [session_id]
  );
  if (!session) throw new Error('Session not found');
  if (context.isTrainer()) PermissionValidator.requireTrainerOwnership(context, session.trainer_id);

  await pool.query(
    `UPDATE pt_sessions SET status = 'cancelled', notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $1`,
    [session_id, reason || null]
  );

  return { success: true, session_id, client_name: session.client_name, date: session.date };
}

async function getSchedule({ date, trainer_id }, context) {
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const tid = trainer_id || (context.isTrainer() ? context.trainerId : null);

  const conditions = [`s.date = $1`, `s.status != 'cancelled'`];
  const params = [targetDate];
  let p = 2;
  if (tid) { conditions.push(`s.trainer_id = $${p++}`); params.push(tid); }

  const { rows } = await pool.query(
    `SELECT s.id, s.time, s.duration_mins, s.status,
            c.first_name || ' ' || c.last_name AS client_name,
            t.first_name || ' ' || t.last_name AS trainer_name,
            s.notes
     FROM pt_sessions s
     LEFT JOIN pt_clients  c ON c.id = s.client_id
     LEFT JOIN pt_trainers t ON t.id = s.trainer_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.time ASC`,
    params
  );
  return { date: targetDate, count: rows.length, schedule: rows };
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('session.list',
    listSessions,
    z.object({
      date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      client_id:  z.union([z.string(), z.number()]).optional(),
      trainer_id: z.union([z.string(), z.number()]).optional(),
      from:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit:      z.number().int().max(200).optional(),
    }),
    ['admin','manager','trainer','staff','reception','receptionist'],
    false
  )
  .register('session.book',
    bookSession,
    z.object({
      client_id:    z.union([z.string(), z.number()]),
      trainer_id:   z.union([z.string(), z.number()]),
      date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      time:         z.string().optional(),
      duration_mins:z.number().int().min(15).max(180).optional(),
      notes:        z.string().optional(),
    }),
    ['admin','manager','trainer','staff','reception','receptionist'],
    true  // write action
  )
  .register('session.cancel',
    cancelSession,
    z.object({
      session_id: z.union([z.string(), z.number()]),
      reason:     z.string().optional(),
    }),
    ['admin','manager','trainer','staff'],
    true  // write action
  )
  .register('session.getSchedule',
    getSchedule,
    z.object({
      date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      trainer_id: z.union([z.string(), z.number()]).optional(),
    }),
    ['admin','manager','trainer','staff','reception','receptionist'],
    false
  );

module.exports = { listSessions, bookSession, cancelSession, getSchedule };

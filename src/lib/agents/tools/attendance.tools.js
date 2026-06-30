'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');

// ─── Tool implementations ────────────────────────────────────────────────────

async function getToday({ date, type = 'client', limit = 200 }, context) {
  const today = date || new Date().toISOString().slice(0, 10);
  const conditions = ['a.date = $1'];
  const params     = [today];
  let p = 2;

  if (type) { conditions.push(`a.ref_type = $${p++}`); params.push(type); }
  if (context.branchId) { conditions.push(`a.branch_id = $${p++}`); params.push(context.branchId); }

  const { rows } = await pool.query(
    `SELECT a.ref_id, a.ref_name, a.date,
            a.check_in_time  AS check_in,
            a.check_out_time AS check_out,
            a.status, a.method
     FROM attendance_logs a
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.check_in_time DESC NULLS LAST
     LIMIT $${p}`,
    [...params, limit]
  );
  return { date: today, count: rows.length, records: rows };
}

async function getAbsentees({ date, limit = 200 }, context) {
  const today = date || new Date().toISOString().slice(0, 10);

  // PT clients who have no attendance_log entry for the given date
  const conditions = ['c.deleted_at IS NULL', 'c.status = \'active\''];
  const params     = [today];
  let p = 2;
  if (context.branchId) { conditions.push(`c.branch_id = $${p++}`); params.push(context.branchId); }
  if (context.isTrainer() && context.trainerId) {
    conditions.push(`c.trainer_id = $${p++}`); params.push(context.trainerId);
  }

  const { rows } = await pool.query(
    `SELECT c.id, c.first_name || ' ' || c.last_name AS name,
            c.mobile, c.trainer_name
     FROM pt_clients c
     WHERE ${conditions.join(' AND ')}
       AND NOT EXISTS (
         SELECT 1 FROM attendance_logs a
         WHERE a.ref_id = c.id AND a.ref_type = 'client' AND a.date = $1
       )
     ORDER BY c.first_name
     LIMIT $${p}`,
    [...params, limit]
  );
  return { date: today, absent_count: rows.length, absent_members: rows };
}

async function getReport({ from, to, type = 'client' }, context) {
  const fromDate = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const toDate   = to   || new Date().toISOString().slice(0, 10);

  const conditions = ['a.date BETWEEN $1 AND $2', `a.ref_type = $3`];
  const params     = [fromDate, toDate, type];
  let p = 4;
  if (context.branchId) { conditions.push(`a.branch_id = $${p++}`); params.push(context.branchId); }

  const [summary, daily] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) AS total_checkins,
         COUNT(DISTINCT a.ref_id) AS unique_members,
         COUNT(a.check_out_time) AS with_checkout,
         SUM(CASE WHEN a.method = 'face' THEN 1 ELSE 0 END) AS face_checkins
       FROM attendance_logs a
       WHERE ${conditions.join(' AND ')}`,
      params
    ),
    pool.query(
      `SELECT a.date, COUNT(*) AS count
       FROM attendance_logs a
       WHERE ${conditions.join(' AND ')}
       GROUP BY a.date ORDER BY a.date ASC`,
      params
    ),
  ]);

  return {
    period: { from: fromDate, to: toDate },
    summary:     summary.rows[0],
    daily_trend: daily.rows,
  };
}

async function checkIn({ ref_id, ref_type = 'client', method = 'manual', notes }, context) {
  const today     = new Date().toISOString().slice(0, 10);
  const now       = new Date().toISOString();
  const ref_name  = await _getRefName(ref_id, ref_type);

  const { rows } = await pool.query(
    `INSERT INTO attendance_logs (ref_id, ref_type, ref_name, date, check_in_time, status, method, notes, marked_by, branch_id)
     VALUES ($1,$2,$3,$4,$5,'present',$6,$7,$8,$9)
     ON CONFLICT (ref_id, ref_type, date) DO UPDATE
       SET check_in_time = EXCLUDED.check_in_time, method = EXCLUDED.method
     RETURNING id, date, check_in_time`,
    [ref_id, ref_type, ref_name, today, now, method, notes || null, context.userId, context.branchId]
  );
  return { success: true, ...rows[0], ref_name };
}

async function checkOut({ ref_id, ref_type = 'client' }, context) {
  const today = new Date().toISOString().slice(0, 10);
  const now   = new Date().toISOString();

  const { rows } = await pool.query(
    `UPDATE attendance_logs
     SET check_out_time = $3
     WHERE ref_id = $1 AND ref_type = $2 AND date = $4 AND check_out_time IS NULL
     RETURNING id, check_in_time, check_out_time`,
    [ref_id, ref_type, now, today]
  );
  if (!rows.length) return { success: false, message: 'No open check-in found for today' };
  return { success: true, ...rows[0] };
}

async function _getRefName(ref_id, ref_type) {
  try {
    if (ref_type === 'client') {
      const { rows } = await pool.query(
        `SELECT first_name || ' ' || last_name AS name FROM pt_clients WHERE id = $1`,
        [ref_id]
      );
      return rows[0]?.name || String(ref_id);
    }
    if (ref_type === 'staff') {
      const { rows } = await pool.query(`SELECT name FROM users WHERE id = $1`, [ref_id]);
      return rows[0]?.name || String(ref_id);
    }
  } catch { /* ignore */ }
  return String(ref_id);
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('attendance.getToday',
    getToday,
    z.object({
      date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      type:  z.enum(['client','staff','trainer']).optional(),
      limit: z.number().int().max(500).optional(),
    }),
    ['admin','manager','trainer','staff','reception','receptionist'],
    false
  )
  .register('attendance.getAbsentees',
    getAbsentees,
    z.object({
      date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().max(500).optional(),
    }),
    ['admin','manager','trainer','staff'],
    false
  )
  .register('attendance.getReport',
    getReport,
    z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      type: z.enum(['client','staff','trainer']).optional(),
    }),
    ['admin','manager','trainer','staff'],
    false
  )
  .register('attendance.checkIn',
    checkIn,
    z.object({
      ref_id:   z.union([z.string(), z.number()]),
      ref_type: z.enum(['client','staff','trainer']).optional(),
      method:   z.string().optional(),
      notes:    z.string().optional(),
    }),
    ['admin','manager','trainer','staff','reception','receptionist'],
    true  // write action
  )
  .register('attendance.checkOut',
    checkOut,
    z.object({
      ref_id:   z.union([z.string(), z.number()]),
      ref_type: z.enum(['client','staff','trainer']).optional(),
    }),
    ['admin','manager','trainer','staff','reception','receptionist'],
    true  // write action
  );

module.exports = { getToday, getAbsentees, getReport, checkIn, checkOut };

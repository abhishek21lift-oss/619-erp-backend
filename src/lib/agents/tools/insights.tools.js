'use strict';
const { z }    = require('zod');
const pool     = require('../../../db/pool');
const { toolRegistry } = require('../registry/ToolRegistry');
const { PermissionValidator } = require('../middleware/PermissionValidator');

// ─── Tool implementations ────────────────────────────────────────────────────

async function getBusinessSnapshot({ from, to }, context) {
  PermissionValidator.requireMinRole(context, 'manager');
  const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toDate   = to   || new Date().toISOString().slice(0, 10);

  const [revenueRes, membersRes, sessionsRes, trainersRes, renewalsRes, duesRes] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total_revenue, COUNT(*) AS total_payments
       FROM pt_payments WHERE date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status='active') AS active_members,
              COUNT(*) FILTER (WHERE status='inactive') AS inactive_members,
              COUNT(*) FILTER (WHERE pt_start_date BETWEEN $1 AND $2) AS new_members_period
       FROM pt_clients WHERE deleted_at IS NULL`,
      [fromDate, toDate]
    ),
    pool.query(
      `SELECT COUNT(*) AS total_sessions, COUNT(DISTINCT client_id) AS active_clients
       FROM pt_sessions WHERE date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    pool.query(
      `SELECT t.first_name||' '||t.last_name AS trainer_name,
              COUNT(s.id) AS sessions, COALESCE(SUM(p.amount),0) AS revenue
       FROM pt_trainers t
       LEFT JOIN pt_sessions s ON s.trainer_id=t.id AND s.date BETWEEN $1 AND $2
       LEFT JOIN pt_payments p ON p.trainer_id=t.id AND p.date BETWEEN $1 AND $2
       WHERE t.deleted_at IS NULL
       GROUP BY t.id, trainer_name ORDER BY revenue DESC`,
      [fromDate, toDate]
    ),
    pool.query(
      `SELECT COUNT(*) AS total_renewals, COALESCE(SUM(paid_amount),0) AS renewal_revenue
       FROM pt_client_renewals WHERE renewed_at BETWEEN $1 AND $2`,
      [fromDate, toDate]
    ),
    pool.query(
      `SELECT COUNT(*) AS clients_with_dues,
              COALESCE(SUM(ABS(balance)),0) AS total_dues
       FROM pt_clients WHERE deleted_at IS NULL AND balance < 0`
    ),
  ]);

  return {
    period:           { from: fromDate, to: toDate },
    revenue:          revenueRes.rows[0],
    members:          membersRes.rows[0],
    sessions:         sessionsRes.rows[0],
    trainers:         trainersRes.rows,
    renewals:         renewalsRes.rows[0],
    outstanding_dues: duesRes.rows[0],
  };
}

async function getRevenueTrend({ days = 30 }, context) {
  PermissionValidator.requireMinRole(context, 'manager');
  const { rows } = await pool.query(
    `SELECT date, SUM(amount) AS revenue, COUNT(*) AS payment_count
     FROM pt_payments
     WHERE date >= NOW() - INTERVAL '${parseInt(days)} days'
     GROUP BY date ORDER BY date ASC`
  );
  return { days, trend: rows };
}

async function getRetentionStats({}, context) {
  PermissionValidator.requireMinRole(context, 'manager');
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')   AS active,
       COUNT(*) FILTER (WHERE status = 'inactive') AS inactive,
       COUNT(*) FILTER (WHERE status = 'frozen')   AS frozen,
       COUNT(*) FILTER (WHERE pt_end_date < NOW() AND status = 'active') AS expired_but_active,
       COUNT(*) FILTER (WHERE pt_end_date > NOW() AND status = 'active') AS genuinely_active
     FROM pt_clients WHERE deleted_at IS NULL`
  );
  return rows[0];
}

// ─── Registration ────────────────────────────────────────────────────────────

toolRegistry
  .register('insights.getBusinessSnapshot',
    getBusinessSnapshot,
    z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    ['admin','manager'],
    false
  )
  .register('insights.getRevenueTrend',
    getRevenueTrend,
    z.object({ days: z.number().int().min(7).max(365).optional() }),
    ['admin','manager'],
    false
  )
  .register('insights.getRetentionStats',
    getRetentionStats,
    z.object({}),
    ['admin','manager'],
    false
  );

module.exports = { getBusinessSnapshot, getRevenueTrend, getRetentionStats };

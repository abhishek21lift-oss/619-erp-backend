'use strict';
/**
 * Canonical Metric Engine — the ONLY place Insights numbers are computed.
 *
 * Canonical Data → Metric Engine → Insights Engine → AI → Recommendation → Action
 *
 * Every function here:
 * - reads the owner table named in metric-definitions.js (never a legacy mirror),
 * - excludes soft-deleted rows (deleted_at IS NULL) where the table has the column,
 * - scopes to orgId when given (null = platform-wide, super_admin only — the
 *   route layer guarantees only super_admin can pass null),
 * - clamps trainers to their own trainer_id when trainerId is given,
 * - aggregates totals in SQL with no LIMIT (row lists are separate functions
 *   and are explicitly top-N).
 *
 * Reports, dashboards, AI tools and the platform console must call these
 * functions instead of embedding their own SQL for the same metric.
 */
const pool = require('../../db/pool');
const { METRICS, CHECKED_IN_STATUSES } = require('./metric-definitions');

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function defaultRange(from, to) {
  const t = to || new Date().toISOString().slice(0, 10);
  const f = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return { from: f, to: t };
}

// ── Revenue ──────────────────────────────────────────────────────────────────

async function getRevenue({ from, to, orgId = null, trainerId = null } = {}) {
  const { from: f, to: t } = defaultRange(from, to);
  const conds = ['p.deleted_at IS NULL', 'p.date >= $1', 'p.date <= $2'];
  const params = [f, t];
  if (trainerId) { params.push(trainerId); conds.push(`p.trainer_id = $${params.length}`); }
  if (orgId) { params.push(orgId); conds.push(`p.organization_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(p.amount), 0)::float AS total,
            COALESCE(SUM(p.incentive_amt), 0)::float AS total_incentives
       FROM pt_payments p WHERE ${conds.join(' AND ')}`,
    params
  );
  const r = rows[0] || {};
  return {
    metric: 'revenue_total',
    from: f, to: t,
    count: num(r.count, 0),
    total: num(r.total, 0),
    total_incentives: num(r.total_incentives, 0),
  };
}

async function getMonthlyRevenue({ year = new Date().getFullYear(), orgId = null, trainerId = null } = {}) {
  const params = [parseInt(year, 10)];
  let trainerWhere = '';
  if (trainerId) { params.push(trainerId); trainerWhere = `AND p.trainer_id = $${params.length}`; }
  params.push(orgId);
  const orgIdx = params.length;
  const { rows } = await pool.query(
    `SELECT month_num, month_name,
            COUNT(*)::int AS payment_count,
            COALESCE(SUM(revenue), 0)::float AS revenue,
            COALESCE(SUM(incentives), 0)::float AS incentives
       FROM (
         SELECT EXTRACT(MONTH FROM p.date::date) AS month_num,
                TRIM(TO_CHAR(DATE_TRUNC('month', p.date::date), 'Month')) AS month_name,
                p.amount AS revenue, p.incentive_amt AS incentives
           FROM pt_payments p
          WHERE EXTRACT(YEAR FROM p.date::date) = $1
            AND p.deleted_at IS NULL ${trainerWhere}
            AND ($${orgIdx}::uuid IS NULL OR p.organization_id = $${orgIdx})
       ) combined
      GROUP BY month_num, month_name ORDER BY month_num`,
    params
  );
  return rows.map((r) => ({
    month_num: num(r.month_num, 0),
    month_name: String(r.month_name || '').trim(),
    payment_count: num(r.payment_count, 0),
    revenue: num(r.revenue, 0),
    incentives: num(r.incentives, 0),
  }));
}

// ── Dues ─────────────────────────────────────────────────────────────────────

async function getDuesSummary({ high = 10000, medium = 3000, orgId = null, trainerId = null } = {}) {
  const params = [];
  let trainerFilter = '';
  if (trainerId) { params.push(trainerId); trainerFilter = ` AND trainer_id = $${params.length}`; }
  params.push(orgId);
  const orgIdx = params.length;
  params.push(Number(high));
  const highIdx = params.length;
  params.push(Number(medium));
  const medIdx = params.length;
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(balance_amount), 0)::float AS total_outstanding,
            COUNT(*)::int AS debtor_count,
            COUNT(*) FILTER (WHERE balance_amount >= $${highIdx})::int AS high_risk_count,
            COUNT(*) FILTER (WHERE balance_amount >= $${medIdx} AND balance_amount < $${highIdx})::int AS medium_risk_count
       FROM pt_clients
      WHERE balance_amount > 0 AND deleted_at IS NULL
        AND ($${orgIdx}::uuid IS NULL OR organization_id = $${orgIdx})${trainerFilter}`,
    params
  );
  const r = rows[0] || {};
  return {
    metric: 'dues_outstanding',
    total_outstanding: num(r.total_outstanding, 0),
    debtor_count: num(r.debtor_count, 0),
    high_risk_count: num(r.high_risk_count, 0),
    medium_risk_count: num(r.medium_risk_count, 0),
  };
}

/** Top-N debtors for tables. NEVER sum these rows for a total — use getDuesSummary. */
async function getDuesRows({ orgId = null, trainerId = null, limit = 100 } = {}) {
  const params = [];
  let trainerFilter = '';
  if (trainerId) { params.push(trainerId); trainerFilter = ` AND trainer_id = $${params.length}`; }
  params.push(orgId);
  const orgIdx = params.length;
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const limIdx = params.length;
  const { rows } = await pool.query(
    `SELECT id, client_id, name, mobile, trainer_name, photo_url,
            balance_amount, pt_end_date, status
       FROM pt_clients
      WHERE balance_amount > 0 AND deleted_at IS NULL
        AND ($${orgIdx}::uuid IS NULL OR organization_id = $${orgIdx})${trainerFilter}
      ORDER BY balance_amount DESC LIMIT $${limIdx}`,
    params
  );
  return rows;
}

// ── Attendance (canonical: present + late = visit) ───────────────────────────

async function getAttendanceStats({ from, to, granularity = 'day', orgId = null, trainerId = null } = {}) {
  const { from: f, to: t } = defaultRange(from, to);
  const g = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';
  const trunc = g === 'day' ? 'a.date' : `DATE_TRUNC('${g}', a.date)`;
  const params = [f, t];
  let trainerFilter = '';
  if (trainerId) {
    params.push(trainerId);
    trainerFilter = `AND a.ref_id IN (SELECT id FROM pt_clients WHERE trainer_id = $${params.length}) `;
  }
  params.push(orgId);
  const orgIdx = params.length;
  const { rows } = await pool.query(
    `SELECT ${trunc} AS period, a.status, COUNT(*)::int AS count
       FROM attendance_logs a
      WHERE a.date >= $1 AND a.date <= $2 ${trainerFilter}
        AND ($${orgIdx}::uuid IS NULL OR a.organization_id = $${orgIdx})
        AND a.ref_type = 'client'
      GROUP BY period, a.status ORDER BY period ASC`,
    params
  );
  const series = {};
  for (const r of rows) {
    const key = r.period instanceof Date ? r.period.toISOString().slice(0, 10) : String(r.period);
    if (!series[key]) series[key] = { date: key, present: 0, absent: 0, late: 0, total: 0, visits: 0 };
    const c = num(r.count, 0);
    if (r.status === 'present' || r.status === 'late' || r.status === 'absent') {
      series[key][r.status] = c;
    }
    series[key].total += c;
  }
  for (const k of Object.keys(series)) {
    const s = series[k];
    s.visits = s.present + s.late;
    const denom = s.present + s.late + s.absent;
    s.attendance_rate = denom > 0 ? Math.round(((s.present + s.late) / denom) * 1000) / 10 : null;
  }
  const list = Object.values(series);
  const totals = list.reduce(
    (a, s) => ({
      present: a.present + s.present,
      late: a.late + s.late,
      absent: a.absent + s.absent,
      total: a.total + s.total,
      visits: a.visits + s.visits,
    }),
    { present: 0, late: 0, absent: 0, total: 0, visits: 0 }
  );
  const denom = totals.present + totals.late + totals.absent;
  return {
    metric: 'attendance_visits',
    from: f, to: t, granularity: g,
    series: list,
    totals: {
      ...totals,
      attendance_rate: denom > 0 ? Math.round(((totals.present + totals.late) / denom) * 1000) / 10 : null,
    },
  };
}

async function getAttendanceToday({ orgId = null, trainerId = null } = {}) {
  const params = [];
  let trainerFilter = '';
  if (trainerId) {
    params.push(trainerId);
    trainerFilter = `AND a.ref_id IN (SELECT id FROM pt_clients WHERE trainer_id = $${params.length}) `;
  }
  params.push(orgId);
  const orgIdx = params.length;
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE a.status='present')::int AS present,
            COUNT(*) FILTER (WHERE a.status='absent')::int AS absent,
            COUNT(*) FILTER (WHERE a.status='late')::int AS late,
            COUNT(*)::int AS total
       FROM attendance_logs a
      WHERE a.date = CURRENT_DATE AND a.ref_type = 'client' ${trainerFilter}
        AND ($${orgIdx}::uuid IS NULL OR a.organization_id = $${orgIdx})`,
    params
  );
  const r = rows[0] || {};
  const present = num(r.present, 0);
  const late = num(r.late, 0);
  const absent = num(r.absent, 0);
  const denom = present + late + absent;
  return {
    present, late, absent,
    total: num(r.total, 0),
    visits: present + late,
    attendance_rate: denom > 0 ? Math.round(((present + late) / denom) * 1000) / 10 : null,
  };
}

// ── Renewal — TRUE conversion ────────────────────────────────────────────────
/**
 * TRUE renewal conversion for [from,to]:
 *   expired_cohort     = distinct clients whose pt_end_date falls in window
 *   renewed_of_cohort  = distinct renewals in window tied to that cohort
 *                        (old_end_date in window OR client in cohort)
 *   renewal_rate       = renewed_of_cohort / expired_cohort * 100 (null if cohort 0)
 *
 * Also returns active_share_pct (active/(active+expired)) explicitly labelled
 * so callers stop mistaking the snapshot for conversion.
 */
async function getRenewals({ from, to, orgId = null, trainerId = null } = {}) {
  const { from: f, to: t } = defaultRange(from, to);
  const params = [f, t, orgId, trainerId];
  // Trainer clamp ($4): a trainer sees only their own roster's conversion.
  // Staff/admin pass null and see the studio. Same contract as dues/attendance.
  const tClause = `AND ($4 IS NULL OR c.trainer_id = $4)`;
  const rtClause = `AND ($4 IS NULL OR r.client_id IN (SELECT id FROM pt_clients WHERE trainer_id = $4))`;
  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT DISTINCT c.id
         FROM pt_clients c
        WHERE c.deleted_at IS NULL
          AND c.pt_end_date::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR c.organization_id = $3)
          ${tClause}
     ),
     renewed AS (
       SELECT DISTINCT r.client_id
         FROM pt_client_renewals r
         LEFT JOIN pt_clients c ON c.id = r.client_id
        WHERE r.renewed_at::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR c.organization_id = $3)
          ${rtClause}
          AND (
            r.old_end_date::date BETWEEN $1::date AND $2::date
            OR r.client_id IN (SELECT id FROM cohort)
            OR r.old_end_date IS NULL
          )
     ),
     renewed_of_cohort AS (
       SELECT DISTINCT r.client_id
         FROM pt_client_renewals r
         LEFT JOIN pt_clients c ON c.id = r.client_id
        WHERE r.client_id IN (SELECT id FROM cohort)
          AND r.renewed_at::date BETWEEN $1::date AND ($2::date + INTERVAL '30 days')::date
          AND ($3::uuid IS NULL OR c.organization_id = $3)
     ),
     snapshot AS (
       SELECT COUNT(*) FILTER (WHERE status='active')::int AS active,
              COUNT(*) FILTER (WHERE status='expired')::int AS expired,
              COUNT(*) FILTER (WHERE status='active' AND pt_end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS expiring_7d,
              COUNT(*) FILTER (WHERE status='active' AND pt_end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS expiring_30d
         FROM pt_clients c
        WHERE c.deleted_at IS NULL
          AND ($3::uuid IS NULL OR c.organization_id = $3)
          ${tClause}
     ),
     renewal_rev AS (
       SELECT COALESCE(SUM(r.paid_amount),0)::float AS renewal_revenue,
              COUNT(*)::int AS renewal_transactions
         FROM pt_client_renewals r
         LEFT JOIN pt_clients c ON c.id = r.client_id
        WHERE r.renewed_at::date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR c.organization_id = $3)
          ${rtClause}
     )
     SELECT (SELECT COUNT(*) FROM cohort)::int AS expired_cohort,
            (SELECT COUNT(*) FROM renewed)::int AS renewed_in_period,
            (SELECT COUNT(*) FROM renewed_of_cohort)::int AS renewed_of_cohort,
            (SELECT active FROM snapshot)::int AS active,
            (SELECT expired FROM snapshot)::int AS expired,
            (SELECT expiring_7d FROM snapshot)::int AS expiring_7d,
            (SELECT expiring_30d FROM snapshot)::int AS expiring_30d,
            (SELECT renewal_revenue FROM renewal_rev)::float AS renewal_revenue,
            (SELECT renewal_transactions FROM renewal_rev)::int AS renewal_transactions`,
    params
  );
  const r = rows[0] || {};
  const expiredCohort = num(r.expired_cohort, 0);
  const renewedOfCohort = num(r.renewed_of_cohort, 0);
  const active = num(r.active, 0);
  const expired = num(r.expired, 0);
  return {
    metric: 'renewal_rate',
    from: f, to: t,
    expired_cohort: expiredCohort,
    renewed_in_period: num(r.renewed_in_period, 0),
    renewed_of_cohort: renewedOfCohort,
    renewal_rate: expiredCohort > 0 ? Math.round((renewedOfCohort / expiredCohort) * 1000) / 10 : null,
    renewal_revenue: num(r.renewal_revenue, 0),
    renewal_transactions: num(r.renewal_transactions, 0),
    active,
    expired,
    expiring_7d: num(r.expiring_7d, 0),
    expiring_30d: num(r.expiring_30d, 0),
    active_share_pct: active + expired > 0 ? Math.round((active / (active + expired)) * 1000) / 10 : null,
  };
}

/** Renewal pipeline rows (top-N by expiry). Totals come from getRenewals. */
async function getRenewalRows({ orgId = null, trainerId = null, days = 30, limit = 100 } = {}) {
  const params = [Math.min(Math.max(parseInt(days, 10) || 30, 1), 365)];
  let trainerFilter = '';
  if (trainerId) { params.push(trainerId); trainerFilter = ` AND trainer_id = $${params.length}`; }
  params.push(orgId);
  const orgIdx = params.length;
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const limIdx = params.length;
  const { rows } = await pool.query(
    `SELECT id, client_id, name, mobile, trainer_name, package_type, photo_url,
            pt_end_date::text AS pt_end_date,
            (pt_end_date::date - CURRENT_DATE)::int AS days_left,
            balance_amount, status
       FROM pt_clients
      WHERE deleted_at IS NULL AND status = 'active' AND pt_end_date IS NOT NULL
        AND pt_end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
        AND ($${orgIdx}::uuid IS NULL OR organization_id = $${orgIdx})${trainerFilter}
      ORDER BY pt_end_date ASC LIMIT $${limIdx}`,
    params
  );
  return rows.map((c) => ({ ...c, days_left: num(c.days_left, 0) }));
}

// ── Trainers (canonical: org on BOTH sides, soft-delete aware) ───────────────

async function getTrainerSummary({ orgId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.specialization,
            COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.status='active' AND ptc.deleted_at IS NULL)::int AS active_clients,
            COUNT(DISTINCT ptc.id) FILTER (WHERE ptc.deleted_at IS NULL)::int AS total_clients,
            COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.date >= DATE_TRUNC('month', NOW()) AND ptp.deleted_at IS NULL), 0)::float AS month_revenue,
            COALESCE(SUM(ptp.amount) FILTER (WHERE ptp.deleted_at IS NULL), 0)::float AS total_revenue
       FROM trainers t
       LEFT JOIN pt_clients ptc ON ptc.trainer_id = t.id
         AND ($1::uuid IS NULL OR ptc.organization_id = $1)
       LEFT JOIN pt_payments ptp ON ptp.trainer_id = t.id
         AND ptp.deleted_at IS NULL
         AND ($1::uuid IS NULL OR ptp.organization_id = $1)
      WHERE t.status = 'active' AND t.deleted_at IS NULL
        AND ($1::uuid IS NULL OR t.organization_id = $1)
      GROUP BY t.id, t.name, t.specialization
      ORDER BY total_revenue DESC`,
    [orgId]
  );
  return rows.map((r) => ({
    ...r,
    active_clients: num(r.active_clients, 0),
    total_clients: num(r.total_clients, 0),
    month_revenue: num(r.month_revenue, 0),
    total_revenue: num(r.total_revenue, 0),
  }));
}

// ── Utilisation (trained sessions, not booked diary) ─────────────────────────

async function getUtilization({ orgId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (
              WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE)
                AND session_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
            )::int AS this_month_total,
            COUNT(*) FILTER (
              WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE)
                AND session_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
                AND status = 'completed'
            )::int AS this_month_completed,
            COUNT(*) FILTER (
              WHERE session_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
                AND session_date < DATE_TRUNC('month', CURRENT_DATE)
                AND status = 'completed'
            )::int AS last_month_completed
       FROM workout_sessions WHERE TRUE
         AND ($1::uuid IS NULL OR organization_id = $1)`,
    [orgId]
  );
  const r = rows[0] || {};
  const total = num(r.this_month_total, 0);
  const done = num(r.this_month_completed, 0);
  return {
    metric: 'session_utilisation_pct',
    this_month_total: total,
    this_month_completed: done,
    last_month_completed: num(r.last_month_completed, 0),
    utilisation_pct: total > 0 ? Math.round((done / total) * 1000) / 10 : null,
  };
}

// ── Overview: ONE dataset for KPIs + charts + tables ─────────────────────────
/**
 * Returns every headline metric for the same {from,to,org,trainer} window in a
 * single response so charts, KPI cards and tables cannot disagree with each
 * other. Pages must prefer this over firing N independent calls with N
 * slightly different date windows.
 */
async function getOverview({ from, to, year, orgId = null, trainerId = null } = {}) {
  const { from: f, to: t } = defaultRange(from, to);
  const [revenue, dues, attendance, renewals, utilisation, monthly, trainers] = await Promise.all([
    getRevenue({ from: f, to: t, orgId, trainerId }),
    getDuesSummary({ orgId, trainerId }),
    getAttendanceStats({ from: f, to: t, orgId, trainerId }),
    getRenewals({ from: f, to: t, orgId, trainerId }),
    getUtilization({ orgId }),
    getMonthlyRevenue({ year: year || new Date(t).getFullYear(), orgId, trainerId }),
    getTrainerSummary({ orgId }),
  ]);
  return {
    metric_engine: 'canonical/v1',
    definitions: Object.keys(METRICS),
    window: { from: f, to: t },
    revenue, dues, attendance, renewals, utilisation, monthly, trainers,
  };
}

/**
 * One person's OWN attendance history, and the stats over it.
 *
 * Self-scoped rather than org-scoped: the caller is asking about themselves and
 * refId comes from their session, never from the request. It belongs here
 * anyway, because it is the same metric as getAttendanceStats above — a visit
 * is present + late — and the two disagreed until it moved. The member-facing
 * endpoint counted both, the studio-facing attendance page counted 'present'
 * alone, so one person had two attendance rates depending on who was looking.
 *
 * ── Why the stats are their own query ──────────────────────────────────────
 *
 * `limit` bounds the history LIST, and only that. GET /api/qr/my-history used
 * to derive total_days, total_present, this_month, avg_duration and both
 * streaks from that same capped array, so past 90 records the denominator
 * stopped growing: a member who had attended 200 times was shown their rate
 * over the most recent 90, labelled as their overall rate, and `total_days`
 * read 90 forever. Same fault /api/reports/dues had — the reason
 * getDuesSummary exists separately from getDuesRows.
 */
async function getSelfAttendanceHistory({ refId, refType, limit = 90 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 90, 1), 365);

  const { rows: history } = await pool.query(
    `SELECT date, status, check_in_time, check_out_time, method, duration_minutes
       FROM attendance_logs
      WHERE ref_id = $1 AND ref_type = $2
      ORDER BY date DESC
      LIMIT $3`,
    [refId, refType, cap]
  );

  const { rows: agg } = await pool.query(
    `SELECT COUNT(*)::int AS total_days,
            COUNT(*) FILTER (WHERE a.status = ANY($3))::int AS total_present,
            COUNT(*) FILTER (WHERE a.status = ANY($3)
                             AND a.date >= DATE_TRUNC('month', CURRENT_DATE))::int AS this_month,
            ROUND(AVG(a.duration_minutes) FILTER (WHERE a.duration_minutes > 0))::int AS avg_duration
       FROM attendance_logs a
      WHERE a.ref_id = $1 AND a.ref_type = $2`,
    [refId, refType, CHECKED_IN_STATUSES]
  );

  // Streaks walk back a year, so they need a year of dates — not whatever
  // fraction of one the display page happened to include.
  const { rows: streak } = await pool.query(
    `SELECT a.date
       FROM attendance_logs a
      WHERE a.ref_id = $1 AND a.ref_type = $2
        AND a.status = ANY($3)
        AND a.date >= CURRENT_DATE - INTERVAL '365 days'`,
    [refId, refType, CHECKED_IN_STATUSES]
  );

  const s = agg[0] || {};
  return {
    history,
    stats: {
      total_days: num(s.total_days, 0),
      total_present: num(s.total_present, 0),
      this_month: num(s.this_month, 0),
      avg_duration: s.avg_duration == null ? null : num(s.avg_duration, 0),
    },
    presentDates: new Set(
      streak.map((r) => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)))
    ),
  };
}

module.exports = {
  getRevenue,
  getMonthlyRevenue,
  getDuesSummary,
  getDuesRows,
  getAttendanceStats,
  getAttendanceToday,
  getSelfAttendanceHistory,
  getRenewals,
  getRenewalRows,
  getTrainerSummary,
  getUtilization,
  getOverview,
};

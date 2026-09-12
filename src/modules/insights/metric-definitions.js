'use strict';
/**
 * Canonical metric definitions — the ONE source of truth for Insights.
 *
 * Every KPI, chart and table in the Insights system MUST derive from these
 * definitions via metric-engine.js. No route, page or AI tool may invent a
 * second formula for the same named metric.
 *
 * Conventions:
 * - Money is ALWAYS collected money: pt_payments.amount WHERE deleted_at IS NULL.
 *   Contracted amounts (pt_clients.final_amount / monthly_pt_amount) are promises,
 *   not revenue, and must never be labelled "revenue".
 * - Attendance: a visit = status IN ('present','late'). 'absent'/'excused' rows
 *   record that somebody did NOT come in and must never inflate a check-in total.
 *   Canonical helper: CHECKED_IN = present + late.
 * - Renewal: TRUE renewal conversion = renewed cohort / expired cohort in the
 *   same window (see renewal_rate below). The legacy `active/(active+expired)`
 *   ratio is an ACTIVE SHARE snapshot, not a renewal rate, and is exposed under
 *   that name only so nobody mistakes it for conversion again.
 * - Tenant isolation: every metric takes an orgId (UUID string) or null for
 *   platform-wide (super_admin only). Tenant callers ALWAYS pass their org.
 * - Pagination NEVER feeds a total: totals use unbounded COUNT/SUM in SQL;
 *   row lists use LIMIT and are labelled top-N.
 *
 * Owner tables (insights owns none — it reads through owning domains):
 *   finance:            pt_payments, revenue_targets, invoices, expenses
 *   clients:            pt_clients
 *   packages-enrolment: pt_client_renewals, pt_client_subscriptions
 *   attendance:         attendance_logs
 *   scheduling:         pt_sessions
 *   training:           workout_sessions, workout_assignments
 *   compensation:       trainers, pt_trainers
 *   engagement:         offers, feedback
 */

const CHECKED_IN_STATUSES = ['present', 'late'];

const METRICS = {
  // ── Revenue (finance/pt_payments) ──────────────────────────────────────────
  revenue_total: {
    label: 'Revenue collected',
    owner: 'finance',
    table: 'pt_payments',
    formula: 'SUM(amount) WHERE deleted_at IS NULL AND date IN [from,to] AND org',
    unit: 'INR',
  },
  revenue_count: {
    label: 'Payment count',
    owner: 'finance',
    table: 'pt_payments',
    formula: "COUNT(*) WHERE deleted_at IS NULL AND date IN [from,to] AND org",
    unit: 'count',
  },
  revenue_incentives: {
    label: 'Trainer incentives accrued',
    owner: 'finance',
    table: 'pt_payments',
    formula: 'SUM(incentive_amt) WHERE deleted_at IS NULL AND date IN [from,to] AND org',
    unit: 'INR',
  },
  revenue_monthly: {
    label: 'Monthly revenue series',
    owner: 'finance',
    table: 'pt_payments',
    formula: 'GROUP BY month(date): SUM(amount), SUM(incentive_amt), COUNT(*)',
    unit: 'series',
  },

  // ── Dues (clients/pt_clients.balance_amount) ───────────────────────────────
  dues_outstanding: {
    label: 'Total outstanding dues',
    owner: 'clients',
    table: 'pt_clients',
    formula: 'SUM(balance_amount) WHERE balance_amount > 0 AND deleted_at IS NULL AND org (NO LIMIT)',
    unit: 'INR',
  },
  dues_debtor_count: {
    label: 'Clients with dues',
    owner: 'clients',
    table: 'pt_clients',
    formula: 'COUNT(*) WHERE balance_amount > 0 AND deleted_at IS NULL AND org',
    unit: 'count',
  },

  // ── Attendance (attendance/attendance_logs) ────────────────────────────────
  attendance_visits: {
    label: 'Check-in visits',
    owner: 'attendance',
    table: 'attendance_logs',
    formula: "COUNT(*) WHERE ref_type='client' AND status IN ('present','late') AND date IN [from,to] AND org",
    unit: 'count',
  },
  attendance_rate: {
    label: 'Attendance rate',
    owner: 'attendance',
    table: 'attendance_logs',
    formula: '(present + late) / NULLIF(present + late + absent, 0) * 100 over [from,to]',
    unit: 'percent',
  },
  session_utilisation_pct: {
    label: 'Session utilisation',
    owner: 'training',
    table: 'workout_sessions',
    formula: "completed / NULLIF(total started, 0) * 100 WHERE session_date in current month AND org (trained, not booked)",
    unit: 'percent',
  },

  // ── Renewal / retention (packages-enrolment + clients) ─────────────────────
  renewal_rate: {
    label: 'TRUE renewal conversion',
    owner: 'packages-enrolment',
    table: 'pt_client_renewals + pt_clients',
    formula:
      'renewed_of_cohort / NULLIF(expired_cohort, 0) * 100 where ' +
      'expired_cohort = COUNT(DISTINCT pt_clients.id) with pt_end_date in [from,to], ' +
      'renewed_of_cohort = COUNT(DISTINCT pt_client_renewals.client_id) with renewed_at in [from,to] ' +
      'AND (old_end_date in [from,to] OR client in expired_cohort). Null when cohort is 0 — never 0/0.',
    unit: 'percent',
  },
  active_share_pct: {
    label: 'Active share (NOT renewal)',
    owner: 'clients',
    table: 'pt_clients',
    formula: 'active / NULLIF(active + expired, 0) * 100. Snapshot only. Must never be labelled renewal rate.',
    unit: 'percent',
  },
  retention_active: {
    label: 'Active clients',
    owner: 'clients',
    table: 'pt_clients',
    formula: "COUNT(*) WHERE status='active' AND deleted_at IS NULL AND org",
    unit: 'count',
  },

  // ── Clients ────────────────────────────────────────────────────────────────
  clients_expiring_7d: {
    label: 'Expiring in 7 days',
    owner: 'clients',
    table: 'pt_clients',
    formula: "COUNT(*) WHERE status='active' AND pt_end_date BETWEEN today AND today+7 AND org",
    unit: 'count',
  },
  clients_expiring_30d: {
    label: 'Expiring in 30 days',
    owner: 'clients',
    table: 'pt_clients',
    formula: "COUNT(*) WHERE status='active' AND pt_end_date BETWEEN today AND today+30 AND org",
    unit: 'count',
  },

  // ── Trainers (compensation) ────────────────────────────────────────────────
  trainer_revenue: {
    label: 'Trainer revenue collected',
    owner: 'compensation',
    table: 'pt_payments + trainers',
    formula: 'SUM(pt_payments.amount) per trainer WHERE pt_payments.deleted_at IS NULL AND org on BOTH sides',
    unit: 'INR',
  },
};

module.exports = { METRICS, CHECKED_IN_STATUSES };

'use strict';
// The only place these metrics are read from the database.
//
// Every query below composes its predicates from definitions.js rather than
// spelling them out, so "what counts as active" is answerable by reading one
// file. Layering: this module owns the SQL, insights.routes.js owns none —
// the same split training.repository.js used, enforced by
// architecture.layering.convention.test.js.
//
// ── Tenant scoping ─────────────────────────────────────────────────────────
//
// Every query takes an explicit orgId and applies the null-safe form
// `($n::uuid IS NULL OR <col> = $n)`, matching routes/reports.js. A tenant
// user's orgId is their own and can never be null; only a platform super
// admin operating platform-wide passes null, and that is the one case where
// an unfiltered read is the intended answer.
//
// The org column is named on every table the query touches, not just the
// driving one. The audit found four aggregates — reports.js:72,
// trainers.js:38 — where a LEFT JOIN brought in pt_clients or pt_payments
// with no org predicate, so a trainer id that existed in two studios
// aggregated both studios' rows.

const pool = require('../../db/pool');
const D = require('./definitions');

/** Rounded percentage, or null when the denominator is empty.
 *
 *  Null rather than zero, deliberately, and the codebase already settled this
 *  once: subscriptionChurn.test.js pins "null not zero when nobody can churn".
 *  A renewal rate of 0% means every client left; a renewal rate of null means
 *  nobody was due. Rendering the second as the first is how a quiet month
 *  reads as a catastrophe. */
function pct(numerator, denominator) {
  const d = Number(denominator) || 0;
  if (d === 0) return null;
  return Math.round((Number(numerator) / d) * 1000) / 10;
}

/**
 * Client stock: enrolled, active today, lapsed.
 *
 * One scan, three FILTERs, so the three numbers are guaranteed to be of the
 * same instant and of the same population. Three separate COUNT queries can
 * disagree with each other under concurrent writes, and did: the dashboard's
 * active count and the trainer page's active count are separate statements
 * today and use different predicates as well.
 */
async function clientStock(orgId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${D.CLIENT_ENROLLED})::int AS enrolled,
       COUNT(*) FILTER (WHERE ${D.CLIENT_ACTIVE})::int   AS active,
       COUNT(*) FILTER (WHERE ${D.CLIENT_LAPSED})::int   AS lapsed,
       COALESCE(${D.BALANCE_OUTSTANDING}, 0)             AS outstanding,
       COALESCE(SUM(c.monthly_pt_amount) FILTER (WHERE ${D.CLIENT_ACTIVE}), 0)
                                                         AS contracted_monthly
     FROM pt_clients c
     WHERE ($1::uuid IS NULL OR c.organization_id = $1)`,
    [orgId]
  );
  return rows[0];
}

/**
 * True renewal conversion over a window.
 *
 * The cohort is every term whose END DATE fell in the window, assembled from
 * two sources because no single column holds it — see definitions.js. A
 * renewed term's old end date survives only in pt_client_renewals; a lapsed
 * term's is still on the client row.
 *
 * UNION, not UNION ALL: a client who renewed a term whose end date also
 * happens to be their current pt_end_date would otherwise be counted twice
 * on one decision.
 *
 * The join to pt_clients is doing two jobs — it supplies the organization,
 * which pt_client_renewals does not carry, and it drops orphaned renewal rows
 * whose client no longer exists. Both matter: 5 of 6 production renewal rows
 * were orphans when this was written, and an orphan belongs to no studio, so
 * counting it would inflate some studio's numerator with another's history.
 */
async function renewalConversion(orgId, from, to) {
  const { rows } = await pool.query(
    `WITH renewed AS (
       SELECT DISTINCT r.client_id, r.old_end_date AS term_end
         FROM pt_client_renewals r
         JOIN pt_clients c ON c.id = r.client_id
        WHERE ${D.CLIENT_LIVE}
          AND r.old_end_date IS NOT NULL
          AND r.old_end_date BETWEEN $2::date AND $3::date
          AND ($1::uuid IS NULL OR c.organization_id = $1)
     ),
     lapsed AS (
       SELECT c.id AS client_id, c.pt_end_date AS term_end
         FROM pt_clients c
        WHERE ${D.CLIENT_ENROLLED}
          AND c.pt_end_date IS NOT NULL
          AND c.pt_end_date BETWEEN $2::date AND $3::date
          AND ($1::uuid IS NULL OR c.organization_id = $1)
     ),
     cohort AS (
       SELECT client_id, term_end FROM renewed
       UNION
       SELECT client_id, term_end FROM lapsed
     )
     SELECT (SELECT COUNT(*) FROM cohort)::int  AS terms_due,
            (SELECT COUNT(*) FROM renewed)::int AS terms_renewed`,
    [orgId, from, to]
  );
  const r = rows[0];
  return {
    terms_due: r.terms_due,
    terms_renewed: r.terms_renewed,
    renewal_rate_pct: pct(r.terms_renewed, r.terms_due),
  };
}

/**
 * Collected revenue and ledger incentives over a window.
 *
 * Windowed on p.date — when the money arrived — not on any client-row date.
 * super-admin/studios.js windows the same concept on pt_clients.created_at,
 * which instead answers "money belonging to whoever was ENROLLED in this
 * window" — a different question that happens to look similar on a young
 * studio, and diverges the moment a client pays in a later month than the one
 * they joined in.
 */
async function revenue(orgId, from, to) {
  const { rows } = await pool.query(
    `SELECT COALESCE(${D.REVENUE_COLLECTED}, 0) AS collected,
            COALESCE(${D.INCENTIVE_LEDGER}, 0)  AS incentives,
            COUNT(*) FILTER (WHERE ${D.PAYMENT_LIVE})::int AS payment_count
       FROM pt_payments p
      WHERE p.date::date BETWEEN $2::date AND $3::date
        AND ($1::uuid IS NULL OR p.organization_id = $1)`,
    [orgId, from, to]
  );
  return rows[0];
}

/**
 * Client attendance over a window.
 *
 * Restricted to ref_type='client' as part of the definition — attendance_logs
 * also holds staff rows, and a figure that mixes them answers no question
 * anyone asked.
 *
 * The rate is a SQL aggregate over the whole window. The endpoint this
 * replaces for the member-facing case (qr-checkin.js:586) computed it in JS
 * over a LIMIT-capped page, so past the cap the denominator silently froze
 * and the rate stopped moving.
 */
async function attendance(orgId, from, to) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int                                  AS total,
            COUNT(*) FILTER (WHERE ${D.ATTENDED})::int      AS attended,
            COUNT(DISTINCT a.ref_id)::int                   AS unique_clients
       FROM attendance_logs a
      WHERE ${D.ATTENDANCE_CLIENT_ROWS}
        AND a.date BETWEEN $2::date AND $3::date
        AND ($1::uuid IS NULL OR a.organization_id = $1)`,
    [orgId, from, to]
  );
  const r = rows[0];
  return { ...r, attendance_rate_pct: pct(r.attended, r.total) };
}

/**
 * Sessions delivered vs booked.
 *
 * Two tables on purpose. workout_sessions is what was trained;
 * pt_sessions is what was scheduled. Six existing surfaces count pt_sessions
 * and present it as delivery, which reads as zero work done because nothing
 * writes 'completed' to that table.
 */
async function sessions(orgId, from, to) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM workout_sessions ws
         WHERE ${D.SESSION_DELIVERED}
           AND ws.created_at::date BETWEEN $2::date AND $3::date
           AND ($1::uuid IS NULL OR ws.organization_id = $1))::int AS delivered,
       (SELECT COUNT(*) FROM pt_sessions s
         WHERE ${D.SESSION_BOOKED_LIVE}
           AND s.session_date BETWEEN $2::date AND $3::date
           AND ($1::uuid IS NULL OR s.organization_id = $1))::int  AS booked`,
    [orgId, from, to]
  );
  return rows[0];
}

/**
 * One person's own attendance history and the stats over it.
 *
 * Self-scoped rather than org-scoped: the caller is asking about themselves,
 * and `refId` comes from the session, never from the request. It lives here,
 * beside the studio-facing `attendance()` above, so that a member's
 * attendance rate and their studio's attendance rate are the same
 * calculation — `D.ATTENDED` in both. They were not: the member-facing
 * endpoint counted present-or-late over a LIMIT-capped page while the studio
 * page counted `status='present'` alone over the full window, so the same
 * person's attendance had two different rates depending on who was looking.
 *
 * `limit` bounds the history LIST only. The stats are a separate aggregate
 * over the whole population, because that is the difference between "your
 * attendance rate" and "your attendance rate among your last 90 records",
 * and the endpoint this replaces presented the second as the first.
 */
async function selfAttendanceHistory(refId, refType, limit) {
  const { rows: history } = await pool.query(
    `SELECT date, status, check_in_time, check_out_time, method, duration_minutes
       FROM attendance_logs
      WHERE ref_id = $1 AND ref_type = $2
      ORDER BY date DESC
      LIMIT $3`,
    [refId, refType, limit]
  );

  const { rows: agg } = await pool.query(
    `SELECT COUNT(*)::int AS total_days,
            COUNT(*) FILTER (WHERE ${D.ATTENDED})::int AS total_present,
            COUNT(*) FILTER (WHERE ${D.ATTENDED}
                             AND a.date >= DATE_TRUNC('month', CURRENT_DATE))::int AS this_month,
            ROUND(AVG(a.duration_minutes) FILTER (WHERE a.duration_minutes > 0))::int AS avg_duration
       FROM attendance_logs a
      WHERE a.ref_id = $1 AND a.ref_type = $2`,
    [refId, refType]
  );

  // Streaks walk back a year, so they need a year of dates — not whatever
  // fraction of one the display page happened to include.
  const { rows: streak } = await pool.query(
    `SELECT a.date
       FROM attendance_logs a
      WHERE a.ref_id = $1 AND a.ref_type = $2
        AND ${D.ATTENDED}
        AND a.date >= CURRENT_DATE - INTERVAL '365 days'`,
    [refId, refType]
  );

  const stats = agg[0] || {};
  return {
    history,
    stats: {
      total_days: stats.total_days || 0,
      total_present: stats.total_present || 0,
      this_month: stats.this_month || 0,
      avg_duration: stats.avg_duration ?? null,
    },
    presentDates: new Set(
      streak.map((r) => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)))
    ),
  };
}

module.exports = {
  pct,
  clientStock,
  renewalConversion,
  revenue,
  attendance,
  sessions,
  selfAttendanceHistory,
};

'use strict';
// Close sessions nobody checked out of.
//
// A QR check-in writes a row with no checkout. Without this pass the row stays
// open forever: the dashboard shows the client "still inside", and
// duration_minutes — which the insights average reads — never fills in.
//
// The length comes from the studio's own setting. A missing row means enabled
// at 60 minutes, matching GYM_DEFAULTS in routes/settings.js; only an explicit
// `auto_checkout = 'false'` turns it off. MAX_AGE_HOURS keeps the first run
// after enabling from rewriting months of old open rows — the sweep runs every
// five minutes, so a row is normally closed within one tick of its threshold.
//
// Run per studio (organizationId given) for a manual pass; the scheduled job
// calls it with no argument to sweep every studio.

const pool = require('../../db/pool');

const DEFAULT_MINUTES = 60;
const MAX_AGE_HOURS = 24;

async function runAutoCheckout(organizationId = null) {
  const { rows } = await pool.query(
    `WITH cfg AS (
       SELECT o.id AS organization_id,
              COALESCE(bool_or(CASE WHEN s.key = 'auto_checkout' THEN s.value = 'true' END), TRUE) AS enabled,
              LEAST(GREATEST(COALESCE(MAX(CASE
                WHEN s.key = 'auto_checkout_minutes' AND s.value ~ '^[0-9]+$'
                THEN s.value::int END), $1), 1), 1440) AS minutes
         FROM organizations o
         LEFT JOIN system_settings s
           ON s.organization_id = o.id
          AND s.key IN ('auto_checkout', 'auto_checkout_minutes')
        GROUP BY o.id
     )
     UPDATE attendance_logs a
        SET check_out_time = a.check_in_time + make_interval(mins => cfg.minutes)
       FROM cfg
      WHERE a.organization_id = cfg.organization_id
        AND cfg.enabled
        AND a.check_out_time IS NULL
        AND a.check_in_time IS NOT NULL
        AND a.check_in_time <= NOW() - make_interval(mins => cfg.minutes)
        AND a.check_in_time >= NOW() - make_interval(hours => $2)
        AND ($3::uuid IS NULL OR a.organization_id = $3)
     RETURNING a.id, a.organization_id`,
    [DEFAULT_MINUTES, MAX_AGE_HOURS, organizationId]
  );

  return { closed: rows.length, orgs: new Set(rows.map((r) => r.organization_id)).size };
}

module.exports = { runAutoCheckout, DEFAULT_MINUTES, MAX_AGE_HOURS };

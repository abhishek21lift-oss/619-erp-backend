// src/modules/command-center/collectors/backup.collector.js
//
// The newest database backup this deployment can PROVE.
//
// Not "a cron job reported green" — scripts/backup-database.js verifies the
// dump with `pg_restore -l` and only then writes platform_backup_status, so a
// row here means a restorable dump was produced. A backup nobody checked is
// worse than none, because it is trusted.
//
// The nightly schedule makes freshness gradable: 36 hours tolerates one missed
// run plus drift; 72 hours is three missed nights and means the job is broken
// rather than late. Both thresholds are env-overridable for a slower cadence.
'use strict';

const { STATUS, result, degraded } = require('../registry');
const pool = require('../../../db/pool');

const NAME = 'backup';
const STALE_WARN_HOURS = Number(process.env.CC_BACKUP_STALE_WARN_HOURS) || 36;
const STALE_CRIT_HOURS = Number(process.env.CC_BACKUP_STALE_CRIT_HOURS) || 72;

async function collect() {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT last_ok_at, size_bytes, tables, offsite
         FROM platform_backup_status WHERE id = TRUE`
    ));
  } catch (err) {
    // The probe ran and failed: we are blind to backups, not necessarily
    // without one. Degraded says exactly that; critical would overstate it.
    return degraded(NAME, `platform_backup_status could not be read: ${err.message}`);
  }

  const row = rows && rows[0];
  const data = {
    last_ok_at: row?.last_ok_at ? new Date(row.last_ok_at).toISOString() : null,
    age_hours: row?.last_ok_at
      ? Math.round(((Date.now() - new Date(row.last_ok_at).getTime()) / 36e5) * 10) / 10
      : null,
    size_bytes: row?.size_bytes != null ? Number(row.size_bytes) : null,
    tables: row?.tables != null ? Number(row.tables) : null,
    offsite: Boolean(row?.offsite),
    stale_after_hours: STALE_WARN_HOURS,
  };

  if (!row) {
    return result(NAME, {
      status: STATUS.WARNING,
      data,
      reason: 'No verified database backup has been recorded — the nightly job has not succeeded since this card was added.',
    });
  }

  if (data.age_hours >= STALE_CRIT_HOURS) {
    return result(NAME, {
      status: STATUS.CRITICAL,
      data,
      reason: `The newest verified backup is ${Math.floor(data.age_hours)}h old (limit ${STALE_CRIT_HOURS}h). The nightly job is failing.`,
    });
  }
  if (data.age_hours >= STALE_WARN_HOURS) {
    return result(NAME, {
      status: STATUS.WARNING,
      data,
      reason: `The newest verified backup is ${Math.floor(data.age_hours)}h old (expected within ${STALE_WARN_HOURS}h).`,
    });
  }
  if (!data.offsite) {
    return result(NAME, {
      status: STATUS.WARNING,
      data,
      reason: 'The newest verified backup is on the VPS only, not off-site. Losing the host would lose the backup with the database.',
    });
  }
  return result(NAME, { status: STATUS.HEALTHY, data });
}

module.exports = { NAME, collect };

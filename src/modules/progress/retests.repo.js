'use strict';
// src/modules/progress/retests.repo.js
// SQL for Module 5 re-test settings, schedules and the reminder ledger.
// Every statement takes the organization from the caller; no statement trusts
// a client_id or schedule_id from a request without the org predicate.

const pool = require('../../db/pool');

async function getSettings(orgId) {
  const { rows } = await pool.query(
    `SELECT organization_id, cadence_months, reminder_days, is_enabled, updated_at
       FROM progress_retest_settings WHERE organization_id = $1`,
    [orgId]
  );
  return rows[0] || null;
}

async function upsertSettings(orgId, { cadenceMonths, reminderDays, isEnabled }, userId) {
  const { rows } = await pool.query(
    `INSERT INTO progress_retest_settings
       (organization_id, cadence_months, reminder_days, is_enabled, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id) DO UPDATE
       SET cadence_months = EXCLUDED.cadence_months,
           reminder_days = EXCLUDED.reminder_days,
           is_enabled = EXCLUDED.is_enabled,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
     RETURNING *`,
    [orgId, cadenceMonths, reminderDays, isEnabled, userId || null]
  );
  return rows[0];
}

/** The studio's configured zone, or null when it has never been set. */
async function orgTimezone(orgId) {
  const { rows } = await pool.query(
    `SELECT value FROM system_settings WHERE organization_id = $1 AND key = 'timezone' LIMIT 1`,
    [orgId]
  );
  return rows[0]?.value || null;
}

async function listAssessments(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM pt_assessments
      WHERE organization_id = $1 AND client_id = $2
      ORDER BY assessment_date ASC, created_at ASC`,
    [orgId, clientId]
  );
  return rows;
}

async function getAssessment(orgId, clientId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM pt_assessments
      WHERE organization_id = $1 AND client_id = $2 AND id = $3`,
    [orgId, clientId, id]
  );
  return rows[0] || null;
}

async function activeSchedule(orgId, clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM progress_retest_schedules
      WHERE organization_id = $1 AND client_id = $2
        AND status IN ('upcoming','due','overdue','rescheduled')
      ORDER BY created_at DESC LIMIT 1`,
    [orgId, clientId]
  );
  return rows[0] || null;
}

async function listSchedules(orgId, clientId, limit = 50) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT * FROM progress_retest_schedules
      WHERE organization_id = $1 AND client_id = $2
      ORDER BY scheduled_date DESC, created_at DESC LIMIT $3`,
    [orgId, clientId, cap]
  );
  return rows;
}

async function getSchedule(orgId, clientId, id) {
  const { rows } = await pool.query(
    `SELECT * FROM progress_retest_schedules
      WHERE organization_id = $1 AND client_id = $2 AND id = $3`,
    [orgId, clientId, id]
  );
  return rows[0] || null;
}

async function createSchedule({
  orgId, clientId, baselineAssessmentId, scheduledDate, cadenceMonths,
  status = 'upcoming', source = 'auto', notes = null, createdBy = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO progress_retest_schedules
       (organization_id, client_id, baseline_assessment_id, scheduled_date,
        cadence_months, status, source, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [orgId, clientId, baselineAssessmentId || null, scheduledDate, cadenceMonths,
      status, source, notes, createdBy]
  );
  return rows[0];
}

/** Close the current cycle. The assessment is preserved on the row. */
async function completeSchedule(orgId, scheduleId, assessmentId, userId = null) {
  const { rows } = await pool.query(
    `UPDATE progress_retest_schedules
        SET status = 'completed', completed_assessment_id = $3,
            completed_by = COALESCE($4, completed_by),
            completed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
        AND status IN ('upcoming','due','overdue','rescheduled')
      RETURNING *`,
    [scheduleId, orgId, assessmentId, userId || null]
  );
  return rows[0] || null;
}

/**
 * Close the open cycle and open its successor in one transaction.
 *
 * The two writes used to be separate pool.query calls: a failure after the
 * close left the client with no re-test at all. The advisory lock serialises
 * concurrent assessment posts for the same client, and the partial unique
 * index remains the database-level backstop. If the INSERT fails, ROLLBACK
 * puts the old cycle back to open; the assessment itself is already saved and
 * a retry can advance it later.
 *
 * `expectedScheduleId` is for the manual completion route: it refuses to close
 * a different cycle that won a race. `assessmentDate` is compared in SQL so
 * DATE parsing never shifts a day.
 */
async function advanceCycle({
  orgId, clientId, assessmentId, assessmentDate, scheduledDate,
  cadenceMonths, userId = null, expectedScheduleId = null,
}) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`progress_retest:${clientId}`]);
    const activeRes = await tx.query(
      `SELECT * FROM progress_retest_schedules
        WHERE organization_id = $1 AND client_id = $2
          AND status IN ('upcoming','due','overdue','rescheduled')
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`,
      [orgId, clientId]
    );
    const active = activeRes.rows[0] || null;

    if (expectedScheduleId && active?.id !== expectedScheduleId) {
      await tx.query('COMMIT');
      return { schedule: active, completed_previous: null, completed_schedule: null, not_open: true };
    }
    if (active && String(active.baseline_assessment_id) === String(assessmentId)) {
      await tx.query('COMMIT');
      return { schedule: active, completed_previous: null, completed_schedule: null, unchanged: true };
    }
    if (active?.baseline_assessment_id) {
      const backdated = await tx.query(
        `SELECT 1 FROM pt_assessments
          WHERE id = $1 AND organization_id = $2 AND client_id = $3
            AND assessment_date > $4::date`,
        [active.baseline_assessment_id, orgId, clientId, assessmentDate]
      );
      if (backdated.rowCount) {
        await tx.query('COMMIT');
        return { schedule: active, completed_previous: null, completed_schedule: null, backdated: true };
      }
    }

    let closed = null;
    if (active) {
      const closedRes = await tx.query(
        `UPDATE progress_retest_schedules
            SET status = 'completed', completed_assessment_id = $3,
                completed_by = COALESCE($4, completed_by),
                completed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND organization_id = $2
            AND status IN ('upcoming','due','overdue','rescheduled')
          RETURNING *`,
        [active.id, orgId, assessmentId, userId || null]
      );
      closed = closedRes.rows[0] || null;
      if (!closed) throw new Error('Open re-test changed during completion');
    }

    const created = await tx.query(
      `INSERT INTO progress_retest_schedules
         (organization_id, client_id, baseline_assessment_id, scheduled_date,
          cadence_months, status, source, created_by)
       VALUES ($1,$2,$3,$4,$5,'upcoming','auto',$6)
       RETURNING *`,
      [orgId, clientId, assessmentId, scheduledDate, cadenceMonths, userId || null]
    );
    await tx.query('COMMIT');
    return {
      schedule: created.rows[0],
      completed_previous: active?.id || null,
      completed_schedule: closed,
      not_open: false,
    };
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/**
 * Move the open cycle. `rescheduled_from` keeps the first date that was
 * promised, even after several moves; the audit trail is the row history plus
 * updated_at, not a second table that can drift from it.
 */
async function reschedule(orgId, clientId, scheduleId, { scheduledDate, reason, notes }, userId) {
  const { rows } = await pool.query(
    `UPDATE progress_retest_schedules
        SET scheduled_date = $4,
            status = 'rescheduled',
            rescheduled_from = COALESCE(rescheduled_from, scheduled_date),
            reschedule_reason = COALESCE($5, reschedule_reason),
            notes = COALESCE($6, notes),
            updated_by = COALESCE($7, updated_by),
            updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND client_id = $3
        AND status IN ('upcoming','due','overdue','rescheduled')
      RETURNING *`,
    [scheduleId, orgId, clientId, scheduledDate, reason || null, notes || null, userId || null]
  );
  return rows[0] || null;
}

async function cancel(orgId, clientId, scheduleId, reason, userId = null) {
  const { rows } = await pool.query(
    `UPDATE progress_retest_schedules
        SET status = 'cancelled', cancelled_at = NOW(),
            reschedule_reason = COALESCE($4, reschedule_reason),
            updated_by = COALESCE($5, updated_by), updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND client_id = $3
        AND status IN ('upcoming','due','overdue','rescheduled')
      RETURNING *`,
    [scheduleId, orgId, clientId, reason || null, userId || null]
  );
  return rows[0] || null;
}

/**
 * Every non-deleted client with their assessment totals and open cycle.
 * State is derived in the service from the studio's local today, so this
 * query never compares a DATE to the server's UTC clock.
 */
async function rosterForOverview(orgId) {
  const { rows } = await pool.query(
    `WITH latest_assessment AS (
       SELECT DISTINCT ON (a.client_id)
              a.client_id, a.assessment_date AS latest_date,
              a.overall_fitness_score AS latest_score, a.testing_conditions
         FROM pt_assessments a
        WHERE a.organization_id = $1
        ORDER BY a.client_id, a.assessment_date DESC, a.created_at DESC
     ),
     assessment_stats AS (
       SELECT client_id, COUNT(*)::int AS assessment_count,
              MIN(assessment_date) AS baseline_date
         FROM pt_assessments
        WHERE organization_id = $1
        GROUP BY client_id
     ),
     open_schedule AS (
       SELECT DISTINCT ON (s.client_id) s.*
         FROM progress_retest_schedules s
        WHERE s.organization_id = $1
          AND s.status IN ('upcoming','due','overdue','rescheduled')
        ORDER BY s.client_id, s.created_at DESC
     )
     SELECT c.id AS client_id, c.name, c.email, c.mobile,
            c.status AS client_status,
            COALESCE(st.assessment_count, 0) AS assessment_count,
            st.baseline_date, la.latest_date, la.latest_score,
            os.id AS schedule_id, os.scheduled_date, os.cadence_months,
            os.status AS schedule_status, os.rescheduled_from,
            COALESCE(t.name, c.trainer_name) AS trainer_name
       FROM pt_clients c
       LEFT JOIN assessment_stats st ON st.client_id = c.id
       LEFT JOIN latest_assessment la ON la.client_id = c.id
       LEFT JOIN open_schedule os ON os.client_id = c.id
       LEFT JOIN trainers t ON t.id = c.trainer_id AND t.organization_id = c.organization_id
      WHERE c.organization_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.name ASC`,
    [orgId]
  );
  return rows;
}

/** Every open cycle a sweep needs, with the client, timezone and settings. */
async function openSchedulesForSweep() {
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS client_name, c.email, c.whatsapp, c.mobile,
            COALESCE(st.cadence_months, 4) AS setting_cadence_months,
            st.reminder_days,
            tz.value AS timezone
       FROM progress_retest_schedules s
       JOIN pt_clients c ON c.id = s.client_id AND c.organization_id = s.organization_id
       LEFT JOIN progress_retest_settings st ON st.organization_id = s.organization_id
       LEFT JOIN system_settings tz
              ON tz.organization_id = s.organization_id AND tz.key = 'timezone'
      WHERE s.status IN ('upcoming','due','overdue','rescheduled')
        AND COALESCE(st.is_enabled, TRUE) = TRUE
        AND c.deleted_at IS NULL
        AND s.scheduled_date <= (CURRENT_DATE + INTERVAL '120 days')`,
    []
  );
  return rows;
}

/**
 * Claim one reminder for delivery. The unique row is the idempotency key:
 * a sent/skipped reminder returns null, a failed one can be retried up to
 * three times, and a pending row is only reclaimed after ten minutes (a
 * worker that died between claim and send). Recipient is part of the key so
 * the trainer's copy and the client's copy are tracked separately.
 */
async function claimReminder({
  orgId, scheduleId, clientId, kind, stageDays, dueDate, recipient = 'client',
}) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const existing = await tx.query(
      `SELECT * FROM progress_reminder_deliveries
        WHERE schedule_id = $1 AND kind = $2 AND stage_days = $3 AND due_date = $4
          AND recipient = $5
        FOR UPDATE`,
      [scheduleId, kind, stageDays, dueDate, recipient]
    );
    const row = existing.rows[0];
    if (row) {
      const retryable = row.status === 'failed' && row.attempts < 3;
      const stale = row.status === 'pending' && row.updated_at < new Date(Date.now() - 10 * 60 * 1000);
      if (!retryable && !stale) {
        await tx.query('COMMIT');
        return null;
      }
      const updated = await tx.query(
        `UPDATE progress_reminder_deliveries
            SET status = 'pending', attempts = attempts + 1, last_error = NULL, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [row.id]
      );
      await tx.query('COMMIT');
      return updated.rows[0];
    }
    const inserted = await tx.query(
      `INSERT INTO progress_reminder_deliveries
         (organization_id, schedule_id, client_id, kind, stage_days, due_date, recipient, attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1) RETURNING *`,
      [orgId, scheduleId, clientId, kind, stageDays, dueDate, recipient]
    );
    await tx.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/** Failed (or abandoned) rows for this exact cycle date, so a later daily sweep can retry them. */
async function retryableReminders({ orgId, scheduleId, dueDate }) {
  const { rows } = await pool.query(
    `SELECT * FROM progress_reminder_deliveries
      WHERE organization_id = $1 AND schedule_id = $2 AND due_date = $3
        AND (
          (status = 'failed' AND attempts < 3)
          OR (status = 'pending' AND updated_at < NOW() - INTERVAL '10 minutes')
        )
      ORDER BY stage_days DESC`,
    [orgId, scheduleId, dueDate]
  );
  return rows;
}

async function markReminder(id, { status, error = null }) {
  const { rows } = await pool.query(
    `UPDATE progress_reminder_deliveries
        SET status = $2,
            last_error = $3,
            sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
            updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, status, error]
  );
  return rows[0] || null;
}

/** Set the stored state when the date crosses a boundary. Cheap and idempotent. */
async function syncStatus(orgId, scheduleId, status) {
  await pool.query(
    `UPDATE progress_retest_schedules
        SET status = $3, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
        AND status IN ('upcoming','due','overdue','rescheduled')
        AND status <> $3`,
    [scheduleId, orgId, status]
  );
}

module.exports = {
  getSettings, upsertSettings, orgTimezone, listAssessments, getAssessment,
  activeSchedule, listSchedules, getSchedule, createSchedule, completeSchedule, advanceCycle,
  reschedule, cancel, rosterForOverview, openSchedulesForSweep, claimReminder, retryableReminders, markReminder, syncStatus,
};

'use strict';
// src/modules/progress/progress.sweep.js
// The daily pass behind re-test reminders. Pure decisions in
// retest-scheduling.js; this file touches the database and the one existing
// notification service.
//
// Exactly-once is enforced by progress_reminder_deliveries, not by this loop.
// If two replicas sweep at once, the unique (schedule, kind, stage, due_date)
// row means one claims the send and the other skips it.

const logger = require('../../lib/logger');
const repo = require('./retests.repo');
const scheduling = require('./retest-scheduling');
const notifier = require('../notifications/notifications.service');
const { appTimeZone } = require('../../lib/appTime');

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function templateFor(kind) {
  if (kind === 'due') return 'assessment_due';
  if (kind === 'overdue') return 'assessment_overdue';
  return 'assessment_reminder';
}

function deliveryOutcome(results) {
  const values = Object.values(results || {});
  if (!values.length) return { status: 'failed', error: 'no_channel_attempted' };
  if (values.every((r) => r.status === 'suppressed')) return { status: 'skipped', error: 'suppressed_by_preference' };
  if (values.some((r) => r.status === 'sent' || r.status === 'delivered' || r.status === 'queued')) {
    return { status: 'sent', error: null };
  }
  const errors = values.map((r) => r.error).filter(Boolean);
  return { status: 'failed', error: errors.join('; ').slice(0, 500) || 'delivery_failed' };
}

async function runProgressSweep({ now = new Date() } = {}) {
  const rows = await repo.openSchedulesForSweep();
  const summary = { scanned: rows.length, sent: 0, skipped: 0, failed: 0, errors: 0 };

  for (const row of rows) {
    const timezone = row.timezone || appTimeZone();
    const today = scheduling.todayInZone(timezone, now);
    const scheduledDate = dateOnly(row.scheduled_date);
    const state = scheduling.deriveState({
      status: row.status, scheduledDate, today,
    });

    try {
      await repo.syncStatus(row.organization_id, row.id, state.state);

      const reminder = scheduling.reminderFor({
        scheduledDate, today,
        reminderDays: row.reminder_days || [30, 14, 7],
      });

      // A send is attempted once per sweep. Retry rows from earlier failed or
      // abandoned attempts first; the normal stage then runs only if it is a
      // different ledger key.
      const retryable = await repo.retryableReminders({
        orgId: row.organization_id, scheduleId: row.id, dueDate: scheduledDate,
      });
      const attempted = new Set();
      const queue = [
        ...retryable.map((r) => ({ kind: r.kind, stage_days: r.stage_days })),
        ...(reminder ? [reminder] : []),
      ];
      for (const item of queue) {
        const key = `${item.kind}:${item.stage_days}`;
        if (attempted.has(key)) continue;
        attempted.add(key);

        const delivery = await repo.claimReminder({
          orgId: row.organization_id,
          scheduleId: row.id,
          clientId: row.client_id,
          kind: item.kind,
          stageDays: item.stage_days,
          dueDate: scheduledDate,
        });
        if (!delivery) {
          summary.skipped += 1;
          continue;
        }

        const recipient = await notifier.recipientFromClient(row.organization_id, row.client_id);
        if (!recipient) {
          await repo.markReminder(delivery.id, { status: 'skipped', error: 'client_not_found' });
          summary.skipped += 1;
          continue;
        }

        const channels = [];
        if (recipient.user_id) channels.push('inapp');
        if (recipient.email) channels.push('email');
        // A client with a phone but no email or member login still has a way to
        // be reached. Do not send an email channel with no address in front of it.
        if (!recipient.email && !recipient.user_id && recipient.phone) channels.push('whatsapp');
        if (!channels.length) {
          await repo.markReminder(delivery.id, { status: 'skipped', error: 'no_contact_channel' });
          summary.skipped += 1;
          continue;
        }

        const type = templateFor(item.kind);
        const daysUntil = state.days_until;
        const result = await notifier.send(type, recipient, {
          name: recipient.name,
          client_name: recipient.name,
          scheduled_date: scheduledDate,
          days: daysUntil == null ? null : Math.abs(daysUntil),
          days_until: daysUntil,
          state: state.state,
          link: '/member/progress',
        }, channels);

        const outcome = deliveryOutcome(result);
        await repo.markReminder(delivery.id, outcome);
        if (outcome.status === 'sent') summary.sent += 1;
        else if (outcome.status === 'failed') summary.failed += 1;
        else summary.skipped += 1;

        logger.info({
          scheduleId: row.id, orgId: row.organization_id, kind: item.kind,
          stageDays: item.stage_days, state: state.state, outcome: outcome.status,
        }, 'progress reminder attempt');
      }
    } catch (err) {
      summary.errors += 1;
      logger.error({ err: err.message, scheduleId: row.id, orgId: row.organization_id }, 'progress reminder sweep row failed');
    }
  }

  logger.info(summary, 'progress reminder sweep completed');
  return summary;
}

module.exports = { runProgressSweep, deliveryOutcome, templateFor };

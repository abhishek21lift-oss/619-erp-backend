'use strict';
// The daily sweep: the producer for the six trigger events nobody presses a
// button for.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// Twelve trigger events have been selectable in the automation settings page
// since migration 012. Six of them describe something a person did — a payment
// arrived, a client enrolled, a lead was captured, a session was used — and
// those are emitted from the handler that performs the write, in
// automation.triggers.js.
//
// The other six describe a date passing:
//
//   membership_expiring   a membership ends in 7 / 3 / 1 days
//   membership_expired    a membership ended yesterday
//   birthday              it is a client's birthday
//   anniversary           it is the anniversary of them joining
//   attendance_missed     a client has not checked in for a fortnight
//   followup_due          a lead's follow-up date has arrived
//
// Nothing in an HTTP request will ever notice any of those. Without a sweep,
// a studio can switch on a birthday rule, see it listed as active, and never
// find out that it cannot fire — which is the same failure the automation
// engine was written to fix, one layer further out.
//
// ── The shape, and why it is a loop over studios ────────────────────────────
//
//   for each studio with automation switched ON
//     which of these six events does it have an active rule for?
//       for each of those, and only those, run that event's query — scoped to
//       this studio — and hand every row to the engine
//
// The obvious implementation is the other way round: one query per event
// across every studio, joined to automation_rules. It is fewer round trips and
// it is the wrong shape, because the tenant boundary then lives inside a join
// condition. Here the boundary is the loop itself: `orgId` is a local variable,
// every query below binds it, and there is no statement in the sweep that can
// see two studios at once.
//
// The rule check comes before the queries rather than after because a studio
// with one birthday rule should not have its whole roster scanned for missed
// attendance every morning so the engine can discard it row by row.
//
// ── Failure ─────────────────────────────────────────────────────────────────
//
// A studio whose sweep throws is logged and skipped, and the loop continues.
// One studio's malformed date must not stop every other studio's reminders,
// and a sweep that aborts halfway is a sweep whose second half silently never
// runs — which nobody would notice, because the symptom is an absence of
// messages.

const logger = require('../../lib/logger');
const repo = require('./automation.repository');
const triggers = require('./automation.triggers');
const { Outcome } = require('./automation.engine');

/**
 * How many days before expiry to remind, largest first.
 *
 * The same three buckets renewal.worker.js has always used. Each is a separate
 * query and a separate dedupe key, so a client 7 days out gets one message
 * today and another when they are 3 days out — not three today.
 */
function reminderDays() {
  const raw = process.env.AUTOMATION_EXPIRY_REMINDER_DAYS;
  if (!raw) return [7, 3, 1];
  const parsed = raw
    .split(',')
    .map((n) => parseInt(String(n).trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return parsed.length > 0 ? parsed : [7, 3, 1];
}

/** How long a client may be unseen before the studio says something. */
function absenceDays() {
  const n = parseInt(process.env.AUTOMATION_ABSENCE_DAYS, 10);
  return Number.isInteger(n) && n > 0 ? n : 14;
}

// ── There is no clock in this file ──────────────────────────────────────────
//
// Every date the sweep puts into an idempotency key — the expiry date, today,
// the last visit, the follow-up date — arrives as a 'YYYY-MM-DD' string from
// the same query that selected the row, formatted by Postgres. Nothing here
// calls `new Date()`.
//
// That is deliberate and it is not tidiness. The key has to be the same string
// on a re-run, and a Node process is not guaranteed to agree with the database
// about what day it is: node-postgres hands back a DATE as local midnight, and
// `toISOString()` on that in any timezone east of UTC is yesterday. A sweep
// that keys yesterday's date onto today's event writes a key the dedupe index
// has never seen, and the message goes out twice.

/** Sum the engine's per-event answers into one tally. */
function tally(target, result) {
  target.found += 1;
  if (result && result.outcome === Outcome.QUEUED) target.queued += result.queued;
  else if (result) target.skipped[result.outcome] = (target.skipped[result.outcome] || 0) + 1;
  return target;
}

const EMPTY = () => ({ found: 0, queued: 0, skipped: {} });

/**
 * Run every sweep-driven event for ONE studio.
 *
 * Exported for the tests and for an operator who needs to re-drive a single
 * studio without touching the others. `activeEvents` is passed in rather than
 * looked up so the caller can prove it was consulted.
 */
async function sweepOrg(orgId, activeEvents) {
  const want = new Set(activeEvents);
  const stats = {};

  if (want.has('membership_expiring')) {
    const s = (stats.membership_expiring = EMPTY());
    for (const days of reminderDays()) {
      const rows = await repo.membershipExpiringIn(orgId, days);
      for (const row of rows) {
        tally(s, await triggers.membershipExpiring(orgId, {
          clientId: row.id,
          endDate: row.end_date,
          daysRemaining: days,
        }));
      }
    }
  }

  if (want.has('membership_expired')) {
    const s = (stats.membership_expired = EMPTY());
    for (const row of await repo.membershipExpiredYesterday(orgId)) {
      tally(s, await triggers.membershipExpired(orgId, {
        clientId: row.id,
        endDate: row.end_date,
      }));
    }
  }

  if (want.has('birthday')) {
    const s = (stats.birthday = EMPTY());
    for (const row of await repo.birthdaysToday(orgId)) {
      tally(s, await triggers.birthday(orgId, { clientId: row.id, today: row.today }));
    }
  }

  if (want.has('anniversary')) {
    const s = (stats.anniversary = EMPTY());
    for (const row of await repo.anniversariesToday(orgId)) {
      tally(s, await triggers.anniversary(orgId, {
        clientId: row.id, years: row.years, today: row.today,
      }));
    }
  }

  if (want.has('attendance_missed')) {
    const s = (stats.attendance_missed = EMPTY());
    for (const row of await repo.attendanceMissedFor(orgId, absenceDays())) {
      tally(s, await triggers.attendanceMissed(orgId, {
        clientId: row.id,
        lastVisit: row.last_visit,
        daysSince: row.days_since,
      }));
    }
  }

  if (want.has('followup_due')) {
    const s = (stats.followup_due = EMPTY());
    for (const row of await repo.followupsDue(orgId)) {
      tally(s, await triggers.followupDue(orgId, {
        leadId: row.id,
        followUpDate: row.follow_up_date,
        interestedPackage: row.interested_package,
      }));
    }
  }

  return stats;
}

/** The six events this sweep can produce. Nothing else belongs here. */
const SWEEP_EVENTS = Object.freeze([
  'membership_expiring', 'membership_expired', 'birthday',
  'anniversary', 'attendance_missed', 'followup_due',
]);

/**
 * Run the sweep for every studio that has automation switched on.
 *
 * Returns a per-studio summary rather than logging and discarding it: this is
 * what the worker records, and it is the only evidence an operator has that
 * the sweep ran at all on a morning when it correctly sent nothing.
 */
async function runSweep() {
  const orgIds = await repo.orgsWithAutomationOn();
  const summary = { orgs: 0, skipped: 0, byOrg: {} };

  for (const orgId of orgIds) {
    try {
      const active = (await repo.activeTriggerEventsFor(orgId))
        .filter((e) => SWEEP_EVENTS.includes(e));
      if (active.length === 0) continue;

      summary.orgs += 1;
      summary.byOrg[orgId] = await sweepOrg(orgId, active);
    } catch (err) {
      // One studio, not the run. See the header.
      summary.skipped += 1;
      logger.error({ err: err.message, org_id: orgId }, 'automation_sweep_org_failed');
    }
  }

  logger.info(
    { orgs: summary.orgs, skipped: summary.skipped, candidates: orgIds.length },
    'automation_sweep_complete'
  );
  return summary;
}

module.exports = { runSweep, sweepOrg, SWEEP_EVENTS, reminderDays, absenceDays };

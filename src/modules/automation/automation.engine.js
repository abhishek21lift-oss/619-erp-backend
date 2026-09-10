'use strict';
// The automation engine: business event → message queued, or a recorded reason
// it was not.
//
// ── What this replaces ──────────────────────────────────────────────────────
//
// Nothing, which is the point. `automation_rules` has existed since migration
// 012 with a full CRUD API and a settings page in front of it, and a search of
// this repository for its name returns four statements, all of them in
// automation.routes.js: SELECT, INSERT, UPDATE, DELETE. No consumer. The page
// even tells the studio "Logs will appear here once automation rules fire" —
// they never fire, and production holds 0 rules and 0 communication_logs rows
// to match.
//
// This is the missing consumer, and it is deliberately the ONLY one: a second
// place that decides whether to message a client is a second place the
// permission check can be forgotten.
//
// ── The pipeline, and why it is in this order ───────────────────────────────
//
//   business event
//     → is automation on for this STUDIO      (cheapest, and the kill switch)
//     → does an ACTIVE RULE want this event   (no rule, no work)
//     → resolve the RECIPIENT, org-scoped     (also resolves whose trainer)
//     → is the TRAINER granted                (the per-trainer authorisation)
//     → daily limit                            (blast radius)
//     → render, write a QUEUED row, enqueue with the rule's DELAY
//
// The studio switch is first because it is the thing an owner reaches for when
// something is wrong, and it must not be reachable only after five other
// lookups have already run. The recipient is resolved before the permission
// check because the recipient is what determines WHOSE permission applies —
// a client's trainer, not the caller's.
//
// ── Why this never throws ───────────────────────────────────────────────────
//
// It is called from the middle of business transactions: recording a payment,
// creating a client. An automation failure must not roll back a payment. Every
// path returns an outcome object instead, and the outcomes are enumerated
// rather than free text so a caller — and the tests — can assert on WHY
// nothing was sent, which is the question that matters when a studio says
// "the reminders stopped".

const logger = require('../../lib/logger');
const repo = require('./automation.repository');

/**
 * The events a rule may be bound to.
 *
 * Character for character the CHECK constraint in migration 012. A value here
 * that the constraint rejects would let the engine look for rules that can
 * never exist; a value in the constraint that is missing here is a rule a
 * studio can create and nothing will ever fire. Both are silent, so the list
 * is duplicated deliberately and the convention test asserts the two agree.
 */
const TRIGGER_EVENTS = Object.freeze([
  'member_created', 'lead_created', 'followup_due', 'membership_expiring',
  'membership_expired', 'payment_received', 'session_low', 'birthday',
  'anniversary', 'attendance_missed', 'trial_scheduled', 'trial_completed',
]);

/**
 * Every reason a message was not queued.
 *
 * Enumerated because "nothing happened" is the failure mode this feature will
 * actually have in production, and an operator needs to tell a disabled studio
 * from an ungranted trainer from a client with no phone number without reading
 * the source.
 */
const Outcome = Object.freeze({
  QUEUED: 'queued',
  AUTOMATION_DISABLED: 'automation_disabled',
  NO_ACTIVE_RULE: 'no_active_rule',
  RECIPIENT_NOT_FOUND: 'recipient_not_found',
  NO_PHONE: 'no_phone',
  TRAINER_NOT_PERMITTED: 'trainer_not_permitted',
  DAILY_LIMIT_REACHED: 'daily_limit_reached',
  DUPLICATE_EVENT: 'duplicate_event',
  NOT_ENQUEUED: 'not_enqueued',
});

/**
 * Fill `{{placeholders}}` from the event context.
 *
 * Deliberately not a template language. A studio writes these in a textarea,
 * and anything with control flow in it is something that can loop, throw, or
 * read a variable it should not — inside a message to a real client. An
 * unknown placeholder is left standing rather than replaced with "undefined":
 * a client receiving `Hi {{name}}` is a visible bug a studio will report,
 * where `Hi undefined` reads like the product is broken and `Hi ` reads like
 * nothing is wrong at all.
 */
function render(template, context) {
  return String(template).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, key) => {
    const value = context[key];
    return value === undefined || value === null || value === '' ? whole : String(value);
  });
}

/**
 * The idempotency key for one (rule, business event) pair.
 *
 * `eventKey` identifies the business object — a payment id, a client id, a
 * date for the recurring sweeps — and the rule id is included so two different
 * rules on the same payment both fire while the same rule on a redelivered
 * payment does not.
 */
function dedupeKeyFor(triggerEvent, ruleId, eventKey) {
  return `${triggerEvent}:${ruleId}:${eventKey}`;
}

/**
 * Who an event is about, and how to resolve them.
 *
 * Two, because four of the twelve trigger events are about people who are not
 * clients: `lead_created` and `followup_due` concern a pt_leads row, which is
 * deliberately a separate table until conversion. communication_logs has
 * allowed `recipient_type = 'lead'` since migration 012.
 *
 * A map rather than an if/else so that an unrecognised type resolves to
 * nothing and the event is refused, instead of quietly falling through to the
 * client lookup and messaging whichever client happens to share that id.
 */
const RECIPIENT_RESOLVERS = Object.freeze({
  client: (orgId, id) => repo.clientRecipient(orgId, id),
  lead: (orgId, id) => repo.leadRecipient(orgId, id),
});

/**
 * Fire one business event for one studio.
 *
 * @param {object} args
 * @param {string} args.orgId       Server-resolved. NEVER from a request body.
 * @param {string} args.event       One of TRIGGER_EVENTS.
 * @param {string} args.subjectId   The row this is about — a pt_clients id, or
 *                                  a pt_leads id when recipientType is 'lead'.
 * @param {string} [args.recipientType] 'client' (default) or 'lead'.
 * @param {string} args.eventKey    Identifies the business object, for idempotency.
 * @param {object} [args.context]   Template variables.
 * @param {string} [args.requestId]
 * @returns {Promise<{outcome: string, queued: number, results: object[]}>}
 */
async function emit({
  orgId, event, subjectId, recipientType = 'client', eventKey, context = {}, requestId,
} = {}) {
  const done = (outcome, extra = {}) => ({ outcome, queued: 0, results: [], ...extra });

  if (!orgId) {
    // An org-less emit is a programming error, not a business condition. It is
    // logged at error and refused rather than defaulted, because the only
    // available default would be "every studio".
    logger.error({ event }, 'automation_emit_without_organization');
    return done(Outcome.AUTOMATION_DISABLED);
  }
  if (!TRIGGER_EVENTS.includes(event)) {
    logger.error({ event, org_id: orgId }, 'automation_emit_unknown_event');
    return done(Outcome.NO_ACTIVE_RULE);
  }

  try {
    const settings = await repo.settingsFor(orgId);
    if (!settings.automation_enabled) return done(Outcome.AUTOMATION_DISABLED);

    const rules = await repo.activeRulesFor(orgId, event);
    if (rules.length === 0) return done(Outcome.NO_ACTIVE_RULE);

    const resolve = RECIPIENT_RESOLVERS[recipientType];
    if (!resolve) {
      logger.error({ event, org_id: orgId, recipient_type: recipientType }, 'automation_emit_unknown_recipient_type');
      return done(Outcome.RECIPIENT_NOT_FOUND);
    }

    const recipient = await resolve(orgId, subjectId);
    // Null covers both "no such row" and "another studio's row", and the
    // answer is the same for both — which is the whole reason the lookup is
    // org-scoped rather than checked afterwards.
    if (!recipient) return done(Outcome.RECIPIENT_NOT_FOUND);
    if (!recipient.phone) return done(Outcome.NO_PHONE);

    // ── The permission gate ─────────────────────────────────────────────────
    //
    // Whose permission? The trainer the CLIENT belongs to, not whoever
    // happened to trigger the event. A payment recorded by the front desk
    // still produces a message that appears, to the client, to come from their
    // trainer's studio relationship — so it is that trainer's grant that has
    // to exist.
    //
    // A client with no trainer is a studio-level message: there is no
    // individual to attribute it to, the studio switch above is the whole
    // authorisation, and requiring a grant that cannot exist would make
    // unassigned clients silently unmessageable.
    if (recipient.trainer_id) {
      const granted = await repo.trainerIsGranted(orgId, recipient.trainer_id);
      if (!granted) {
        logger.info(
          { org_id: orgId, event, trainer_id: recipient.trainer_id },
          'automation_skipped_trainer_not_permitted'
        );
        return done(Outcome.TRAINER_NOT_PERMITTED);
      }
    }

    const usedToday = await repo.sendsToday(orgId);
    if (usedToday >= settings.daily_send_limit) {
      logger.warn(
        { org_id: orgId, event, used: usedToday, limit: settings.daily_send_limit },
        'automation_daily_limit_reached'
      );
      return done(Outcome.DAILY_LIMIT_REACHED);
    }

    const vars = { ...context, name: context.name || recipient.name };
    const results = [];
    let queued = 0;

    for (const rule of rules) {
      const dedupeKey = dedupeKeyFor(event, rule.id, eventKey || subjectId);

      // The row FIRST, then the job. A row with no job is a message that
      // visibly never went out; a job with no row is a message a client
      // receives that this system has no record of.
      const logId = await repo.insertQueued({
        orgId,
        recipientType,
        recipientId: recipient.id,
        recipientName: recipient.name,
        recipientPhone: recipient.phone,
        template: rule.name,
        message: render(rule.template, vars),
        ruleId: rule.id,
        dedupeKey,
      });

      if (!logId) {
        // The same event already produced this message. Normal, not an error.
        results.push({ ruleId: rule.id, outcome: Outcome.DUPLICATE_EVENT });
        continue;
      }

      const delayMs = Math.max(0, (rule.delay_minutes || 0) * 60_000);
      const { enqueueWhatsapp } = require('../../services/whatsapp.service');
      const job = await enqueueWhatsapp(
        'automation',
        { logId, orgId, requestId },
        {
          delay: delayMs,
          // The log row id IS the job id. BullMQ refuses a duplicate job id
          // while the job exists, which makes the enqueue idempotent for free
          // and means a retried emit cannot produce two jobs for one row.
          jobId: `wa-auto-${logId}`,
        }
      );

      if (!job) {
        // Redis is down. The row stays 'queued' rather than being marked
        // failed: it is a true statement, and it is the state an operator can
        // re-drive from once the queue is back. Marking it failed would throw
        // away a message the studio still wants sent.
        logger.error({ org_id: orgId, log_id: logId }, 'automation_enqueue_unavailable');
        results.push({ ruleId: rule.id, logId, outcome: Outcome.NOT_ENQUEUED });
        continue;
      }

      await repo.touchRule(orgId, rule.id);
      queued += 1;
      results.push({ ruleId: rule.id, logId, jobId: job.id, delayMs, outcome: Outcome.QUEUED });
    }

    return { outcome: queued > 0 ? Outcome.QUEUED : results[0]?.outcome || Outcome.NO_ACTIVE_RULE, queued, results };
  } catch (err) {
    // The caller is inside a business transaction. Automation failing must not
    // roll back a payment, so this is logged and swallowed.
    logger.error({ err: err.message, org_id: orgId, event }, 'automation_emit_failed');
    return done(Outcome.NOT_ENQUEUED, { error: err.message });
  }
}

module.exports = { emit, render, dedupeKeyFor, TRIGGER_EVENTS, Outcome };

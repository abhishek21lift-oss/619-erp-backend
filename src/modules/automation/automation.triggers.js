'use strict';
// Named business events, for the code that produces them.
//
// ── Why this exists rather than calling emit() directly ─────────────────────
//
// Because the call sites are inside handlers that are about something else —
// recording a payment, enrolling a client — and the person editing them next
// is thinking about that, not about automation. A named function with a fixed
// context shape means a call site cannot quietly drift: the placeholders a
// studio can use in a template are decided here, once, rather than by whatever
// each caller happened to pass.
//
// It is also the seam that keeps `emit` out of business handlers entirely, so
// the rule "automation is triggered, never performed, by business code" is
// visible in the imports.
//
// ── Every one of these is fire-and-forget, deliberately ────────────────────
//
// They are awaited so that a queued row is written before the request answers
// — a studio pressing Save and immediately opening the log should see it — but
// emit() never throws, and none of these is inside the transaction that owns
// the business write. Automation must not be able to roll back a payment.

const { emit } = require('./automation.engine');
const { orgIdOf } = require('../../lib/tenant-db');

/**
 * Money arrived from a client.
 *
 * `eventKey` is the payment's own identity. Two payments from one client on
 * one day are two events and must both fire; the SAME payment recorded twice
 * by a retried request is one, and the dedupe key is what makes that true.
 * Where the caller has no payment id, a composite of client, amount and date
 * is the closest honest approximation and is documented as such at the call
 * site rather than hidden here.
 */
async function paymentReceived(req, { clientId, amount, eventKey, currency = '₹' }) {
  return paymentReceivedFor(orgIdOf(req), { clientId, amount, eventKey, currency, requestId: req.id });
}

/**
 * The same event, for a caller that has an organization but no request.
 *
 * lib/upiPayments.js is a service: a UTR approval runs with an `orgId` and an
 * `actor`, never a `req`, so the request-driven signature above could not be
 * used there and the event simply was not raised — money arrived and the
 * client heard nothing. Inventing a fake `req` to satisfy the signature is
 * exactly what the sweep-driven triggers below refuse to do, and for the same
 * reason: it invites the next reader to reach for req.user in a context that
 * has none.
 *
 * The organization is the caller's own resolved value and must come from
 * server-side context, never a request body — the same rule orgIdOf enforces
 * on the other side.
 */
async function paymentReceivedFor(orgId, { clientId, amount, eventKey, currency = '₹', requestId }) {
  return emit({
    orgId,
    event: 'payment_received',
    subjectId: clientId,
    eventKey,
    context: { amount: `${currency}${amount}`, amount_value: amount },
    requestId,
  });
}

/** A client was enrolled. */
async function memberCreated(req, { clientId }) {
  return emit({
    orgId: orgIdOf(req),
    event: 'member_created',
    subjectId: clientId,
    // The client id IS the event: a client is created once, and a retried
    // enrolment that produced a second row is a different client.
    eventKey: clientId,
    context: {},
    requestId: req.id,
  });
}

/**
 * At what remaining count a balance counts as low.
 *
 * Three, which is what migration 012's partial index `sb_low_idx` has always
 * called low — the definition already existed in the schema and there is no
 * reason for a second one to appear here and disagree with it.
 */
function sessionLowThreshold() {
  const n = parseInt(process.env.AUTOMATION_SESSION_LOW_THRESHOLD, 10);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

/**
 * A client's PT session balance ran low.
 *
 * ── Why the threshold is decided here and not at the call site ──────────────
 *
 * The caller is the handler that decrements a balance, and it decrements on
 * every session used. Asking it to also know what "low" means would put a
 * business rule in an HTTP adapter, where the next person to add a second way
 * of consuming a session will not think to copy it. So this is called
 * unconditionally after every decrement and answers `not_low` most of the
 * time, which costs nothing — it returns before touching the database.
 *
 * The event key carries the remaining count so that a balance falling 3 → 2 →
 * 1 fires three times, while a page that reads the balance twice at 2 fires
 * once. Dropping the count would make the first reading the only one that ever
 * fires; using a timestamp would make every read fire.
 */
async function sessionLow(req, { clientId, remaining }) {
  // `Number(null)` is 0, not NaN — so a null balance would read as "no
  // sessions left" and warn a client whose balance is simply unknown. The
  // null check has to come before the coercion, not after it.
  const left = remaining === null || remaining === undefined || remaining === ''
    ? NaN
    : Number(remaining);
  if (!Number.isFinite(left) || left > sessionLowThreshold()) {
    return { outcome: 'not_low', queued: 0, results: [] };
  }
  return emit({
    orgId: orgIdOf(req),
    event: 'session_low',
    subjectId: clientId,
    eventKey: `${clientId}:${remaining}`,
    context: { remaining: String(remaining) },
    requestId: req.id,
  });
}

/**
 * A lead was captured.
 *
 * The recipient is a lead, not a client — pt_leads stays independent of
 * pt_clients until conversion — so this is the first trigger to name a
 * recipient type. The lead id is the event for the same reason the client id
 * is for `member_created`: a lead is captured once, and a retried POST that
 * produced a second row is a second lead.
 *
 * `source` and `interested_package` are offered as placeholders because they
 * are the two things a studio's first message to a lead actually differs on
 * ("thanks for enquiring about our transformation package"). They are passed
 * through as the caller received them; the engine leaves an unknown or empty
 * placeholder standing rather than rendering the word "undefined".
 */
async function leadCreated(req, { leadId, source, interestedPackage }) {
  return emit({
    orgId: orgIdOf(req),
    event: 'lead_created',
    recipientType: 'lead',
    subjectId: leadId,
    eventKey: leadId,
    context: { source: source || '', package: interestedPackage || '' },
    requestId: req.id,
  });
}

/**
 * A lead's trial has been booked.
 *
 * ── Why the lead id alone is the key ────────────────────────────────────────
 *
 * There is nowhere on pt_leads to record WHEN the trial is — `trial_scheduled`
 * is a value of `status`, and the only date on the row is the follow-up date,
 * which is a different thing. So the event this can honestly describe is "this
 * lead's trial got booked", which happens once.
 *
 * That falls out of the key for free, and it is why this is called on every
 * PATCH that leaves the lead in `trial_scheduled` rather than only on the
 * transition into it: editing the notes on an already-booked lead re-emits,
 * produces the same key, and the dedupe index refuses the second row. No
 * previous-status lookup, and no extra statement in the handler.
 *
 * The cost, stated rather than hidden: a genuinely REBOOKED trial sends
 * nothing, because it is the same lead and the same key. Sending a second
 * "your trial is booked" would need a trial date to key on, and inventing one
 * from `updated_at` would put a timestamp in the key — which is the one thing
 * a dedupe key must never contain.
 */
async function trialScheduled(req, { leadId }) {
  return emit({
    orgId: orgIdOf(req),
    event: 'trial_scheduled',
    recipientType: 'lead',
    subjectId: leadId,
    eventKey: leadId,
    context: {},
    requestId: req.id,
  });
}

// ── The sweep-driven events ─────────────────────────────────────────────────
//
// The six below are not produced by anybody doing anything. Nobody presses a
// button to make a birthday arrive. They are found by the daily sweep, which
// means two things the request-driven triggers above do not have to think
// about:
//
//   · There is no `req`. The org comes from the sweep's own loop over studios
//     that have automation switched on, so these take an explicit orgId. A
//     signature that pretended a request existed would invite someone to reach
//     for req.user in a worker that has none.
//
//   · The idempotency key has to survive the sweep running twice. Every key
//     below is anchored to a DATE that the underlying fact owns — the expiry
//     date, today's date, the last visit, the follow-up date — never to the
//     time the sweep ran. A key containing a timestamp would make every re-run
//     a new event, which is the failure mode that turns a retry into a second
//     message to a real client.

/** A membership ends in `daysRemaining` days. */
async function membershipExpiring(orgId, { clientId, endDate, daysRemaining }) {
  return emit({
    orgId,
    event: 'membership_expiring',
    subjectId: clientId,
    // The expiry date is in the key, not just the client: a client who renews
    // and later approaches a NEW expiry is a new event, and keying on the
    // client and bucket alone would silence it forever.
    eventKey: `${clientId}:${endDate}:${daysRemaining}`,
    context: { days: String(daysRemaining), expiry_date: String(endDate) },
  });
}

/** A membership ended yesterday. */
async function membershipExpired(orgId, { clientId, endDate }) {
  return emit({
    orgId,
    event: 'membership_expired',
    subjectId: clientId,
    eventKey: `${clientId}:${endDate}`,
    context: { expiry_date: String(endDate) },
  });
}

/** It is a client's birthday. */
async function birthday(orgId, { clientId, today }) {
  return emit({
    orgId,
    event: 'birthday',
    subjectId: clientId,
    // The year, not the full date: the month and day are already implied by
    // the sweep having selected this client at all, and the year is what makes
    // next year's birthday a different event from this one's.
    eventKey: `${clientId}:${String(today).slice(0, 4)}`,
    context: {},
  });
}

/** It is the anniversary of a client joining. */
async function anniversary(orgId, { clientId, years, today }) {
  return emit({
    orgId,
    event: 'anniversary',
    subjectId: clientId,
    eventKey: `${clientId}:${String(today).slice(0, 4)}`,
    context: { years: String(years) },
  });
}

/** A client has not been seen for a while. */
async function attendanceMissed(orgId, { clientId, lastVisit, daysSince }) {
  return emit({
    orgId,
    event: 'attendance_missed',
    subjectId: clientId,
    // The LAST VISIT, not the day count. The count climbs every day the client
    // stays away, so keying on it would send one message per day of absence;
    // the last visit does not change until they come back, which is exactly
    // when the next absence should be allowed to fire.
    eventKey: `${clientId}:${lastVisit}`,
    context: { days: String(daysSince), last_visit: String(lastVisit) },
  });
}

/** A lead's follow-up date has arrived. */
async function followupDue(orgId, { leadId, followUpDate, interestedPackage }) {
  return emit({
    orgId,
    event: 'followup_due',
    recipientType: 'lead',
    subjectId: leadId,
    // The follow-up date is the event. A lead whose date has passed is chased
    // once; moving the date — which is a human deciding to chase again — is
    // what produces the next one.
    eventKey: `${leadId}:${followUpDate}`,
    context: { follow_up_date: String(followUpDate), package: interestedPackage || '' },
  });
}

module.exports = {
  // Request-driven: called from the handler that performs the business write.
  paymentReceived,
  // Same event, for a service that has an organization but no request.
  paymentReceivedFor,
  memberCreated,
  sessionLow,
  sessionLowThreshold,
  leadCreated,
  trialScheduled,
  // Sweep-driven: called from src/modules/automation/automation.sweep.js.
  membershipExpiring,
  membershipExpired,
  birthday,
  anniversary,
  attendanceMissed,
  followupDue,
};


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
  return emit({
    orgId: orgIdOf(req),
    event: 'payment_received',
    clientId,
    eventKey,
    context: { amount: `${currency}${amount}`, amount_value: amount },
    requestId: req.id,
  });
}

/** A client was enrolled. */
async function memberCreated(req, { clientId }) {
  return emit({
    orgId: orgIdOf(req),
    event: 'member_created',
    clientId,
    // The client id IS the event: a client is created once, and a retried
    // enrolment that produced a second row is a different client.
    eventKey: clientId,
    context: {},
    requestId: req.id,
  });
}

/**
 * A client's PT session balance ran low.
 *
 * The event key carries the remaining count so that a balance falling 3 → 2 →
 * 1 fires three times, while a page that reads the balance twice at 2 fires
 * once. Dropping the count would make the first reading the only one that ever
 * fires; using a timestamp would make every read fire.
 */
async function sessionLow(req, { clientId, remaining }) {
  return emit({
    orgId: orgIdOf(req),
    event: 'session_low',
    clientId,
    eventKey: `${clientId}:${remaining}`,
    context: { remaining: String(remaining) },
    requestId: req.id,
  });
}

module.exports = { paymentReceived, memberCreated, sessionLow };

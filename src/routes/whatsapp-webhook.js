'use strict';
// src/routes/whatsapp-webhook.js
//
// Receives normalised connection events from the self-hosted WhatsApp gateway
// and keeps whatsapp_instances in step with them.
//
// Mounted BEFORE express.json() in server.js, exactly like
// routes/razorpay-webhook.js, because the signature covers the RAW body. Any
// middleware that parses and re-serialises the JSON first changes the bytes and
// every signature fails — which presents as "the webhook never works" with
// nothing in the logs to explain why.
//
// ── What this adds over the Razorpay handler it is modelled on ──────────────
//
// 1. A timestamp INSIDE the signed material, plus a ±5 minute window. Razorpay's
//    handler signs the body alone, so a captured request replays forever. Here
//    an attacker cannot move a captured event to a new time without
//    invalidating it.
//
// 2. An idempotency ledger. The gateway delivers at-least-once — its outbox
//    retries on any non-2xx, and a crash between delivery and acknowledgement
//    replays — so duplicates are NORMAL. Without the ledger a redelivered
//    `disconnected` would overwrite a `connected` that arrived after it, and a
//    studio would be shown as offline while its WhatsApp is working.

const express = require('express');
const crypto  = require('crypto');
const pool    = require('../db/pool');
const logger  = require('../lib/logger');

const router = express.Router();

/** ±5 minutes. Wide enough for clock skew between two containers, narrow
 *  enough that a captured request is useless by the time it is replayed. */
const TIMESTAMP_TOLERANCE_SEC = 300;

// 64 KB. The gateway sends small JSON envelopes; no media crosses this hop.
router.use(express.raw({ type: 'application/json', limit: '64kb' }));

/**
 * Constant-time compare that does not leak length either.
 *
 * timingSafeEqual throws on a length mismatch, and returning early on that
 * throw leaks the secret's length through response timing. Hashing both sides
 * first makes every comparison run over 32 bytes. Same helper, same reasoning,
 * as middleware/serviceAuth.js.
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Which whatsapp_instances columns an event updates.
 *
 * A lookup rather than a switch so that an unknown event_type is inert by
 * construction: it is acknowledged (so the gateway stops retrying it) and
 * changes nothing. A `default:` branch that guessed would be worse — the
 * gateway may ship a new event type before this deploy does.
 */
const STATUS_FOR_EVENT = {
  'whatsapp.instance.created':      'never_connected',
  'whatsapp.instance.qr':           'connecting',
  'whatsapp.instance.connecting':   'connecting',
  'whatsapp.instance.connected':    'connected',
  'whatsapp.instance.disconnected': 'disconnected',
  'whatsapp.instance.logged_out':   'logged_out',
};

/**
 * Apply one message lifecycle event to communication_logs.
 *
 * ── Two different keys, and the reason for each ─────────────────────────────
 *
 * `sent` and `failed` are matched on the ERP's own id — the one it minted as
 * communication_logs.id and handed the gateway as client_message_id — because
 * at the moment they are emitted that is the only id both sides share.
 *
 * `delivered` and `read` are matched on the PROVIDER's message id, because
 * WhatsApp's own receipts arrive keyed that way and the alternative would be
 * for the gateway to hold a mapping across restarts. The ERP already stored
 * that id in external_id when it processed `sent`, so the join exists here.
 *
 * ── Why a receipt for an unknown message is not an error ────────────────────
 *
 * A studio replying by hand from their phone produces receipts too, and the
 * connector filters those on `fromMe` — but a message sent before this deploy,
 * or one whose row was pruned, would also arrive with nothing to match. The
 * count is returned and logged; the webhook still answers 2xx, because asking
 * the gateway to retry an event that can never match is how a dead-letter list
 * fills up with nothing actionable.
 *
 * Every statement is bound to `tenant_id` from the signed envelope, so an
 * event naming another studio's message id updates nothing.
 */
async function applyMessageEvent(eventType, payload, tenantId, occurredAt, client) {
  const repo = require('../modules/automation/automation.repository');
  const kind = eventType.slice('whatsapp.message.'.length);

  if (kind === 'delivered' || kind === 'read') {
    const externalId = payload.provider_message_id;
    if (!externalId) return { applied: 0, subject: null };
    const applied = await repo.applyReceipt(
      tenantId,
      externalId,
      kind,
      payload.delivered_at || payload.read_at || occurredAt || null,
      { client }
    );
    return { applied, subject: externalId };
  }

  if (kind === 'failed') {
    const logId = payload.client_message_id;
    if (!logId) return { applied: 0, subject: null };
    const applied = await repo.markFailedByClientId(
      tenantId, logId, payload.reason_code || 'gateway_failed', { client }
    );
    return { applied, subject: logId };
  }

  // `sent` is deliberately inert. The worker already recorded the send
  // synchronously from the HTTP response, which carried the same provider id —
  // and it did so before this event could arrive. Applying it again would at
  // best be a no-op and at worst move a row that has since been delivered back
  // to 'sent'.
  //
  // The provider id is still returned so the ledger records WHICH message the
  // event was about. That is what makes a later unmatched receipt diagnosable:
  // the id the gateway believes it sent under, next to the id a receipt came
  // looking for, in two rows of the same table.
  return { applied: 0, subject: payload.provider_message_id || payload.client_message_id || null };
}

/**
 * Stamp the claim row with what the event referred to and what it changed.
 *
 * The statement lives in the repository, like every other write this handler
 * performs; this is the adapter half. A separate UPDATE rather than more
 * columns on the claim INSERT, because the
 * claim has to be taken BEFORE the work — it is what serialises two concurrent
 * redeliveries — and `applied_rows` is only known after. Same transaction, so
 * the outcome commits with the work it describes or not at all: there is no
 * state in which the ledger claims an event applied 1 row and the row is
 * unchanged.
 *
 * Never allowed to fail the request. This is observability; a webhook that
 * answered 500 because it could not write a diagnostic column would turn the
 * thing meant to explain a problem into one.
 */
async function recordOutcome(client, eventId, subject, applied) {
  const repo = require('../modules/automation/automation.repository');
  try {
    await repo.recordEventOutcome(eventId, subject, applied, { client });
  } catch (err) {
    logger.warn({ err: err.message, event_id: eventId }, 'whatsapp_webhook_outcome_not_recorded');
  }
}

router.post('/', async (req, res) => {
  const secret = process.env.WA_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed on a half-configured deploy, as serviceAuth.js does: an
    // unverifiable claim answered with "fine" is worse than an outage.
    logger.error('WA_WEBHOOK_SECRET is not set — whatsapp webhook rejected');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const signature = req.headers['x-wa-signature'];
  const timestamp = req.headers['x-wa-timestamp'];

  if (!signature || !timestamp) {
    return res.status(400).json({ error: 'Missing signature headers' });
  }

  // Strict. `parseInt` would read '1788000000abc' as a valid 1788000000, and
  // Number('') is 0 — a plausible-looking epoch in 1970.
  if (!/^\d{1,15}$/.test(String(timestamp))) {
    return res.status(400).json({ error: 'Malformed timestamp' });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > TIMESTAMP_TOLERANCE_SEC) {
    logger.warn({ skew_s: nowSec - Number(timestamp) }, 'whatsapp_webhook_stale_timestamp');
    return res.status(400).json({ error: 'Stale timestamp' });
  }

  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`, 'utf8').digest('hex');

  if (!safeEqual(signature, expected)) {
    // Never log the presented signature — a near-miss is the most useful thing
    // an attacker could get written into a log file.
    logger.warn({ ip: req.ip }, 'whatsapp_webhook_signature_mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const { event_id, event_type, instance_id, tenant_id, occurred_at } = event || {};
  if (!event_id || !event_type || !instance_id || !tenant_id) {
    return res.status(400).json({ error: 'Malformed event envelope' });
  }

  const log = logger.child({
    event_id,
    event_type,
    instance_id,
    tenant_id,
    operation: 'whatsapp.webhook',
  });

  // ── One transaction for the claim AND the work it authorises ──────────────
  //
  // These used to be two autocommitted statements, and the claim went first.
  // That made the ledger a record of "an event arrived", not of "an event was
  // applied" — so any failure AFTER the claim lost the event permanently:
  //
  //   1. INSERT the claim            → committed immediately
  //   2. apply the event             → throws (a deadlock, a blip, anything)
  //   3. answer 500                  → the gateway dutifully retries
  //   4. the retry hits ON CONFLICT  → "duplicate", returns without applying
  //
  // The comment on the catch below promised that a database blip "delays the
  // update rather than losing it". The opposite was true, and nothing would
  // have said so: the studio simply never sees that message reach delivered.
  //
  // Sharing one transaction makes the claim conditional on the work. A failure
  // rolls both back, so the gateway's retry finds no claim and genuinely
  // re-applies. A duplicate is still answered 2xx and still does nothing.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ── Idempotency ─────────────────────────────────────────────────────────
    //
    // The INSERT is the claim. ON CONFLICT DO NOTHING with a checked rowCount
    // is atomic; a SELECT-then-INSERT would let two concurrent redeliveries
    // both see "not present" and both apply the update.
    //
    // Two concurrent redeliveries still serialise here: the loser blocks on
    // the winner's uncommitted row and sees rowCount 0 once it commits.
    const claim = await client.query(
      `INSERT INTO whatsapp_webhook_events (event_id, event_type, organization_id, instance_id, occurred_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
       ON CONFLICT (event_id) DO NOTHING`,
      [event_id, event_type, tenant_id, instance_id, occurred_at || null]
    );

    if (claim.rowCount === 0) {
      // A duplicate IS success from the sender's point of view — answering
      // non-2xx would make the gateway retry it forever.
      await client.query('ROLLBACK');
      log.info({ status: 'ok', duplicate: true }, 'whatsapp_webhook_duplicate');
      return res.json({ received: true, duplicate: true });
    }

    // ── Message lifecycle events ────────────────────────────────────────────
    //
    // These update communication_logs rather than whatsapp_instances, so they
    // branch before the instance-status lookup below. They are the delivery
    // callbacks the table's sent_at / delivered_at / read_at columns and its
    // 'delivered'/'read' status values have been waiting for since migration
    // 012 — until now nothing wrote them, because nothing sent anything.
    if (event_type.startsWith('whatsapp.message.')) {
      const { applied, subject } = await applyMessageEvent(
        event_type, event.payload || {}, tenant_id, occurred_at, client
      );
      await recordOutcome(client, event_id, subject, applied);
      await client.query('COMMIT');
      // `applied: 0` on a receipt is the signal worth having: the event was
      // genuine and verified, and it matched no message this ERP sent. Logged
      // at warn (not info) with the id it was looking for, and recorded on the
      // ledger row so the answer survives log retention.
      if (applied === 0 && (event_type.endsWith('.delivered') || event_type.endsWith('.read'))) {
        log.warn({ status: 'ok', applied, subject_key: subject }, 'whatsapp_webhook_receipt_unmatched');
      } else {
        log.info({ status: 'ok', applied, subject_key: subject }, 'whatsapp_webhook_message_event');
      }
      return res.json({ received: true });
    }

    const status = STATUS_FOR_EVENT[event_type];
    if (!status) {
      // Acknowledged and ignored. The gateway may ship a new event type before
      // this deploy does, and retrying something we will never understand
      // only fills the dead-letter list.
      await recordOutcome(client, event_id, null, 0);
      await client.query('COMMIT');
      log.info({ status: 'ok', applied: false }, 'whatsapp_webhook_unknown_type');
      return res.json({ received: true });
    }

    const payload = event.payload || {};

    // ── Apply, but never move an instance BACKWARDS in time ─────────────────
    //
    // `last_event_at` guards ordering. At-least-once delivery plus independent
    // retry backoff means events can arrive out of order — a retried
    // `disconnected` landing after the `connected` that superseded it. Without
    // this guard that would show a studio as offline while its WhatsApp works,
    // and nothing would correct it until the next real transition.
    //
    // Scoped by instance_id AND organization_id. The tenant_id is the
    // gateway's, and the gateway is trusted here (it holds the signing secret),
    // but scoping costs nothing and means a gateway bug cannot rewrite another
    // studio's row.
    const result = await client.query(
      `UPDATE whatsapp_instances
          SET status          = $3,
              phone_e164      = COALESCE($4, phone_e164),
              last_error_code = $5,
              connected_at    = CASE WHEN $3 = 'connected' THEN COALESCE($6::timestamptz, NOW())
                                     ELSE connected_at END,
              disconnected_at = CASE WHEN $3 IN ('disconnected','logged_out','failed')
                                     THEN NOW() ELSE disconnected_at END,
              last_event_at   = COALESCE($7::timestamptz, NOW()),
              updated_at      = NOW()
        WHERE instance_id = $1
          AND organization_id = $2
          AND (last_event_at IS NULL OR last_event_at <= COALESCE($7::timestamptz, NOW()))`,
      [
        instance_id,
        tenant_id,
        status,
        payload.phone_e164 || null,
        payload.reason_code || null,
        payload.connected_at || null,
        occurred_at || null,
      ]
    );

    await recordOutcome(client, event_id, instance_id, result.rowCount);

    // Committed BEFORE the re-drive below. That enqueues real sends to real
    // people, and a transaction that later rolled back would have it acting on
    // a reconnection the database never recorded.
    await client.query('COMMIT');

    log.info(
      { status: 'ok', applied: result.rowCount > 0, new_status: status },
      result.rowCount > 0 ? 'whatsapp_webhook_applied' : 'whatsapp_webhook_superseded'
    );

    // ── A reconnection re-drives what was lost while it was down ───────────
    //
    // The worker marks a message `failed` when the studio's WhatsApp is
    // unusable, and rightly does not retry it: no number of BullMQ attempts
    // reconnects a socket only the studio can restore by scanning a QR. But
    // nothing acted on the restore either. Production: a Welcome Message
    // failed `whatsapp_logged_out` at 10:56, the studio reconnected at 11:04,
    // and the message stayed failed permanently — its dedupe key means the
    // business event can never produce another row.
    //
    // This is that missing half. Only on an APPLIED transition to connected:
    // `applied: false` means this event was superseded by a newer one, and
    // acting on a stale reconnect would re-drive against a status that has
    // since moved on.
    //
    // Fire-and-forget, and caught. The studio's WhatsApp coming back must be
    // recorded even if re-driving its backlog fails — and a throw here would
    // answer 500, which makes the gateway redeliver an event that was applied
    // correctly.
    if (status === 'connected' && result.rowCount > 0) {
      const { recoverAfterReconnect } = require('../modules/automation/automation.recovery');
      recoverAfterReconnect(tenant_id)
        .then((stats) => {
          if (stats.requeued > 0 || stats.candidates > 0) {
            log.info({ org_id: tenant_id, ...stats }, 'whatsapp_reconnect_recovery');
          }
        })
        .catch((err) => log.error({ err: err.message, org_id: tenant_id }, 'whatsapp_reconnect_recovery_failed'));
    }

    // 200 either way. `applied: false` means the row is already newer, which is
    // a correct outcome, not a failure to retry.
    return res.json({ received: true, applied: result.rowCount > 0 });
  } catch (err) {
    // Roll the claim back with the work. This is what makes the 500 below
    // honest: the gateway retries, finds no claim, and applies the event for
    // real. Before the two shared a transaction the claim survived and the
    // retry was answered "duplicate", so the event was lost for good.
    //
    // A failed ROLLBACK is swallowed — the connection is being released either
    // way, and masking the original error with a teardown error would hide the
    // reason this request failed.
    await client.query('ROLLBACK').catch(() => {});
    // 500 so the gateway retries. Its outbox is durable and bounded, so a
    // database blip now delays the update rather than losing it.
    log.error({ status: 'error', err: err.message }, 'whatsapp_webhook_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  } finally {
    client.release();
  }
});

module.exports = router;

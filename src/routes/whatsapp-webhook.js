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

  try {
    // ── Idempotency ─────────────────────────────────────────────────────────
    //
    // The INSERT is the claim. ON CONFLICT DO NOTHING with a checked rowCount
    // is atomic; a SELECT-then-INSERT would let two concurrent redeliveries
    // both see "not present" and both apply the update.
    const claim = await pool.query(
      `INSERT INTO whatsapp_webhook_events (event_id, event_type, organization_id, instance_id, occurred_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
       ON CONFLICT (event_id) DO NOTHING`,
      [event_id, event_type, tenant_id, instance_id, occurred_at || null]
    );

    if (claim.rowCount === 0) {
      // A duplicate IS success from the sender's point of view — answering
      // non-2xx would make the gateway retry it forever.
      log.info({ status: 'ok', duplicate: true }, 'whatsapp_webhook_duplicate');
      return res.json({ received: true, duplicate: true });
    }

    const status = STATUS_FOR_EVENT[event_type];
    if (!status) {
      // Acknowledged and ignored. The gateway may ship a new event type before
      // this deploy does, and retrying something we will never understand
      // only fills the dead-letter list.
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
    const result = await pool.query(
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

    log.info(
      { status: 'ok', applied: result.rowCount > 0, new_status: status },
      result.rowCount > 0 ? 'whatsapp_webhook_applied' : 'whatsapp_webhook_superseded'
    );

    // 200 either way. `applied: false` means the row is already newer, which is
    // a correct outcome, not a failure to retry.
    return res.json({ received: true, applied: result.rowCount > 0 });
  } catch (err) {
    // 500 so the gateway retries. Its outbox is durable and bounded, so a
    // database blip delays the update rather than losing it.
    log.error({ status: 'error', err: err.message }, 'whatsapp_webhook_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;

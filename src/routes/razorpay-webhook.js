// src/routes/razorpay-webhook.js
// H-06: Razorpay webhook receiver with HMAC-SHA256 signature verification.
// Mount BEFORE express.json() so the raw body is available for sig check.

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
// No database import here: this handler no longer writes. See the event
// dispatch block below for what was removed and why.
const logger  = require('../lib/logger');

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

// Raw-body middleware for this route only — must come before json parsing.
router.use(express.raw({ type: 'application/json', limit: '50kb' }));

router.post('/', async (req, res) => {
  if (!WEBHOOK_SECRET) {
    logger.error('RAZORPAY_WEBHOOK_SECRET is not set — webhook rejected');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing signature header' });
  }

  // H-06: timing-safe HMAC comparison
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    logger.warn({ signature }, 'Razorpay webhook signature mismatch');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const eventType = event?.event;
  logger.info({ eventType }, 'Razorpay webhook received');

  try {
    // ── The three UPDATEs that used to live here are gone ──────────────────
    //
    // They read:
    //
    //   UPDATE payments SET gateway_status = 'captured', gateway_payload = $2
    //    WHERE gateway_payment_id = $1
    //
    // and neither `gateway_payment_id`, `gateway_payload` nor `refund_id`
    // exists on that table — it carries `gateway_txn_id` and no payload column
    // at all. So every payment.captured, payment.failed and refund.processed
    // event raised `column "gateway_payment_id" does not exist`, was caught by
    // the handler below, logged, and answered 200 so that Razorpay would not
    // retry. Silent, total loss of every gateway payment confirmation, for as
    // long as this has been deployed.
    //
    // Nothing was lost in practice: production holds 26 payments, all CASH or
    // UPI, and zero gateway payments have ever been recorded — which is what
    // being broken since the beginning looks like from the data side.
    //
    // The legacy `payments` table is being dropped, and pt_payments has no
    // gateway columns, so there is nothing to repoint this at. Recording
    // gateway payments is a feature to be built on pt_payments deliberately,
    // with the columns it needs and an organization_id on every row — not a
    // repair of three statements that never worked.
    //
    // The signature verification above is untouched and still runs. This
    // endpoint remains a valid, authenticated webhook receiver; it simply no
    // longer claims to write a payment it cannot write.
    if (eventType === 'payment.captured' || eventType === 'payment.failed'
        || eventType === 'refund.processed') {
      logger.info(
        { eventType, payment_id: event.payload?.payment?.entity?.id
          || event.payload?.refund?.entity?.payment_id || null },
        'razorpay_payment_event_not_recorded'
      );
    }

    // Unknown event types are acknowledged but ignored
    res.json({ received: true });
  } catch (err) {
    logger.error({ err: err.message, eventType }, 'Razorpay webhook handler error');
    // Return 200 anyway so Razorpay does not retry — DB errors are logged
    res.json({ received: true });
  }
});

module.exports = router;

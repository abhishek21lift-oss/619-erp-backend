'use strict';
// How a WhatsApp message actually leaves this building.
//
// ── Why this layer exists at all ────────────────────────────────────────────
//
// Before it, `services/whatsappDelivery.js` WAS the transport: it read
// TWILIO_ACCOUNT_SID and TWILIO_WHATSAPP_FROM straight from process.env and
// posted to Twilio. That has one property that makes it unusable for studio
// automation, and it is not a small one — the sender is a single
// platform-wide number with no tenancy anywhere in the call. The adapter it
// served took `{ to, template, variables }`: a bare phone number and no
// organization_id at all. There was nothing to isolate because tenancy never
// entered the path.
//
// What a studio is buying is that a message to their client arrives from THEIR
// WhatsApp — their business name, their number, a thread the client already
// has. So the transport has to be resolved per organization, from that
// organization's own connected instance, and the resolution has to be the same
// one every caller uses or the two paths drift.
//
// ── Provider-agnostic, deliberately ─────────────────────────────────────────
//
// The automation engine never names Baileys. It calls send() with an
// organization and a message; this module decides what carries it. Adding a
// provider — a fallback, WhatsApp Cloud API, a regional gateway — is a new
// entry in PROVIDERS and a resolution rule, not a change to the engine, the
// worker, or the logging.
//
// ── The one thing this will NOT do ──────────────────────────────────────────
//
// It will not silently fall back to a shared platform number for an automated
// send. Everywhere else in this codebase, degrading beats failing: the gateway
// client returns a result instead of throwing, notifications fall back to
// inline delivery when Redis is down. This is the exception, and the reason is
// that the fallback is not a worse version of the same thing — it is a
// different thing.
//
// A studio's client receives an automated reminder. If it comes from a number
// they do not recognise, carrying a platform identity rather than the gym's,
// the studio has not had a degraded send. They have had their client messaged
// by a stranger on their behalf, in a thread they cannot see, and they will
// find out when the client asks them about it. Not sending, and saying so
// loudly on the row and in the log, is recoverable. That is not.
//
// So `send()` for an automated message resolves the tenant's own instance or
// fails. TWILIO stays available as a provider for the explicitly non-automated
// paths that already used it, and `allowSharedProvider` is the flag that
// separates the two — named for what it permits rather than for a provider, so
// the next fallback inherits the same rule.

const pool = require('../../db/pool');
const logger = require('../../lib/logger');
const gateway = require('../../lib/whatsappGateway');

/** The providers this build knows how to send through. */
const PROVIDERS = Object.freeze({
  /** The studio's own WhatsApp, paired over the self-hosted Baileys gateway. */
  BAILEYS: 'baileys',
  /** A shared platform number. Never used for automation — see the header. */
  TWILIO: 'twilio',
});

/**
 * Outcomes, matching the vocabulary communication_logs already stores.
 *
 * `not_connected` is separate from `failed` on purpose: it is the studio's to
 * fix by reconnecting, no retry against this service will help, and telling
 * the two apart is what stops the worker burning its whole attempt budget on a
 * WhatsApp that is simply switched off.
 */
const SendStatus = Object.freeze({
  SENT: 'sent',
  FAILED: 'failed',
  NOT_CONNECTED: 'not_connected',
  NOT_CONFIGURED: 'not_configured',
});

/** Statuses a retry could plausibly change. */
function isRetryable(status) {
  return status === SendStatus.FAILED;
}

/**
 * The studio's connected WhatsApp instance, or a reason it cannot be used.
 *
 * The organization id is the ONLY input, and it must have come from an
 * authenticated session or from server-side context — never from a request
 * body. `whatsapp_instances` has a UNIQUE constraint on organization_id, so
 * this cannot return another studio's row for a valid id, and the query is
 * scoped anyway rather than relying on that.
 *
 * `status = 'connected'` is checked here as well as at the gateway. The
 * gateway is authoritative and will refuse a send on a dead socket regardless;
 * checking first means the common case — a studio that has not connected
 * WhatsApp at all — costs a local index lookup instead of an HTTP round trip
 * per queued message.
 */
async function resolveInstance(orgId) {
  if (!orgId) return { ok: false, reason: 'no_organization' };

  const { rows } = await pool.query(
    `SELECT instance_id, status, phone_e164
       FROM whatsapp_instances
      WHERE organization_id = $1`,
    [orgId]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_connected' };
  if (row.status !== 'connected') return { ok: false, reason: 'not_connected', state: row.status };

  return { ok: true, instanceId: row.instance_id, phone: row.phone_e164 };
}

/**
 * Send through the studio's own number.
 *
 * Every gateway error code is mapped to a status the caller can act on rather
 * than passed through, because the retry decision belongs to whoever owns the
 * attempt budget and it must not be made by reading message text.
 *
 * DUPLICATE_MESSAGE deserves its odd-looking treatment: it means another
 * attempt at THIS message is already in flight at the gateway. Reporting it as
 * failed would have the worker retry and race that send; reporting it as sent
 * would record a provider id we do not have. It is a non-retryable failure
 * whose row says exactly that.
 */
async function sendViaBaileys(orgId, { to, text, clientMessageId, requestId }) {
  const instance = await resolveInstance(orgId);
  if (!instance.ok) {
    return {
      status: SendStatus.NOT_CONNECTED,
      provider: PROVIDERS.BAILEYS,
      provider_id: null,
      error: instance.state ? `whatsapp_${instance.state}` : instance.reason,
    };
  }

  const res = await gateway.sendMessage(
    orgId,
    instance.instanceId,
    { to, text, clientMessageId },
    requestId
  );

  if (res.ok) {
    return {
      status: SendStatus.SENT,
      provider: PROVIDERS.BAILEYS,
      provider_id: res.data?.provider_message_id || null,
      // A replay the gateway recognised. The message went to the client once,
      // which is the outcome we wanted; the flag is carried so the caller can
      // avoid writing a second log row for it.
      duplicate: Boolean(res.data?.duplicate),
    };
  }

  if (res.code === 'INSTANCE_NOT_CONNECTED' || res.code === 'INSTANCE_NOT_FOUND') {
    return {
      status: SendStatus.NOT_CONNECTED,
      provider: PROVIDERS.BAILEYS,
      provider_id: null,
      error: res.code.toLowerCase(),
    };
  }

  if (res.code === 'GATEWAY_NOT_CONFIGURED') {
    return {
      status: SendStatus.NOT_CONFIGURED,
      provider: PROVIDERS.BAILEYS,
      provider_id: null,
      error: 'gateway_not_configured',
    };
  }

  if (res.code === 'DUPLICATE_MESSAGE') {
    return {
      status: SendStatus.FAILED,
      provider: PROVIDERS.BAILEYS,
      provider_id: null,
      error: 'duplicate_in_flight',
      // Explicitly not retryable: a retry would race the send already running.
      retryable: false,
    };
  }

  return {
    status: SendStatus.FAILED,
    provider: PROVIDERS.BAILEYS,
    provider_id: null,
    error: res.code ? res.code.toLowerCase() : 'gateway_error',
  };
}

/**
 * Send through the shared platform number.
 *
 * Reachable only with `allowSharedProvider: true`, which the automation engine
 * never sets. It exists so the non-automated paths that predate this module —
 * and any future fallback a studio explicitly opts into — have somewhere to
 * live inside the same interface rather than beside it.
 */
async function sendViaTwilio({ to, text }) {
  const { sendText } = require('../../services/whatsappDelivery');
  const res = await sendText({ to, body: text });
  return {
    status:
      res.status === 'sent'
        ? SendStatus.SENT
        : res.status === 'not_configured'
          ? SendStatus.NOT_CONFIGURED
          : SendStatus.FAILED,
    provider: PROVIDERS.TWILIO,
    provider_id: res.provider_id || null,
    error: res.error || null,
  };
}

/**
 * Send one WhatsApp message on behalf of one organization.
 *
 * @param {object} msg
 * @param {string} msg.orgId            Resolved from an authenticated session or server context.
 * @param {string} msg.to               E.164.
 * @param {string} msg.text
 * @param {string} msg.clientMessageId  Stable across the caller's retries. communication_logs.id.
 * @param {string} [msg.requestId]      Propagated so one send is traceable across both services.
 * @param {boolean} [msg.allowSharedProvider=false]
 *        Permits falling back to a shared platform number. NEVER set for an
 *        automated send — see the header for why this is the one place in the
 *        codebase that refuses to degrade.
 */
async function send({
  orgId,
  to,
  text,
  clientMessageId,
  requestId,
  allowSharedProvider = false,
}) {
  if (!orgId) {
    // Fail closed, and loudly. An org-less send is the shape of the bug this
    // module was written to remove: the old path had no organization at all
    // and posted to a shared number regardless.
    logger.error({ to_present: Boolean(to) }, 'whatsapp_send_without_organization');
    return {
      status: SendStatus.FAILED,
      provider: null,
      provider_id: null,
      error: 'no_organization',
      retryable: false,
    };
  }
  if (!to) return { status: SendStatus.FAILED, provider: null, provider_id: null, error: 'no_recipient', retryable: false };
  if (!text) return { status: SendStatus.FAILED, provider: null, provider_id: null, error: 'empty_message', retryable: false };
  if (!clientMessageId) {
    // Without it the gateway cannot dedupe, so a retry would send twice. That
    // is a caller bug and it fails here rather than becoming a double message.
    return { status: SendStatus.FAILED, provider: null, provider_id: null, error: 'no_client_message_id', retryable: false };
  }

  const result = await sendViaBaileys(orgId, { to, text, clientMessageId, requestId });

  if (result.status === SendStatus.SENT) return result;

  if (allowSharedProvider) {
    logger.warn(
      { org_id: orgId, reason: result.error },
      'whatsapp_falling_back_to_shared_provider'
    );
    return sendViaTwilio({ to, text });
  }

  // No fallback. The row records exactly why, and the studio sees "your
  // WhatsApp is not connected" rather than a message from a number they have
  // never heard of arriving at their client.
  return result;
}

module.exports = {
  send,
  resolveInstance,
  isRetryable,
  PROVIDERS,
  SendStatus,
};

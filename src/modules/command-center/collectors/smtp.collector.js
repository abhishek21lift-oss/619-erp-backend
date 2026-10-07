// src/modules/command-center/collectors/smtp.collector.js
//
// Mail health, on top of lib/email.js — no second transport, no second config
// parser. That file already knows what "configured" means, already verifies a
// connection, and already turns SMTP error codes into sentences an operator can
// act on (`diagnose()`); duplicating any of it would mean two definitions of
// "is mail working" that drift.
//
// ── Why the live probe is behind a flag ─────────────────────────────────────
//
// verifyConnection() opens a real TCP connection and runs an SMTP handshake.
// On a tick-driven console that is a connection every few seconds to a provider
// that rate-limits and, on a timeout, blocks for the full socket timeout. So
// the default probe is configuration + recent delivery outcomes, which is cheap
// and read from data we already have; the handshake runs only on an explicit
// fresh probe (the Test SMTP command in Phase 5).
//
// ── What the card judges ────────────────────────────────────────────────────
//
// The outcome of the MOST RECENT invitation email actually attempted in the
// last DELIVERY_WINDOW_DAYS — not the platform's whole history. It used to
// count every invitation ever created, so two rows from August (one cancelled,
// one activated through a copied link, neither ever emailed successfully) held
// the card at Critical indefinitely, after SMTP had been fixed and a live send
// was accepted by the provider. A health signal that cannot recover teaches
// the operator to ignore it. History is still reported in `data.history`;
// it just no longer sets the colour.
//
// Invitations shared by copy-link were never emailed (send_attempts = 0,
// sent_at NULL) and are not delivery evidence either way.
'use strict';

const { STATUS, result } = require('../registry');
const pool = require('../../../db/pool');
const email = require('../../../lib/email');

const NAME = 'smtp';

/** How far back an invitation send still says something about mail today. */
const DELIVERY_WINDOW_DAYS = 14;

async function optional(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.probe=false] run a real SMTP handshake
 */
async function collect(opts = {}) {
  const configured = email.isConfigured();
  const config = email.describeConfig();

  // Delivery evidence, from the only durable record of outbound mail we keep:
  // invitations whose email was actually attempted, inside the window.
  const invitations = await optional(async () => {
    const { rows } = await pool.query(`
      WITH attempted AS (
        SELECT sent_at, last_error, send_attempts, updated_at
          FROM admin_invitations
         WHERE (send_attempts > 0 OR sent_at IS NOT NULL)
           AND updated_at > NOW() - make_interval(days => $1)
      ), latest AS (
        SELECT sent_at, last_error, updated_at
          FROM attempted ORDER BY updated_at DESC LIMIT 1
      )
      SELECT (SELECT count(*) FROM attempted)::int                                   AS total,
             (SELECT count(*) FROM attempted WHERE sent_at IS NOT NULL)::int         AS sent,
             (SELECT count(*) FROM attempted WHERE last_error IS NOT NULL)::int      AS errored,
             (SELECT count(*) FROM attempted
               WHERE send_attempts > 0 AND sent_at IS NULL)::int                     AS attempted_never_sent,
             (SELECT max(sent_at) FROM attempted)                                    AS last_sent_at,
             (SELECT last_error FROM attempted WHERE last_error IS NOT NULL
               ORDER BY updated_at DESC LIMIT 1)                                     AS last_error,
             (SELECT updated_at FROM latest)                                         AS latest_at,
             (SELECT sent_at IS NOT NULL FROM latest)                                AS latest_ok,
             (SELECT last_error FROM latest)                                         AS latest_error,
             (SELECT count(*) FROM admin_invitations)::int                           AS history_total,
             (SELECT max(sent_at) FROM admin_invitations)                            AS history_last_sent_at`,
      [DELIVERY_WINDOW_DAYS]);
    return rows[0];
  });

  let probe = null;
  if (opts.probe) {
    probe = await optional(() => email.verifyConnection(), { ok: false, reason: 'PROBE_FAILED' });
  }

  const data = {
    configured,
    // describeConfig names the missing variables; never echo SMTP_PASS.
    missing_vars: config?.missing ?? null,
    host: config?.host ?? null,
    port: config?.port ?? null,
    from: config?.from ?? null,
    delivery: invitations ? {
      window_days: DELIVERY_WINDOW_DAYS,
      invitations_total: invitations.total,
      invitations_sent: invitations.sent,
      invitations_errored: invitations.errored,
      attempted_never_sent: invitations.attempted_never_sent,
      last_sent_at: invitations.last_sent_at,
      last_error: invitations.last_error,
      latest_attempt: invitations.latest_at
        ? { at: invitations.latest_at, ok: Boolean(invitations.latest_ok), error: invitations.latest_error || null }
        : null,
    } : null,
    history: invitations ? {
      invitations_total: invitations.history_total,
      last_sent_at: invitations.history_last_sent_at,
    } : null,
    live_probe: probe,
    probe_note: opts.probe ? null : 'Live SMTP handshake runs only on demand — it is a real connection per probe',
  };

  if (!configured) {
    // Not "unavailable": mail being off is an outage for invitations and
    // password resets, both of which the product depends on. The forgot-password
    // endpoint answers "a reset link has been sent" either way, so nothing else
    // in the system will ever tell you about this.
    return result(NAME, {
      status: STATUS.CRITICAL,
      data,
      reason: `SMTP not configured — missing ${(config?.missing || []).join(', ') || 'credentials'}. Invitations and password resets are silently discarded.`,
    });
  }

  if (probe && probe.ok === false) {
    return result(NAME, {
      status: STATUS.CRITICAL,
      data,
      reason: probe.diagnosis || probe.message || `SMTP handshake failed (${probe.reason})`,
    });
  }

  // A handshake that just succeeded is the strongest evidence there is: mail
  // works now, whatever an older send recorded.
  if (probe && probe.ok) {
    return result(NAME, { status: STATUS.HEALTHY, data, reason: null });
  }

  // The latest real send failed: that is mail today, not history.
  if (invitations && invitations.latest_at && !invitations.latest_ok && invitations.latest_error) {
    return result(NAME, {
      status: STATUS.CRITICAL,
      data,
      reason: `Latest invitation email failed — ${invitations.latest_error}`,
    });
  }

  // Attempted, no error recorded, never confirmed sent: stuck or in flight.
  if (invitations && invitations.latest_at && !invitations.latest_ok) {
    return result(NAME, {
      status: STATUS.WARNING,
      data,
      reason: 'Latest invitation email was attempted but never confirmed sent',
    });
  }

  return result(NAME, { status: STATUS.HEALTHY, data, reason: null });
}

module.exports = { NAME, collect, DELIVERY_WINDOW_DAYS };

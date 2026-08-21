const dns = require('dns').promises;
const net = require('net');
const nodemailer = require('nodemailer');
const logger = require('./logger');
const { frontendUrl } = require('./frontendUrl');
const { invitationHtml, invitationText } = require('./emailTemplates/invitation');
const { clientActivationHtml, clientActivationText } = require('./emailTemplates/clientActivation');

// FRONTEND_URL is deliberately NOT checked here any more.
//
// This module used to throw at import time if it was unset. server.js already
// lists FRONTEND_URL in REQUIRED_ENV and exits at boot when it is missing —
// earlier, and reporting every missing variable at once instead of the first.
// So the throw added nothing in production and made this module impossible to
// import anywhere that had not set the variable, which silently took out seven
// unrelated test suites the moment super-admin.routes.js started requiring it.
//
// An import-time throw for something a caller only needs at CALL time is a
// landmine: it turns "this feature is misconfigured" into "this file cannot be
// loaded". frontendUrl() reads the variable when a link is actually built.

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
// Falls back to SMTP_USER, not a hardcoded address, when SMTP_FROM is unset.
// The mailbox can always send as itself; a hardcoded domain it was never
// provisioned for cannot — and previously fell back to noreply@619fitness.com,
// a domain with no DNS records at all. Hostinger (and any relay) rejects the
// envelope outright when the From domain doesn't match the authenticated
// mailbox's, which fails password resets and the admin reset OTP silently:
// SMTP looks "configured" (host/port/user/pass all present) because the
// failure is in the From address, not the credentials.
const FROM_ADDR = process.env.SMTP_FROM || SMTP_USER;
// Invitations are the one message a recipient is asked to TRUST, so they go
// from the support identity rather than a noreply nobody can answer. Falls
// back to the general from-address so a deploy that has not set it still
// sends rather than silently doing nothing.
const INVITE_FROM = process.env.EMAIL_FROM || FROM_ADDR;

/** Retries for a send that failed for a reason that might not repeat. */
const SEND_ATTEMPTS = parseInt(process.env.SMTP_SEND_ATTEMPTS, 10) || 3;

/**
 * SMTP failures split in two, and retrying the wrong kind is worse than not
 * retrying at all: a rejected recipient retried three times is three bounces
 * against the sending domain's reputation. 4xx and connection errors are
 * transient; 5xx is the server saying "not this message, ever".
 */
function isTransient(err) {
  const code = err?.responseCode;
  if (typeof code === 'number') return code >= 400 && code < 500;
  // No response code at all means it never got far enough to be rejected —
  // DNS, TLS, timeout, refused connection. All worth another go.
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send with bounded retry and exponential backoff. Throws the final error so
 * the caller can record WHY delivery failed rather than only that it did.
 */
async function sendWithRetry(message, ctx = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      const info = await (await getTransport()).sendMail(message);
      if (attempt > 1) logger.info({ ...ctx, attempt }, 'email sent after retry');
      return info;
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === SEND_ATTEMPTS) break;
      const backoffMs = 500 * 2 ** (attempt - 1);
      logger.warn({ ...ctx, attempt, err: err.message, backoffMs }, 'email send failed — retrying');
      await sleep(backoffMs);
    }
  }
  logger.error({ ...ctx, err: lastErr?.message }, 'email send failed permanently');
  throw lastErr;
}

function isConfigured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

/**
 * Queue-or-inline dispatcher shared by the public senders below.
 *
 * When Redis/BullMQ is available the send is enqueued for the email worker and
 * this returns immediately — the request path never blocks on SMTP. When Redis
 * is unavailable, or the enqueue itself fails, it degrades to the inline send
 * so the message is still attempted. This is the "graceful degradation" rule:
 * a queue outage must mean slower/fallback sends, never a dropped email.
 */
async function dispatchEmail(type, payload, inline) {
  try {
    const redis = require('./redis');
    if (redis.isReady()) {
      const { enqueueEmail } = require('../services/email.service');
      const job = await enqueueEmail(type, payload);
      if (job) return { sent: true, queued: true, jobId: job.id };
    }
  } catch (err) {
    logger.warn({ err: err.message, type }, 'email enqueue failed — sending inline');
  }
  return inline();
}

/**
 * The transport, and the DNS resolution that has to happen before it exists.
 *
 * Cached as a PROMISE rather than a transport. Building one now requires a DNS
 * lookup, so a synchronous getter would either have to block or hand back a
 * half-built object; caching the in-flight promise means concurrent senders
 * all await the same resolution and exactly one transport is ever created. No
 * caller can observe a transport that is not ready, because there is nothing
 * to observe until the promise settles.
 */
let transportPromise = null;

/**
 * Resolve SMTP_HOST to a single IPv4 literal, or null if that is not possible.
 *
 * Never throws: a DNS failure must degrade to the previous behaviour, not take
 * outgoing mail down with it.
 */
async function resolveIpv4() {
  // An address configured directly needs no lookup, and resolve4() on a
  // literal does not do what the name suggests.
  if (net.isIP(SMTP_HOST)) return null;
  try {
    const addresses = await dns.resolve4(SMTP_HOST);
    const ip = (addresses || []).find(Boolean) || null;
    if (!ip) throw new Error('host has no A record');
    return ip;
  } catch (err) {
    // Warn, not error: mail still gets attempted over the hostname below.
    logger.warn(
      { host: SMTP_HOST, err: err.message },
      'SMTP IPv4 resolution failed — falling back to the hostname, which may '
      + 'select an unreachable IPv6 address',
    );
    return null;
  }
}

/**
 * Build the transport, pinning the connection to IPv4 by resolving the host
 * ourselves instead of asking nodemailer to prefer a family.
 *
 * ── Why `family: 4` never worked ───────────────────────────────────────────
 *
 * It was here for months, with a comment calling it "the whole reason no mail
 * was leaving the deploy", and a test asserting it was present. It does
 * nothing. nodemailer 9.0.3 never reads `options.family` — grep the package:
 * the only matches are its own internal interface probing. `connect()` builds
 * the socket options from scratch as `{ port, host, allowInternalNetworkInterfaces,
 * timeout }` plus `localAddress`, so `family` is dropped before net.connect()
 * is ever called.
 *
 * What it does instead (lib/shared/index.js) is resolve BOTH families,
 * concatenate them IPv4-first, and then pick one with `Math.random()`. So a
 * host publishing an A and an AAAA gets a coin flip per connection, and on a
 * box with no IPv6 route the AAAA half fails with ENETUNREACH. That is why
 * production kept logging ENETUNREACH against 2606:4700:… for ten days after
 * the "fix" shipped, and why it never reproduced on a laptop.
 *
 * ── Why this works ────────────────────────────────────────────────────────
 *
 * `resolveHostname()` short-circuits on an IP literal — "nothing to do here" —
 * so passing one skips the resolution and the random pick entirely. There is
 * no code path left that can choose an AAAA.
 *
 * ── Why `servername` is mandatory, not decoration ─────────────────────────
 *
 * smtp-connection sets `this.servername = options.servername ? options.servername
 * : !net.isIP(this.host) ? this.host : false`. Once `host` is an IP literal
 * that middle branch is gone, so omitting `servername` yields `false` — no SNI,
 * and certificate validation against an IP address, which fails against any
 * normal SMTP certificate. It is carried into the TLS options on both paths:
 * the STARTTLS upgrade for 587 and the implicit-TLS connect for 465.
 */
async function buildTransport() {
  const ipv4 = await resolveIpv4();
  if (ipv4) {
    logger.info(
      { host: SMTP_HOST, address: ipv4, port: SMTP_PORT },
      'SMTP host resolved to IPv4 — connection pinned, no address-family selection',
    );
  }
  const transport = nodemailer.createTransport({
    // The IP when we have one; the hostname when we do not, which is exactly
    // the behaviour that shipped before this change.
    host: ipv4 || SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Always the hostname, never the address. See the note above — this is
    // what keeps TLS validating against the certificate's real subject.
    servername: SMTP_HOST,
  });
  // `pinned` is reported rather than re-derived from the transport, so nothing
  // here depends on nodemailer's internal shape.
  return { transport, pinned: Boolean(ipv4) };
}

function getTransport() {
  if (!transportPromise) {
    transportPromise = buildTransport().then(({ transport, pinned }) => {
      // A transport built on the fallback path is deliberately not cached, so
      // the next send retries the lookup. A DNS blip at boot would otherwise
      // pin the process to the hostname — and therefore to the random address
      // pick — for the rest of its life. buildTransport() never rejects, so
      // the cache can never hold a poisoned promise.
      if (!pinned) transportPromise = null;
      return transport;
    });
  }
  return transportPromise;
}

/**
 * Public entry point — enqueues the reset email when Redis is ready, otherwise
 * falls back to the inline SMTP send (which throws on permanent failure so the
 * caller can surface it; see sendPasswordResetInline).
 */
async function sendPasswordReset(email, rawToken) {
  return dispatchEmail('password_reset', { email, token: rawToken }, () =>
    sendPasswordResetInline(email, rawToken)
  );
}

/**
 * @returns {Promise<{sent: boolean, reason?: string}>} so the caller can tell
 *   "not configured" from "sent" — it used to return undefined in both cases,
 *   which made the two indistinguishable at the only call site that has to
 *   stay silent to its own caller for enumeration reasons.
 */
async function sendPasswordResetInline(email, rawToken) {
  if (!isConfigured()) {
    logger.warn({ email, missing: describeConfig().missing },
      'SMTP not configured — password reset email skipped');
    return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };
  }

  // frontendUrl(), not string concatenation: FRONTEND_URL is stored with a
  // trailing slash in production, which would make every reset link
  // ".com//reset-password".
  const resetUrl = frontendUrl(`/reset-password?token=${rawToken}`);

  // sendWithRetry, not a bare sendMail: a reset link that fails on a transient
  // TLS blip is a person locked out, and the invitation path already retries.
  //
  // This THROWS on permanent failure rather than logging and returning. It used
  // to swallow the error, which made the `.catch()` at its only call site
  // (routes/auth.js) dead code and made "the email failed" indistinguishable
  // from "the email was sent" to anything upstream. The public forgot-password
  // route still cannot tell its caller — it must not reveal whether an address
  // exists — but it already attaches that .catch(), so it is unaffected, and
  // the operator-facing route can now report the truth.
  await sendWithRetry({
    from: FROM_ADDR,
    to: email,
    subject: 'Password Reset — MY PT STUDIO',
    html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#e11d48">Password Reset Request</h2>
          <p>Click the link below to set a new password.</p>
          <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#e11d48;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Set Password</a>
          <p style="color:#666;font-size:13px">If you didn't request this, ignore this email.</p>
        </div>
      `,
  }, { email, kind: 'password_reset' });
  logger.info({ email }, 'Password reset email sent');
  return { sent: true };
}

async function sendAdminResetOtp(email, otp) {
  return dispatchEmail('admin_otp', { email, otp }, () =>
    sendAdminResetOtpInline(email, otp).catch((err) => {
      logger.error({ err: err.message, email }, 'Failed to send admin reset OTP email');
      return { sent: false, reason: err.message };
    })
  );
}

/**
 * Inline SMTP send used by the email worker and by sendAdminResetOtp's
 * fallback. Unlike the public wrapper this THROWS on failure — the worker
 * relies on the throw so BullMQ retry/backoff applies to a transient SMTP
 * blip. A user waiting for a reset code is exactly who deserves a retry.
 */
async function sendAdminResetOtpInline(email, otp) {
  if (!isConfigured()) return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };
  const t = await getTransport();
  await t.sendMail({
    from: FROM_ADDR,
    to: email,
    subject: 'MY PT STUDIO — Admin Data Reset OTP',
    text: `Your one-time code to confirm the data reset is: ${otp}\n\nThis code expires in 10 minutes. If you did not request this, ignore this email.`,
    html: `<p>Your one-time code to confirm the data reset is:</p><h2>${otp}</h2><p>This code expires in <strong>10 minutes</strong>. If you did not request this, ignore this email.</p>`,
  });
  return { sent: true };
}

/**
 * The admin invitation.
 *
 * Unlike the other senders here this one THROWS on failure instead of logging
 * and returning. The difference is what the caller can do about it: a password
 * reset that does not arrive can be requested again by the user themselves,
 * but only the operator can resend an invitation, and they can only do that if
 * the UI told them it failed. Swallowing this error produces a studio sitting
 * unclaimed with everyone believing the email went out.
 */
async function sendAdminInvitation({ to, ownerName, studioName, actionUrl, pixelUrl, expiryHours }) {
  if (!isConfigured()) {
    const err = new Error('SMTP is not configured on this deploy');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const vars = { ownerName, studioName, email: to, actionUrl, pixelUrl, expiryHours };
  return sendWithRetry({
    from: INVITE_FROM,
    to,
    subject: `You're invited to MY PT STUDIO — activate ${studioName || 'your studio'}`,
    text: invitationText(vars),
    html: invitationHtml(vars),
    headers: {
      // Not a marketing email, and mail clients treat it better when told so.
      'X-Entity-Ref-ID': 'admin-invitation',
    },
  }, { to, kind: 'admin_invitation' });
}

/**
 * The client activation email.
 *
 * Throws when SMTP is unconfigured rather than resolving quietly, the same as
 * sendAdminInvitation. The caller has already created the account and the
 * link by this point, so a silent no-op would leave a trainer looking at a
 * card that says the client was invited when nothing was sent. The route
 * turns the throw into a 502 that says exactly that and offers Resend.
 */
async function sendClientActivation({ to, clientName, studioName, actionUrl, expiryHours }) {
  if (!isConfigured()) {
    const err = new Error('SMTP is not configured on this deploy');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  const vars = { clientName, studioName, actionUrl, expiryHours };
  return sendWithRetry({
    from: INVITE_FROM,
    to,
    subject: `Activate your ${studioName || 'MY PT STUDIO'} account`,
    text: clientActivationText(vars),
    html: clientActivationHtml(vars),
    headers: {
      // Not a marketing email, and mail clients treat it better when told so.
      'X-Entity-Ref-ID': 'client-activation',
    },
  }, { to, kind: 'client_activation' });
}

/**
 * Generic send for callers that are not one of the named flows above (e.g.
 * the notification centre's email channel). Routes through the same
 * transporter, retry policy and FROM address as everything else in this
 * file — there must be exactly one place that knows how to reach Hostinger,
 * or the two drift (which is how the notification channel ended up with its
 * own copy of the SMTP setup, keyed off an SMTP_SECURE variable this file
 * never reads and Render was never told to set).
 *
 * Never throws — returns a result object instead, since callers here (the
 * notification log) want a status to record, not an exception to catch.
 */
async function sendRaw({ to, subject, html, text }, ctx = {}) {
  if (!isConfigured()) return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };
  try {
    const info = await sendWithRetry({ from: FROM_ADDR, to, subject, html, text }, ctx);
    return { sent: true, messageId: info?.messageId };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

/**
 * Explain an SMTP failure in terms of what to change, rather than echoing a
 * code. Lifted here from scripts/verify-smtp.js so the boot check and the
 * script give the same answer — two diagnoses that disagree is worse than one.
 */
function diagnose(err) {
  const code = err?.code || '';
  const response = err?.response || '';

  if (code === 'EAUTH' || /535|534|password|authenticat/i.test(response)) {
    return 'The host accepted the connection but rejected the credentials. '
      + 'SMTP_USER must be the FULL address, not the mailbox name; SMTP_PASS is the '
      + 'MAILBOX password from hPanel → Emails → the mailbox → Change password, not the '
      + 'hPanel account password; and the mailbox must actually exist — authenticating '
      + 'against an address that was never provisioned fails exactly like a wrong password.';
  }
  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(err?.message || '')) {
    return `The hostname "${SMTP_HOST}" does not resolve, so this is a wrong host or a typo `
      + 'rather than a credentials problem. Check for a stray space or a pasted https:// prefix — '
      + 'this field is a bare hostname, not a URL.';
  }
  // Checked before the generic connection branch below, which used to catch
  // this and blame a blocked SMTP port — confident, wrong, and it cost several
  // rounds of changing SMTP_PORT back and forth. An unreachable network with a
  // colon-bearing address is IPv6, and it is a different problem entirely.
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || /ENETUNREACH|EHOSTUNREACH/.test(err?.message || '')) {
    const v6 = /\b([0-9a-f]{0,4}:){3,}[0-9a-f]{0,4}\b/i.test(err?.message || '');
    return v6
      ? `No route to "${SMTP_HOST}" over IPv6. The host publishes an AAAA record, this network `
        + 'has no IPv6 route, and Node prefers AAAA by default — so the connection never reaches '
        + 'the IPv4 address that does work. The transport pins family: 4 to prevent this; if you '
        + 'are seeing this, something is building a transport that does not.'
      : `No route to "${SMTP_HOST}" from this host — a network reachability problem rather than `
        + 'credentials, TLS or the port pairing.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNREFUSED') {
    return `Could not establish a session on port ${SMTP_PORT}. 465 is implicit TLS and 587 is `
      + 'STARTTLS, and those are the only two correct pairings. If the address in the error '
      + 'contains colons it is IPv6 and the port is a red herring — see the family: 4 note in '
      + 'getTransport(). Otherwise, some hosts do block outbound SMTP: if this works from a '
      + 'laptop but not from the deploy, that is the likely cause.';
  }
  if (code === 'EENVELOPE' || /550|553|relay/i.test(response)) {
    return 'The server refused the envelope, usually the From address. SMTP_FROM / EMAIL_FROM must be '
      + 'an address on a domain this mailbox may send as; a relay will not send for a domain it does '
      + 'not host, even with valid credentials.';
  }
  return 'No specific diagnosis for this one — see the raw error.';
}

/**
 * Prove the credentials work, without sending anything.
 *
 * Exists because every failure on the password-reset path is invisible by
 * design: the endpoint must answer the same whether or not an address is
 * registered, so a broken mailbox looks exactly like a working one until
 * somebody reports a missing email. Running this at boot turns that into a
 * line in the deploy log, on every deploy, without anyone having to think of
 * it.
 *
 * Never throws — the caller is startup, and mail being misconfigured must not
 * stop a studio taking check-ins.
 */
async function verifyConnection() {
  if (!isConfigured()) {
    return { ok: false, reason: 'SMTP_NOT_CONFIGURED', missing: describeConfig().missing };
  }
  try {
    await (await getTransport()).verify();
    return { ok: true, host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, from: FROM_ADDR };
  } catch (err) {
    return {
      ok: false,
      reason: err.code || 'ERROR',
      message: err.message,
      response: err.response,
      diagnosis: diagnose(err),
      host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, from: FROM_ADDR,
    };
  }
}

/** The three variables isConfigured() requires, in the order to report them. */
const REQUIRED_VARS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

/**
 * What state the mail configuration is in, as data rather than a log line.
 *
 * Split out from the boot check so the decision is testable without booting a
 * server — server.js reads a database, binds a port, and exits the process on
 * several paths, none of which a unit test can sit through.
 *
 * Reads process.env at CALL time, not module load, so a test can set a
 * variable and ask again.
 *
 * @returns {{state:'configured'|'partial'|'absent', set:string[], missing:string[]}}
 */
function describeConfig(env = process.env) {
  const set = REQUIRED_VARS.filter((k) => Boolean(env[k]));
  const missing = REQUIRED_VARS.filter((k) => !env[k]);
  if (set.length === REQUIRED_VARS.length) return { state: 'configured', set, missing };
  return { state: set.length > 0 ? 'partial' : 'absent', set, missing };
}


/** A studio name is user-supplied and goes straight into the markup below. */
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Welcome mail sent the moment a studio application is approved.
 *
 * Its whole job is to say "you can log in now, with the password you already
 * chose" — the applicant last saw a Pending Approval screen and has no other
 * signal that anything changed. Deliberately plain: no invitation link, because
 * there is no second credential to hand out.
 */
async function sendWelcome({ to, name, studioName, trialDays }) {
  return dispatchEmail('welcome', { to, name, studioName, trialDays }, () =>
    sendWelcomeInline({ to, name, studioName, trialDays })
  );
}

/**
 * Inline send used by the email worker and by sendWelcome's fallback. Returns
 * sendRaw's {sent, reason} shape (never throws).
 */
async function sendWelcomeInline({ to, name, studioName, trialDays }) {
  const url = `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/login`;
  const days = Number(trialDays) || 3;
  const subject = `${studioName} is live on MY PT STUDIO`;

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#0F172A">
      <h1 style="font-size:20px;margin:0 0 12px">You're approved${name ? `, ${escapeHtml(name)}` : ''} 🎉</h1>
      <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 12px">
        <strong>${escapeHtml(studioName)}</strong> has been activated by the MY PT STUDIO Command Centre.
        Your ${days}-day free trial starts now.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 20px">
        Sign in with the email and password you created when you registered.
      </p>
      <a href="${url}" style="display:inline-block;background:#0067E0;color:#fff;text-decoration:none;
        padding:12px 22px;border-radius:12px;font-weight:700;font-size:14px">Sign in</a>
      <p style="font-size:12px;color:#94A3B8;margin:20px 0 0">
        If the button does not work, open ${url}
      </p>
    </div>`;

  const text = [
    `You're approved${name ? `, ${name}` : ''}.`,
    `${studioName} has been activated. Your ${days}-day free trial starts now.`,
    'Sign in with the email and password you created when you registered.',
    url,
  ].join('\n\n');

  return sendRaw({ to, subject, html, text }, { kind: 'welcome' });
}

module.exports = {
  sendWelcome, sendPasswordReset, sendAdminResetOtp, sendAdminInvitation, sendRaw,
  sendClientActivation,
  sendWelcomeInline, sendPasswordResetInline, sendAdminResetOtpInline,
  verifyConnection, diagnose,
  isConfigured, describeConfig, REQUIRED_VARS, sendWithRetry, isTransient,
};

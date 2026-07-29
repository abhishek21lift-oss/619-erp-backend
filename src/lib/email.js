const nodemailer = require('nodemailer');
const logger = require('./logger');
const { frontendUrl } = require('./frontendUrl');
const { invitationHtml, invitationText } = require('./emailTemplates/invitation');

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
const FROM_ADDR = process.env.SMTP_FROM || 'noreply@619fitness.com';
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
      const info = await getTransport().sendMail(message);
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

let transporter = null;

function getTransport() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendPasswordReset(email, rawToken) {
  if (!isConfigured()) {
    logger.warn({ email }, 'SMTP not configured — password reset email skipped');
    return;
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
}

async function sendAdminResetOtp(email, otp) {
  if (!isConfigured()) {
    logger.warn({ email }, 'SMTP not configured — admin reset OTP not sent');
    return;
  }
  try {
    const t = getTransport();
    await t.sendMail({
      from: FROM_ADDR,
      to: email,
      subject: 'MY PT STUDIO — Admin Data Reset OTP',
      text: `Your one-time code to confirm the data reset is: ${otp}\n\nThis code expires in 10 minutes. If you did not request this, ignore this email.`,
      html: `<p>Your one-time code to confirm the data reset is:</p><h2>${otp}</h2><p>This code expires in <strong>10 minutes</strong>. If you did not request this, ignore this email.</p>`,
    });
  } catch (err) {
    logger.error({ err: err.message, email }, 'Failed to send admin reset OTP email');
  }
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

module.exports = {
  sendPasswordReset, sendAdminResetOtp, sendAdminInvitation,
  isConfigured, describeConfig, REQUIRED_VARS, sendWithRetry, isTransient,
};

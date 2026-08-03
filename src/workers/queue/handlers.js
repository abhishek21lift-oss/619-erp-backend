'use strict';

/**
 * What each queue's jobs actually do.
 *
 * Split from the Worker wiring on purpose: these are plain async functions
 * over a payload, so they can be unit-tested without Redis, and the same
 * function is what enqueue() runs inline when there is no queue. One
 * definition, two execution contexts — a second copy for the fallback path
 * would drift within a release.
 *
 * None of these implement anything new. Email still goes through lib/email.js
 * with its own inner retry; WhatsApp still goes through the notifications
 * service and its Twilio adapter; AI ingestion is still knowledgeBase's
 * pipeline; renewals are still renewal.worker's three sweeps. The queue moves
 * WHERE that work runs and gives it a retry budget that survives a restart.
 * It does not change what it does.
 *
 * ── Throwing is the interface ──────────────────────────────────────────────
 *
 * A handler that catches its own failure and returns is a job BullMQ records
 * as completed, which silently disables the retry policy. So these let errors
 * out, and the only things they catch are the cases that genuinely are not
 * failures — an unconfigured channel is a no-op, not an error to retry five
 * times with exponential backoff.
 */

const logger = require('../../lib/logger');

/* ── email ───────────────────────────────────────────────────────────────── */

/**
 * Every outgoing message goes through one of lib/email.js's senders. The job
 * carries which one and its arguments rather than a rendered message, so a
 * template fix applies to mail already sitting in the queue.
 */
async function email(data) {
  const mailer = require('../../lib/email');
  const { kind } = data;

  if (!mailer.isConfigured()) {
    // Not a failure. SMTP being unconfigured is a deployment state, and
    // retrying it five times with backoff produces five identical log lines
    // and no mail. The boot check and /super-admin/mail/status are where
    // that is reported.
    logger.warn({ kind, missing: mailer.describeConfig().missing },
      'email job skipped — SMTP not configured');
    return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };
  }

  switch (kind) {
    case 'password_reset':
      return mailer.sendPasswordReset(data.to, data.token);
    case 'admin_reset_otp':
      return mailer.sendAdminResetOtp(data.to, data.otp);
    case 'welcome':
      return mailer.sendWelcome({
        to: data.to, name: data.name, studioName: data.studioName, trialDays: data.trialDays,
      });
    case 'invitation':
      return mailer.sendAdminInvitation(data.invitation);
    case 'raw':
      // sendRaw swallows its own errors, so its result has to be inspected —
      // returning it unread would mark a failed send as a completed job.
      {
        const out = await mailer.sendRaw(
          { to: data.to, subject: data.subject, html: data.html, text: data.text },
          { kind: 'queued' }
        );
        if (out && out.sent === false && out.reason !== 'SMTP_NOT_CONFIGURED') {
          throw new Error(out.reason || 'send failed');
        }
        return out;
      }
    default:
      // Unknown kind is a bug, not a transient fault. Throwing retries it
      // four more times to no purpose, but silently dropping mail is worse.
      throw new Error(`Unknown email job kind: ${kind}`);
  }
}

/* ── whatsapp ────────────────────────────────────────────────────────────── */

/**
 * Twilio's WhatsApp adapter, via the notifications service.
 *
 * The adapter returns {status:'failed'} rather than throwing, so the result
 * is checked — otherwise every rejected message would be recorded as a
 * successful job and never retried.
 */
async function whatsapp(data) {
  const notifier = require('../../modules/notifications/notifications.service');
  const out = await notifier.send(data.type, data.recipient, data.data, ['whatsapp']);

  const failed = Array.isArray(out)
    ? out.find((r) => r && r.status === 'failed')
    : (out && out.status === 'failed' ? out : null);

  if (failed) throw new Error(failed.error || 'whatsapp send failed');
  return out;
}

/* ── ai ──────────────────────────────────────────────────────────────────── */

/**
 * Knowledge-base ingestion: extract text, chunk it, embed each chunk.
 *
 * This is the job the queue exists for. It was fire-and-forget from the
 * upload route because a multi-page PDF takes well over the 30s request
 * timeout to embed on CPU — which meant a container restart mid-ingestion
 * lost the work with the document left on status='processing' forever, and
 * nothing retried it.
 */
async function ai(data) {
  const { ingestDocument } = require('../../lib/ai/knowledgeBase');
  await ingestDocument(data.documentId);
  return { documentId: data.documentId };
}

/* ── renewal ─────────────────────────────────────────────────────────────── */

/**
 * The membership sweeps, unchanged. Each one is already idempotent and
 * row-locked — which is what made a plain setInterval safe before, and what
 * makes an at-least-once queue safe now.
 */
async function renewal(data) {
  const worker = require('../renewal.worker');
  const task = data.task || 'all';

  if (task === 'reminders') return worker.runReminders();
  if (task === 'auto_renew') return worker.runAutoRenew();
  if (task === 'class_reminders') return worker.runClassReminders();

  await worker.runReminders();
  await worker.runAutoRenew();
  await worker.runClassReminders();
  return { task: 'all' };
}

module.exports = { email, whatsapp, ai, renewal };

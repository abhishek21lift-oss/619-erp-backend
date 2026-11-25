'use strict';

// The deterministic floor under the AI draft. Every message reason has a body
// here, so an AI outage degrades the wording, not the trainer's ability to act.
// Copy is intentionally plain: no links, no emojis, no claims the studio did not
// supply.

const { firstName, reasonIdentity, MESSAGE_CODES } = require('./priority');
const { formatDay } = require('./signals/dates');

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const MESSAGE_SET = new Set(MESSAGE_CODES);

function studioLabel(name) {
  const raw = typeof name === 'string' ? name : '';
  const cleaned = raw.replace(/[<>\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 60) : 'the studio';
}

function amountLabel(value) {
  return `₹${inr.format(Number(value) || 0)}`;
}

const BODIES = {
  never_started: ({ first }) =>
    `Hi ${first}, you're all set up with us but we haven't got your first session in the diary yet. Would this week work?`,
  silent_21: ({ first }) =>
    `Hi ${first}, it's been a while since your last session and I wanted to check in. Want me to hold a slot for you this week?`,
  silent_10: ({ first }) =>
    `Hi ${first}, missed you at training lately. Shall I book you in for a session this week?`,
  term_ending_7: ({ first, date }) => (date
    ? `Hi ${first}, your PT term ends on ${date}. Want to renew and keep your slot?`
    : `Hi ${first}, your PT term is ending soon. Want to renew and keep your slot?`),
  term_ending_30: ({ first, date }) => (date
    ? `Hi ${first}, your PT term ends on ${date}. Let's plan your next block when you're ready.`
    : `Hi ${first}, your PT term is ending soon. Let's plan your next block when you're ready.`),
  term_ended: ({ first }) =>
    `Hi ${first}, your PT term has finished. If you'd like to keep training, I can set up your next block.`,
  dues: ({ first, amount }) =>
    `Hi ${first}, a balance of ${amount} is pending on your training account. Could you clear it before your next session?`,
  no_show_recent: ({ first }) =>
    `Hi ${first}, we missed you at your last session. Everything okay? Let's get you back on the schedule.`,
  checkin_missing_7: ({ first }) =>
    `Hi ${first}, how's the week going? A quick check-in helps me keep your plan on track.`,
  checkin_missing_14: ({ first }) =>
    `Hi ${first}, it's been a couple of weeks since your last check-in. How are you feeling about your training?`,
  lead_due: ({ first, studio }) =>
    `Hi ${first}, just following up on your enquiry at ${studio}. Would you like to book a trial this week?`,
  lead_stale: ({ first, studio }) =>
    `Hi ${first}, checking in about your training enquiry at ${studio}. Still interested in getting started?`,
};

function templateDraft({ subject, primaryReason, studioName }) {
  const code = primaryReason?.code;
  if (!MESSAGE_SET.has(code) || !BODIES[code]) return null;

  const ctx = {
    first: firstName(subject?.name),
    date: formatDay(primaryReason?.evidence?.pt_end_date),
    amount: amountLabel(primaryReason?.evidence?.balance_amount),
    studio: studioLabel(studioName),
  };

  return {
    body: BODIES[code](ctx),
    channel: 'whatsapp',
    source: 'template',
    model: null,
    generated_at: new Date().toISOString(),
    confidence: null,
    reason_key: reasonIdentity(primaryReason),
  };
}

module.exports = { templateDraft, firstName, studioLabel };

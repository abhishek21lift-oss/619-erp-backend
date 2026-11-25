'use strict';

// Adapter over the churn screen. `rows` is the visible list; `handled` is
// history the trainer has already parked, and re-emitting it would undo that
// decision. We do not re-score: churn-risk.js is the one scorer.

const { buildChurnList } = require('../../pt-os/churn.service');
const { POINTS } = require('../priority');

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function evidenceFor(code, row) {
  switch (code) {
    case 'never_started':
      return { never_started: true };
    case 'silent_21':
    case 'silent_10':
      return { last_session: row.last_session ?? null };
    case 'term_ending_7':
    case 'term_ending_30':
    case 'term_ended':
      return { pt_end_date: row.term?.end ?? null };
    case 'dues':
      return { balance_amount: Number(row.balance_amount) || 0 };
    default:
      return {};
  }
}

function dueFor(code, row) {
  if (code === 'term_ending_7' || code === 'term_ending_30') return row.term?.end ?? null;
  return null;
}

function labelFor(reason, row) {
  if (reason.code === 'dues') {
    return `₹${inr.format(Number(row.balance_amount) || 0)} overdue`;
  }
  return reason.label;
}

function toReason(reason, row) {
  if (!reason || !Object.prototype.hasOwnProperty.call(POINTS, reason.code)) return null;
  return {
    code: reason.code,
    label: labelFor(reason, row),
    evidence: evidenceFor(reason.code, row),
    due_at: dueFor(reason.code, row),
    // A sort key, not evidence: including it in the hash would reopen a
    // dismissed "silent" item every morning without a single fact changing.
    days_quiet: row.days_quiet ?? null,
  };
}

async function collect({ orgId, today }) {
  const list = await buildChurnList(orgId, { today });
  return (list.rows || []).flatMap((row) => {
    const subject = { type: 'client', id: row.client_id, name: row.client_name, photo_url: null };
    return (row.reasons || [])
      .map((reason) => toReason(reason, row))
      .filter(Boolean)
      .map((reason) => ({ subject, reason }));
  });
}

module.exports = { collect, toReason, evidenceFor };

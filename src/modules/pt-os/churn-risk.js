'use strict';
// Deterministic churn scoring: no clock, no DB, no model call. Every point
// traces to a reason the trainer can read, and the reasons are the contract.

const WEIGHTS = Object.freeze({
  never_started: 60,
  silent_21: 60,
  silent_10: 25,
  term_ending_7: 35,
  term_ending_30: 15,
  term_ended: 20,
  dues: 15,
});

const BANDS = [[60, 'critical'], [35, 'high'], [15, 'medium'], [1, 'low']];

const ACTIONS = {
  never_started: 'Call today and book their first session — the paid term is running.',
  silent_21: 'Call this week. They are paying for training they are not taking.',
  term_ending_7: 'Renewal conversation this week, before the term lapses.',
  term_ended: 'Win-back, not a chase. They completed what they bought.',
  silent_10: 'Check in before the gap becomes a habit.',
  term_ending_30: 'Renewal conversation in the next two weeks.',
  dues: 'Collect the balance before the next session.',
};

const ACTION_ORDER = [
  'never_started', 'silent_21', 'term_ending_7', 'term_ended',
  'silent_10', 'term_ending_30', 'dues',
];

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

function bandFor(score) {
  for (const [min, band] of BANDS) {
    if (score >= min) return band;
  }
  return null;
}

function scoreClient({ days_quiet, never_started, flagged, term, balance_amount } = {}) {
  const reasons = [];
  const add = (code, label) => reasons.push({ code, label, points: WEIGHTS[code] });

  if (never_started) {
    add('never_started', 'Paid but has never trained');
  } else if (typeof days_quiet === 'number') {
    if (days_quiet >= 21) add('silent_21', `Last trained ${days(days_quiet)} ago`);
    else if (days_quiet >= 10) add('silent_10', `Last trained ${days(days_quiet)} ago`);
  }

  const days_left = term && typeof term.days_left === 'number' ? term.days_left : null;
  const ended = days_left !== null && term.state === 'ended';
  if (ended) {
    if (flagged) add('term_ended', `Term ended ${days(Math.abs(days_left))} ago`);
  } else if (days_left !== null && days_left >= 0) {
    if (days_left === 0) add('term_ending_7', 'Term ends today');
    else if (days_left <= 7) add('term_ending_7', `Term ends in ${days(days_left)}`);
    else if (days_left <= 30) add('term_ending_30', `Term ends in ${days(days_left)}`);
  }

  if (Number(balance_amount) > 0) add('dues', 'Unpaid balance on file');

  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0));
  const codes = reasons.map((r) => r.code);
  const action = ACTION_ORDER.find((code) => codes.includes(code));

  return {
    score,
    band: bandFor(score),
    reasons,
    next_action: action ? ACTIONS[action] : null,
  };
}

const quietRank = (row) => (row.reasons && row.reasons.some((r) => r.code === 'never_started')
  ? Infinity
  : (row.days_quiet ?? -1));

function rankClients(rows) {
  return [...rows].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const qa = quietRank(a);
    const qb = quietRank(b);
    if (qa !== qb) return qb - qa;
    return a.client_name < b.client_name ? -1 : a.client_name > b.client_name ? 1 : 0;
  });
}

module.exports = { scoreClient, rankClients, bandFor, WEIGHTS };

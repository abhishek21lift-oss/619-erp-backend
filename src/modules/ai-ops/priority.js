'use strict';

// The queue's ordering is deterministic on purpose: the same studio data must
// produce the same list tomorrow, and the AI must never be able to promote a
// client by writing persuasive prose. Points are a fixed catalog, and churn
// points are the churn screen's own weights so the two surfaces cannot drift.

const crypto = require('crypto');
const { WEIGHTS } = require('../pt-os/churn-risk');

const FAMILY = Object.freeze({
  never_started: 'churn',
  silent_21: 'churn',
  silent_10: 'churn',
  term_ending_7: 'churn',
  term_ending_30: 'churn',
  term_ended: 'churn',
  dues: 'churn',
  no_show_recent: 'training',
  form_check_pending: 'training',
  checkin_missing_7: 'engagement',
  checkin_missing_14: 'engagement',
  parq_missing: 'screening',
  consent_missing: 'screening',
  clearance_expired: 'screening',
  lead_due: 'leads',
  lead_stale: 'leads',
});

// Churn first, then the eight additions. Spreading WEIGHTS makes parity
// structural: a change to the churn scale moves this scale with it.
const POINTS = Object.freeze({
  ...WEIGHTS,
  no_show_recent: 20,
  form_check_pending: 20,
  checkin_missing_7: 15,
  checkin_missing_14: 25,
  parq_missing: 25,
  consent_missing: 15,
  clearance_expired: 35,
  lead_due: 30,
  lead_stale: 20,
});

// Reasons a WhatsApp message can plausibly resolve. Screening and form-check
// reasons need the trainer in the app, not a message to the client.
const MESSAGE_CODES = Object.freeze([
  'never_started', 'silent_21', 'silent_10', 'term_ending_7',
  'term_ending_30', 'term_ended', 'dues', 'no_show_recent',
  'checkin_missing_7', 'checkin_missing_14', 'lead_due', 'lead_stale',
]);

const BANDS = Object.freeze([
  [60, 'critical'],
  [35, 'high'],
  [15, 'medium'],
  [1, 'low'],
]);

// Tie-break order for chooseAction: points first, then this list, which is
// also the order reasons are documented in. It is not alphabetical by
// accident — it puts money and renewal ahead of nudges.
const ACTION_ORDER = Object.freeze([
  'never_started', 'silent_21', 'term_ending_7', 'term_ending_30',
  'term_ended', 'dues', 'clearance_expired', 'parq_missing',
  'consent_missing', 'no_show_recent', 'form_check_pending',
  'checkin_missing_14', 'checkin_missing_7', 'lead_due', 'lead_stale',
]);

const ACTION_BY_CODE = Object.freeze({
  form_check_pending: { kind: 'internal', label: 'Review form check', href: '/pt-os/form-checks' },
  parq_missing: { kind: 'internal', label: 'Open screening' },
  consent_missing: { kind: 'internal', label: 'Open screening' },
  clearance_expired: { kind: 'internal', label: 'Open screening' },
  lead_due: { kind: 'message', label: 'Send follow-up', href: null },
  lead_stale: { kind: 'message', label: 'Send follow-up', href: null },
  term_ending_7: { kind: 'message', label: 'Send renewal reminder', href: null },
  term_ending_30: { kind: 'message', label: 'Send renewal reminder', href: null },
  dues: { kind: 'message', label: 'Send payment reminder', href: null },
  never_started: { kind: 'message', label: 'Book first session', href: null },
  silent_21: { kind: 'message', label: 'Send win-back', href: null },
  term_ended: { kind: 'message', label: 'Send win-back', href: null },
  silent_10: { kind: 'message', label: 'Send check-in', href: null },
  no_show_recent: { kind: 'message', label: 'Send check-in', href: null },
  checkin_missing_7: { kind: 'message', label: 'Send check-in nudge', href: null },
  checkin_missing_14: { kind: 'message', label: 'Send check-in nudge', href: null },
});

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function bandFor(score) {
  for (const [floor, band] of BANDS) {
    if (score >= floor) return band;
  }
  return 'low';
}

function dedupeReasons(reasons) {
  const seen = new Set();
  const out = [];
  for (const reason of reasons || []) {
    if (!reason || typeof reason.code !== 'string') continue;
    if (seen.has(reason.code)) continue;
    seen.add(reason.code);
    out.push(reason);
  }
  return out;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && YMD.test(value)) return `${value}T00:00:00.000Z`;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function scoreReasons(reasons) {
  const distinct = dedupeReasons(reasons);
  let score = 0;
  for (const reason of distinct) {
    score += POINTS[reason.code] || 0;
  }
  score = Math.min(100, score);

  let nextDue = null;
  for (const reason of distinct) {
    const due = toIso(reason.due_at);
    if (due && (nextDue === null || Date.parse(due) < Date.parse(nextDue))) nextDue = due;
  }

  return { score, band: bandFor(score), next_due_at: nextDue };
}

function maxDaysQuiet(item) {
  let max = null;
  for (const reason of item.reasons || []) {
    const value = reason && reason.days_quiet;
    if (typeof value === 'number' && Number.isFinite(value) && (max === null || value > max)) {
      max = value;
    }
  }
  return max;
}

// Nulls sort last on every key, because "no due date" is not "due yesterday".
function compareItems(a, b) {
  if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;

  const aDue = toIso(a.next_due_at);
  const bDue = toIso(b.next_due_at);
  if (aDue && bDue) {
    const diff = Date.parse(aDue) - Date.parse(bDue);
    if (diff !== 0) return diff;
  } else if (aDue) {
    return -1;
  } else if (bDue) {
    return 1;
  }

  const aQuiet = maxDaysQuiet(a);
  const bQuiet = maxDaysQuiet(b);
  if (aQuiet !== bQuiet) {
    if (aQuiet === null) return 1;
    if (bQuiet === null) return -1;
    return bQuiet - aQuiet;
  }

  const aName = a.subject?.name || '';
  const bName = b.subject?.name || '';
  return aName.localeCompare(bName);
}

// A stable stringify: object keys sorted at every depth, arrays left in the
// order the collector emitted them. Evidence is built by our own collectors,
// so arrays there are already deterministic.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function evidenceHash(evidence) {
  return crypto.createHash('sha256').update(stableStringify(evidence ?? {})).digest('hex');
}

function reasonIdentity(reason) {
  return `${reason.code}:${evidenceHash(reason.evidence)}`;
}

function closedReasons(reasons) {
  const out = [];
  const seen = new Set();
  for (const reason of reasons || []) {
    if (!reason || typeof reason.code !== 'string') continue;
    const evidence_hash = evidenceHash(reason.evidence);
    const key = `${reason.code}:${evidence_hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: reason.code, evidence_hash });
  }
  return out;
}

function shouldReopen(reasons, item) {
  const distinct = dedupeReasons(reasons);
  if (!distinct.length) return false;

  const { score } = scoreReasons(distinct);
  if (score >= (item.closed_score || 0) + 15) return true;

  const closed = new Map();
  for (const entry of item.closed_reasons || []) {
    if (!entry || typeof entry.code !== 'string') continue;
    if (!closed.has(entry.code)) closed.set(entry.code, new Set());
    closed.get(entry.code).add(entry.evidence_hash);
  }

  for (const reason of distinct) {
    const hashes = closed.get(reason.code);
    if (!hashes) return true;
    if (!hashes.has(evidenceHash(reason.evidence))) return true;
  }
  return false;
}

function chooseAction(reasons, subject) {
  const distinct = dedupeReasons(reasons);
  const ranked = [...distinct].sort((a, b) => {
    const points = (POINTS[b.code] || 0) - (POINTS[a.code] || 0);
    if (points !== 0) return points;
    return ACTION_ORDER.indexOf(a.code) - ACTION_ORDER.indexOf(b.code);
  });

  for (const reason of ranked) {
    const action = ACTION_BY_CODE[reason.code];
    if (!action) continue;
    const href = action.kind === 'internal'
      ? (action.href || (subject?.type === 'lead' ? '/pt-os/leads' : `/pt-os/clients/${subject?.id}`))
      : null;
    return { kind: action.kind, label: action.label, href, reason_code: reason.code };
  }

  return {
    kind: 'internal',
    label: subject?.type === 'lead' ? 'Review lead' : 'Review client',
    href: subject?.type === 'lead' ? '/pt-os/leads' : `/pt-os/clients/${subject?.id}`,
    reason_code: distinct[0]?.code ?? null,
  };
}

function firstName(name) {
  const raw = typeof name === 'string' ? name : '';
  const first = raw.trim().split(/\s+/)[0] || '';
  const cleaned = first.replace(/[<>\u0000-\u001F\u007F]/g, '').trim();
  if (!cleaned) return 'there';
  return cleaned.slice(0, 40);
}

module.exports = {
  FAMILY,
  POINTS,
  MESSAGE_CODES,
  BANDS,
  bandFor,
  dedupeReasons,
  scoreReasons,
  compareItems,
  evidenceHash,
  reasonIdentity,
  closedReasons,
  shouldReopen,
  chooseAction,
  firstName,
};

'use strict';

// Merge every collector into one group per subject. This module owns three
// rules the collectors must not each reinvent:
//   1. points and family come from priority.js, never from a collector;
//   2. a duplicate code is kept once (the first collector wins);
//   3. one failing collector is logged and skipped, not fatal.
//
// Collector order is deliberate: churn first (the strongest, already-reviewed
// signal), then activity, check-ins, screening, form checks, leads.

const logger = require('../../../lib/logger');
const {
  POINTS, FAMILY, dedupeReasons, scoreReasons, compareItems,
} = require('../priority');

const churn = require('./churn');
const activity = require('./activity');
const checkins = require('./checkins');
const screening = require('./screening');
const formChecks = require('./formChecks');
const leads = require('./leads');

const COLLECTORS = Object.freeze([
  { name: 'churn', collect: churn.collect },
  { name: 'activity', collect: activity.collect },
  { name: 'checkins', collect: checkins.collect },
  { name: 'screening', collect: screening.collect },
  { name: 'formChecks', collect: formChecks.collect },
  { name: 'leads', collect: leads.collect },
]);

function subjectKey(subject) {
  return `${subject.type}:${subject.id}`;
}

function plainSubject(subject) {
  return {
    type: subject.type,
    id: subject.id,
    name: subject.name ?? null,
    photo_url: subject.photo_url ?? null,
  };
}

function byScore(a, b) {
  return compareItems(
    { priority_score: a.score, next_due_at: a.next_due_at, subject: a.subject, reasons: a.reasons },
    { priority_score: b.score, next_due_at: b.next_due_at, subject: b.subject, reasons: b.reasons },
  );
}

async function collectAll({ orgId, today }) {
  const settled = await Promise.allSettled(
    COLLECTORS.map((collector) => collector.collect({ orgId, today })),
  );

  const groups = new Map();

  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn(
        { collector: COLLECTORS[index].name, err: result.reason?.message ?? String(result.reason) },
        'ai_ops_signal_failed',
      );
      return;
    }

    for (const emission of result.value || []) {
      const subject = emission?.subject;
      const reason = emission?.reason;
      if (!subject || (subject.type !== 'client' && subject.type !== 'lead')) continue;
      if (!subject.id || !reason || !Object.prototype.hasOwnProperty.call(POINTS, reason.code)) continue;

      const key = subjectKey(subject);
      if (!groups.has(key)) {
        groups.set(key, { subject: plainSubject(subject), reasons: [] });
      }
      groups.get(key).reasons.push({
        ...reason,
        points: POINTS[reason.code],
        family: FAMILY[reason.code],
      });
    }
  });

  const out = [];
  for (const group of groups.values()) {
    const reasons = dedupeReasons(group.reasons).sort((a, b) => b.points - a.points);
    const scored = scoreReasons(reasons);
    out.push({
      subject: group.subject,
      reasons,
      score: scored.score,
      band: scored.band,
      next_due_at: scored.next_due_at,
    });
  }

  return out.sort(byScore);
}

module.exports = { collectAll, COLLECTORS };

'use strict';
// The things a trainer should be told without having to go and look.
//
// ── What was actually missing ──────────────────────────────────────────────
//
// Stages 1-5 answer questions when asked. Someone opens a client and the
// engine says what it knows. That is the wrong shape for the problem a studio
// actually has, which was measured before this was written:
//
//   1 client trained in the last 7 days.
//   16 last trained 15-30 days ago.
//   4 have not trained in over a month.
//
// Nothing raised a flag about any of them, and the reason is specific rather
// than an oversight. client-snapshot.js has a `missed_workout` alert, and it
// fires only on a session that was SCHEDULED and not completed — deliberately,
// because "a client with nothing booked has not missed anything". That is
// right for a missed appointment and exactly wrong for the failure mode this
// studio has: clients who stop booking at all. Silence raises nothing, and
// silence is the signal.
//
// The second half is reach. Those alerts are computed when a profile is
// opened, so a trainer with 34 clients would have to open 34 profiles to find
// the seven that matter. Nothing has ever swept the roster.
//
// ── The split that turns a list into a to-do list ──────────────────────────
//
// "16 clients have gone quiet" is noise. Measured against the term:
//
//   7 quiet AND still inside a paid term    → they are paying and not coming
//   8 quiet AND term already finished       → not ghosting; they finished
//   1 paid and never trained at all         → worst case
//
// Only the first and third are something to do today. The middle group is a
// different conversation and putting it in the same list is how a trainer
// learns to ignore the list.
//
// ── Reuse, not reinvention ─────────────────────────────────────────────────
//
// Plateau, regression, deload and volume come from buildTrainingHistory,
// deloadTriggers and volumeLandmarks — stages 1 and 2. Nothing here
// re-derives them. This file decides what is worth SAYING, and says what it
// could not check.

const { MIN_SESSIONS_FOR_TREND } = require('./training-history');

/**
 * Days of silence before it is worth a word.
 *
 * Ten, because a client training even twice a week has missed at least three
 * sessions by then, and one missed week is a holiday rather than a pattern.
 */
const QUIET_DAYS = 10;

/** …and beyond this it is not drift, it is a client who has stopped. */
const GONE_DAYS = 21;

/** A paid client who has never logged a session, after this long, is a failure to start. */
const NEVER_STARTED_DAYS = 14;

/** Severities, worst first. Ordering is a claim about what to look at. */
const SEVERITY = Object.freeze({ CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' });
const RANK = Object.freeze({ critical: 0, warning: 1, info: 2 });

const day = (v) => {
  if (!v) return null;
  const s = typeof v === 'string' ? v : v.toISOString?.();
  return s ? String(s).slice(0, 10) : null;
};

function daysBetween(from, to) {
  const a = new Date(`${day(from)}T00:00:00Z`).getTime();
  const b = new Date(`${day(to)}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Is this client inside a paid term, finished, or unknown?
 *
 * The difference decides whether silence is a problem to chase or a client who
 * simply reached the end. `pt_end_date` is the studio's own record of what was
 * bought; nothing infers it.
 */
function termState(client, today) {
  const end = day(client?.pt_end_date);
  if (!end) return { state: 'unknown', end: null, days_left: null };
  const left = daysBetween(today, end);
  return { state: left >= 0 ? 'current' : 'ended', end, days_left: left };
}

/**
 * Every signal this client's data supports, worst first.
 *
 * @param {object}  input
 * @param {object}  input.client       pt_clients row (needs id, name, pt_end_date)
 * @param {string}  input.today        studio's today, YYYY-MM-DD
 * @param {string=} input.lastSession  last COMPLETED session date, or null
 * @param {object=} input.history      buildTrainingHistory() output
 * @param {object=} input.volume       volumeLandmarks() output
 * @param {object=} input.deload       deloadTriggers() output
 */
function detectSignals({
  client, today, lastSession = null, history = null, volume = null, deload = null,
} = {}) {
  const signals = [];
  const unobservable = [];
  const term = termState(client, today);
  const quietFor = lastSession ? daysBetween(lastSession, today) : null;

  const push = (s) => signals.push(s);

  // ── Silence ─────────────────────────────────────────────────────────────
  if (lastSession === null) {
    // Never trained. Only worth saying for someone who has bought something —
    // a prospect who has not started is not a training problem.
    const sinceStart = client?.pt_start_date ? daysBetween(client.pt_start_date, today) : null;
    if (term.state === 'current' && (sinceStart === null || sinceStart >= NEVER_STARTED_DAYS)) {
      push({
        id: 'never_started',
        severity: SEVERITY.CRITICAL,
        headline: 'Paid but has never trained',
        evidence: `no completed session on record${sinceStart !== null ? `, ${sinceStart} days since the term began` : ''}`,
        recommendation: 'Call them. A client who never starts does not renew, and the term is already running.',
      });
    }
  } else if (quietFor !== null && quietFor >= QUIET_DAYS) {
    // The signal client-snapshot.js cannot raise: nothing was scheduled, so
    // nothing was missed, so nothing fired.
    const gone = quietFor >= GONE_DAYS;
    if (term.state === 'current') {
      push({
        id: 'gone_quiet',
        severity: gone ? SEVERITY.CRITICAL : SEVERITY.WARNING,
        headline: gone ? 'Paying, and stopped coming' : 'Paying, and gone quiet',
        evidence: `last trained ${lastSession}, ${quietFor} days ago; term runs to ${term.end}`,
        recommendation: gone
          ? 'Contact them this week. They are paying for training they are not taking, which is the shape of a non-renewal.'
          : 'Check in before it becomes a habit.',
        days_quiet: quietFor,
      });
    } else if (term.state === 'ended') {
      // Not ghosting — finished. A different conversation, and it must not sit
      // in the same list as the paying ones.
      push({
        id: 'term_ended_inactive',
        severity: SEVERITY.INFO,
        headline: 'Term finished, not training',
        evidence: `last trained ${lastSession}, ${quietFor} days ago; term ended ${term.end}`,
        recommendation: 'Win-back, not a chase. They completed what they bought.',
        days_quiet: quietFor,
      });
    } else {
      push({
        id: 'gone_quiet',
        severity: SEVERITY.WARNING,
        headline: 'Gone quiet',
        evidence: `last trained ${lastSession}, ${quietFor} days ago; no term dates on file`,
        recommendation: 'Check whether they are still a client at all — nothing records what they bought.',
        days_quiet: quietFor,
      });
    }
  }

  // ── Training signals, from stages 1 and 2 ───────────────────────────────
  //
  // Each one reports when it could not be evaluated rather than staying
  // silent, because "no plateau detected" from a client with two sessions is
  // not a finding, it is an absence of one.
  if (!history || !history.has_history) {
    unobservable.push({ signal: 'plateau', reason: 'no sets logged' });
    unobservable.push({ signal: 'regression', reason: 'no sets logged' });
  } else if (!history.confidence.enough_for_progression_calls) {
    unobservable.push({
      signal: 'plateau',
      reason: `no lift has ${MIN_SESSIONS_FOR_TREND} logged sessions yet`,
    });
    unobservable.push({
      signal: 'regression',
      reason: `no lift has ${MIN_SESSIONS_FOR_TREND} logged sessions yet`,
    });
  } else {
    if (history.regressing.length) {
      push({
        id: 'regression',
        severity: SEVERITY.WARNING,
        headline: `Going backwards on ${history.regressing.length} lift${history.regressing.length > 1 ? 's' : ''}`,
        evidence: history.regressing.join(', '),
        recommendation: 'Check load, technique and recovery before adding anything.',
      });
    }
    if (history.plateaued.length) {
      push({
        id: 'plateau',
        severity: SEVERITY.INFO,
        headline: `Stalled on ${history.plateaued.length} lift${history.plateaued.length > 1 ? 's' : ''}`,
        evidence: history.plateaued.join(', '),
        recommendation: 'Change a variable — rep range, tempo, or the movement itself.',
      });
    }
  }

  if (deload) {
    if (deload.deload_indicated) {
      push({
        id: 'deload_due',
        severity: SEVERITY.WARNING,
        headline: 'Deload indicated',
        evidence: deload.triggers.map((t) => t.evidence).join('; '),
        recommendation: 'Drop volume for a week before the next block.',
      });
    } else if (deload.evaluated === 0) {
      unobservable.push({
        signal: 'deload',
        reason: `none of ${deload.of} triggers could be evaluated`,
      });
    }
  } else {
    unobservable.push({ signal: 'deload', reason: 'no training history supplied' });
  }

  // Volume is only worth raising for a client who is actually training. An
  // under-trained muscle group on somebody who has not been in for a month is
  // a symptom of the silence, not a separate finding.
  if (volume && volume.weeks_observed && (quietFor === null || quietFor < QUIET_DAYS)) {
    // The ranges are the studio's own, edited in analytics, so a finding here
    // is measured against what this gym decided rather than a constant.
    if (volume.below.length) {
      push({
        id: 'undertrained',
        severity: SEVERITY.INFO,
        headline: `Below the working range on ${volume.below.join(', ')}`,
        evidence: volume.muscles
          .filter((m) => volume.below.includes(m.muscle))
          .map((m) => `${m.muscle} ${m.latest_sets} sets vs ${m.mev_sets} minimum`)
          .join('; '),
        recommendation: 'Add a set or two per session, or a second exposure in the week.',
      });
    }
    if (volume.above.length) {
      push({
        id: 'overreaching',
        severity: SEVERITY.WARNING,
        headline: `Above the recoverable range on ${volume.above.join(', ')}`,
        evidence: volume.muscles
          .filter((m) => volume.above.includes(m.muscle))
          .map((m) => `${m.muscle} ${m.latest_sets} sets vs ${m.mrv_sets} ceiling`)
          .join('; '),
        recommendation: 'Cut volume on that muscle before it costs a session.',
      });
    }
  } else if (volume && !volume.weeks_observed) {
    unobservable.push({ signal: 'volume', reason: 'no attributable weekly volume' });
  }

  signals.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  return {
    client_id: client?.id ?? null,
    client_name: client?.name ?? null,
    term,
    last_session: day(lastSession),
    days_quiet: quietFor,
    signals,
    // What could not be checked. Named per client so "nothing to report"
    // and "nothing could be computed" are never the same answer.
    unobservable,
    worst: signals.length ? signals[0].severity : null,
  };
}

/**
 * How long this client has been silent, for ordering.
 *
 * A client with no session at all has been silent for their whole term, which
 * is longer than anyone who has trained once — Infinity rather than zero, so
 * "paid and never came" cannot sort below "trained last month".
 */
function quietRank(row) {
  if (row.last_session === null) return Infinity;
  return row.days_quiet ?? 0;
}

/**
 * The roster, as one list a trainer can act on.
 *
 * `rows` are detectSignals() outputs. Clients with nothing to say are counted
 * but not listed: a sweep that returns all 34 every time is a sweep nobody
 * reads twice.
 */
function summariseRoster(rows = []) {
  const withSignals = rows.filter((r) => r.signals.length);

  const byId = new Map();
  for (const r of withSignals) {
    for (const s of r.signals) {
      if (!byId.has(s.id)) byId.set(s.id, { id: s.id, severity: s.severity, clients: 0 });
      byId.get(s.id).clients += 1;
    }
  }

  // Only where NOTHING at all could be computed. A client with one observable
  // signal is not "unobservable", and counting them as such would overstate
  // how blind the engine is.
  const blind = rows.filter((r) => !r.signals.length && r.unobservable.length);

  return {
    clients: rows.length,
    clients_with_signals: withSignals.length,
    critical: withSignals.filter((r) => r.worst === SEVERITY.CRITICAL).length,
    warning: withSignals.filter((r) => r.worst === SEVERITY.WARNING).length,
    info: withSignals.filter((r) => r.worst === SEVERITY.INFO).length,
    // Worst severity, then most clients, then the id. The last term is not
    // cosmetic: without it two signals of equal severity and equal count come
    // back in whatever order the roster happened to be in, so the same data
    // renders differently between two calls.
    by_signal: [...byId.values()].sort(
      (a, b) => RANK[a.severity] - RANK[b.severity]
        || b.clients - a.clients
        || a.id.localeCompare(b.id),
    ),
    // Stated rather than implied. On this studio's data most clients cannot be
    // assessed for plateau at all, and a sweep that quietly returned "all
    // clear" for them would be claiming a check nobody ran.
    not_assessable: blind.length,
    // Worst severity first, then the longest silence. A client who has NEVER
    // trained has no days_quiet, and treating that as zero sorted the worst
    // case — paid, never came — below every client who at least turned up
    // once. Their silence is the longest there is, so they sort as such.
    clients_detail: withSignals.sort(
      (a, b) => RANK[a.worst] - RANK[b.worst]
        || quietRank(b) - quietRank(a),
    ),
  };
}

module.exports = {
  detectSignals,
  summariseRoster,
  termState,
  daysBetween,
  SEVERITY,
  QUIET_DAYS,
  GONE_DAYS,
  NEVER_STARTED_DAYS,
};

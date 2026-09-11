'use strict';
// The metric dictionary. One definition per business metric, and only here.
//
// ── Why this file exists ───────────────────────────────────────────────────
//
// An audit of the reporting surface found the same named metric computed with
// different SQL in different files, and the numbers disagreed:
//
//   "active client"   seven definitions. pt-os.service.js:259 requires
//                     pt_start_date IS NOT NULL; reports.js:67 does not;
//                     trainers.js:41 filters neither deleted_at nor
//                     pt_start_date and so counts soft-deleted clients.
//   "present"         attendance.js:185 counts status='present';
//                     qr-checkin.js:502 counts present OR late.
//   "revenue"         nine collected-money queries plus two that sum the
//                     CONTRACTED pt_clients.monthly_pt_amount and label it
//                     revenue in the same response object.
//   "renewal rate"    computed nowhere on the server. The UI divided
//                     active by (active + expired).
//
// Nothing here is new arithmetic. Each definition below is one of the
// existing ones, chosen deliberately, with the reason it beat the others
// written down. Callers take a fragment from here instead of writing their
// own, so a definition can be argued with in one place rather than drifting
// in nine.
//
// ── The form ───────────────────────────────────────────────────────────────
//
// Fragments are SQL text with no bind parameters of their own. Tenant scoping
// is deliberately NOT baked in: it depends on the caller's request and on
// which table alias carries organization_id, and a fragment that silently
// carried its own org filter would be impossible to audit at the call site.
// Callers apply orgWhere()/orgParam() as they already do.

// ── Client state ───────────────────────────────────────────────────────────
//
// pt_clients.status is a hand-maintained string with no CHECK constraint
// (migration 017 declares it `TEXT NOT NULL DEFAULT 'active'`), and it is
// measurably unreliable: at the time of writing, 12 of production's 34 live
// clients carry a status that disagrees with their own pt_end_date.
// automation.repository.js:747 reached the same conclusion independently and
// switched that module to dates.
//
// A membership being live is a fact about a date, so the date decides.
// `status` is left in the schema — it is what the UI edits and what a trainer
// reads — but no metric is derived from it.
//
// pt_start_date IS NOT NULL is what separates an enrolled client from a lead
// or an abandoned intake. Without it the count includes rows that have never
// been a paying membership, which is the difference between reports.js:67 and
// pt-os.service.js:259.
const CLIENT_LIVE = `c.deleted_at IS NULL`;

const CLIENT_ENROLLED = `${CLIENT_LIVE} AND c.pt_start_date IS NOT NULL`;

/** Enrolled and inside their term today. The canonical "active client". */
const CLIENT_ACTIVE = `${CLIENT_ENROLLED}
      AND (c.pt_end_date IS NULL OR c.pt_end_date >= CURRENT_DATE)`;

/** Enrolled and their term has run out. Not the same as status='expired'. */
const CLIENT_LAPSED = `${CLIENT_ENROLLED}
      AND c.pt_end_date IS NOT NULL AND c.pt_end_date < CURRENT_DATE`;

// ── Money ──────────────────────────────────────────────────────────────────
//
// Collected money is pt_payments. It is the ledger: every payment path writes
// a row, and pt-os.routes.js:697 records what happened the last time one did
// not ("renewal income was invisible to every financial report").
//
// pt_clients.monthly_pt_amount is CONTRACTED money — what a client agreed to
// pay, not what arrived. pt-os.service.js:301 sums it and calls the result
// `monthly_revenue`, in the same response object as a collected figure. Both
// numbers are legitimate; calling both "revenue" is not. Anything derived
// from the contract is named `contracted_*` here.
//
// pt_clients.paid_amount is a running total on the client row, not a ledger,
// and super-admin/studios.js windows it on pt_clients.created_at — i.e. by
// when the CLIENT was created, not when the money arrived. It is not used.
const PAYMENT_LIVE = `p.deleted_at IS NULL`;

/** Money actually received, in a window on the payment's own date. */
const REVENUE_COLLECTED = `SUM(p.amount) FILTER (WHERE ${PAYMENT_LIVE})`;

/** Trainer incentive as the LEDGER recorded it at the time of payment.
 *
 *  Not `amount × current incentive_rate`, which is what trainers.js:60
 *  computes. The rate is snapshotted onto the row when the payment is taken
 *  (pt-os.routes.js:711), so recomputing from today's rate silently rewrites
 *  history every time a trainer's rate changes. The same file already has the
 *  ledger form at trainers.js:107 — two answers to one question, one file
 *  apart. */
const INCENTIVE_LEDGER = `SUM(p.incentive_amt) FILTER (WHERE ${PAYMENT_LIVE})`;

/** Outstanding money owed. `> 0` on purpose: a credit balance is not a debt,
 *  and netting one off against another client's arrears understates what the
 *  studio is owed. reports.js:195 filters; pt-os.service.js:270 does not. */
const BALANCE_OUTSTANDING = `SUM(c.balance_amount) FILTER (WHERE c.balance_amount > 0)`;

// ── Attendance ─────────────────────────────────────────────────────────────
//
// A late arrival is an attendance. The person came. Counting `late` as absent
// — which attendance.js:185 effectively does by filtering status='present'
// alone — understates footfall and makes the same studio look worse on the
// attendance page than on the check-in dashboard, which counts both
// (qr-checkin.js:502).
//
// ref_type='client' is part of the definition, not an incidental filter:
// attendance_logs also holds staff rows, and qr-checkin.js:425 groups without
// restricting, so its "today" figure mixes clients and staff into one number.
const ATTENDED = `a.status IN ('present', 'late')`;
const ATTENDANCE_CLIENT_ROWS = `a.ref_type = 'client'`;

// ── Renewal ────────────────────────────────────────────────────────────────
//
// A renewal rate is a CONVERSION: of the terms that came up for renewal in a
// window, how many were renewed. It is a flow, measured over a period.
//
// What the product showed instead was a STOCK ratio —
// active / (active + expired) — over the current value of a status column,
// with no window at all. Those are different questions, and on production
// they give very different answers:
//
//   Sachin PT Studio    10 terms came up, 0 renewed   → 0%      (UI said 50%)
//   Abhishek PT Studio   6 terms came up, 1 renewed   → 16.7%   (UI said 50%)
//
// The stock ratio cannot fall below 50% while a studio keeps enrolling, since
// every new client lands in the numerator. It measures growth, not loyalty.
//
// ── The cohort, and why it is built from two sources ───────────────────────
//
// "Terms that came up for renewal in the window" is not one column. When a
// client renews, pt_clients.pt_end_date moves forward to the NEW end date —
// the old one survives only in pt_client_renewals.old_end_date. So:
//
//   renewed terms   pt_client_renewals.old_end_date IN window
//   lapsed  terms   pt_clients.pt_end_date          IN window (still the
//                   current term, so nothing renewed it)
//
// Union of the two is every term that reached its end date in the window;
// the first set is the numerator. A client who renewed twice in the window
// contributes two terms, which is correct — two renewal decisions were made.
//
// ── What this cannot see ───────────────────────────────────────────────────
//
// pt_client_renewals carries no organization_id and, until the migration that
// ships with this file, no foreign key either — so 5 of its 6 production rows
// are orphans whose client was hard-deleted. Orphans are excluded here (the
// join drops them) and CANNOT be attributed to a studio at all. The migration
// stops new ones being created; it cannot recover the five.
const RENEWAL_WINDOW_NOTE =
  'Windowed on the end date of the term being renewed, not on when the '
  + 'renewal was recorded: a renewal keyed in late still belongs to the month '
  + 'the term ran out.';

// ── Sessions ───────────────────────────────────────────────────────────────
//
// pt_sessions is the DIARY — a booked appointment. Nothing in the product
// ever moves one of its rows to 'completed'; pt-os.service.js:614 documents
// the card that read 0/0 for exactly this reason. Finishing a workout writes
// workout_sessions.
//
// So "sessions delivered" is workout_sessions, and "sessions booked" is
// pt_sessions. They are different questions and neither substitutes for the
// other. Six surfaces currently count pt_sessions and call it delivery.
const SESSION_DELIVERED = `ws.status = 'completed'`;
const SESSION_BOOKED_LIVE = `s.deleted_at IS NULL`;

/**
 * Every metric this module publishes, with the sentence a reader needs to
 * know what they are looking at.
 *
 * Served verbatim by GET /api/insights/definitions so the UI can label a
 * figure with its own definition instead of restating it in a tooltip that
 * drifts. A metric that cannot be explained in one line is usually two
 * metrics.
 */
const CATALOGUE = {
  active_clients: {
    unit: 'clients',
    definition: 'Enrolled clients whose term covers today. Derived from '
      + 'pt_start_date and pt_end_date, not from the status column, which '
      + 'disagrees with the dates for roughly a third of live clients.',
  },
  lapsed_clients: {
    unit: 'clients',
    definition: 'Enrolled clients whose term end date has passed and who have '
      + 'not renewed.',
  },
  renewal_rate_pct: {
    unit: 'percent',
    definition: 'Of the terms that reached their end date in the window, the '
      + 'share that were renewed. A conversion rate, not the active-to-expired '
      + 'ratio it replaced. ' + RENEWAL_WINDOW_NOTE,
    nullWhen: 'No term reached its end date in the window, so there was '
      + 'nothing to convert. Null, never zero — zero would read as total churn.',
  },
  terms_due: {
    unit: 'terms',
    definition: 'Terms whose end date fell inside the window. The denominator '
      + 'of renewal_rate_pct.',
  },
  terms_renewed: {
    unit: 'terms',
    definition: 'Terms from that cohort with a recorded renewal. The numerator '
      + 'of renewal_rate_pct.',
  },
  revenue_collected: {
    unit: 'INR',
    definition: 'Money received, from the pt_payments ledger, windowed on the '
      + 'payment date. Excludes contracted-but-unpaid amounts.',
  },
  revenue_contracted_monthly: {
    unit: 'INR',
    definition: 'What active clients have agreed to pay per month. A forward '
      + 'commitment, not income — deliberately named apart from collected '
      + 'revenue, which several dashboards previously conflated with it.',
  },
  outstanding: {
    unit: 'INR',
    definition: 'Sum of positive client balances. Credit balances are not '
      + 'netted off, so this is what the studio is owed rather than a net '
      + 'position.',
  },
  attendance_rate_pct: {
    unit: 'percent',
    definition: 'Client check-ins marked present or late, as a share of all '
      + 'client attendance rows in the window. A late arrival is an '
      + 'attendance.',
    nullWhen: 'No attendance was recorded in the window.',
  },
  sessions_delivered: {
    unit: 'sessions',
    definition: 'Workout sessions actually completed (workout_sessions). Not '
      + 'the appointment diary, whose rows are never moved to completed.',
  },
  sessions_booked: {
    unit: 'sessions',
    definition: 'Appointments in the diary (pt_sessions) for the window.',
  },
};

module.exports = {
  CLIENT_LIVE,
  CLIENT_ENROLLED,
  CLIENT_ACTIVE,
  CLIENT_LAPSED,
  PAYMENT_LIVE,
  REVENUE_COLLECTED,
  INCENTIVE_LEDGER,
  BALANCE_OUTSTANDING,
  ATTENDED,
  ATTENDANCE_CLIENT_ROWS,
  SESSION_DELIVERED,
  SESSION_BOOKED_LIVE,
  CATALOGUE,
};

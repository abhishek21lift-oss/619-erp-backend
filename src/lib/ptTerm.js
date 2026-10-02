'use strict';
// Does this client have a PT term? One answer, used by every screen and route
// that has to choose between "Enroll in PT" and "Renew PT".
//
// ── Why pt_end_date, and not pt_start_date ──────────────────────────────────
//
// Every path that actually creates a term writes an END date:
//   * Enroll (PATCH /clients/:id from the enroll page) sends pt_end_date;
//   * Renew (renewal.service.js) computes and writes it;
//   * a member's UPI renewal or plan purchase (lib/upiPayments.js) writes it;
//   * POST /clients with a package/duration computes it.
//
// pt_start_date was never a reliable signal. POST /clients defaulted it to
// today for every new client — including a name-and-phone add with no package
// — so the client profile, which decided Enroll vs Renew on
// `!!client.pt_start_date`, offered "Renew" to people who had never been
// enrolled. Renewing them wrote a renewal row, after which the enroll screen
// refused them for "having renewed before".
//
// So a client has a term when ANY of these holds — the same "enrolled" test
// POST /clients (status CASE), PATCH /clients/:id (looksEnrolled) and
// migrations 110/118 already apply, plus the term history:
//   * pt_end_date holds a date (a DATE column since migration 033; read
//     defensively anyway, since older code paths treated it as text);
//   * a duration, or a charged price, is on the row;
//   * a pt_client_renewals row exists;
//   * a pt_client_subscriptions row exists (written for the first term by
//     Enroll, and for every renewal and UPI purchase).
// The history tables are there for legacy rows: a client who renewed and later
// had the end date cleared must still be renewable, or Renew would refuse them
// as "not enrolled" while Enroll refuses them as "use Renew".

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function hasEndDate(value) {
  if (value == null) return false;
  const raw = value instanceof Date ? value.toISOString() : String(value).trim();
  return DATE_RE.test(raw) && !Number.isNaN(new Date(raw.slice(0, 10)).getTime());
}

/**
 * JS form, for a row already in hand.
 * @param {object} row          a pt_clients row
 * @param {number} [termRecords] count of renewal + subscription rows, when known
 */
function hasPtTerm(row, termRecords = 0) {
  if (!row) return false;
  return hasEndDate(row.pt_end_date)
    || Number(row.duration_months) > 0
    || Number(row.final_amount) > 0
    || Number(termRecords) > 0;
}

/**
 * SQL form, for a pt_clients alias. Same rule. Matches on the text form, so it
 * holds whether the column is DATE or a legacy TEXT one.
 */
function hasPtTermSql(alias = 'c') {
  return `(COALESCE(${alias}.pt_end_date::TEXT, '') ~ '^\\d{4}-\\d{2}-\\d{2}'
    OR COALESCE(${alias}.duration_months, 0) > 0
    OR COALESCE(${alias}.final_amount, 0) > 0
    OR EXISTS (SELECT 1 FROM pt_client_renewals ptr WHERE ptr.client_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM pt_client_subscriptions pts WHERE pts.client_id = ${alias}.id))`;
}

/** How many term records a client has, for hasPtTerm's second argument. */
async function termRecordCount(db, clientId) {
  const { rows } = await db.query(
    `SELECT (SELECT COUNT(*) FROM pt_client_renewals WHERE client_id = $1)
          + (SELECT COUNT(*) FROM pt_client_subscriptions WHERE client_id = $1) AS n`,
    [clientId],
  );
  return Number(rows[0]?.n ?? 0);
}

module.exports = { hasPtTerm, hasPtTermSql, termRecordCount, hasEndDate };

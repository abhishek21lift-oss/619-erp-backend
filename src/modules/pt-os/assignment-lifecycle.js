'use strict';
// Assignment lifecycle — one live programme per client.
//
// The schema has always allowed several `active` rows for one client: the
// unique key is (workout_plan_id, client_id), so a second PLAN is a second
// row. Nothing retired the first one when a new block was assigned, and every
// read that asked "which programme is this client on" had to guess. Different
// reads guessed differently, which is how 26 of 55 programmed client-days
// resolved to the wrong assignment before the Today roster was fixed.
//
// This module owns the two halves of the fix:
//
//   retireOthers   the write that ends every other live assignment when a new
//                  one is given to the client. Reversible: the row keeps its
//                  history and `retired_at`; a later assign revives it through
//                  the (plan, client) upsert.
//   pickCurrent    the read rule, in one place, for callers that have the
//                  rows already. The Today roster's SQL encodes the same rule
//                  (prescribes this weekday first, then newest); this is the
//                  JS twin for member reads and tests.

const { dbDate } = require('../../lib/appTime');

const TODAY = () => new Date().toISOString().slice(0, 10);

// DATE columns come back from node-postgres as JS Dates, and String(date)
// is "Mon Aug 03" — which compares wrongly against a YYYY-MM-DD today.
const isLive = (a, today) => {
  if (!a || String(a.status) !== 'active') return false;
  const day = dbDate(today) || TODAY();
  const start = dbDate(a.start_date);
  const end = dbDate(a.end_date);
  return (!start || start <= day) && (!end || end >= day);
};

/**
 * End every active assignment for a client except one.
 *
 * @param {{ query: Function }} client  pool or transaction client
 * @returns {Promise<{ retired: number }>}
 */
async function retireOthers(client, {
  clientId, orgId, exceptId, reason = 'replaced',
} = {}) {
  if (!clientId || !orgId || !exceptId) return { retired: 0 };
  const { rowCount } = await client.query(
    `UPDATE workout_assignments
        SET status = 'completed',
            retired_at = NOW(),
            retire_reason = $4,
            updated_at = NOW()
      WHERE client_id = $1
        AND organization_id = $2
        AND id <> $3
        AND status = 'active'`,
    [clientId, orgId, exceptId, reason],
  );
  return { retired: rowCount || 0 };
}

/**
 * The one programme a client is on, from rows already fetched.
 *
 * `prescribesDow` is optional: when the caller knows which assignment
 * prescribes the requested weekday, that one wins. Otherwise the most recent
 * live assignment wins. Ties break on created_at, then id, so the answer is
 * deterministic even for legacy rows with identical dates.
 */
function pickCurrent(rows = [], { today = TODAY(), prescribesDow = null } = {}) {
  const live = rows.filter((r) => isLive(r, today));
  if (!live.length) return null;
  const prescribes = (r) => r.prescribes_dow === true
    || (prescribesDow != null && Number(r.prescribes_dow) === Number(prescribesDow));
  const score = (r) => (prescribes(r) ? 1 : 0);
  return live.sort((a, b) => (
    score(b) - score(a)
    || String(dbDate(b.start_date) || '').localeCompare(String(dbDate(a.start_date) || ''))
    || String(b.created_at || '').localeCompare(String(a.created_at || ''))
    || String(b.id || '').localeCompare(String(a.id || ''))
  ))[0];
}

/**
 * Retire one assignment by id. The row keeps its plan, dates, progress and
 * notes; `retired_at` records when it stopped and `retire_reason` why.
 *
 * @returns {Promise<object|null>} the updated row, or null when it is not in
 *   this studio / does not exist.
 */
async function retireAssignment(db, {
  id, orgId, status = 'completed', reason = null,
} = {}) {
  const { rows } = await db.query(
    `UPDATE workout_assignments
        SET status = $1,
            retired_at = COALESCE(retired_at, NOW()),
            retire_reason = $2,
            updated_at = NOW()
      WHERE id = $3 AND organization_id = $4
      RETURNING *`,
    [status, reason, id, orgId],
  );
  return rows[0] || null;
}

/**
 * Update the lifecycle fields a trainer actually changes. Re-activating makes
 * the programme current again, so the caller still owns retiring the others.
 *
 * @returns {Promise<object|null>} the updated row, or null when there is
 *   nothing to update or the row is not in this studio.
 */
async function patchAssignment(db, { id, orgId, fields = {} } = {}) {
  const sets = [];
  const values = [];
  for (const col of ['status', 'start_date', 'end_date', 'notes']) {
    if (fields[col] !== undefined) {
      values.push(fields[col]);
      sets.push(`${col} = $${values.length}`);
    }
  }
  if (!sets.length) return null;
  if (fields.status === 'active') {
    sets.push('retired_at = NULL', 'retire_reason = NULL');
  } else if (fields.status !== undefined) {
    sets.push('retired_at = COALESCE(retired_at, NOW())');
  }
  values.push(id, orgId);
  const { rows } = await db.query(
    `UPDATE workout_assignments SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND organization_id = $${values.length}
      RETURNING *`,
    values,
  );
  return rows[0] || null;
}

module.exports = { retireOthers, pickCurrent, isLive, retireAssignment, patchAssignment };

'use strict';
// The studio's trainer profile, resolved inside one organization.
//
// pt_clients.trainer_id, pt_payments.trainer_id and pt_leads.trainer_id point
// at `trainers` — the coach profile that belongs to the studio's trainer. Those
// ids arrive in request bodies, and a `trainers` row is found by primary key,
// so a lookup that is not also filtered by organization_id lets one studio
// attach — and then read back, through joins and incentive lookups — another
// studio's trainer profile. Every trainer id that comes from a request goes
// through resolveTrainerId() before it is stored; every lookup of a stored one
// goes through trainerForOrg().
//
// `db` is anything with a `query(sql, params)` method: the pool, or a client
// that is inside a transaction.

const { HttpError } = require('../middleware/errorHandler');

// An HttpError, so errorHandler answers 400 with the message rather than 500.
class InvalidTrainerError extends HttpError {
  constructor() {
    super(400, 'INVALID_TRAINER', 'trainer_id does not belong to this studio');
  }
}

/**
 * A live trainer profile in `orgId`, or null. Never matches another studio's
 * row, and never matches anything when orgId is missing.
 */
async function trainerForOrg(db, orgId, trainerId) {
  if (!trainerId || !orgId) return null;
  const { rows } = await db.query(
    `SELECT id, name, incentive_rate
       FROM trainers
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [trainerId, orgId]
  );
  return rows[0] || null;
}

/**
 * Validate a trainer id supplied by the caller.
 *
 *   null / undefined / ''  → null (no trainer on the record)
 *   an id in this studio   → that id
 *   anything else          → throws InvalidTrainerError (400)
 *
 * Refusing rather than silently dropping the value: a record saved with a
 * trainer the caller did not intend is worse than a clear validation error.
 */
async function resolveTrainerId(db, orgId, requested) {
  if (requested === undefined || requested === null || requested === '') return null;
  const found = await trainerForOrg(db, orgId, String(requested));
  if (!found) throw new InvalidTrainerError();
  return found.id;
}

module.exports = { trainerForOrg, resolveTrainerId, InvalidTrainerError };

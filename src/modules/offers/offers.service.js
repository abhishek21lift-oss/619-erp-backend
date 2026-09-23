'use strict';

/**
 * Offer reads and writes that need more than one statement.
 *
 * Extracted from `routes/offers.js` because updating an offer stopped being a
 * single statement. The route used to `UPDATE … SET col = COALESCE($n, col)`
 * per column, which cannot express the rule the offers table actually has:
 * `discount_type` and `discount_value` are only valid **as a pair**, so a
 * request that changes one without mentioning the other has to be checked
 * against the stored value of the other.
 *
 * That makes it a read-then-write, and a read-then-write in an HTTP adapter is
 * what the layering guard exists to prevent. So it lives here.
 *
 * Takes a `scope` (`tenantScope(req)`) rather than a `req`, matching
 * pt-os.service: a service that reaches into a request object cannot be called
 * from a worker, a job or a test without one being faked.
 */

const pool = require('../../db/pool');
const { validateOffer } = require('../../lib/offerRules');

/** The columns a client may set. Anything else in the body is ignored. */
const MUTABLE_COLUMNS = Object.freeze([
  'title',
  'description',
  'discount_type',
  'discount_value',
  'code',
  'audience',
  'max_uses',
  'valid_from',
  'valid_until',
  'status',
]);

/**
 * Append the tenant predicate, mirroring `orgWhere` but from a scope.
 *
 * Fail-closed in the same way: the predicate is always added, so a missing
 * scope or org id narrows to nothing rather than widening to everything.
 */
function orgPredicate(scope, params, col = 'organization_id') {
  params.push(scope ? scope.orgId : null);
  return ` AND ${col} = $${params.length}`;
}

/**
 * Apply a partial update to an offer, validating the merged record.
 *
 * @returns {Promise<{ status: 'ok', offer: object }
 *                 | { status: 'notFound' }
 *                 | { status: 'invalid', message: string, field?: string }>}
 *
 * Returns a tagged result rather than throwing, so the route maps outcomes to
 * status codes in one place and a validation failure is not an exception —
 * it is an ordinary answer to an ordinary request.
 */
async function updateOffer(scope, id, patch) {
  const readParams = [id];
  const readOrg = orgPredicate(scope, readParams);
  const current = await pool.query(
    `SELECT title, description, discount_type, discount_value, code, audience,
            max_uses, valid_from, valid_until, status
       FROM offers WHERE id = $1${readOrg}`,
    readParams
  );
  if (!current.rows.length) return { status: 'notFound' };

  // Only keys the request actually carries override the stored row, so a
  // partial update stays partial. `undefined` means "not mentioned"; an
  // explicit `null` means "clear it" and is passed through to be validated.
  const merged = { ...current.rows[0] };
  for (const key of MUTABLE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
      merged[key] = patch[key];
    }
  }

  const check = validateOffer(merged);
  if (!check.ok) return { status: 'invalid', message: check.message, field: check.field };
  const v = check.value;

  const params = [
    v.title, v.description, v.discount_type, v.discount_value, v.code,
    v.audience, v.max_uses, v.valid_from, v.valid_until, v.status, id,
  ];
  const org = orgPredicate(scope, params);
  const result = await pool.query(
    `UPDATE offers
        SET title          = $1,
            description    = $2,
            discount_type  = $3,
            discount_value = $4,
            code           = $5,
            audience       = $6,
            max_uses       = $7,
            valid_from     = $8,
            valid_until    = $9,
            status         = $10,
            updated_at     = NOW()
      WHERE id = $11${org}
      RETURNING *`,
    params
  );

  // The row existed a moment ago and the same tenant predicate applies, so an
  // empty result means it was deleted in between. Reported as not-found rather
  // than as a server error: that is what it is, and the client's next read will
  // agree.
  if (!result.rows.length) return { status: 'notFound' };

  return { status: 'ok', offer: result.rows[0] };
}

module.exports = { updateOffer, MUTABLE_COLUMNS };

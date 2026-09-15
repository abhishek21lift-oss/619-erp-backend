'use strict';
// Discount offers and coupon codes.
//
// Scoped to the caller's studio throughout. Before migration 174 the offers
// table had no organization_id, so every read returned the whole platform's
// offers and `DELETE FROM offers WHERE id = $1` deleted any studio's. The
// `code` column also carried a PLATFORM-WIDE unique constraint, which meant
// the first studio to create "SUMMER20" took that code away from everyone
// else; 174 replaces it with a per-studio unique index, so the 23505 handlers
// below now mean "you already have that code" rather than "somebody does".
const express = require('express');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { orgWhere, orgIdOf, tenantScope } = require('../lib/tenant-db');
const { validateOffer } = require('../lib/offerRules');
const { updateOffer } = require('../modules/offers/offers.service');

const router = express.Router();
router.use(auth, adminOnly);

/**
 * Shape a rule failure as a validation error.
 *
 * Carries `field` alongside the message, which the rest of the API does not yet
 * do — all 82 of its other VALIDATION responses are message-only, so a client
 * has nothing to key on and must show every server error at form level. The
 * frontend's error mapper already reads this key; this is the first endpoint to
 * send it, and the shape other endpoints should adopt.
 */
function validationError(check) {
  return {
    error: {
      code: 'VALIDATION',
      message: check.message,
      ...(check.field ? { field: check.field } : {}),
    },
  };
}

// GET /api/offers
router.get('/', async (req, res, next) => {
  try {
    const { status, audience } = req.query;
    const values = [];
    const org = orgWhere(req, values);
    const conditions = [];
    if (status)   { values.push(status);   conditions.push(`status = $${values.length}`); }
    if (audience) { values.push(audience); conditions.push(`audience = $${values.length}`); }
    const extra = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, code, status,
              title          AS name,
              discount_type  AS type,
              discount_value AS value,
              audience       AS plan,
              valid_from     AS "validFrom",
              valid_until    AS "validUntil",
              max_uses       AS "usageLimit",
              used_count     AS used,
              created_at
       FROM offers WHERE 1=1${org}${extra} ORDER BY created_at DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/offers/stats
router.get('/stats', async (req, res, next) => {
  try {
    const values = [];
    const org = orgWhere(req, values);
    const result = await pool.query(`
      SELECT
        COUNT(*)                                           AS total,
        COUNT(*) FILTER (WHERE status = 'active')         AS active,
        COUNT(*) FILTER (WHERE status = 'expired')        AS expired,
        COALESCE(SUM(used_count), 0)                      AS total_used
      FROM offers WHERE 1=1${org}
    `, values);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/offers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const values = [req.params.id];
    const org = orgWhere(req, values);
    const result = await pool.query(`SELECT * FROM offers WHERE id = $1${org}`, values);
    if (!result.rows.length) return res.status(404).json({ error: 'Offer not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/offers
router.post('/', async (req, res, next) => {
  try {
    const check = validateOffer(req.body || {});
    if (!check.ok) return res.status(400).json(validationError(check));
    const v = check.value;

    const result = await pool.query(
      `INSERT INTO offers
         (title, description, discount_type, discount_value, code, audience, max_uses, valid_from, valid_until, status, created_by, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        v.title,
        v.description,
        v.discount_type,
        v.discount_value,
        v.code,
        v.audience,
        v.max_uses,
        v.valid_from,
        v.valid_until,
        v.status,
        req.user?.id,
        orgIdOf(req),
      ]
    );
    res.status(201).json({ offer: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'You already have an offer with this code' });
    next(err);
  }
});

// PUT /api/offers/:id
router.put('/:id', async (req, res, next) => {
  try {
    // The merge-and-validate lives in the service: discount_type and
    // discount_value are only valid as a pair, so a request changing one must
    // be checked against the stored value of the other, and that read-then-write
    // does not belong in an adapter.
    const result = await updateOffer(tenantScope(req), req.params.id, req.body || {});

    if (result.status === 'notFound') return res.status(404).json({ error: 'Offer not found' });
    if (result.status === 'invalid') return res.status(400).json(validationError(result));
    res.json({ offer: result.offer });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'You already have an offer with this code' });
    next(err);
  }
});

// DELETE /api/offers/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const values = [req.params.id];
    const org = orgWhere(req, values);
    const result = await pool.query(`DELETE FROM offers WHERE id = $1${org} RETURNING id`, values);
    if (!result.rows.length) return res.status(404).json({ error: 'Offer not found' });
    res.json({ message: 'Offer deleted' });
  } catch (err) { next(err); }
});

// POST /api/offers/:id/redeem — increment used_count
router.post('/:id/redeem', async (req, res, next) => {
  try {
    const values = [req.params.id];
    const org = orgWhere(req, values);
    const result = await pool.query(
      `UPDATE offers
       SET used_count = used_count + 1, updated_at = NOW()
       WHERE id = $1${org}
         AND status = 'active'
         AND (max_uses IS NULL OR used_count < max_uses)
         AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
       RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(400).json({ error: 'Offer is not redeemable' });
    res.json({ success: true, offer: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;

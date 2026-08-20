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
const { orgWhere, orgIdOf } = require('../lib/tenant-db');

const router = express.Router();
router.use(auth, adminOnly);

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
    const { title, description, discount_type, discount_value, code, audience, max_uses, valid_from, valid_until, status } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const result = await pool.query(
      `INSERT INTO offers
         (title, description, discount_type, discount_value, code, audience, max_uses, valid_from, valid_until, status, created_by, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        title,
        description || null,
        discount_type || 'percent',
        discount_value || 0,
        code || null,
        audience || 'all',
        max_uses || null,
        valid_from || null,
        valid_until || null,
        status || 'active',
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
    const { title, description, discount_type, discount_value, code, audience, max_uses, valid_from, valid_until, status } = req.body;
    const values = [title, description, discount_type, discount_value, code, audience, max_uses || null, valid_from || null, valid_until || null, status, req.params.id];
    const org = orgWhere(req, values);
    const result = await pool.query(
      `UPDATE offers
       SET title          = COALESCE($1, title),
           description    = COALESCE($2, description),
           discount_type  = COALESCE($3, discount_type),
           discount_value = COALESCE($4, discount_value),
           code           = COALESCE($5, code),
           audience       = COALESCE($6, audience),
           max_uses       = $7,
           valid_from     = $8,
           valid_until    = $9,
           status         = COALESCE($10, status),
           updated_at     = NOW()
       WHERE id = $11${org}
       RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Offer not found' });
    res.json({ offer: result.rows[0] });
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

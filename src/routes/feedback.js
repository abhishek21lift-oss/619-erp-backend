'use strict';
// Member feedback and staff replies.
//
// Scoped to the caller's studio throughout. Before migration 174 the feedback
// table had no organization_id, so every read and every reply/resolve/delete
// addressed by :id reached any studio's feedback.
//
// Note on member_id: it was declared `REFERENCES clients(id)`, the legacy
// table migration 170 dropped — 170 resolves the FK set from pg_catalog and
// drops each one, so the column survives as unconstrained TEXT. It is not used
// for scoping here for exactly that reason; organization_id is.
const express = require('express');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');
const { orgWhere, orgIdOf } = require('../lib/tenant-db');

const router = express.Router();
router.use(auth, adminOnly);

// GET /api/feedback
router.get('/', async (req, res, next) => {
  try {
    const { status, type, limit = 50, offset = 0 } = req.query;
    const values = [];
    const org = orgWhere(req, values);
    const conditions = [];
    if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
    if (type)   { values.push(type);   conditions.push(`type = $${values.length}`); }
    const extra = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
    values.push(Number(limit), Number(offset));
    const result = await pool.query(
      `SELECT id, rating, message, reply, status,
              member_name                AS member,
              type                       AS category,
              created_at                 AS date,
              CASE
                WHEN rating >= 4 THEN 'positive'
                WHEN rating <= 2 THEN 'negative'
                ELSE 'neutral'
              END                        AS sentiment
       FROM feedback WHERE 1=1${org}${extra}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/feedback/stats
router.get('/stats', async (req, res, next) => {
  try {
    const values = [];
    const org = orgWhere(req, values);
    const result = await pool.query(`
      SELECT
        COUNT(*)                                         AS total,
        COUNT(*) FILTER (WHERE status = 'open')         AS open,
        COUNT(*) FILTER (WHERE status = 'resolved')     AS resolved,
        ROUND(AVG(rating)::NUMERIC, 1)                  AS avg_rating,
        COUNT(*) FILTER (WHERE rating >= 4)             AS positive,
        COUNT(*) FILTER (WHERE rating <= 2)             AS negative,
        CASE WHEN COUNT(rating) = 0 THEN 0
          ELSE ROUND(
            (COUNT(*) FILTER (WHERE rating >= 4)::NUMERIC -
             COUNT(*) FILTER (WHERE rating <= 2)::NUMERIC)
            / COUNT(rating)::NUMERIC * 100
          )
        END                                             AS nps
      FROM feedback WHERE 1=1${org}
    `, values);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/feedback/:id
router.get('/:id', async (req, res, next) => {
  try {
    const values = [req.params.id];
    const org = orgWhere(req, values);
    const result = await pool.query(`SELECT * FROM feedback WHERE id = $1${org}`, values);
    if (!result.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/feedback — record feedback against the caller's studio
router.post('/', async (req, res, next) => {
  try {
    const { member_id, member_name, type, rating, message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const result = await pool.query(
      `INSERT INTO feedback (member_id, member_name, type, rating, message, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [member_id || null, member_name || null, type || 'general', rating || null, message, orgIdOf(req)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/feedback/:id/reply
router.post('/:id/reply', async (req, res, next) => {
  try {
    const { reply } = req.body;
    if (!reply) return res.status(400).json({ error: 'reply is required' });
    const values = [reply, req.params.id];
    const org = orgWhere(req, values);
    const result = await pool.query(
      `UPDATE feedback
       SET reply = $1, replied_at = NOW(), status = 'replied', updated_at = NOW()
       WHERE id = $2${org}
       RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ message: 'Reply sent' });
  } catch (err) { next(err); }
});

// POST /api/feedback/:id/resolve
router.post('/:id/resolve', async (req, res, next) => {
  try {
    const values = [req.params.id];
    const org = orgWhere(req, values);
    const result = await pool.query(
      `UPDATE feedback SET status = 'resolved', updated_at = NOW() WHERE id = $1${org} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ message: 'Feedback resolved' });
  } catch (err) { next(err); }
});

// DELETE /api/feedback/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const values = [req.params.id];
    const org = orgWhere(req, values);
    const result = await pool.query(`DELETE FROM feedback WHERE id = $1${org} RETURNING id`, values);
    if (!result.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

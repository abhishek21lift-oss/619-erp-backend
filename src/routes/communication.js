'use strict';
const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(auth, adminOnly);

// GET /api/communication/history
router.get('/history', async (req, res, next) => {
  try {
    const { type, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    if (type) { conditions.push(`type = $${values.length + 1}`); values.push(type); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(Number(limit), Number(offset));
    const result = await pool.query(
      `SELECT * FROM communication_history ${where}
       ORDER BY sent_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/communication/history/:id
router.get('/history/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM communication_history WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/communication/send
router.post('/send', async (req, res, next) => {
  try {
    const { title, body, type, audience, recipients } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

    // Count recipients if not explicitly provided
    let recipientCount = recipients;
    if (!recipientCount) {
      if (audience === 'all' || !audience) {
        const r = await pool.query("SELECT COUNT(*) FROM clients WHERE status = 'active'");
        recipientCount = Number(r.rows[0].count);
      } else {
        recipientCount = 0;
      }
    }

    const result = await pool.query(
      `INSERT INTO communication_history (title, body, type, audience, recipients, status, sent_by)
       VALUES ($1, $2, $3, $4, $5, 'sent', $6)
       RETURNING *`,
      [title, body, type || 'announcement', audience || 'all', recipientCount, req.user?.id]
    );

    // Broadcast in-app notification to all active members (fire-and-forget)
    pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       SELECT user_id, 'announcement', $1, $2
       FROM clients
       WHERE status = 'active' AND user_id IS NOT NULL
       LIMIT 500`,
      [title, body]
    ).catch(() => {});

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/communication/history/:id
router.delete('/history/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM communication_history WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

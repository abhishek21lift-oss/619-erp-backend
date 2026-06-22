// src/modules/sessions/sessions.routes.js
// Personal Training session scheduling.
// Conflict detection lives in the DB trigger pt_no_overlap.

const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/v1/pt-sessions
router.get('/', auth, wrap(async (req, res) => {
  const { from, to, trainer_id, member_id, status } = req.query;
  const where = [];
  const params = [];

  // Scoping
  if (req.user.role === 'trainer') { params.push(req.user.trainer_id); where.push(`pt.trainer_id = $${params.length}`); }
  else if (req.user.role === 'member') { params.push(req.user.member_id); where.push(`pt.member_id = $${params.length}`); }
  else {
    if (trainer_id) { params.push(trainer_id); where.push(`pt.trainer_id = $${params.length}`); }
    if (member_id)  { params.push(member_id);  where.push(`pt.member_id = $${params.length}`); }
  }
  if (from)   { params.push(from);   where.push(`pt.starts_at >= $${params.length}`); }
  if (to)     { params.push(to);     where.push(`pt.starts_at <= $${params.length}`); }
  if (status) { params.push(status); where.push(`pt.status = $${params.length}`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT pt.*, m.name AS member_name, m.member_code, t.name AS trainer_name
     FROM pt_sessions pt
     JOIN members m ON m.id = pt.member_id
     JOIN trainers t ON t.id = pt.trainer_id
     ${whereSql}
     ORDER BY pt.starts_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

// POST /api/v1/pt-sessions
router.post('/', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const { member_id, trainer_id, starts_at, ends_at, goal, membership_id } = req.body;
  // Trainer can only create sessions for themselves
  const tid = req.user.role === 'trainer' ? req.user.trainer_id : trainer_id;

  try {
    const { rows } = await pool.query(
      `INSERT INTO pt_sessions
         (member_id, trainer_id, starts_at, ends_at, goal, membership_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'scheduled')
       RETURNING *`,
      [member_id, tid, starts_at, ends_at, goal || null, membership_id || null]
    );
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    if (err.message?.includes('conflicting session')) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: err.message } });
    }
    throw err;
  }
}));

// PATCH /api/v1/pt-sessions/:id
router.patch('/:id', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const { starts_at, ends_at, goal, trainer_notes } = req.body;
  const sets = [];
  const params = [];
  if (starts_at)     { params.push(starts_at);     sets.push(`starts_at = $${params.length}`); }
  if (ends_at)       { params.push(ends_at);       sets.push(`ends_at = $${params.length}`); }
  if (goal !== undefined) { params.push(goal);     sets.push(`goal = $${params.length}`); }
  if (trainer_notes !== undefined) { params.push(trainer_notes); sets.push(`trainer_notes = $${params.length}`); }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No fields' } });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE pt_sessions SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length} RETURNING *`,
    params
  );
  res.json({ data: rows[0] });
}));

// POST /api/v1/pt-sessions/:id/complete
router.post('/:id/complete', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  // Fetch the session first so we can check membership balance
  const { rows: sessionRows } = await pool.query(
    `SELECT id, status, trainer_id, member_id, membership_id FROM pt_sessions WHERE id = $1`,
    [req.params.id]
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  const session = sessionRows[0];

  if (session.status !== 'scheduled') {
    return res.status(400).json({ error: { code: 'BAD_STATE', message: `Session is already ${session.status}` } });
  }

  // If linked to a membership, verify there are sessions remaining
  if (session.membership_id) {
    const { rows: memRows } = await pool.query(
      `SELECT pt_sessions_total, pt_sessions_used FROM member_memberships WHERE id = $1`,
      [session.membership_id]
    );
    if (memRows.length > 0) {
      const remaining = (memRows[0].pt_sessions_total || 0) - (memRows[0].pt_sessions_used || 0);
      if (remaining <= 0) {
        return res.status(402).json({
          error: { code: 'NO_SESSIONS_REMAINING', message: 'No PT sessions remaining in this membership' },
        });
      }
    }
  }

  const { rows } = await pool.query(
    `UPDATE pt_sessions SET status='completed', updated_at = NOW()
     WHERE id = $1 AND status='scheduled' RETURNING *`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(400).json({ error: { code: 'BAD_STATE' } });
  // Increment usage on membership if linked
  if (rows[0].membership_id) {
    await pool.query(
      `UPDATE member_memberships SET pt_sessions_used = pt_sessions_used + 1 WHERE id = $1`,
      [rows[0].membership_id]
    );
  }
  res.json({ data: rows[0] });
}));

// DELETE /api/v1/pt-sessions/:id  — cancel
router.delete('/:id', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT trainer_id, member_id FROM pt_sessions WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (req.user.role === 'trainer' && rows[0].trainer_id !== req.user.trainer_id) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot cancel another trainer\'s session' } });
  }
  await pool.query(
    `UPDATE pt_sessions SET status='cancelled', updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.status(204).end();
}));

module.exports = router;

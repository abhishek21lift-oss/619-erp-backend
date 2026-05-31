const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', auth, wrap(async (req, res) => {
  const { status, source, search, assigned_to, limit, offset } = req.query;
  const where = ['l.deleted_at IS NULL'];
  const params = [];
  let p = 1;
  if (status) { params.push(status); where.push(`l.status = $${p++}`); }
  if (source) { params.push(source); where.push(`l.source = $${p++}`); }
  if (assigned_to) { params.push(assigned_to); where.push(`l.assigned_to = $${p++}`); }
  if (search) { params.push(`%${search}%`); where.push(`(l.name ILIKE $${p} OR l.mobile ILIKE $${p} OR l.email ILIKE $${p})`); p++; }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  params.push(lim); params.push(off);
  const { rows } = await pool.query(`
    SELECT l.*, u.name AS assigned_name,
      (SELECT COUNT(*) FROM lead_followups WHERE lead_id = l.id AND outcome = 'pending') AS pending_followups
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
    WHERE ${where.join(' AND ')}
    ORDER BY l.created_at DESC LIMIT $${p++} OFFSET $${p++}
  `, params);
  const { rows: [{ total }] } = await pool.query(
    `SELECT COUNT(*)::INT AS total FROM leads l WHERE ${where.join(' AND ')}`, params.slice(0, -2)
  );
  res.json({ data: rows, total, limit: lim, offset: off });
}));

router.get('/stats', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'new')::INT AS new_leads,
      COUNT(*) FILTER (WHERE status = 'contacted')::INT AS contacted,
      COUNT(*) FILTER (WHERE status = 'follow_up')::INT AS follow_up,
      COUNT(*) FILTER (WHERE status = 'interested')::INT AS interested,
      COUNT(*) FILTER (WHERE status = 'not_interested')::INT AS not_interested,
      COUNT(*) FILTER (WHERE status = 'trial_booked')::INT AS trial_booked,
      COUNT(*) FILTER (WHERE status = 'converted')::INT AS converted,
      COUNT(*) FILTER (WHERE status = 'lost')::INT AS lost,
      COUNT(*) FILTER (WHERE source = 'website')::INT AS website,
      COUNT(*) FILTER (WHERE source = 'instagram')::INT AS instagram,
      COUNT(*) FILTER (WHERE source = 'whatsapp')::INT AS whatsapp,
      COUNT(*) FILTER (WHERE source = 'referral')::INT AS referral,
      COUNT(*) FILTER (WHERE source = 'walk_in')::INT AS walk_in,
      COUNT(*) FILTER (WHERE source = 'call')::INT AS call
    FROM leads WHERE deleted_at IS NULL
  `);
  res.json({ data: rows[0] });
}));

router.get('/:id', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT l.*, u.name AS assigned_name
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
    WHERE l.id = $1
  `, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
  const { rows: followups } = await pool.query(
    'SELECT * FROM lead_followups WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]
  );
  res.json({ data: { ...rows[0], followups } });
}));

router.post('/', auth, wrap(async (req, res) => {
  const { name, mobile, email, gender, source, status, interest, notes, assigned_to } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Name is required' } });
  const { rows } = await pool.query(
    `INSERT INTO leads (name, mobile, email, gender, source, status, interest, notes, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [name.trim(), mobile || null, email?.toLowerCase() || null, gender || null,
     source || 'walk_in', status || 'new', interest || null, notes || null, assigned_to || null]
  );
  res.status(201).json({ data: rows[0] });
}));

router.patch('/:id', auth, wrap(async (req, res) => {
  const allowed = ['name','mobile','email','gender','source','status','interest','notes','assigned_to'];
  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  res.json({ data: rows[0] });
}));

router.post('/:id/convert', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: { code: 'VALIDATION', message: 'client_id is required' } });
  const { rows } = await pool.query(
    `UPDATE leads SET status = 'converted', converted_to_client_id = $1, converted_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
    [client_id, req.params.id]
  );
  res.json({ data: rows[0] });
}));

router.delete('/:id', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  await pool.query('UPDATE leads SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

router.get('/:id/followups', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM lead_followups WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]
  );
  res.json({ data: rows });
}));

router.post('/:id/followups', auth, wrap(async (req, res) => {
  const { followup_type, outcome, notes, scheduled_at, next_followup_at } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO lead_followups (lead_id, followup_type, outcome, notes, scheduled_at, performed_by, next_followup_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.id, followup_type || 'call', outcome || 'pending', notes || null,
     scheduled_at || null, req.user.id, next_followup_at || null]
  );
  if (outcome && outcome !== 'pending') {
    await pool.query(
      `UPDATE leads SET status = CASE WHEN $1 = 'converted' THEN 'converted'
                                       WHEN $1 IN ('not_interested','reached') THEN 'contacted'
                                       ELSE 'follow_up' END,
       updated_at = NOW() WHERE id = $2`,
      [outcome, req.params.id]
    );
  }
  res.status(201).json({ data: rows[0] });
}));

router.patch('/followups/:followupId', auth, wrap(async (req, res) => {
  const { outcome, notes, completed_at, next_followup_at } = req.body;
  const sets = []; const params = [];
  if (outcome !== undefined) { params.push(outcome); sets.push(`outcome = $${params.length}`); }
  if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`); }
  if (completed_at !== undefined) { params.push(completed_at); sets.push(`completed_at = $${params.length}`); }
  if (next_followup_at !== undefined) { params.push(next_followup_at); sets.push(`next_followup_at = $${params.length}`); }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  params.push(req.params.followupId);
  const { rows } = await pool.query(
    `UPDATE lead_followups SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params
  );
  res.json({ data: rows[0] });
}));

module.exports = router;

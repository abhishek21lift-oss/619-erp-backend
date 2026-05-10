// src/routes/plans.js  — CRUD for membership plans
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/plans
router.get('/', auth, async (req, res, next) => {
  try {
    const { kind, active } = req.query;
    const conds = ['1=1'];
    const params = [];
    let p = 1;
    if (kind)   { conds.push(`kind = $${p++}`);       params.push(kind); }
    if (active !== undefined) { conds.push(`is_active = $${p++}`); params.push(active !== 'false'); }

    const { rows } = await pool.query(
      `SELECT * FROM plans WHERE ${conds.join(' AND ')} ORDER BY kind, duration, final_amount`,
      params
    );
    res.json(rows);
  } catch (err) {
    // Table may not exist yet on fresh deployments — return empty array gracefully
    if (err && typeof err.message === 'string' && err.message.includes('does not exist')) return res.json([]);
    next(err);
  }
});

// POST /api/plans  (admin only)
router.post('/', auth, adminOnly, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.name?.trim())      return res.status(400).json({ error: 'Plan name is required' });
    if (!d.final_amount || parseFloat(d.final_amount) <= 0)
      return res.status(400).json({ error: 'Final amount must be > 0' });

    const id = uuid();
    const base  = parseFloat(d.base_amount)  || 0;
    const disc  = parseFloat(d.discount)     || 0;
    const final = parseFloat(d.final_amount) || Math.max(0, base - disc);
    const features = Array.isArray(d.features) ? JSON.stringify(d.features) : (d.features || '[]');

    const { rows } = await pool.query(
      `INSERT INTO plans (id,kind,name,duration,base_amount,discount,final_amount,
         sessions_per_week,features,popular,is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [id, d.kind || 'Membership', d.name.trim(),
       d.duration || 'Monthly', base, disc, final,
       d.sessions_per_week ? parseInt(d.sessions_per_week) : null,
       features, Boolean(d.popular), d.is_active !== false]
    );
    res.status(201).json({ message: 'Plan created', plan: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/plans/:id  (admin only)
router.put('/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const d = req.body;
    const { rows: ex } = await pool.query('SELECT * FROM plans WHERE id=$1', [req.params.id]);
    if (!ex[0]) return res.status(404).json({ error: 'Plan not found' });

    // BUG FIX: `parseFloat(d.x) ?? ex[0].x` is broken — when d.x is undefined
    // parseFloat returns NaN, which is NOT nullish, so ?? does not coalesce
    // and the column is set to NaN (Postgres rejects, surfacing as a 500).
    // Use an explicit "is the field present?" check.
    const numField = (key) =>
      d[key] !== undefined && d[key] !== null && d[key] !== ''
        ? parseFloat(d[key])
        : ex[0][key];
    const base  = numField('base_amount');
    const disc  = numField('discount');
    const final = numField('final_amount');
    const features = Array.isArray(d.features)
      ? JSON.stringify(d.features)
      : (d.features !== undefined ? d.features : JSON.stringify(ex[0].features ?? []));

    const { rows } = await pool.query(
      `UPDATE plans SET
         kind=$1, name=$2, duration=$3, base_amount=$4, discount=$5, final_amount=$6,
         sessions_per_week=$7, features=$8, popular=$9, is_active=$10, updated_at=NOW()
       WHERE id=$11 RETURNING *`,
      [d.kind || ex[0].kind, (d.name || ex[0].name).trim(),
       d.duration || ex[0].duration, base, disc, final,
       d.sessions_per_week ? parseInt(d.sessions_per_week) : ex[0].sessions_per_week,
       features, Boolean(d.popular ?? ex[0].popular),
       d.is_active !== undefined ? Boolean(d.is_active) : ex[0].is_active,
       req.params.id]
    );
    res.json({ message: 'Plan updated', plan: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/plans/:id  (admin only)
router.delete('/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM plans WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Plan not found' });
    res.json({ message: 'Plan deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

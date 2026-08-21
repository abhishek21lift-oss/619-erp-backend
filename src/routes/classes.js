const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');

// GET /api/classes/sessions
//
// Was unscoped: any authenticated account — including the `member` logins
// client activation creates — saw every studio's class timetable, trainer
// names and capacity. Migration 176 gave class_sessions its organization_id;
// this is the filter that uses it.
//
// class_templates is joined but deliberately NOT filtered here. It carries the
// shared shape (a NULL org means platform-provided content, like `exercises`
// and `meals`), so filtering the join would hide the seeded template library
// and blank the class name on every session built from it. The session row is
// the tenant-owned record and scoping it is what bounds the result.
router.get('/sessions', auth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const params = [from || new Date().toISOString(), to || null];

    const scope = tenantScope(req);
    let orgClause = '';
    if (scope.applyFilter) {
      params.push(scope.orgId);
      orgClause = ` AND cs.organization_id = $${params.length}`;
    }

    const { rows } = await pool.query(`
      SELECT
        cs.id AS session_id,
        cs.starts_at,
        cs.ends_at,
        cs.capacity,
        ct.name AS class_name,
        ct.category,
        t.name AS trainer_name,
        COALESCE((SELECT COUNT(*) FROM bookings b WHERE b.session_id = cs.id AND b.status = 'confirmed'), 0)::int AS confirmed,
        GREATEST(0, cs.capacity - COALESCE((SELECT COUNT(*) FROM bookings b WHERE b.session_id = cs.id AND b.status = 'confirmed'), 0))::int AS spots_left
      FROM class_sessions cs
      JOIN class_templates ct ON ct.id = cs.template_id
      LEFT JOIN trainers t ON t.id = cs.trainer_id
      WHERE (cs.starts_at >= $1 OR $1 IS NULL)
        AND (cs.starts_at <= $2 OR $2 IS NULL)${orgClause}
      ORDER BY cs.starts_at
    `, params);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

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

    // starts_at / ends_at are COMPUTED, not stored. class_sessions has `date`,
    // `start_time` and `end_time`; this route asked for `cs.starts_at`,
    // `cs.ends_at` and `cs.trainer_id`, none of which exist, so it answered
    // `column cs.trainer_id does not exist` — a 500 on every call, which is why
    // no session id ever reached the member Classes screen to be booked.
    //
    // The aliases keep the response shape the screen reads. The zone comes from
    // the connection (db/pool.js sets it per studio), so a 09:00 class is 09:00
    // where the studio is.
    //
    // class_templates is LEFT JOINed: template_id is nullable and an inner join
    // hides every ad-hoc session, which looks to a member like an empty
    // timetable rather than a missing class name.
    const { rows } = await pool.query(`
      SELECT
        cs.id AS session_id,
        (cs.date + cs.start_time) AT TIME ZONE current_setting('TimeZone') AS starts_at,
        (cs.date + cs.end_time)   AT TIME ZONE current_setting('TimeZone') AS ends_at,
        cs.capacity,
        COALESCE(ct.name, cs.title) AS class_name,
        ct.category,
        COALESCE(t.name, cs.instructor_name) AS trainer_name,
        COALESCE((SELECT COUNT(*) FROM bookings b WHERE b.session_id = cs.id AND b.status = 'confirmed'), 0)::int AS confirmed,
        GREATEST(0, cs.capacity - COALESCE((SELECT COUNT(*) FROM bookings b WHERE b.session_id = cs.id AND b.status = 'confirmed'), 0))::int AS spots_left
      FROM class_sessions cs
      LEFT JOIN class_templates ct ON ct.id = cs.template_id
      LEFT JOIN trainers t ON t.id = cs.instructor_id
      WHERE ((cs.date + cs.start_time) AT TIME ZONE current_setting('TimeZone') >= $1 OR $1 IS NULL)
        AND ((cs.date + cs.start_time) AT TIME ZONE current_setting('TimeZone') <= $2 OR $2 IS NULL)${orgClause}
      ORDER BY cs.date, cs.start_time
    `, params);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

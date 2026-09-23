// src/routes/attendance.js
// Uses the canonical attendance_logs table (v4 schema).
// Column mapping from old attendance table:
//   attendance.type       → attendance_logs.ref_type
//   attendance.check_in   → attendance_logs.check_in_time (TIMESTAMPTZ)
//   attendance.check_out  → attendance_logs.check_out_time (TIMESTAMPTZ)
//   attendance.check_in_method → attendance_logs.method
//   trainer_id/name       → marked_by (references users.id)
// Removed: updated_at, branch_id, member_id, booking_id, pt_session_id, device_id
// Unique constraint: (ref_id, ref_type, date)

const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth, requireTrainer } = require('../middleware/auth');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

// ── AUD-004 (P1): this is the studio's back office ──────────────────────────
//
// Every route below was gated on `auth` alone. The mount in server.js adds
// `gate('attendance')`, which is [auth, requireFeature('attendance')] — a
// feature flag, not a role check. And the ownership check inside PUT and
// DELETE was written as a role branch, so an account with role `member` fell
// straight through it.
//
// The result, with an ordinary session and no exploit: an activated client
// could read the studio's entire attendance register — every other client's
// name, dates and times — and create, edit or delete rows in it. Reproduced in
// __tests__/security/attendance.authz.test.js, where a `member` got 201 from
// POST /bulk and 200 from /stats, /gaps and /today-summary against the code
// this comment replaces.
//
// Declared HERE rather than at the mount, matching offers.js / campaigns.js /
// feedback.js / integrations.js: the guard travels with the router, so it
// cannot be lost if the mount is edited or the router is mounted a second time.
// `auth` runs twice as a result (once from the mount's gate, once here) and
// that is deliberate and cheap — the second call is a user-cache hit, and the
// same doubling already happens on every /api/pt-os mount.
//
// A client's own attendance is served by GET /api/me/attendance
// (modules/client-portal/client-portal.routes.js), which scopes to
// req.user.pt_client_id — so nothing member-facing is lost here.
router.use(auth, requireTrainer);

// What an attendance row may be about: a client of the studio, or the
// studio's own trainer profile. ('staff' and 'user' went with the staff
// roles; migration 208 narrows the column's CHECK to match.)
const SUBJECT_TYPES = ['client', 'trainer'];

/**
 * True when `refId` is a live subject of `type` in this organization.
 *
 * attendance_logs is written with ON CONFLICT (ref_id, ref_type, date) DO
 * UPDATE, and that unique key has no organization in it — so writing a row
 * for another studio's client id would UPDATE that studio's row. Checking the
 * subject first, inside this studio, is what keeps an attendance write from
 * crossing the tenant boundary.
 */
async function subjectInOrg(orgId, type, refId) {
  if (!orgId || !refId || !SUBJECT_TYPES.includes(type)) return false;
  const table = type === 'client' ? 'pt_clients' : 'trainers';
  const { rowCount } = await pool.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [refId, orgId]
  );
  return rowCount > 0;
}

// GET /api/attendance?date=YYYY-MM-DD&type=client&page=1&limit=100
router.get('/', auth, async (req, res, next) => {
  try {
    const { date, from, to, type = 'client', ref_id } = req.query;
    const conditions = ['1=1'];
    const params = [];
    let p = 1;

    if (date)   { conditions.push(`a.date = $${p++}`);     params.push(date); }
    if (from)   { conditions.push(`a.date >= $${p++}`);    params.push(from); }
    if (to)     { conditions.push(`a.date <= $${p++}`);    params.push(to); }
    if (type)   { conditions.push(`a.ref_type = $${p++}`); params.push(type); }
    if (ref_id) { conditions.push(`a.ref_id = $${p++}`);   params.push(ref_id); }

    const scope = tenantScope(req);
    conditions.push(`a.organization_id = $${p++}`); params.push(scope.orgId);
    const bparams = params;

    const whereClause = conditions.join(' AND ');

    // Pagination: if page is provided use paginated response, otherwise fall back to legacy limit
    if (req.query.page !== undefined) {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const offset = (page - 1) * limit;

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS total FROM attendance_logs a WHERE ${whereClause}`,
        bparams
      );
      const total = parseInt(countRows[0].total);

      const { rows } = await pool.query(
        `SELECT a.id, a.ref_id, a.ref_type AS type, a.ref_name,
                a.date, a.check_in_time AS check_in, a.check_out_time AS check_out,
                a.status, a.notes, a.method AS check_in_method, a.created_at
           FROM attendance_logs a
         WHERE ${whereClause}
         ORDER BY a.date DESC, a.check_in_time DESC NULLS LAST
         LIMIT $${p} OFFSET $${p + 1}`,
        bparams.concat(limit, offset)
      );
      return res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
    }

    // Legacy: no page param — use default limit (200 for no date range, 500 cap for date range)
    const limit = (from || to) ? Math.min(5000, 500) : 200;

    const { rows } = await pool.query(
      `SELECT a.id, a.ref_id, a.ref_type AS type, a.ref_name,
              a.date, a.check_in_time AS check_in, a.check_out_time AS check_out,
              a.status, a.notes, a.method AS check_in_method, a.created_at
         FROM attendance_logs a
       WHERE ${whereClause}
       ORDER BY a.date DESC, a.check_in_time DESC NULLS LAST
       LIMIT $${p}`,
      bparams.concat(limit)
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance — mark attendance
router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body;
    if (!d.ref_id || !d.date)
      return res.status(400).json({ error: 'ref_id and date required' });

    const type = d.type || 'client';
    if (!SUBJECT_TYPES.includes(type))
      return res.status(400).json({ error: `type must be one of: ${SUBJECT_TYPES.join(', ')}` });
    // 404, not 403: another studio's id must look like one that does not exist.
    if (!await subjectInOrg(orgIdOf(req), type, d.ref_id))
      return res.status(404).json({ error: 'Not found' });

    const id = randomUUID();
    const checkIn = d.check_in ? new Date(d.date + 'T' + d.check_in).toISOString() : null;
    const checkOut = d.check_out ? new Date(d.date + 'T' + d.check_out).toISOString() : null;
    await pool.query(`
      INSERT INTO attendance_logs
        (id, ref_id, ref_type, ref_name, date, check_in_time, check_out_time,
         status, notes, method, marked_by, organization_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (ref_id, ref_type, date) DO UPDATE
        SET status=$8,
            check_in_time=COALESCE(attendance_logs.check_in_time, $6),
            check_out_time=$7,
            notes=$9,
            method=$10,
            organization_id=COALESCE(attendance_logs.organization_id, $12)
        -- The conflict key carries no organization; this does. A row that
        -- belongs to another studio is left untouched.
        WHERE attendance_logs.organization_id IS NULL OR attendance_logs.organization_id = $12`,
      [id, d.ref_id, type, d.ref_name || null,
       d.date, checkIn, checkOut,
       d.status || 'present', d.notes || null,
       'manual', req.user.id, orgIdOf(req)]
    );
    res.status(201).json({ message: 'Attendance marked' });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/today-summary
router.get('/today-summary', auth, async (req, res, next) => {
  try {
    const params = [];
    const scope = tenantScope(req);
    let orgFilter = '';
    params.push(scope.orgId); orgFilter = 'AND a.organization_id = $' + params.length + ' ';

    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE a.status='present') AS present,
        COUNT(*) FILTER (WHERE a.status='absent')  AS absent,
        COUNT(*) FILTER (WHERE a.status='late')    AS late,
        COUNT(*)                                    AS total
      FROM attendance_logs a
      WHERE a.date = CURRENT_DATE AND a.ref_type = 'client' ${orgFilter}`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/attendance/:id — update a specific attendance record
router.put('/:id', auth, async function(req, res, next) {
  try {
    const scope = tenantScope(req);
    const existGuard = ' AND organization_id = $2';
    const { rows: existing } = await pool.query(
      'SELECT id, ref_id, ref_type FROM attendance_logs WHERE id = $1' + existGuard,
      [req.params.id, scope.orgId]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Attendance record not found' });

    const fields = [];
    const params = [req.params.id];
    let idx = 2;
    const d = req.body;

    if (d.status !== undefined) { fields.push('status = $' + idx++); params.push(d.status); }
    if (d.check_in !== undefined) { fields.push('check_in_time = $' + idx++); params.push(d.check_in); }
    if (d.check_out !== undefined) { fields.push('check_out_time = $' + idx++); params.push(d.check_out); }
    if (d.notes !== undefined) { fields.push('notes = $' + idx++); params.push(d.notes); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(scope.orgId);
    const { rows } = await pool.query(
      'UPDATE attendance_logs SET ' + fields.join(', ') + ' WHERE id = $1 AND organization_id = $' + params.length + ' RETURNING id, ref_id, ref_type AS type, ref_name, date, check_in_time AS check_in, check_out_time AS check_out, status, notes, method AS check_in_method, created_at',
      params
    );
    res.json({ message: 'Attendance updated', attendance: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/attendance/:id — delete a specific attendance record
router.delete('/:id', auth, async function(req, res, next) {
  try {
    const scope = tenantScope(req);
    const existGuard = ' AND organization_id = $2';
    const { rows: existing } = await pool.query(
      'SELECT id, ref_id, ref_type FROM attendance_logs WHERE id = $1' + existGuard,
      [req.params.id, scope.orgId]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Attendance record not found' });

    await pool.query('DELETE FROM attendance_logs WHERE id = $1 AND organization_id = $2', [req.params.id, scope.orgId]);
    res.json({ message: 'Attendance record deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/attendance/bulk — mark attendance for multiple members
router.post('/bulk', auth, async function(req, res, next) {
  try {
    const records = req.body.records;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records array is required' });
    }

    if (records.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 records per bulk operation' });
    }

    const results = [];
    const errors = [];
    const bulkOrgId = orgIdOf(req);

    for (let i = 0; i < records.length; i++) {
      const d = records[i];
      if (!d.ref_id || !d.date || !d.status) {
        errors.push({ index: i, error: 'ref_id, date, and status required' });
        continue;
      }

      try {
        const type = d.type || 'client';
        const id = randomUUID();

        // Same rule as POST /: the subject must be this studio's, because the
        // upsert's conflict key has no organization in it.
        if (!await subjectInOrg(bulkOrgId, type, d.ref_id)) {
          errors.push({ index: i, ref_id: d.ref_id, error: 'Not found' });
          continue;
        }

        const bulkCheckIn = d.check_in ? new Date(d.date + 'T' + d.check_in).toISOString() : null;
        const bulkCheckOut = d.check_out ? new Date(d.date + 'T' + d.check_out).toISOString() : null;
        await pool.query(`
          INSERT INTO attendance_logs
            (id, ref_id, ref_type, ref_name, date,
             check_in_time, check_out_time, status, notes, method, marked_by, organization_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (ref_id, ref_type, date) DO UPDATE
            SET status=$8, notes=$9,
                organization_id=COALESCE(attendance_logs.organization_id, $12)
            WHERE attendance_logs.organization_id IS NULL OR attendance_logs.organization_id = $12`,
          [id, d.ref_id, type, d.ref_name || null,
           d.date, bulkCheckIn, bulkCheckOut,
           d.status || 'present', d.notes || null,
           'manual', req.user.id, bulkOrgId]
        );
        results.push({ index: i, ref_id: d.ref_id, status: d.status });
      } catch (err) {
        errors.push({ index: i, ref_id: d.ref_id, error: err.message });
      }
    }

    res.status(201).json({
      message: results.length + ' records processed',
      processed: results.length,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/stats — attendance statistics for charts
// Query params: from, to, granularity (day|week|month)
router.get('/stats', auth, async function(req, res, next) {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];
    const granularity = req.query.granularity || 'day';

    const granularityVal = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';
    const dateTrunc = granularityVal === 'day' ? 'a.date' : `DATE_TRUNC('${granularityVal}', a.date)`;

    const params = [from, to];
    const scope = tenantScope(req);
    let orgFilter = '';
    params.push(scope.orgId); orgFilter = 'AND a.organization_id = $' + params.length + ' ';

    const { rows } = await pool.query(
      'SELECT ' + dateTrunc + ' AS period, ' +
      'a.status, COUNT(*) AS count ' +
      'FROM attendance_logs a ' +
      'WHERE a.date >= $1 AND a.date <= $2 ' + orgFilter +
      'AND a.ref_type = \'client\' ' +
      'GROUP BY period, a.status ' +
      'ORDER BY period ASC',
      params
    );

    // Pivot: group by period, spread statuses
    const series = {};
    for (const r of rows) {
      const key = r.period instanceof Date ? r.period.toISOString().split('T')[0] : String(r.period);
      if (!series[key]) series[key] = { date: key, present: 0, absent: 0, late: 0, total: 0 };
      series[key][r.status] = parseInt(r.count) || 0;
      series[key].total += parseInt(r.count) || 0;
    }

    res.json(Object.values(series));
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/gaps — members with attendance gaps (absent streaks)
// Query params: min_streak_days (default 3), from, to
router.get('/gaps', auth, async function(req, res, next) {
  try {
    const minStreak = parseInt(req.query.min_streak_days) || 3;
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const to = req.query.to || new Date().toISOString().split('T')[0];

    const params = [from, to, minStreak];
    // Tenant scope: the client identity list must be limited to this org.
    const scope = tenantScope(req);
    let ptOrg = '', aOrg = '', a2Org = '';
    params.push(scope.orgId);
    const orgIdx = params.length;
    // Qualified as c.organization_id: both pt_clients and attendance_logs
    // carry the column, so an unqualified reference is ambiguous.
    ptOrg = ' AND c.organization_id = $' + orgIdx;
    aOrg = ' AND a.organization_id = $' + orgIdx;
    a2Org = ' AND a2.organization_id = $' + orgIdx;

    // Find members (PT) with absent streak >= minStreak
    const { rows } = await pool.query(
      'SELECT c.id, c.name, c.mobile, c.trainer_id, ' +
      'COALESCE(t.name, \'—\') AS trainer_name, ' +
      'COUNT(a.id) FILTER (WHERE a.date >= $1::DATE) AS absent_days, ' +
      'MAX(a.date) AS last_absent_date, ' +
      '(SELECT COUNT(*) FROM attendance_logs a2 ' +
      '  WHERE a2.ref_id = c.id AND a2.ref_type = \'client\' ' +
      '  AND a2.date >= $1::DATE AND a2.date <= $2::DATE' + a2Org + ') AS total_entries ' +
      'FROM pt_clients c ' +
      'LEFT JOIN attendance_logs a ON a.ref_id = c.id AND a.ref_type = \'client\' AND a.status = \'absent\'' + aOrg + ' ' +
      'LEFT JOIN trainers t ON t.id = c.trainer_id AND t.organization_id = c.organization_id ' +
      'WHERE c.deleted_at IS NULL AND c.status = \'active\'' + ptOrg + ' ' +
      'GROUP BY c.id, c.name, c.mobile, c.trainer_id, t.name ' +
      'HAVING COUNT(a.id) >= $3 ' +
      'ORDER BY absent_days DESC',
      params
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

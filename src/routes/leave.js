// src/routes/leave.js
// Leave request management — CRUD + approve/reject workflow.
// DB table: leave_requests (schema.sql / migration 002)

const router = require('express').Router();
const pool = require('../db/pool');
const logger = require('../lib/logger');
const { auth, adminOrManager } = require('../middleware/auth');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');

// Tenant filter for this file, same shape as the orgWhere() helpers in the
// pt-os and training modules: appends ` AND <col> = $n` and pushes the org id,
// or returns '' for a platform super admin operating platform-wide.
//
// Every handler below MUST use it. `adminOrManager` on approve/reject is a
// ROLE gate, not a tenant gate — it answers "may this person approve leave",
// never "whose leave" — so without this, an admin in any studio could approve
// or reject another studio's trainer's leave by id, and list every studio's
// requests along with the trainer name, email and mobile the LEFT JOIN adds.
// leave_requests.organization_id arrives in migration 168.
function orgWhere(req, params, col = 'lr.organization_id') {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return '';
  params.push(scope.orgId);
  return ' AND ' + col + ' = $' + params.length;
}

// GET /api/leave — list leave requests
// Filters: status, trainer_id, from, to
router.get('/', auth, async function(req, res) {
  try {
    const conditions = [];
    const params = [];
    let idx = 1;

    // Tenant scope first, so it is present whatever the optional filters do.
    const scope = tenantScope(req);
    if (scope.applyFilter) {
      conditions.push('lr.organization_id = $' + idx++);
      params.push(scope.orgId);
    }

    if (req.query.status) {
      conditions.push('lr.status = $' + idx++);
      params.push(req.query.status);
    }
    if (req.query.trainer_id) {
      conditions.push('lr.trainer_id = $' + idx++);
      params.push(req.query.trainer_id);
    }
    if (req.query.from) {
      conditions.push('lr.from_date >= $' + idx++);
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push('lr.to_date <= $' + idx++);
      params.push(req.query.to);
    }

    // Trainers can only see their own leave requests
    if (req.user.role === 'trainer') {
      conditions.push('lr.trainer_id = $' + idx++);
      const { rows: tr } = await pool.query('SELECT id FROM trainers WHERE id = $1 OR user_id = $1', [req.user.id]);
      params.push(tr.length ? tr[0].id : req.user.trainer_id || req.user.id);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);

    const { rows } = await pool.query(
      'SELECT lr.*, t.name AS trainer_name, t.email AS trainer_email, t.mobile AS trainer_phone ' +
      'FROM leave_requests lr ' +
      'LEFT JOIN trainers t ON t.id = lr.trainer_id ' +
      where + ' ORDER BY lr.created_at DESC LIMIT $' + (params.length - 1) + ' OFFSET $' + params.length,
      params
    );

    // Map fields to frontend expectations
    const result = rows.map(function(r) {
      const from = new Date(r.from_date);
      const to = new Date(r.to_date);
      return {
        id: r.id,
        trainer_id: r.trainer_id,
        trainer_name: r.trainer_name || '',
        leave_type: r.leave_type,
        from_date: r.from_date,
        to_date: r.to_date,
        reason: r.reason || '',
        admin_note: r.admin_note || '',
        status: r.status,
        approved_by: r.approved_by,
        approved_at: r.approved_at,
        days: Math.max(Math.round((to.getTime() - from.getTime()) / 86400000) + 1, 1),
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, 'Leave list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/leave/:id — single leave request
router.get('/:id', auth, async function(req, res) {
  try {
    const params = [req.params.id];
    const orgClause = orgWhere(req, params);
    const { rows } = await pool.query(
      'SELECT lr.*, t.name AS trainer_name, t.email AS trainer_email ' +
      'FROM leave_requests lr ' +
      'LEFT JOIN trainers t ON t.id = lr.trainer_id ' +
      'WHERE lr.id = $1' + orgClause,
      params
    );

    // 404, not 403, for another studio's id: the two are indistinguishable to
    // the caller, so an id that exists elsewhere on the platform cannot be
    // told apart from one that does not exist at all.
    if (!rows[0]) return res.status(404).json({ error: 'Leave request not found' });

    const r = rows[0];
    const from = new Date(r.from_date);
    const to = new Date(r.to_date);

    res.json({
      id: r.id,
      trainer_id: r.trainer_id,
      trainer_name: r.trainer_name || '',
      leave_type: r.leave_type,
      from_date: r.from_date,
      to_date: r.to_date,
      reason: r.reason || '',
      admin_note: r.admin_note || '',
      status: r.status,
      approved_by: r.approved_by,
      approved_at: r.approved_at,
      days: Math.max(Math.round((to.getTime() - from.getTime()) / 86400000) + 1, 1),
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Leave get error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leave — create leave request
router.post('/', auth, async function(req, res) {
  try {
    const { trainer_id, leave_type, from_date, to_date, reason } = req.body;

    if (!trainer_id || !from_date || !to_date) {
      return res.status(400).json({ error: 'trainer_id, from_date, to_date are required' });
    }

    const VALID_LEAVE_TYPES = ['sick', 'casual', 'personal', 'earned', 'unpaid', 'emergency', 'other'];
    if (leave_type && !VALID_LEAVE_TYPES.includes(leave_type)) {
      return res.status(400).json({ error: 'Invalid leave_type' });
    }

    if (new Date(to_date) < new Date(from_date)) {
      return res.status(400).json({ error: 'to_date must be on or after from_date' });
    }

    // Trainers can only create leave for themselves
    if (req.user.role === 'trainer') {
      const { rows: tr } = await pool.query(
        'SELECT id FROM trainers WHERE id = $1 OR user_id = $1', [req.user.id]
      );
      const myTrainerId = tr.length ? tr[0].id : req.user.trainer_id;
      if (trainer_id !== myTrainerId) {
        return res.status(403).json({ error: 'You can only submit leave for yourself' });
      }
    }

    // The trainer must belong to the caller's studio. Without this an admin
    // could file leave against another studio's trainer, and the row would be
    // stamped with the CALLER's organization — a request that is invisible to
    // the studio whose trainer it is actually about.
    const trainerParams = [trainer_id];
    const trainerOrg = orgWhere(req, trainerParams, 'organization_id');
    const { rowCount: trainerOk } = await pool.query(
      'SELECT 1 FROM trainers WHERE id = $1' + trainerOrg,
      trainerParams
    );
    if (!trainerOk) return res.status(404).json({ error: 'Trainer not found' });

    // Check for overlapping pending leave
    const overlapParams = [trainer_id, 'pending', to_date, from_date];
    const overlapOrg = orgWhere(req, overlapParams);
    const { rows: overlap } = await pool.query(
      'SELECT lr.id FROM leave_requests lr WHERE lr.trainer_id = $1 AND lr.status = $2 ' +
      'AND lr.from_date <= $3 AND lr.to_date >= $4' + overlapOrg + ' LIMIT 1',
      overlapParams
    );

    if (overlap.length) {
      return res.status(409).json({ error: 'Overlapping leave request already exists' });
    }

    // Stamp the organization, or the row belongs to nobody: invisible to its
    // own studio under the filters above, and rejected outright by the NOT
    // NULL that migration 168 adds.
    const { rows } = await pool.query(
      'INSERT INTO leave_requests (trainer_id, leave_type, from_date, to_date, reason, organization_id) ' +
      'VALUES ($1, $2, $3, $4, $5, COALESCE($6, (SELECT organization_id FROM trainers WHERE id = $1))) ' +
      'RETURNING *',
      [trainer_id, leave_type || 'other', from_date, to_date, reason || '', orgIdOf(req)]
    );

    const r = rows[0];
    res.status(201).json({
      message: 'Leave request submitted',
      leave: {
        id: r.id,
        trainer_id: r.trainer_id,
        leave_type: r.leave_type,
        from_date: r.from_date,
        to_date: r.to_date,
        reason: r.reason,
        status: r.status,
        created_at: r.created_at,
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Leave create error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leave/:id/approve — approve leave
router.post('/:id/approve', auth, adminOrManager, async function(req, res) {
  try {
    const params = ['approved', req.user.id, req.body.admin_note || null, req.params.id, 'pending'];
    const orgClause = orgWhere(req, params, 'organization_id');
    const { rows } = await pool.query(
      'UPDATE leave_requests SET status = $1, approved_by = $2, approved_at = NOW(), ' +
      'admin_note = COALESCE($3, admin_note), updated_at = NOW() ' +
      'WHERE id = $4 AND status = $5' + orgClause + ' RETURNING *',
      params
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Leave request not found or already processed' });
    }

    res.json({ message: 'Leave approved', leave: rows[0] });
  } catch (err) {
    logger.error({ err: err.message }, 'Leave approve error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leave/:id/reject — reject leave
router.post('/:id/reject', auth, adminOrManager, async function(req, res) {
  try {
    const params = ['rejected', req.user.id, req.body.admin_note || null, req.params.id, 'pending'];
    const orgClause = orgWhere(req, params, 'organization_id');
    const { rows } = await pool.query(
      'UPDATE leave_requests SET status = $1, approved_by = $2, ' +
      'admin_note = COALESCE($3, admin_note), updated_at = NOW() ' +
      'WHERE id = $4 AND status = $5' + orgClause + ' RETURNING *',
      params
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Leave request not found or already processed' });
    }

    res.json({ message: 'Leave rejected', leave: rows[0] });
  } catch (err) {
    logger.error({ err: err.message }, 'Leave reject error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

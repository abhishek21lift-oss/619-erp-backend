// src/modules/members/members.service.js
// Business logic for members. Routes call into this; nothing else.

const pool = require('../../db/pool');
const { HttpError } = require('../../middleware/errorHandler');

const SAFE_FIELDS = `
  id, branch_id, member_code, user_id, name, email, phone, gender, dob, address,
  emergency_contact, emergency_phone, primary_trainer_id,
  joining_date, status, source, notes, photo_url, tags,
  created_at, updated_at
`;

/**
 * List members with filters + pagination.
 * @param {object} opts
 * @param {string} opts.role           - requesting user's role
 * @param {string} opts.trainerId      - trainer's id (if role === 'trainer')
 * @param {string} opts.memberId       - member's id (if role === 'member')
 * @param {object} opts.filters        - { status, plan, search, trainer_id }
 * @param {object} opts.page           - { page, limit, sort }
 */
async function list({ role, trainerId, memberId, filters = {}, page = {} }) {
  const limit  = Math.min(parseInt(page.limit) || 25, 100);
  const offset = ((parseInt(page.page) || 1) - 1) * limit;

  const where = [];
  const params = [];
  const push = (sql, ...vals) => { params.push(...vals); where.push(sql); };

  // Role-based scoping
  if (role === 'trainer') push(`m.primary_trainer_id = $${params.length + 1}`, trainerId);
  if (role === 'member')  push(`m.id = $${params.length + 1}`, memberId);

  if (filters.status)     push(`m.status = $${params.length + 1}`, filters.status);
  if (filters.trainer_id) push(`m.primary_trainer_id = $${params.length + 1}`, filters.trainer_id);
  if (filters.search) {
    push(`(m.name ILIKE $${params.length + 1} OR m.phone ILIKE $${params.length + 1} OR m.member_code ILIKE $${params.length + 1})`,
         `%${filters.search}%`);
  }
  if (filters.plan) {
    push(`EXISTS (SELECT 1 FROM member_memberships mm WHERE mm.member_id = m.id AND mm.plan_id = $${params.length + 1} AND mm.status = 'active')`,
         filters.plan);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, total] = await Promise.all([
    pool.query(
      `SELECT ${SAFE_FIELDS},
              v.plan_name, v.end_date, v.days_remaining, v.balance_amount,
              t.name AS trainer_name
       FROM members m
       LEFT JOIN v_member_active_membership v ON v.member_id = m.id
       LEFT JOIN trainers t ON t.id = m.primary_trainer_id
       ${whereSql}
       ORDER BY m.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query(`SELECT COUNT(*) FROM members m ${whereSql}`, params),
  ]);

  return {
    data: rows.rows,
    meta: {
      page: parseInt(page.page) || 1,
      limit,
      total: parseInt(total.rows[0].count),
      pages: Math.ceil(parseInt(total.rows[0].count) / limit),
    },
  };
}

async function getById(id, ctx) {
  const { rows } = await pool.query(
    `SELECT m.*, t.name AS trainer_name,
            v.plan_name, v.end_date, v.days_remaining, v.balance_amount
     FROM members m
     LEFT JOIN trainers t ON t.id = m.primary_trainer_id
     LEFT JOIN v_member_active_membership v ON v.member_id = m.id
     WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [id]
  );
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Member not found');

  // Authorization
  const m = rows[0];
  if (ctx.role === 'trainer' && m.primary_trainer_id !== ctx.trainer_id) {
    throw new HttpError(403, 'FORBIDDEN', 'Member not assigned to you');
  }
  if (ctx.role === 'member' && m.id !== ctx.member_id) {
    throw new HttpError(403, 'FORBIDDEN', 'Cannot view other members');
  }
  return m;
}

async function create(input, ctx) {
  // Auto-generate member_code: FS0001 style
  const codeRow = await pool.query(`SELECT COUNT(*) AS c FROM members`);
  const next = (parseInt(codeRow.rows[0].c) + 1).toString().padStart(4, '0');
  const memberCode = `FS${next}`;

  const { rows } = await pool.query(
    `INSERT INTO members
       (branch_id, member_code, name, email, phone, gender, dob, address,
        emergency_contact, emergency_phone, primary_trainer_id,
        joining_date, status, source, notes, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${SAFE_FIELDS}`,
    [
      input.branch_id || 'br-main',
      memberCode,
      input.name,
      input.email || null,
      input.phone || null,
      input.gender || null,
      input.dob || null,
      input.address || null,
      input.emergency_contact || null,
      input.emergency_phone || null,
      input.primary_trainer_id || null,
      input.joining_date || new Date(),
      input.status || 'active',
      input.source || null,
      input.notes || null,
      input.tags || null,
    ]
  );
  // Audit
  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, after) VALUES ($1,'member.create','member',$2,$3)`,
    [ctx.user_id, rows[0].id, rows[0]]
  );
  return rows[0];
}

async function update(id, patch, ctx) {
  const before = await getById(id, ctx);

  // Whitelisted columns
  const allowed = [
    'name','email','phone','gender','dob','address',
    'emergency_contact','emergency_phone','primary_trainer_id',
    'status','source','notes','photo_url','tags',
  ];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      params.push(patch[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (sets.length === 0) return before;

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE members SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING ${SAFE_FIELDS}`,
    params
  );

  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, before, after)
     VALUES ($1,'member.update','member',$2,$3,$4)`,
    [ctx.user_id, id, before, rows[0]]
  );
  return rows[0];
}

async function softDelete(id, ctx) {
  await pool.query(`UPDATE members SET deleted_at = NOW(), status='cancelled' WHERE id = $1`, [id]);
  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'member.delete','member',$2)`,
    [ctx.user_id, id]
  );
}

async function getPayments(memberId) {
  const { rows } = await pool.query(
    `SELECT id, amount, method, date, receipt_no, package_type, notes, gateway, gateway_status
     FROM payments
     WHERE member_id = $1 OR client_id = $1
     ORDER BY date DESC`,
    [memberId]
  );
  return rows;
}

async function getAttendance(memberId, { from, to } = {}) {
  const params = [memberId];
  let dateFilter = '';
  if (from) { params.push(from); dateFilter += ` AND date >= $${params.length}`; }
  if (to)   { params.push(to);   dateFilter += ` AND date <= $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT date, check_in, check_out, status, check_in_method
     FROM attendance
     WHERE (member_id = $1 OR ref_id = $1) AND type='client' ${dateFilter}
     ORDER BY date DESC LIMIT 200`,
    params
  );
  return rows;
}

async function getMetrics(memberId) {
  const { rows } = await pool.query(
    `SELECT date, weight_kg, body_fat_pct, muscle_kg, chest_cm, waist_cm, hip_cm, arm_cm, thigh_cm, bmi, notes
     FROM body_metrics WHERE member_id = $1 ORDER BY date DESC LIMIT 100`,
    [memberId]
  );
  return rows;
}

async function freezeMembership(membershipId, { reason, start_date, end_date, notes }, ctx) {
  // Insert hold record
  const { rows } = await pool.query(
    `INSERT INTO holds_freezes (membership_id, reason, start_date, end_date, approved_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [membershipId, reason, start_date, end_date, ctx.user_id, notes]
  );
  // Extend the end_date by the freeze duration
  await pool.query(
    `UPDATE member_memberships
     SET end_date = end_date + ($2::date - $3::date), status = 'frozen', updated_at = NOW()
     WHERE id = $1`,
    [membershipId, end_date, start_date]
  );
  return rows[0];
}

module.exports = {
  list, getById, create, update, softDelete,
  getPayments, getAttendance, getMetrics, freezeMembership,
};

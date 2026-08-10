// src/modules/members/members.service.js
// Business logic for members. Routes call into this; nothing else.

const pool = require('../../db/pool');
const { HttpError } = require('../../middleware/errorHandler');

/**
 * The next FS#### member code.
 *
 * This was the one borrowed-client path in the whole app that ran outside a
 * transaction, which is why db/pool.js's tenant wrapper could not scope it and
 * why it logged tenant_scope_gap. Three separate defects, fixed together
 * because the fix for each is the same shape:
 *
 *   The lock was pg_advisory_lock — SESSION scoped. Taken on a pooled
 *   connection, it is only released by the explicit unlock in the finally
 *   block; if that unlock ever failed, or the process died between the two,
 *   the lock outlived the request and every subsequent member creation
 *   blocked forever on a connection nobody could identify.
 *   pg_advisory_xact_lock releases at COMMIT or ROLLBACK, unconditionally.
 *   That is the primitive lib/subscription.js already uses in production.
 *
 *   The lock stays on one global key. Normally it would be keyed per org so
 *   two studios do not serialise against each other — lib/subscription.js
 *   keys its lock by orgId for exactly that reason — but `members` has no
 *   organization_id to key on, and a global sequence needs a global lock. It
 *   stays global until that column exists.
 *
 *   The code was derived from COUNT(*), which is not a sequence. Delete one
 *   member and the next code collides with one that already exists. MAX+1
 *   over the existing codes is what db/id-gen.js already documents as the
 *   pattern for exactly this, and it survives deletions.
 *
 * NOTE, and it is the important one: `members` carries no organization_id, so
 * this count is global and RLS does not — cannot — constrain it. That is not
 * fixed here. See MEMBERS-TENANT-GAP.md; it needs a schema decision, not a
 * code change.
 */
async function nextMemberCode(client) {
  // Serialises concurrent creates. Transaction-scoped, so the caller's COMMIT
  // or ROLLBACK releases it — and, crucially, it is still held while the
  // caller INSERTs the row that uses this code.
  await client.query('SELECT pg_advisory_xact_lock($1)', [2026052201]);
  const { rows } = await client.query(
    `SELECT member_code FROM members
      WHERE member_code ~ '^FS[0-9]+$'
      ORDER BY CAST(SUBSTRING(member_code FROM 3) AS INTEGER) DESC
      LIMIT 1`
  );
  const last = rows[0]?.member_code;
  const next = last ? parseInt(last.slice(2), 10) + 1 : 1;
  return `FS${String(next).padStart(4, '0')}`;
}

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
  // One transaction for the whole create, which is what makes the code
  // allocation actually atomic. Previously the code was generated on one
  // pooled connection, the lock was dropped, and the INSERT went out on a
  // different connection — so two concurrent creates could read the same
  // last code and both use it. Holding a transaction-scoped lock across both
  // statements is the only thing that closes that window.
  //
  // It also means db/pool.js's tenant wrapper can scope this path: it hooks
  // BEGIN, so a borrowed client that never begins a transaction can never
  // carry app.org_id. This was the last such path in the app.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const memberCode = await nextMemberCode(client);

    const { rows } = await client.query(
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
    // Audit. Previously targeted a differently-shaped legacy table and threw
    // on every call — unreached in practice (this route has no frontend
    // caller; see the members module's mount comment in server.js), which is
    // the only reason it never surfaced as a 500. Now writes the table every
    // other audited write in the app actually uses, and inside the same
    // transaction as the row it describes, so the two cannot diverge.
    await client.query(
      `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, new_data, organization_id)
       VALUES ($1,$2,'member.create','member',$3,$4,$5)`,
      [ctx.user_id, ctx.user_name || null, rows[0].id, JSON.stringify(rows[0]), ctx.organization_id || null]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
    `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, old_data, new_data, organization_id)
     VALUES ($1,$2,'member.update','member',$3,$4,$5,$6)`,
    [ctx.user_id, ctx.user_name || null, id, JSON.stringify(before), JSON.stringify(rows[0]), ctx.organization_id || null]
  );
  return rows[0];
}

async function softDelete(id, ctx) {
  await pool.query(`UPDATE members SET deleted_at = NOW(), status='cancelled' WHERE id = $1`, [id]);
  await pool.query(
    `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, organization_id)
     VALUES ($1,$2,'member.delete','member',$3,$4)`,
    [ctx.user_id, ctx.user_name || null, id, ctx.organization_id || null]
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO holds_freezes (membership_id, reason, start_date, end_date, approved_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [membershipId, reason, start_date, end_date, ctx.user_id, notes]
    );
    await client.query(
      `UPDATE member_memberships
       SET end_date = end_date + ($2::date - $3::date), status = 'frozen', updated_at = NOW()
       WHERE id = $1`,
      [membershipId, end_date, start_date]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  list, getById, create, update, softDelete,
  getPayments, getAttendance, getMetrics, freezeMembership,
};

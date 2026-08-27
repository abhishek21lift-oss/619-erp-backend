// Automation rules, communication logs, PT session balances and PT packages.
//
// ── What changed, and why every handler in this file was rewritten ──────────
//
// None of the four tables this module serves carried an organization_id until
// migration 174, and not one handler applied a tenant filter. The reads were
// the worst of it: GET /session-balance joined session_balance to pt_clients
// and returned every studio's client NAMES and MOBILE NUMBERS alongside how
// many PT sessions each had left, to any authenticated account of any role —
// including the `member` accounts the client-activation flow creates, because
// the mount in server.js carried no requireStaff either.
//
// The writes were worse in a different way. POST /session-balance/:id/use
// decremented any balance row on the platform by id, which is a studio's sold
// inventory; DELETE /pt-packages/:id removed another studio's product
// catalogue.
//
// So: every statement below is scoped with orgWhere(), every insert stamps
// orgIdOf(), and every handler that accepts a client_id from the request runs
// it through clientInOrg() first — stamping the caller's org onto a row that
// points at a foreign client would otherwise just move the problem.
const router = require('express').Router();
const pool = require('../../db/pool');
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { orgWhere, orgIdOf } = require('../../lib/tenant-db');
const { clientInOrg } = require('../../lib/orgGuard');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const notFound = (res, what) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `${what} not found` } });

// ── Automation rules ────────────────────────────────────────────────────────

router.get('/rules', auth, wrap(async (req, res) => {
  const { trigger_event, is_active } = req.query;
  const params = [];
  const org = orgWhere(req, params, 'ar.organization_id');
  const where = [];
  if (trigger_event) { params.push(trigger_event); where.push(`ar.trigger_event = $${params.length}`); }
  if (is_active !== undefined) { params.push(is_active === 'true'); where.push(`ar.is_active = $${params.length}`); }
  const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT ar.*, u.name AS created_by_name FROM automation_rules ar
     LEFT JOIN users u ON u.id = ar.created_by
     WHERE 1=1${org}${extra} ORDER BY ar.created_at DESC`, params
  );
  res.json({ data: rows });
}));

router.post('/rules', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { name, trigger_event, channel, template, delay_minutes } = req.body;
  if (!name?.trim() || !trigger_event || !template?.trim()) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'name, trigger_event, and template are required' } });
  }
  const { rows } = await pool.query(
    `INSERT INTO automation_rules (name, trigger_event, channel, template, delay_minutes, created_by, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name.trim(), trigger_event, channel || 'whatsapp', template, parseInt(delay_minutes) || 0, req.user.id, orgIdOf(req)]
  );
  return res.status(201).json({ data: rows[0] });
}));

router.patch('/rules/:id', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const allowed = ['name','trigger_event','channel','template','delay_minutes','is_active'];
  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE automation_rules SET ${sets.join(', ')} WHERE id = $1${org} RETURNING *`, params
  );
  // 404 rather than 403 on another studio's rule: the response must not
  // confirm the id exists elsewhere.
  if (!rows[0]) return notFound(res, 'Rule');
  return res.json({ data: rows[0] });
}));

router.delete('/rules/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  const params = [req.params.id];
  const org = orgWhere(req, params);
  const { rowCount } = await pool.query(
    `DELETE FROM automation_rules WHERE id = $1${org}`, params
  );
  if (rowCount === 0) return notFound(res, 'Rule');
  return res.status(204).end();
}));

// ── Communication logs ──────────────────────────────────────────────────────

router.get('/communication-logs', auth, wrap(async (req, res) => {
  const { channel, status, recipient_type, recipient_id, limit, offset } = req.query;
  const params = [];
  const org = orgWhere(req, params);
  const where = [];
  if (channel) { params.push(channel); where.push(`channel = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (recipient_type) { params.push(recipient_type); where.push(`recipient_type = $${params.length}`); }
  if (recipient_id) { params.push(recipient_id); where.push(`recipient_id = $${params.length}`); }
  const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  // The count runs on the filter params only — the two LIMIT/OFFSET values are
  // appended after this slice point, so the count query must not see them.
  const filterParams = params.slice();
  params.push(lim, off);

  const { rows } = await pool.query(
    `SELECT * FROM communication_logs WHERE 1=1${org}${extra}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params
  );
  const { rows: [{ total }] } = await pool.query(
    `SELECT COUNT(*)::INT AS total FROM communication_logs WHERE 1=1${org}${extra}`, filterParams
  );
  res.json({ data: rows, total });
}));

router.get('/communication-logs/stats', auth, wrap(async (req, res) => {
  const params = [];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::INT AS total,
      COUNT(*) FILTER (WHERE status = 'sent')::INT AS sent,
      COUNT(*) FILTER (WHERE status = 'delivered')::INT AS delivered,
      COUNT(*) FILTER (WHERE status = 'read')::INT AS read,
      COUNT(*) FILTER (WHERE status = 'failed')::INT AS failed,
      COUNT(*) FILTER (WHERE channel = 'whatsapp')::INT AS whatsapp,
      COUNT(*) FILTER (WHERE channel = 'sms')::INT AS sms,
      COUNT(*) FILTER (WHERE channel = 'email')::INT AS email
    FROM communication_logs
    WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'${org}
  `, params);
  res.json({ data: rows[0] });
}));

// ── PT session balances ─────────────────────────────────────────────────────

router.get('/session-balance', auth, wrap(async (req, res) => {
  const { client_id, status, low_balance } = req.query;
  const params = [];
  const org = orgWhere(req, params, 'sb.organization_id');
  const where = [];
  if (client_id) { params.push(client_id); where.push(`sb.client_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`sb.status = $${params.length}`); }
  if (low_balance === 'true') { where.push("sb.remaining_sessions <= 3 AND sb.status = 'active'"); }
  const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT sb.*, c.name AS client_name, c.mobile AS client_mobile
     FROM session_balance sb JOIN pt_clients c ON c.id = sb.client_id
     WHERE 1=1${org}${extra}
     ORDER BY sb.remaining_sessions ASC, sb.end_date ASC`, params
  );
  res.json({ data: rows });
}));

router.post('/session-balance', auth, wrap(async (req, res) => {
  const { client_id, total_sessions, package_name, start_date, end_date } = req.body;
  if (!client_id || !total_sessions) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'client_id and total_sessions are required' } });
  }
  // The client id comes from the request body, so it is checked against the
  // caller's studio before a row is stamped with that studio's org.
  if (!await clientInOrg(req, client_id)) return notFound(res, 'Client');
  const { rows } = await pool.query(
    `INSERT INTO session_balance (client_id, total_sessions, used_sessions, package_name, start_date, end_date, organization_id)
     VALUES ($1,$2,0,$3,$4,$5,$6) RETURNING *`,
    [client_id, parseInt(total_sessions), package_name || null, start_date || new Date().toISOString().split('T')[0], end_date || null, orgIdOf(req)]
  );
  return res.status(201).json({ data: rows[0] });
}));

router.post('/session-balance/:id/use', auth, wrap(async (req, res) => {
  const params = [req.params.id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE session_balance SET used_sessions = used_sessions + 1, updated_at = NOW()
     WHERE id = $1${org} AND used_sessions < total_sessions AND status = 'active' RETURNING *`,
    params
  );
  // Kept as one statement rather than a read-then-write: the increment has to
  // be atomic, and splitting it to distinguish "not yours" from "exhausted"
  // would open a double-spend window on a studio's sold sessions. The message
  // stays deliberately vague for the same reason it is a 400 — it must not
  // reveal whether the id belongs to another studio.
  if (!rows[0]) return res.status(400).json({ error: { code: 'BALANCE_EXHAUSTED', message: 'No sessions remaining' } });
  return res.json({ data: rows[0] });
}));

// ── PT packages ─────────────────────────────────────────────────────────────

router.get('/pt-packages', auth, wrap(async (req, res) => {
  const { goal_type, is_active } = req.query;
  const params = [];
  const org = orgWhere(req, params);
  const where = [];
  if (goal_type) { params.push(goal_type); where.push(`goal_type = $${params.length}`); }
  if (is_active !== undefined) { params.push(is_active === 'true'); where.push(`is_active = $${params.length}`); }
  const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM pt_packages WHERE 1=1${org}${extra} ORDER BY price ASC`, params
  );
  res.json({ data: rows });
}));

router.post('/pt-packages', auth, requireRole('admin'), wrap(async (req, res) => {
  const { name, session_count, duration_days, price, goal_type, description } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO pt_packages (name, session_count, duration_days, price, goal_type, description, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, parseInt(session_count), parseInt(duration_days), parseFloat(price), goal_type || null, description || null, orgIdOf(req)]
    );
    return res.status(201).json({ data: rows[0] });
  } catch (err) {
    // pt_packages.name was UNIQUE across the whole platform until migration
    // 174 made it unique per studio, so this now means "you already have one
    // by that name" rather than "some other studio does".
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'DUPLICATE', message: 'You already have a package with this name' } });
    }
    throw err;
  }
}));

router.patch('/pt-packages/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  const allowed = ['name','session_count','duration_days','price','goal_type','description','is_active'];
  const sets = []; const params = [req.params.id];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: { code: 'NO_FIELDS' } });
  sets.push('updated_at = NOW()');
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `UPDATE pt_packages SET ${sets.join(', ')} WHERE id = $1${org} RETURNING *`, params
  );
  if (!rows[0]) return notFound(res, 'Package');
  return res.json({ data: rows[0] });
}));

router.delete('/pt-packages/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  const params = [req.params.id];
  const org = orgWhere(req, params);
  const { rows } = await pool.query(
    `DELETE FROM pt_packages WHERE id = $1${org} RETURNING id`, params
  );
  if (!rows.length) return notFound(res, 'Package');
  return res.json({ data: { id: rows[0].id } });
}));

module.exports = router;

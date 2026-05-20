const pool = require('../../db/pool');
const { HttpError } = require('../../middleware/errorHandler');

function ctx(req) {
  return {
    user_id: req.user.id,
    role: req.user.role,
    trainer_id: req.user.trainer_id,
    member_id: req.user.member_id,
  };
}

async function dashboard(userCtx) {
  const { role, trainer_id } = userCtx;
  const isTrainer = role === 'trainer' && trainer_id;
  const tf = (col) => isTrainer ? ` AND ${col} = '${trainer_id}'` : '';

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const queries = {
    overview: pool.query(`
      SELECT
        (SELECT COUNT(*) FROM pt_os_assignments WHERE status = 'active'${tf('trainer_id')}) AS active_clients,
        (SELECT COUNT(*) FROM pt_os_sessions WHERE status = 'scheduled' AND scheduled_at >= $1::timestamptz) AS upcoming_sessions,
        (SELECT COUNT(*) FROM pt_os_sessions WHERE status = 'completed' AND created_at >= $1::timestamptz${tf('trainer_id')}) AS completed_sessions_month,
        (SELECT COALESCE(SUM(amount),0) FROM pt_os_payments WHERE status = 'completed' AND created_at >= $1::timestamptz) AS revenue_month,
        (SELECT COALESCE(SUM(amount),0) FROM pt_os_payments WHERE status = 'completed') AS revenue_total,
        (SELECT COUNT(*) FROM pt_os_assignments WHERE status IN ('active','completed')${tf('trainer_id')}) AS total_assignments
    `,
      [monthStart]
    ),
    revenue_trend: pool.query(`
      SELECT
        TO_CHAR(date_trunc('month', created_at), 'Mon') AS month,
        TO_CHAR(date_trunc('month', created_at), 'YYYY-MM') AS month_key,
        EXTRACT(MONTH FROM created_at)::INT AS m,
        EXTRACT(YEAR FROM created_at)::INT AS y,
        COALESCE(SUM(amount),0) AS revenue
      FROM pt_os_payments
      WHERE status = 'completed'
        AND created_at >= date_trunc('month', NOW()) - INTERVAL '5 months'
      GROUP BY date_trunc('month', created_at)
      ORDER BY date_trunc('month', created_at)
    `),
    package_distribution: pool.query(`
      SELECT p.type, COUNT(*) AS count, COALESCE(SUM(a.final_amount),0) AS revenue
      FROM pt_os_assignments a
      JOIN pt_os_packages p ON p.id = a.package_id
      WHERE a.status = 'active'${tf('a.trainer_id')}
      GROUP BY p.type ORDER BY count DESC
    `),
    session_stats: pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'missed') AS missed,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled,
        COUNT(*) AS total
      FROM pt_os_sessions
      WHERE created_at >= date_trunc('month', NOW())${tf('trainer_id')}
    `),
    trainer_leaderboard: pool.query(`
      SELECT
        t.id, t.name, t.photo_url,
        COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'active') AS active_clients,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'completed' AND s.created_at >= date_trunc('month', NOW())) AS sessions_month,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'approved'), 0) AS earnings_total,
        COALESCE(AVG(a.health_score) FILTER (WHERE a.status = 'active'), 0)::INT AS avg_health_score,
        COALESCE(AVG(a.adherence_pct) FILTER (WHERE a.status = 'active'), 0)::DECIMAL(5,1) AS avg_adherence
      FROM trainers t
      LEFT JOIN pt_os_assignments a ON a.trainer_id = t.id
      LEFT JOIN pt_os_sessions s ON s.trainer_id = t.id
      LEFT JOIN pt_os_earnings e ON e.trainer_id = t.id
      WHERE t.deleted_at IS NULL${isTrainer ? ` AND t.id = '${trainer_id}'` : ''}
      GROUP BY t.id, t.name, t.photo_url
      ORDER BY sessions_month DESC NULLS LAST
      LIMIT 10
    `),
    recent_activity: pool.query(`
      SELECT e.*, c.name AS client_name, t.name AS trainer_name
      FROM pt_os_coaching_events e
      LEFT JOIN clients c ON c.id = e.client_id
      LEFT JOIN trainers t ON t.id = e.trainer_id
      WHERE 1=1${tf('e.trainer_id')}
      ORDER BY e.occurred_at DESC LIMIT 20
    `),
    alerts: pool.query(`
      SELECT 'expiring' AS type, a.id, c.name AS client_name, t.name AS trainer_name,
             a.end_date, (a.end_date - CURRENT_DATE) AS days_left
      FROM pt_os_assignments a
      JOIN clients c ON c.id = a.client_id
      LEFT JOIN trainers t ON t.id = a.trainer_id
      WHERE a.status = 'active' AND a.end_date IS NOT NULL
        AND a.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'${tf('a.trainer_id')}
      UNION ALL
      SELECT 'overdue' AS type, p.id, c.name AS client_name, NULL AS trainer_name,
             p.due_date AS end_date, (CURRENT_DATE - p.due_date) AS days_left
      FROM pt_os_payments p
      JOIN pt_os_assignments a ON a.id = p.assignment_id
      JOIN clients c ON c.id = p.client_id
      WHERE p.status = 'pending' AND p.due_date < CURRENT_DATE${tf('a.trainer_id')}
      ORDER BY days_left LIMIT 10
    `),
    insights: pool.query(`
      SELECT i.*, c.name AS client_name
      FROM pt_os_ai_insights i
      LEFT JOIN clients c ON c.id = i.client_id
      WHERE NOT dismissed${tf('i.trainer_id')}
      ORDER BY i.severity DESC, i.confidence DESC NULLS LAST, i.created_at DESC
      LIMIT 10
    `),
    retention: pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        COUNT(*) FILTER (WHERE status = 'expired') AS expired
      FROM pt_os_assignments
      WHERE 1=1${tf('trainer_id')}
    `),
  };

  const results = await Promise.all(Object.values(queries));
  const keys = Object.keys(queries);
  const data = {};
  keys.forEach((k, i) => { data[k] = results[i].rows; });

  return {
    overview: data.overview[0],
    revenue_trend: data.revenue_trend,
    package_distribution: data.package_distribution,
    session_stats: data.session_stats[0],
    trainer_leaderboard: data.trainer_leaderboard,
    recent_activity: data.recent_activity,
    alerts: data.alerts,
    insights: data.insights,
    retention: data.retention[0],
  };
}

async function listClients({ role, trainerId, filters = {}, page = {} }) {
  const limit  = Math.min(parseInt(page.limit) || 25, 100);
  const offset = ((parseInt(page.page) || 1) - 1) * limit;

  const where = [];
  const params = [];
  const push = (sql, ...vals) => { params.push(...vals); where.push(sql); };

  if (role === 'trainer' && trainerId) push(`a.trainer_id = $${params.length + 1}`, trainerId);
  if (filters.search) {
    push(`(c.name ILIKE $${params.length + 1} OR c.mobile ILIKE $${params.length + 1})`, `%${filters.search}%`);
  }
  if (filters.status) push(`a.status = $${params.length + 1}`, filters.status);
  if (filters.trainer_id) push(`a.trainer_id = $${params.length + 1}`, filters.trainer_id);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, total] = await Promise.all([
    pool.query(`
      SELECT DISTINCT ON (c.id)
        c.id, c.name, c.mobile, c.email, c.gender, c.photo_url, c.status AS client_status,
        a.id AS assignment_id, a.status AS assignment_status,
        a.sessions_total, a.sessions_used,
        (a.sessions_total - a.sessions_used) AS sessions_remaining,
        a.start_date, a.end_date, a.health_score, a.adherence_pct,
        a.final_amount, a.amount,
        t.id AS trainer_id, t.name AS trainer_name,
        p.name AS package_name, p.type AS package_type,
        (SELECT COUNT(*) FROM pt_os_sessions s WHERE s.client_id = c.id AND s.status = 'completed') AS total_sessions,
        (SELECT MAX(s.scheduled_at) FROM pt_os_sessions s WHERE s.client_id = c.id AND s.status = 'completed') AS last_session
      FROM clients c
      JOIN pt_os_assignments a ON a.client_id = c.id
      LEFT JOIN trainers t ON t.id = a.trainer_id
      LEFT JOIN pt_os_packages p ON p.id = a.package_id
      ${whereSql}
      ORDER BY c.id, a.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]),
    pool.query(`
      SELECT COUNT(DISTINCT c.id)
      FROM clients c
      JOIN pt_os_assignments a ON a.client_id = c.id
      ${whereSql}
    `, params),
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

async function getClient(id, userCtx) {
  const client = (await pool.query(`
    SELECT c.*,
      a.id AS assignment_id, a.status AS assignment_status,
      a.sessions_total, a.sessions_used,
      (a.sessions_total - a.sessions_used) AS sessions_remaining,
      a.start_date, a.end_date, a.health_score, a.adherence_pct,
      a.final_amount, a.amount, a.discount, a.notes AS assignment_notes,
      a.created_at AS assignment_created_at,
      t.id AS trainer_id, t.name AS trainer_name, t.mobile AS trainer_mobile,
      t.photo_url AS trainer_photo, t.specialization AS trainer_specialization,
      p.id AS package_id, p.name AS package_name, p.type AS package_type,
      p.sessions AS package_sessions, p.duration_days, p.commission_pct
    FROM clients c
    LEFT JOIN pt_os_assignments a ON a.client_id = c.id
    LEFT JOIN trainers t ON t.id = a.trainer_id
    LEFT JOIN pt_os_packages p ON p.id = a.package_id
    WHERE c.id = $1
    ORDER BY a.created_at DESC LIMIT 1
  `, [id])).rows[0];

  if (!client) throw new HttpError(404, 'NOT_FOUND', 'Client not found');

  if (userCtx.role === 'trainer' && client.trainer_id !== userCtx.trainer_id) {
    throw new HttpError(403, 'FORBIDDEN', 'Client not assigned to you');
  }

  const [sessions, measurements, payments, events, insights] = await Promise.all([
    pool.query(`
      SELECT * FROM pt_os_sessions WHERE client_id = $1
      ORDER BY scheduled_at DESC LIMIT 20
    `, [id]),
    pool.query(`
      SELECT * FROM pt_os_measurements WHERE client_id = $1
      ORDER BY measured_at DESC LIMIT 10
    `, [id]),
    pool.query(`
      SELECT * FROM pt_os_payments WHERE client_id = $1
      ORDER BY created_at DESC LIMIT 20
    `, [id]),
    pool.query(`
      SELECT e.*, t.name AS trainer_name
      FROM pt_os_coaching_events e
      LEFT JOIN trainers t ON t.id = e.trainer_id
      WHERE e.client_id = $1
      ORDER BY e.occurred_at DESC LIMIT 30
    `, [id]),
    pool.query(`
      SELECT * FROM pt_os_ai_insights WHERE client_id = $1 AND NOT dismissed
      ORDER BY created_at DESC LIMIT 10
    `, [id]),
  ]);

  return {
    ...client,
    sessions: sessions.rows,
    measurements: measurements.rows,
    payments: payments.rows,
    events: events.rows,
    insights: insights.rows,
  };
}

async function listTrainers({ role, trainerId, filters = {}, page = {} }) {
  const limit  = Math.min(parseInt(page.limit) || 25, 100);
  const offset = ((parseInt(page.page) || 1) - 1) * limit;

  const where = [];
  const params = [];
  const push = (sql, ...vals) => { params.push(...vals); where.push(sql); };

  if (filters.search) {
    push(`(t.name ILIKE $${params.length + 1} OR t.mobile ILIKE $${params.length + 1})`, `%${filters.search}%`);
  }
  if (filters.status) push(`t.status = $${params.length + 1}`, filters.status);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, total] = await Promise.all([
    pool.query(`
      SELECT
        t.id, t.name, t.email, t.mobile, t.specialization, t.bio,
        t.photo_url, t.status, t.joining_date, t.incentive_rate,
        COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'active') AS active_clients,
        COUNT(DISTINCT a.id) AS total_assignments,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'completed') AS completed_sessions,
        COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'completed' AND s.created_at >= date_trunc('month', NOW())) AS sessions_this_month,
        COALESCE(AVG(a.health_score) FILTER (WHERE a.status = 'active'), 0)::INT AS avg_health_score,
        COALESCE(AVG(a.adherence_pct) FILTER (WHERE a.status = 'active'), 0)::DECIMAL(5,1) AS avg_adherence,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'approved'), 0) AS total_earnings,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'approved' AND e.created_at >= date_trunc('month', NOW())), 0) AS earnings_this_month
      FROM trainers t
      LEFT JOIN pt_os_assignments a ON a.trainer_id = t.id
      LEFT JOIN pt_os_sessions s ON s.trainer_id = t.id
      LEFT JOIN pt_os_earnings e ON e.trainer_id = t.id
      WHERE t.deleted_at IS NULL
      ${whereSql}
      GROUP BY t.id
      ORDER BY active_clients DESC NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]),
    pool.query(`
      SELECT COUNT(*) FROM trainers t WHERE t.deleted_at IS NULL ${where ? 'AND ' + where.join(' AND ') : ''}
    `, params),
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

async function getTrainer(id, userCtx) {
  const trainer = (await pool.query(`
    SELECT
      t.*,
      COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'active') AS active_clients,
      COUNT(DISTINCT a.id) AS total_assignments,
      COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'completed') AS completed_sessions,
      COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'completed' AND s.created_at >= date_trunc('month', NOW())) AS sessions_this_month,
      COALESCE(AVG(a.health_score) FILTER (WHERE a.status = 'active'), 0)::INT AS avg_health_score,
      COALESCE(AVG(a.adherence_pct) FILTER (WHERE a.status = 'active'), 0)::DECIMAL(5,1) AS avg_adherence,
      COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'approved'), 0) AS total_earnings,
      COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'approved' AND e.created_at >= date_trunc('month', NOW())), 0) AS earnings_this_month
    FROM trainers t
    LEFT JOIN pt_os_assignments a ON a.trainer_id = t.id
    LEFT JOIN pt_os_sessions s ON s.trainer_id = t.id
    LEFT JOIN pt_os_earnings e ON e.trainer_id = t.id
    WHERE t.id = $1 AND t.deleted_at IS NULL
    GROUP BY t.id
  `, [id])).rows[0];

  if (!trainer) throw new HttpError(404, 'NOT_FOUND', 'Trainer not found');

  const [clients, earnings, sessions] = await Promise.all([
    pool.query(`
      SELECT c.id, c.name, c.mobile, c.photo_url, c.status,
        a.id AS assignment_id, a.health_score, a.adherence_pct,
        a.sessions_total, a.sessions_used,
        (a.sessions_total - a.sessions_used) AS sessions_remaining,
        a.start_date, a.end_date, a.status AS assignment_status,
        p.name AS package_name, p.type AS package_type
      FROM pt_os_assignments a
      JOIN clients c ON c.id = a.client_id
      LEFT JOIN pt_os_packages p ON p.id = a.package_id
      WHERE a.trainer_id = $1
      ORDER BY a.created_at DESC
    `, [id]),
    pool.query(`
      SELECT DATE_TRUNC('month', created_at)::DATE AS month,
        SUM(amount) FILTER (WHERE type = 'commission') AS commission,
        SUM(amount) FILTER (WHERE type = 'incentive') AS incentive,
        SUM(amount) FILTER (WHERE type = 'bonus') AS bonus,
        SUM(amount) AS total
      FROM pt_os_earnings
      WHERE trainer_id = $1 AND status = 'approved'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC LIMIT 12
    `, [id]),
    pool.query(`
      SELECT s.*, c.name AS client_name
      FROM pt_os_sessions s
      JOIN clients c ON c.id = s.client_id
      WHERE s.trainer_id = $1
      ORDER BY s.scheduled_at DESC LIMIT 20
    `, [id]),
  ]);

  return {
    ...trainer,
    clients: clients.rows,
    earnings: earnings.rows,
    sessions: sessions.rows,
  };
}

async function listSessions({ role, trainerId, memberId, filters = {} }) {
  const where = [];
  const params = [];

  if (role === 'trainer' && trainerId) { params.push(trainerId); where.push(`s.trainer_id = $${params.length}`); }
  if (filters.client_id) { params.push(filters.client_id); where.push(`s.client_id = $${params.length}`); }
  if (filters.trainer_id && role !== 'trainer') { params.push(filters.trainer_id); where.push(`s.trainer_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); where.push(`s.status = $${params.length}`); }
  if (filters.from) { params.push(filters.from); where.push(`s.scheduled_at >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); where.push(`s.scheduled_at <= $${params.length}`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(`
    SELECT s.*, c.name AS client_name, c.mobile AS client_mobile, c.photo_url AS client_photo,
      t.name AS trainer_name, t.photo_url AS trainer_photo,
      a.package_name
    FROM pt_os_sessions s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN trainers t ON t.id = s.trainer_id
    LEFT JOIN pt_os_active_assignments a ON a.assignment_id = s.assignment_id
    ${whereSql}
    ORDER BY s.scheduled_at DESC LIMIT 100
  `, params);

  return { data: rows };
}

async function getSession(id) {
  const session = (await pool.query(`
    SELECT s.*, c.name AS client_name, c.mobile AS client_mobile, c.photo_url AS client_photo,
      t.name AS trainer_name, t.email AS trainer_email, t.photo_url AS trainer_photo
    FROM pt_os_sessions s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN trainers t ON t.id = s.trainer_id
    WHERE s.id = $1
  `, [id])).rows[0];

  if (!session) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
  return session;
}

async function financeSummary() {
  const [revenue, trainerEarnings, pending, trend, paymentMethods] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed' AND created_at >= date_trunc('month', NOW())), 0) AS revenue_month,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed' AND created_at >= date_trunc('year', NOW())), 0) AS revenue_year,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS revenue_total,
        COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_total,
        COUNT(*) FILTER (WHERE status = 'completed' AND created_at >= date_trunc('month', NOW())) AS tx_count_month
      FROM pt_os_payments
    `),
    pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS paid_total,
        COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_payout
      FROM pt_os_earnings
    `),
    pool.query(`
      SELECT p.*, c.name AS client_name
      FROM pt_os_payments p
      JOIN clients c ON c.id = p.client_id
      WHERE p.status = 'pending' AND p.due_date IS NOT NULL
      ORDER BY p.due_date LIMIT 20
    `),
    pool.query(`
      SELECT DATE_TRUNC('month', created_at)::DATE AS month,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS revenue,
        COUNT(*) FILTER (WHERE status = 'completed') AS tx_count
      FROM pt_os_payments
      WHERE created_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month
    `),
    pool.query(`
      SELECT payment_method, COUNT(*) AS count, SUM(amount) AS total
      FROM pt_os_payments WHERE status = 'completed'
      GROUP BY payment_method ORDER BY count DESC
    `),
  ]);

  return {
    summary: revenue.rows[0],
    earnings: trainerEarnings.rows[0],
    pending_payments: pending.rows,
    trend: trend.rows,
    payment_methods: paymentMethods.rows,
  };
}

async function analyticsSummary() {
  const [retention, healthDist, adherenceDist, sessionsByType, topPackages] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status IN ('cancelled','expired','refunded')) AS churned,
        ROUND(COUNT(*) FILTER (WHERE status = 'active') * 100.0 / NULLIF(COUNT(*), 0), 1) AS retention_rate
      FROM pt_os_assignments
    `),
    pool.query(`
      SELECT health_label, COUNT(*) AS count
      FROM pt_os_client_health
      GROUP BY health_label ORDER BY count DESC
    `),
    pool.query(`
      SELECT
        CASE
          WHEN adherence_pct >= 80 THEN '80-100%'
          WHEN adherence_pct >= 60 THEN '60-80%'
          WHEN adherence_pct >= 40 THEN '40-60%'
          ELSE '0-40%'
        END AS range,
        COUNT(*) AS count
      FROM pt_os_assignments WHERE status = 'active' AND adherence_pct IS NOT NULL
      GROUP BY range ORDER BY range DESC
    `),
    pool.query(`
      SELECT session_type, COUNT(*) AS count
      FROM pt_os_sessions WHERE status = 'completed'
      GROUP BY session_type ORDER BY count DESC
    `),
    pool.query(`
      SELECT p.name, p.type, COUNT(*) AS assignments, SUM(a.final_amount) AS revenue
      FROM pt_os_assignments a
      JOIN pt_os_packages p ON p.id = a.package_id
      GROUP BY p.name, p.type ORDER BY revenue DESC LIMIT 10
    `),
  ]);

  return {
    retention: retention.rows[0],
    health_distribution: healthDist.rows,
    adherence_distribution: adherenceDist.rows,
    sessions_by_type: sessionsByType.rows,
    top_packages: topPackages.rows,
  };
}

async function listInsights({ dismissed = false, limit = 20 } = {}) {
  const { rows } = await pool.query(`
    SELECT i.*, c.name AS client_name, t.name AS trainer_name
    FROM pt_os_ai_insights i
    LEFT JOIN clients c ON c.id = i.client_id
    LEFT JOIN trainers t ON t.id = i.trainer_id
    WHERE i.dismissed = $1
    ORDER BY i.severity DESC, i.confidence DESC NULLS LAST, i.created_at DESC
    LIMIT $2
  `, [dismissed, limit]);
  return { data: rows };
}

async function dismissInsight(id) {
  const { rows } = await pool.query(
    `UPDATE pt_os_ai_insights SET dismissed = TRUE, dismissed_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Insight not found');
  return rows[0];
}

async function listActivity({ limit = 30 } = {}) {
  const { rows } = await pool.query(`
    SELECT e.*, c.name AS client_name, t.name AS trainer_name
    FROM pt_os_coaching_events e
    LEFT JOIN clients c ON c.id = e.client_id
    LEFT JOIN trainers t ON t.id = e.trainer_id
    ORDER BY e.occurred_at DESC LIMIT $1
  `, [limit]);
  return { data: rows };
}

module.exports = {
  ctx, dashboard,
  listClients, getClient,
  listTrainers, getTrainer,
  listSessions, getSession,
  financeSummary, analyticsSummary,
  listInsights, dismissInsight,
  listActivity,
};

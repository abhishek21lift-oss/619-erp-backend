// src/routes/renewals.js — Renewal Analytics & Pipeline
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const logger = require('../lib/logger');

// GET /api/renewals/pipeline — Members up for renewal with risk data
router.get('/pipeline', auth, async (req, res, next) => {
  try {
    const { status, search, days = 30 } = req.query;
    const conds = ['c.deleted_at IS NULL'];
    const params = [];
    let p = 1;

    // Active members expiring within N days
    conds.push(`c.status = 'active'`);
    conds.push(`c.pt_end_date IS NOT NULL`);
    conds.push(`c.pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $${p++}::int`);
    params.push(parseInt(days));

    // Trainer scoping
    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conds.push(`c.trainer_id = $${p++}`);
      params.push(req.user.trainer_id);
    }

    if (search) {
      conds.push(`(c.name ILIKE $${p} OR c.mobile ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }

    // Status filter maps to renewal risk levels
    if (status && status !== 'all') {
      if (status === 'at-risk') {
        conds.push(`(c.balance_amount > 0 OR c.pt_end_date <= CURRENT_DATE + 7)`);
      } else if (status === 'expired') {
        conds.push(`c.pt_end_date < CURRENT_DATE`);
      } else if (status === 'auto-renew') {
        // Members with auto-renewal flag (using balance_amount = 0 as proxy)
        conds.push(`c.balance_amount <= 0`);
      }
    }

    const { rows } = await pool.query(`
      SELECT
        c.id, c.name, c.mobile, c.email, c.package_type AS plan,
        c.pt_end_date AS expiry_date,
        c.pt_start_date,
        c.base_amount, c.discount, c.final_amount, c.paid_amount, c.balance_amount,
        c.trainer_id, c.trainer_name AS coach,
        c.photo_url,
        c.status,
        (c.pt_end_date - CURRENT_DATE)::int AS days_left,
        CASE
          WHEN c.balance_amount > 0 THEN 'at-risk'
          WHEN c.pt_end_date <= CURRENT_DATE THEN 'expired'
          WHEN c.pt_end_date <= CURRENT_DATE + 7 THEN 'pending'
          ELSE 'active'
        END AS renewal_status,
        -- Simple churn risk scoring
        GREATEST(0, LEAST(100,
          CASE WHEN c.balance_amount > 0 THEN 30 ELSE 0 END +
          CASE WHEN c.pt_end_date <= CURRENT_DATE THEN 40 ELSE 0 END +
          CASE WHEN c.pt_end_date <= CURRENT_DATE + 3 THEN 15 ELSE 0 END +
          CASE WHEN (SELECT COUNT(*) FROM attendance_logs al WHERE al.ref_id = c.id AND al.date >= CURRENT_DATE - 30) < 5 THEN 15 ELSE 0 END
        ))::int AS risk_score
      FROM clients c
      WHERE ${conds.join(' AND ')}
      ORDER BY c.pt_end_date ASC, c.name
      LIMIT 200`,
      params
    );

    // Stats
    const { rows: stats } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE pt_end_date = CURRENT_DATE)::int AS expiring_today,
        COUNT(*) FILTER (WHERE pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND balance_amount <= 0)::int AS likely_to_renew,
        COUNT(*) FILTER (WHERE balance_amount > 0 AND pt_end_date <= CURRENT_DATE + 7)::int AS high_value_at_risk,
        COUNT(*) FILTER (WHERE balance_amount <= 0)::int AS auto_renewals,
        COUNT(*)::int AS total_pipeline
      FROM clients
      WHERE deleted_at IS NULL
        AND status = 'active'
        AND pt_end_date IS NOT NULL
        AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int`,
      [parseInt(days)]
    );

    res.json({ members: rows, stats: stats[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals/churn-alerts — High-risk members
router.get('/churn-alerts', auth, async (req, res, next) => {
  try {
    const conds = ['c.deleted_at IS NULL', 'c.status = \'active\''];
    const params = [];
    let p = 1;

    if (req.user.role === 'trainer' && req.user.trainer_id) {
      conds.push(`c.trainer_id = $${p++}`);
      params.push(req.user.trainer_id);
    }

    const { rows } = await pool.query(`
      SELECT
        c.id, c.name, c.mobile, c.email, c.package_type AS plan,
        c.pt_end_date, c.balance_amount, c.trainer_name AS coach,
        c.pt_end_date - CURRENT_DATE AS days_left,
        GREATEST(0, LEAST(100,
          CASE WHEN c.balance_amount > 0 THEN 30 ELSE 0 END +
          CASE WHEN c.pt_end_date <= CURRENT_DATE + 3 THEN 25 ELSE 0 END +
          CASE WHEN (SELECT COUNT(*) FROM attendance_logs al WHERE al.ref_id = c.id AND al.date >= CURRENT_DATE - 30) < 3 THEN 25 ELSE 0 END +
          CASE WHEN c.pt_end_date <= CURRENT_DATE THEN 20 ELSE 0 END
        ))::int AS risk_score,
        CASE
          WHEN (SELECT COUNT(*) FROM attendance_logs al WHERE al.ref_id = c.id AND al.date >= CURRENT_DATE - 30) < 3 THEN 'Low attendance - member at risk of churn'
          WHEN c.balance_amount > 5000 THEN 'Outstanding balance of ₹' || c.balance_amount || ' may cause churn'
          WHEN c.pt_end_date <= CURRENT_DATE + 3 THEN 'Membership expiring in ' || (c.pt_end_date - CURRENT_DATE)::text || ' days - prompt renewal'
          ELSE 'Member showing early churn signals'
        END AS reason,
        CASE
          WHEN (SELECT COUNT(*) FROM attendance_logs al WHERE al.ref_id = c.id AND al.date >= CURRENT_DATE - 30) < 3 THEN 'Schedule a check-in call and offer a complimentary session'
          WHEN c.balance_amount > 5000 THEN 'Send payment reminder with flexible EMI options'
          WHEN c.pt_end_date <= CURRENT_DATE + 3 THEN 'Send personalised renewal offer with loyalty discount'
          ELSE 'Reach out with a personalised fitness assessment offer'
        END AS suggested_action
      FROM clients c
      WHERE ${conds.join(' AND ')}
        AND (
          c.balance_amount > 0
          OR c.pt_end_date <= CURRENT_DATE + 7
          OR (SELECT COUNT(*) FROM attendance_logs al WHERE al.ref_id = c.id AND al.date >= CURRENT_DATE - 30) < 3
        )
      ORDER BY risk_score DESC, c.pt_end_date ASC
      LIMIT 20`,
      params
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/renewals/insights — AI retention insights
router.get('/insights', auth, async (req, res, next) => {
  try {
    const { rows: stats } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS expiring_30d,
        COUNT(*) FILTER (WHERE pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS expiring_7d,
        COUNT(*) FILTER (WHERE pt_end_date = CURRENT_DATE)::int AS expiring_today,
        COALESCE(AVG(
          CASE WHEN pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
            THEN GREATEST(0, LEAST(100,
              CASE WHEN balance_amount > 0 THEN 30 ELSE 0 END +
              CASE WHEN pt_end_date <= CURRENT_DATE + 3 THEN 25 ELSE 0 END
            )) ELSE NULL END
        ), 0)::int AS avg_risk_score,
        COUNT(*) FILTER (WHERE balance_amount > 0 AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS high_risk_count,
        COUNT(*) FILTER (WHERE balance_amount = 0 AND pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS low_risk_count
      FROM clients
      WHERE deleted_at IS NULL AND status = 'active' AND pt_end_date IS NOT NULL
    `);

    const insights = [];

    if (stats[0].expiring_7d > 0) {
      insights.push({
        id: 'insight-1',
        title: stats[0].expiring_7d + ' memberships expiring this week',
        description: stats[0].expiring_7d + ' members need renewal attention. ' +
          stats[0].high_risk_count + ' have outstanding balances and require immediate follow-up.',
        type: stats[0].high_risk_count > 3 ? 'warning' : 'neutral',
        action: { label: 'View Pipeline', onClick: 'pipeline' },
      });
    }

    if (stats[0].low_risk_count > 5) {
      insights.push({
        id: 'insight-2',
        title: stats[0].low_risk_count + ' members likely to auto-renew',
        description: 'These members have zero balance and consistent attendance. Consider sending them a loyalty upgrade offer.',
        type: 'positive',
        action: { label: 'Send Offers', onClick: 'offers' },
      });
    }

    if (stats[0].avg_risk_score > 40) {
      insights.push({
        id: 'insight-3',
        title: 'Average churn risk is ' + stats[0].avg_risk_score + '% — above threshold',
        description: 'Members with low attendance in the last 30 days are driving this up. A re-engagement campaign could help.',
        type: 'negative',
        action: { label: 'View Churn Alerts', onClick: 'churn' },
      });
    }

    if (stats[0].expiring_30d > 20) {
      insights.push({
        id: 'insight-4',
        title: stats[0].expiring_30d + ' memberships expiring in 30 days',
        description: 'Start proactive renewal outreach now. Early renewals improve retention by up to 40%.',
        type: 'neutral',
        action: { label: 'Start Campaign', onClick: 'campaign' },
      });
    }

    res.json({ stats: stats[0], insights });
  } catch (err) {
    next(err);
  }
});

// POST /api/renewals/:id/renew — Trigger renewal
router.post('/:id/renew', auth, async (req, res, next) => {
  try {
    const { rows: cl } = await pool.query(
      'SELECT * FROM clients WHERE id=$1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!cl[0]) return res.status(404).json({ error: 'Member not found' });

    const d = req.body;
    const newEndDate = d.new_end_date || (
      cl[0].pt_end_date ?
        new Date(new Date(cl[0].pt_end_date).getTime() + 30 * 86400000).toISOString().split('T')[0]
        : new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]
    );

    // Record renewal
    await pool.query(`
      INSERT INTO renewals (id, client_id, client_name, trainer_id, trainer_name,
        old_package, new_package, old_end_date, new_end_date,
        amount, paid_amount, payment_method, renewed_on, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_DATE,$13)`,
      [uuid(), cl[0].id, cl[0].name, cl[0].trainer_id, cl[0].trainer_name,
       cl[0].package_type, d.new_package || cl[0].package_type,
       cl[0].pt_end_date, newEndDate,
       parseFloat(d.amount) || cl[0].final_amount || 0,
       parseFloat(d.paid_amount) || 0, d.payment_method || 'CASH', d.notes || null]
    );

    // Update client
    await pool.query(`
      UPDATE clients SET
        package_type = COALESCE($1, package_type),
        pt_end_date = $2,
        base_amount = COALESCE($3, base_amount),
        final_amount = COALESCE($4, final_amount),
        paid_amount = paid_amount + COALESCE($5, 0),
        balance_amount = GREATEST(0, COALESCE($6, final_amount) - (paid_amount + COALESCE($5, 0))),
        updated_at = NOW()
      WHERE id = $7`,
      [d.new_package || null, newEndDate,
       d.base_amount ? parseFloat(d.base_amount) : null,
       d.final_amount ? parseFloat(d.final_amount) : null,
       d.paid_amount ? parseFloat(d.paid_amount) : 0,
       d.final_amount ? parseFloat(d.final_amount) : cl[0].final_amount,
       cl[0].id]
    );

    // If paid, record payment
    if (parseFloat(d.paid_amount) > 0) {
      await pool.query(`
        INSERT INTO payments (id, client_id, client_name, trainer_id, trainer_name,
          amount, method, date, receipt_no, package_type, incentive_amt, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8,$9,$10,$11)`,
        [uuid(), cl[0].id, cl[0].name, cl[0].trainer_id, cl[0].trainer_name,
         parseFloat(d.paid_amount), d.payment_method || 'CASH',
         'REN-' + Date.now(), d.new_package || cl[0].package_type, 0,
         'Renewal payment for ' + cl[0].name]
      );
    }

    res.json({ message: 'Membership renewed successfully' });
  } catch (err) {
    logger.error({ err: err.message }, 'Renewal error');
    next(err);
  }
});

// POST /api/renewals/reminders — Send bulk reminders
router.post('/reminders', auth, async (req, res, next) => {
  try {
    const { days = 7 } = req.body;
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.mobile, c.email, c.pt_end_date
      FROM clients c
      WHERE c.deleted_at IS NULL
        AND c.status = 'active'
        AND c.pt_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
      ORDER BY c.pt_end_date`,
      [parseInt(days)]
    );

    logger.info({ count: rows.length, userId: req.user.id }, 'Renewal reminders sent');
    res.json({ message: `Reminders sent to ${rows.length} members`, count: rows.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

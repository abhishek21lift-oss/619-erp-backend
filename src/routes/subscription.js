'use strict';
// Tenant-facing subscription API. Reachable even when a studio is frozen (it is
// on the auth allowlist) so the frozen screen, trial banner, and pricing page
// always have data. All reads are scoped to the caller's own studio.

const router = require('express').Router();
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const sub = require('../lib/subscription');

// GET /api/subscription/status — the caller's studio subscription snapshot.
router.get('/status', auth, async (req, res, next) => {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      // Platform super admin / org-less accounts have no studio subscription.
      return res.json({ data: { subscription_status: null, state: 'platform', allowed: true } });
    }
    const { rows } = await pool.query(
      `SELECT o.id, o.name, o.status, o.subscription_status, o.trial_ends_at,
              o.current_period_start, o.current_period_end, o.plan_code,
              o.client_limit, o.is_founder, o.founder_number, o.locked_price_inr,
              p.name AS plan_name, p.duration_months, p.price_inr,
              (SELECT count(*) FROM pt_clients c
                 WHERE c.organization_id = o.id AND c.deleted_at IS NULL)::int AS client_count
         FROM organizations o
         LEFT JOIN subscription_plans p ON p.code = o.plan_code
        WHERE o.id = $1`,
      [orgId]
    );
    const o = rows[0];
    if (!o) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Studio not found' } });

    const access = sub.computeAccess({
      status: o.status,
      subscription_status: o.subscription_status,
      trial_ends_at: o.trial_ends_at,
      current_period_end: o.current_period_end,
    });

    res.json({
      data: {
        organization_id: o.id,
        subscription_status: o.subscription_status,
        state: access.state,
        allowed: access.allowed,
        reason: access.reason || null,
        trial_ends_at: o.trial_ends_at,
        current_period_start: o.current_period_start,
        current_period_end: o.current_period_end,
        trial_days_left: access.trialDaysLeft ?? null,
        period_days_left: access.periodDaysLeft ?? null,
        renewal_due: access.renewalDue ?? false,
        plan: o.plan_code ? { code: o.plan_code, name: o.plan_name, duration_months: o.duration_months, price_inr: o.price_inr } : null,
        client_limit: o.client_limit,
        client_count: o.client_count,
        is_founder: o.is_founder,
        founder_number: o.founder_number,
        locked_price_inr: o.locked_price_inr,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/subscription/plans — the plan catalogue with live launch pricing +
// remaining founder slots, so the pricing page can render the offer accurately.
router.get('/plans', auth, async (req, res, next) => {
  try {
    const plans = await sub.getPlans();
    const slots = await sub.founderSlotsRemaining();
    const priced = plans.map((p) => {
      const { amount, isLaunch } = sub.effectivePrice(p, slots);
      return { ...p, effective_price_inr: amount, is_launch: isLaunch };
    });
    res.json({ data: { plans: priced, founder_slots_remaining: slots, founder_limit: sub.FOUNDER_LIMIT } });
  } catch (err) { next(err); }
});

// GET /api/subscription/invoices — the studio's own invoice history.
router.get('/invoices', auth, async (req, res, next) => {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) return res.json({ data: [] });
    const { rows } = await pool.query(
      `SELECT id, invoice_number, plan_code, amount_inr, period_start, period_end, status, issued_at
         FROM subscription_invoices WHERE organization_id = $1 ORDER BY issued_at DESC LIMIT 100`,
      [orgId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// GET /api/subscription/payments — the studio's own payment history.
router.get('/payments', auth, async (req, res, next) => {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) return res.json({ data: [] });
    const { rows } = await pool.query(
      `SELECT id, plan_code, amount_inr, method, reference, status, period_start, period_end, refunded_at, created_at
         FROM subscription_payments WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [orgId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /api/subscription/request-activation — a studio asks the platform to
// activate/renew its subscription (admin-activated billing). Notifies the super
// admins in-app and logs the request so it surfaces in the command centre.
// Reachable while frozen (on the auth allowlist). De-duplicated to once / 6h.
router.post('/request-activation', auth, async (req, res, next) => {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) return res.status(400).json({ error: { code: 'NO_ORG', message: 'No studio context' } });
    const planCode = req.body?.plan_code || null;

    const { rows: recent } = await pool.query(
      `SELECT 1 FROM subscription_events
        WHERE organization_id=$1 AND event='activation_requested'
          AND created_at > now() - interval '6 hours' LIMIT 1`, [orgId]
    );
    if (recent.length) {
      return res.json({ data: { requested: true, deduped: true, message: 'We already have your request — we’ll activate shortly.' } });
    }

    const { rows: [org] } = await pool.query('SELECT name FROM organizations WHERE id=$1', [orgId]);
    await pool.query(
      `INSERT INTO subscription_events (organization_id, event, data, actor_id, actor_name)
       VALUES ($1,'activation_requested',$2,$3,$4)`,
      [orgId, JSON.stringify({ plan_code: planCode }), req.user.id, req.user.name || null]
    );

    // Notify every active platform super admin (in-app).
    const { rows: admins } = await pool.query(
      `SELECT id FROM users WHERE role='super_admin' AND is_active=true AND deleted_at IS NULL`
    );
    for (const a of admins) {
      try {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, link)
           VALUES ($1,'subscription',$2,$3,'/platform')`,
          [a.id, 'Activation requested', `${org?.name || 'A studio'} requested subscription activation${planCode ? ` (${planCode})` : ''}.`]
        );
      } catch { /* best-effort */ }
    }

    res.json({ data: { requested: true, message: 'Request sent — we’ll activate your subscription shortly.' } });
  } catch (err) { next(err); }
});

module.exports = router;

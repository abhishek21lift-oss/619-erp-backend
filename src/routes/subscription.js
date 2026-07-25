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
              o.pending_plan_code, o.pending_plan_effective_at,
              p.name AS plan_name, p.duration_months, p.price_inr,
              pp.name AS pending_plan_name, pp.client_limit AS pending_client_limit
         FROM organizations o
         LEFT JOIN subscription_plans p  ON p.code  = o.plan_code
         LEFT JOIN subscription_plans pp ON pp.code = o.pending_plan_code
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

    // Seat usage comes from the same helper the 403 gate uses, so what the UI
    // shows can never disagree with what enforcement actually counts (only
    // ACTIVE clients consume a seat).
    const usage = await sub.clientLimitStatus(o.id);

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
        client_limit: usage.limit,
        client_count: usage.count,
        client_remaining: usage.remaining,
        at_client_limit: usage.atLimit,
        // A scheduled downgrade, if one is pending. Nothing changes until
        // pending_plan_effective_at passes.
        pending_change: o.pending_plan_code
          ? {
            plan_code: o.pending_plan_code,
            plan_name: o.pending_plan_name,
            client_limit: o.pending_client_limit,
            effective_at: o.pending_plan_effective_at,
          }
          : null,
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

// GET /api/subscription/change-quote?plan_code=growth — price a plan change
// before the studio commits to it. Read-only: nothing is scheduled or charged.
// Returns the direction (upgrade/downgrade/renewal/activation), the proration
// credit, the amount due, when it takes effect, and an over-limit warning when
// a downgrade would leave the studio above the target plan's seat limit.
router.get('/change-quote', auth, async (req, res, next) => {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) return res.status(400).json({ error: { code: 'NO_ORG', message: 'No studio context' } });
    const planCode = req.query.plan_code;
    if (!planCode) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'plan_code is required' } });
    }
    const quote = await sub.quotePlanChange(orgId, String(planCode));
    res.json({ data: quote });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'BAD_REQUEST', message: err.message } });
    next(err);
  }
});

// POST /api/subscription/request-change { plan_code } — the studio asks to move
// plans. Billing is admin-activated, so an UPGRADE is recorded as a request for
// the super admin to execute against a real payment. A DOWNGRADE costs nothing,
// so it is scheduled immediately for the end of the current period and needs no
// operator involvement.
router.post('/request-change', auth, async (req, res, next) => {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) return res.status(400).json({ error: { code: 'NO_ORG', message: 'No studio context' } });
    const planCode = req.body?.plan_code;
    if (!planCode) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'plan_code is required' } });
    }

    const quote = await sub.quotePlanChange(orgId, String(planCode));

    if (quote.direction === 'downgrade') {
      await sub.scheduleDowngrade(orgId, String(planCode), req.user);
      return res.json({
        data: {
          scheduled: true,
          direction: 'downgrade',
          effective_at: quote.effective_at,
          warning: quote.warning,
          message: `Your plan will change to ${quote.new_plan.name} at the end of your current billing period. Nothing changes until then.`,
        },
      });
    }

    // Upgrade / renewal / first activation — needs a payment, so it goes to the
    // operator queue exactly like request-activation does.
    await pool.query(
      `INSERT INTO subscription_events (organization_id, event, data, actor_id, actor_name)
       VALUES ($1,'change_requested',$2,$3,$4)`,
      [orgId, JSON.stringify({
        plan_code: planCode, direction: quote.direction,
        amount_due_inr: quote.amount_due_inr, proration_credit_inr: quote.proration_credit_inr,
      }), req.user.id, req.user.name || null]
    );

    const { rows: [org] } = await pool.query('SELECT name FROM organizations WHERE id=$1', [orgId]);
    const { rows: admins } = await pool.query(
      `SELECT id FROM users WHERE role='super_admin' AND is_active=true AND deleted_at IS NULL`
    );
    for (const a of admins) {
      try {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, link)
           VALUES ($1,'subscription',$2,$3,'/platform')`,
          [a.id, 'Plan change requested',
           `${org?.name || 'A studio'} requested an ${quote.direction} to ${quote.new_plan.name} (₹${quote.amount_due_inr} due after ₹${quote.proration_credit_inr} credit).`]
        );
      } catch { /* best-effort */ }
    }

    res.json({
      data: {
        requested: true,
        direction: quote.direction,
        amount_due_inr: quote.amount_due_inr,
        proration_credit_inr: quote.proration_credit_inr,
        message: `Request sent — we’ll upgrade you to ${quote.new_plan.name} once payment is confirmed.`,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: { code: err.code || 'BAD_REQUEST', message: err.message } });
    next(err);
  }
});

// POST /api/subscription/cancel-scheduled-change — drop a pending downgrade so
// the studio stays on its current plan.
router.post('/cancel-scheduled-change', auth, async (req, res, next) => {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) return res.status(400).json({ error: { code: 'NO_ORG', message: 'No studio context' } });
    const result = await sub.cancelScheduledChange(orgId, req.user);
    res.json({ data: result });
  } catch (err) { next(err); }
});

module.exports = router;

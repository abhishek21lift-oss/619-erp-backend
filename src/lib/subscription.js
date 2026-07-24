'use strict';
// Subscription engine for MY PT STUDIO (SaaS billing).
//
// Central, backend-authoritative logic for the studio subscription lifecycle:
//   trial → active → (expired | frozen | cancelled)
// plus the Founder Club (first 50 paying studios keep a lifetime-locked price)
// and the launch offer (Elite launch price while founder slots remain).
//
// `computeAccess` is a PURE function used by the auth layer to decide, on every
// request, whether a studio may use protected features. It works off timestamps
// so trial/period expiry is enforced lazily (no cron needed to freeze). A worker
// flips the stored status + sends reminders, but enforcement never depends on it.

const pool = require('../db/pool');

const FOUNDER_LIMIT = 50;
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS, 10) || 7;
const DAY_MS = 86400000;

// ── Access decision (pure) ────────────────────────────────────────────────────
// org snapshot: { status, subscription_status, trial_ends_at, current_period_end }
//   status                — organizations.status: super-admin hard on/off switch
//   subscription_status   — trial | active | expired | frozen | cancelled
// Returns { allowed, state, reason?, trialDaysLeft?, periodDaysLeft?, renewalDue? }.
function computeAccess(org) {
  const now = Date.now();
  if (!org) return { allowed: true, state: 'active' };

  // Super-admin hard suspend overrides everything.
  if (org.status === 'suspended') {
    return { allowed: false, state: 'suspended', reason: 'Your account has been suspended. Please contact support.' };
  }

  const sub = org.subscription_status || 'active';
  const trialEnds = org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : null;
  const periodEnds = org.current_period_end ? new Date(org.current_period_end).getTime() : null;

  if (sub === 'cancelled') {
    return { allowed: false, state: 'cancelled', reason: 'Your subscription was cancelled. Subscribe again to continue using MY PT STUDIO.' };
  }
  if (sub === 'frozen') {
    return { allowed: false, state: 'frozen', reason: 'Your trial has expired. Please subscribe to continue using MY PT STUDIO.' };
  }
  if (sub === 'expired') {
    return { allowed: false, state: 'expired', reason: 'Your subscription has expired. Please renew to continue using MY PT STUDIO.' };
  }
  if (sub === 'trial') {
    if (trialEnds !== null && trialEnds <= now) {
      return { allowed: false, state: 'trial_expired', reason: 'Your trial has expired. Please subscribe to continue using MY PT STUDIO.' };
    }
    const trialDaysLeft = trialEnds !== null ? Math.max(0, Math.ceil((trialEnds - now) / DAY_MS)) : null;
    return { allowed: true, state: 'trial', trialDaysLeft };
  }
  if (sub === 'active') {
    if (periodEnds !== null && periodEnds <= now) {
      return { allowed: false, state: 'expired', reason: 'Your subscription has expired. Please renew to continue using MY PT STUDIO.' };
    }
    const periodDaysLeft = periodEnds !== null ? Math.max(0, Math.ceil((periodEnds - now) / DAY_MS)) : null;
    const renewalDue = periodDaysLeft !== null && periodDaysLeft <= 7;
    return { allowed: true, state: 'active', periodDaysLeft, renewalDue };
  }
  // Unknown state — fail open (never lock a studio out on a data anomaly).
  return { allowed: true, state: sub };
}

// ── Plan catalogue ─────────────────────────────────────────────────────────────
async function getPlans() {
  const { rows } = await pool.query(
    `SELECT code, name, price_inr, launch_price_inr, duration_months, client_limit, best_for, sort_order
       FROM subscription_plans WHERE is_active = TRUE ORDER BY sort_order`
  );
  return rows;
}

async function getPlan(code) {
  const { rows } = await pool.query(
    `SELECT code, name, price_inr, launch_price_inr, duration_months, client_limit, best_for
       FROM subscription_plans WHERE code = $1`, [code]
  );
  return rows[0] || null;
}

async function founderSlotsRemaining(client = pool) {
  const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM founder_members');
  return Math.max(0, FOUNDER_LIMIT - n);
}

// Effective price for a plan given current founder-slot availability. The launch
// price applies only while founder slots remain (first 50 studios).
function effectivePrice(plan, slotsRemaining) {
  if (slotsRemaining > 0 && plan.launch_price_inr != null) {
    return { amount: plan.launch_price_inr, isLaunch: true };
  }
  return { amount: plan.price_inr, isLaunch: false };
}

// A priced quote for a plan (what a studio would pay to subscribe right now).
async function quote(code) {
  const plan = await getPlan(code);
  if (!plan) return null;
  const slots = await founderSlotsRemaining();
  const { amount, isLaunch } = effectivePrice(plan, slots);
  return {
    ...plan,
    effective_price_inr: amount,
    is_launch: isLaunch,
    founder_eligible: slots > 0,
    founder_slots_remaining: slots,
  };
}

// ── Billing audit ──────────────────────────────────────────────────────────────
async function logEvent(client, orgId, event, data, actor) {
  try {
    await (client || pool).query(
      `INSERT INTO subscription_events (organization_id, event, data, actor_id, actor_name)
       VALUES ($1,$2,$3,$4,$5)`,
      [orgId, event, data ? JSON.stringify(data) : null, actor?.id || null, actor?.name || null]
    );
  } catch { /* best-effort audit */ }
}

// ── Client limits ─────────────────────────────────────────────────────────────
// Current roster size vs the studio's plan limit. limit === null means unlimited
// (grandfathered studios and the Elite plan). atLimit is the gate for new-client
// creation; existing clients always stay accessible.
async function clientLimitStatus(orgId, client = pool) {
  if (!orgId) return { limit: null, count: 0, atLimit: false };
  const { rows: [r] } = await client.query(
    `SELECT o.client_limit,
            (SELECT count(*) FROM pt_clients c
               WHERE c.organization_id = o.id AND c.deleted_at IS NULL)::int AS count
       FROM organizations o WHERE o.id = $1`,
    [orgId]
  );
  if (!r) return { limit: null, count: 0, atLimit: false };
  const limit = r.client_limit;
  return { limit, count: r.count, atLimit: limit != null && r.count >= limit };
}

// ── Trial ────────────────────────────────────────────────────────────────────
// Start (or restart) a studio's free trial. Called at studio creation.
async function startTrial(orgId, days = TRIAL_DAYS, actor = null) {
  await pool.query(
    `UPDATE organizations
        SET subscription_status = 'trial',
            trial_ends_at = now() + ($2 || ' days')::interval,
            current_period_start = NULL,
            current_period_end = NULL,
            cancelled_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [orgId, String(days)]
  );
  await logEvent(pool, orgId, 'trial_started', { days }, actor);
}

// ── Activation / renewal (records a payment and activates the studio) ─────────
// opts: { amount_inr?, method?, reference?, notes?, periodMonths?, actor }
// Founder club: the first 50 studios to activate become permanent Founder
// Members with a lifetime-locked price. Founders keep their locked price on
// renewal. The founder-slot check + assignment is serialized under a table lock
// so the 50th slot can never be double-granted.
async function activate(orgId, planCode, opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE founder_members IN SHARE ROW EXCLUSIVE MODE');

    const plan = (await client.query('SELECT * FROM subscription_plans WHERE code = $1', [planCode])).rows[0];
    if (!plan) throw Object.assign(new Error('Unknown plan'), { status: 400 });
    const org = (await client.query('SELECT * FROM organizations WHERE id = $1', [orgId])).rows[0];
    if (!org) throw Object.assign(new Error('Studio not found'), { status: 404 });

    const slots = await founderSlotsRemaining(client);
    const alreadyFounder = org.is_founder;
    const grantFounder = !alreadyFounder && slots > 0;

    const { amount: effAmount } = effectivePrice(plan, slots);
    const paidAmount = opts.amount_inr != null ? Number(opts.amount_inr)
      : (alreadyFounder && org.locked_price_inr != null) ? org.locked_price_inr
      : effAmount;

    const months = opts.periodMonths || plan.duration_months;
    const now = new Date();
    const base = (org.current_period_end && new Date(org.current_period_end) > now) ? new Date(org.current_period_end) : now;
    const periodEnd = new Date(base);
    periodEnd.setMonth(periodEnd.getMonth() + Number(months));

    let founderNumber = org.founder_number;
    let lockedPrice = org.locked_price_inr;
    if (grantFounder) {
      const n = (await client.query('SELECT COALESCE(MAX(founder_number),0)+1 AS n FROM founder_members')).rows[0].n;
      founderNumber = n;
      lockedPrice = paidAmount;
      await client.query(
        `INSERT INTO founder_members (organization_id, founder_number, plan_code, locked_price_inr)
         VALUES ($1,$2,$3,$4)`,
        [orgId, n, planCode, lockedPrice]
      );
    }

    await client.query(
      `UPDATE organizations
          SET subscription_status = 'active', plan_code = $2, client_limit = $3,
              current_period_start = $4, current_period_end = $5, cancelled_at = NULL,
              is_founder = (is_founder OR $6), founder_number = $7, locked_price_inr = $8,
              updated_at = now()
        WHERE id = $1`,
      [orgId, planCode, plan.client_limit, now, periodEnd, grantFounder, founderNumber, lockedPrice]
    );

    const pay = (await client.query(
      `INSERT INTO subscription_payments
         (organization_id, plan_code, amount_inr, method, reference, status,
          period_start, period_end, recorded_by, recorded_by_name, notes)
       VALUES ($1,$2,$3,$4,$5,'paid',$6,$7,$8,$9,$10) RETURNING id`,
      [orgId, planCode, paidAmount, opts.method || null, opts.reference || null,
       now, periodEnd, opts.actor?.id || null, opts.actor?.name || null, opts.notes || null]
    )).rows[0];

    const seq = (await client.query('SELECT count(*)+1 AS n FROM subscription_invoices')).rows[0].n;
    const invoiceNumber = `MPT-${now.getFullYear()}-${String(seq).padStart(5, '0')}`;
    await client.query(
      `INSERT INTO subscription_invoices
         (organization_id, payment_id, invoice_number, plan_code, amount_inr, period_start, period_end, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'paid')`,
      [orgId, pay.id, invoiceNumber, planCode, paidAmount, now, periodEnd]
    );

    await logEvent(client, orgId, 'activated', { plan_code: planCode, amount_inr: paidAmount, period_end: periodEnd }, opts.actor);
    if (grantFounder) await logEvent(client, orgId, 'founder_granted', { founder_number: founderNumber, locked_price_inr: lockedPrice }, opts.actor);

    await client.query('COMMIT');
    return { plan_code: planCode, amount_inr: paidAmount, period_end: periodEnd, invoice_number: invoiceNumber, founder_granted: grantFounder, founder_number: founderNumber };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function freeze(orgId, actor, reason) {
  await pool.query(`UPDATE organizations SET subscription_status='frozen', updated_at=now() WHERE id=$1`, [orgId]);
  await logEvent(pool, orgId, 'frozen', { reason: reason || 'manual' }, actor);
}

// Comp reactivation (no payment) — un-freeze a studio back to active.
async function reactivate(orgId, actor) {
  await pool.query(`UPDATE organizations SET subscription_status='active', cancelled_at=NULL, updated_at=now() WHERE id=$1`, [orgId]);
  await logEvent(pool, orgId, 'reactivated', {}, actor);
}

async function cancelSubscription(orgId, actor) {
  await pool.query(`UPDATE organizations SET subscription_status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1`, [orgId]);
  await logEvent(pool, orgId, 'cancelled', {}, actor);
}

// Change the trial or subscription expiry directly (admin override / comps).
async function changeExpiry(orgId, { trialEndsAt, periodEnd }, actor) {
  const sets = [];
  const params = [orgId];
  if (trialEndsAt !== undefined) { params.push(trialEndsAt); sets.push(`trial_ends_at = $${params.length}`); }
  if (periodEnd !== undefined) { params.push(periodEnd); sets.push(`current_period_end = $${params.length}`); }
  if (!sets.length) return;
  sets.push('updated_at = now()');
  await pool.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $1`, params);
  await logEvent(pool, orgId, 'expiry_changed', { trialEndsAt, periodEnd }, actor);
}

// Manually grant founder status (outside the automatic first-50 flow).
async function grantFounder(orgId, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE founder_members IN SHARE ROW EXCLUSIVE MODE');
    const org = (await client.query('SELECT is_founder, locked_price_inr, plan_code FROM organizations WHERE id=$1', [orgId])).rows[0];
    if (!org) throw Object.assign(new Error('Studio not found'), { status: 404 });
    if (org.is_founder) { await client.query('COMMIT'); return { already: true }; }
    const n = (await client.query('SELECT COALESCE(MAX(founder_number),0)+1 AS n FROM founder_members')).rows[0].n;
    const locked = org.locked_price_inr || 0;
    await client.query(
      `INSERT INTO founder_members (organization_id, founder_number, plan_code, locked_price_inr) VALUES ($1,$2,$3,$4)`,
      [orgId, n, org.plan_code || null, locked]
    );
    await client.query(
      `UPDATE organizations SET is_founder=TRUE, founder_number=$2, updated_at=now() WHERE id=$1`,
      [orgId, n]
    );
    await logEvent(client, orgId, 'founder_granted', { founder_number: n, manual: true }, actor);
    await client.query('COMMIT');
    return { founder_number: n };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function refundPayment(paymentId, actor) {
  const pay = (await pool.query(
    `UPDATE subscription_payments SET status='refunded', refunded_at=now()
      WHERE id=$1 AND status='paid' RETURNING organization_id, amount_inr`, [paymentId]
  )).rows[0];
  if (!pay) throw Object.assign(new Error('Payment not found or already refunded'), { status: 404 });
  await pool.query(`UPDATE subscription_invoices SET status='refunded' WHERE payment_id=$1`, [paymentId]);
  await logEvent(pool, pay.organization_id, 'refunded', { payment_id: paymentId, amount_inr: pay.amount_inr }, actor);
  return pay;
}

module.exports = {
  FOUNDER_LIMIT,
  TRIAL_DAYS,
  computeAccess,
  getPlans,
  getPlan,
  founderSlotsRemaining,
  effectivePrice,
  quote,
  logEvent,
  startTrial,
  clientLimitStatus,
  activate,
  freeze,
  reactivate,
  cancelSubscription,
  changeExpiry,
  grantFounder,
  refundPayment,
};

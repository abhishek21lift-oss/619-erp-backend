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
};

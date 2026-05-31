// src/modules/subscriptions/subscriptions.routes.js
//
// REST endpoints for subscription history (Blueprint §2.5).
//
// Routes are mounted under /api/subscriptions in server.js. The legacy
// /api/clients/:id/add-subscription route in routes/client-actions.js
// continues to handle the existing form submit; this module gives the
// frontend a richer read path (history list, expiring queue) and a
// future-facing write path that uses the new subscriptions table
// directly.
//
// All mutating routes are wrapped in transactions inside the service.

const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { branchScope } = require('../../middleware/branch-scope');
const svc      = require('./subscriptions.service');

// ── utility ─────────────────────────────────────────────────────────
function send(res, err) {
  const status = (err && err.status) || 500;
  const message = err && err.message ? err.message : 'Internal server error';
  // Hide 5xx detail in production (matches the project's existing policy).
  if (status >= 500 && process.env.NODE_ENV === 'production') {
    return res.status(status).json({ error: 'Internal server error' });
  }
  return res.status(status).json({ error: message });
}

function optionalNumber(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

// GET /api/subscriptions/client/:clientId  — full history
router.get('/client/:clientId', auth, branchScope, async (req, res) => {
  try {
    const rows = await svc.listForClient(req.params.clientId, req.user);
    res.json(rows);
  } catch (err) { send(res, err); }
});

// GET /api/subscriptions/active/:clientId  — current active sub (or null)
router.get('/active/:clientId', auth, branchScope, async (req, res) => {
  try {
    const row = await svc.getActive(req.params.clientId, req.user);
    res.json(row);
  } catch (err) { send(res, err); }
});

// GET /api/subscriptions/expiring?days=7&branch_id=...
router.get('/expiring', auth, branchScope, async (req, res) => {
  try {
    const days     = Math.max(1, Math.min(90, parseInt(req.query.days || '7', 10)));
    const branchId = req.query.branch_id || null;
    // Trainers are scoped to their own clients.
    const rows = await svc.listExpiring({ days, branchId });
    const filtered = req.user.role === 'trainer'
      ? rows.filter((r) => r.trainer_id === req.user.trainer_id)
      : rows;
    res.json(filtered);
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/  — create new (used by the new wizard)
//   body: { client_id, plan_rows: [...], payment_method, branch_id, gst_percent, signup_fee, group_id }
router.post('/', auth, branchScope, async (req, res) => {
  try {
    const d = req.body || {};
    const result = await svc.addSubscription({
      clientId:      d.client_id,
      planRows:      d.plan_rows || [],
      paymentMethod: d.payment_method || 'CASH',
      branchId:      d.branch_id || null,
      gstPercent:    optionalNumber(d.gst_percent),
      signupFee:     optionalNumber(d.signup_fee),
      groupId:       d.group_id || null,
      user:          req.user,
    });
    res.status(201).json({ message: 'Subscription added', ...result });
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/renew  — renew (chains via parent_id)
router.post('/renew', auth, branchScope, async (req, res) => {
  try {
    const d = req.body || {};
    const result = await svc.renewSubscription({
      clientId:      d.client_id,
      planRows:      d.plan_rows || [],
      paymentMethod: d.payment_method || 'CASH',
      branchId:      d.branch_id || null,
      gstPercent:    optionalNumber(d.gst_percent),
      signupFee:     optionalNumber(d.signup_fee),
      user:          req.user,
    });
    res.json({ message: 'Subscription renewed', ...result });
  } catch (err) { send(res, err); }
});

// ── missing endpoints (added 2026-05) ───────────────────────────────

// GET /api/subscriptions  — list all with optional filters
router.get('/', auth, branchScope, async (req, res) => {
  try {
    const rows = await svc.listAll(req.query, req.user);
    res.json(rows);
  } catch (err) { send(res, err); }
});

// GET /api/subscriptions/:id  — single subscription
router.get('/:id', auth, async (req, res) => {
  try {
    const row = await svc.getById(req.params.id, req.user);
    res.json(row);
  } catch (err) { send(res, err); }
});

// PUT /api/subscriptions/:id  — update metadata (notes, coupon, etc.)
router.put('/:id', auth, async (req, res) => {
  try {
    const row = await svc.update(req.params.id, req.body, req.user);
    res.json(row);
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/:id/payments  — record a payment on a subscription
router.post('/:id/payments', auth, async (req, res) => {
  try {
    const result = await svc.addPayment(req.params.id, req.body, req.user);
    res.status(201).json(result);
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/:id/freeze  — freeze (pause) a subscription
router.post('/:id/freeze', auth, async (req, res) => {
  try {
    const result = await svc.freeze(req.params.id, req.body, req.user);
    res.json(result);
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/:id/unfreeze  — resume a frozen subscription
router.post('/:id/unfreeze', auth, async (req, res) => {
  try {
    const result = await svc.unfreeze(req.params.id, req.user);
    res.json(result);
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/:id/upgrade  — upgrade to a better plan
router.post('/:id/upgrade', auth, async (req, res) => {
  try {
    const result = await svc.upgrade(req.params.id, req.body, req.user);
    res.json(result);
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/:id/downgrade  — downgrade plan
router.post('/:id/downgrade', auth, async (req, res) => {
  try {
    const result = await svc.downgrade(req.params.id, req.body, req.user);
    res.json(result);
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/:id/transfer  — transfer to another member
router.post('/:id/transfer', auth, async (req, res) => {
  try {
    const result = await svc.transfer(req.params.id, req.body, req.user);
    res.json(result);
  } catch (err) { send(res, err); }
});

// POST /api/subscriptions/:id/extend  — extend the end date
router.post('/:id/extend', auth, async (req, res) => {
  try {
    const result = await svc.extend(req.params.id, req.body, req.user);
    res.json(result);
  } catch (err) { send(res, err); }
});

module.exports = router;

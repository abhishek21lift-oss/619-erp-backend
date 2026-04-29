// src/modules/members/members.routes.js
const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const svc = require('./members.service');

// Helper: extract role context for service layer
function ctx(req) {
  return {
    user_id: req.user.id,
    role: req.user.role,
    trainer_id: req.user.trainer_id,
    member_id: req.user.member_id,
  };
}

// Async wrapper to forward errors
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/v1/members
router.get('/', auth, wrap(async (req, res) => {
  const result = await svc.list({
    role: req.user.role,
    trainerId: req.user.trainer_id,
    memberId: req.user.member_id,
    filters: {
      status: req.query.status,
      plan: req.query.plan,
      search: req.query.search,
      trainer_id: req.query.trainer_id,
    },
    page: { page: req.query.page, limit: req.query.limit, sort: req.query.sort },
  });
  res.json(result);
}));

// POST /api/v1/members  — admin only
router.post('/', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const member = await svc.create(req.body, ctx(req));
  res.status(201).json({ data: member });
}));

// GET /api/v1/members/:id
router.get('/:id', auth, wrap(async (req, res) => {
  const member = await svc.getById(req.params.id, ctx(req));
  res.json({ data: member });
}));

// PATCH /api/v1/members/:id
router.patch('/:id', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const member = await svc.update(req.params.id, req.body, ctx(req));
  res.json({ data: member });
}));

// DELETE /api/v1/members/:id  — soft delete
router.delete('/:id', auth, requireRole('admin'), wrap(async (req, res) => {
  await svc.softDelete(req.params.id, ctx(req));
  res.status(204).end();
}));

// GET /api/v1/members/:id/payments
router.get('/:id/payments', auth, wrap(async (req, res) => {
  await svc.getById(req.params.id, ctx(req));   // authz check
  const data = await svc.getPayments(req.params.id);
  res.json({ data });
}));

// GET /api/v1/members/:id/attendance
router.get('/:id/attendance', auth, wrap(async (req, res) => {
  await svc.getById(req.params.id, ctx(req));
  const data = await svc.getAttendance(req.params.id, req.query);
  res.json({ data });
}));

// GET /api/v1/members/:id/metrics
router.get('/:id/metrics', auth, wrap(async (req, res) => {
  await svc.getById(req.params.id, ctx(req));
  const data = await svc.getMetrics(req.params.id);
  res.json({ data });
}));

// POST /api/v1/members/:id/freeze
router.post('/:id/freeze', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const hold = await svc.freezeMembership(req.body.membership_id, req.body, ctx(req));
  res.status(201).json({ data: hold });
}));

module.exports = router;

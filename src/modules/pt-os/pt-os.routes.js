const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const svc = require('./pt-os.service');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/dashboard', auth, wrap(async (req, res) => {
  const data = await svc.dashboard(svc.ctx(req));
  res.json({ data });
}));

router.get('/clients', auth, wrap(async (req, res) => {
  const result = await svc.listClients({
    role: req.user.role,
    trainerId: req.user.trainer_id,
    filters: {
      search: req.query.search,
      status: req.query.status,
      trainer_id: req.query.trainer_id,
    },
    page: { page: req.query.page, limit: req.query.limit, sort: req.query.sort },
  });
  res.json(result);
}));

router.get('/clients/:id', auth, wrap(async (req, res) => {
  const data = await svc.getClient(req.params.id, svc.ctx(req));
  res.json({ data });
}));

router.get('/trainers', auth, wrap(async (req, res) => {
  const result = await svc.listTrainers({
    role: req.user.role,
    trainerId: req.user.trainer_id,
    filters: {
      search: req.query.search,
      status: req.query.status,
    },
    page: { page: req.query.page, limit: req.query.limit, sort: req.query.sort },
  });
  res.json(result);
}));

router.get('/trainers/:id', auth, wrap(async (req, res) => {
  const data = await svc.getTrainer(req.params.id, svc.ctx(req));
  res.json({ data });
}));

router.get('/sessions', auth, wrap(async (req, res) => {
  const result = await svc.listSessions({
    role: req.user.role,
    trainerId: req.user.trainer_id,
    memberId: req.user.member_id,
    filters: {
      client_id: req.query.client_id,
      trainer_id: req.query.trainer_id,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
    },
  });
  res.json(result);
}));

router.get('/sessions/:id', auth, wrap(async (req, res) => {
  const data = await svc.getSession(req.params.id);
  res.json({ data });
}));

router.get('/finance', auth, wrap(async (req, res) => {
  const data = await svc.financeSummary();
  res.json({ data });
}));

router.get('/analytics', auth, wrap(async (req, res) => {
  const data = await svc.analyticsSummary();
  res.json({ data });
}));

router.get('/insights', auth, wrap(async (req, res) => {
  const data = await svc.listInsights({
    dismissed: req.query.dismissed === 'true',
    limit: parseInt(req.query.limit) || 20,
  });
  res.json(data);
}));

router.patch('/insights/:id/dismiss', auth, wrap(async (req, res) => {
  const data = await svc.dismissInsight(req.params.id);
  res.json({ data });
}));

router.get('/activity', auth, wrap(async (req, res) => {
  const data = await svc.listActivity({
    limit: parseInt(req.query.limit) || 30,
  });
  res.json(data);
}));

module.exports = router;

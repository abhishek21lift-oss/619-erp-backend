// src/modules/notifications/notifications.routes.js
const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const svc = require('./notifications.service');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/v1/notifications  — current user's inbox
router.get('/', auth, wrap(async (req, res) => {
  const data = await svc.inbox(req.user.id, { unreadOnly: req.query.unread === '1' });
  res.json({ data });
}));

// PATCH /api/v1/notifications/read-all  — mark all as read
router.patch('/read-all', auth, wrap(async (req, res) => {
  await svc.markAllRead(req.user.id);
  res.status(204).end();
}));

// PATCH /api/v1/notifications/:id/read
router.patch('/:id/read', auth, wrap(async (req, res) => {
  await svc.markRead(req.params.id, req.user.id);
  res.status(204).end();
}));

// POST /api/v1/notifications/broadcast  — admin only
//
// `member_ids` is caller-supplied, so every id is resolved INSIDE the caller's
// own studio (recipientFromMember takes the organization from req.user, never
// from the body). An id belonging to another studio resolves to nothing and
// raises 'Recipient not found', identically to an id that does not exist.
//
// The same organization is stamped onto each queued job, so the worker verifies
// it a second time against the recipient's own row before delivering. One check
// at the boundary, one at the point of use.
router.post('/broadcast', auth, requireRole('admin','manager'), wrap(async (req, res) => {
  const { type, member_ids, data, channels } = req.body;

  const organizationId = req.user?.organization_id;
  if (!organizationId) {
    return res.status(403).json({
      error: { code: 'NO_TENANT', message: 'This account has no studio to broadcast within.' },
    });
  }

  const sent = [];
  for (const mid of member_ids || []) {
    const r = await svc.recipientFromMember(mid, organizationId);
    sent.push(await svc.send(type, r, data || {}, channels || ['inapp'], { organizationId, scope: 'tenant' }));
  }
  res.json({ data: { count: sent.length } });
}));

module.exports = router;

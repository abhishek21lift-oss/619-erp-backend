// src/modules/notifications/notifications.routes.js
const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireTrainer } = require('../../middleware/rbac');
const svc = require('./notifications.service');
const { orgIdOf } = require('../../lib/tenant-db');

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

// POST /api/v1/notifications/broadcast  — the studio trainer
//
// Recipients are this studio's own PT clients. It used to resolve each id
// through recipientFromMember, which looks in tables with no organization at
// all — so a trainer could message anybody whose id they had, from any
// studio. An id that is not a live client of this studio is skipped and
// counted, never looked up elsewhere. Opt-outs are honoured per channel by
// the service (deliverChannel); a recipient whose every requested channel was
// suppressed for an opt-out is counted in `suppressed` (the attempt itself is
// in notification_log, status 'suppressed').
router.post('/broadcast', auth, requireTrainer, wrap(async (req, res) => {
  const { type, member_ids, data, channels } = req.body;
  if (!svc.templates[type]) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Unknown notification type' } });
  const orgId = orgIdOf(req);
  const sent = [];
  let skipped = 0;
  let suppressed = 0;
  for (const mid of member_ids || []) {
    const r = await svc.recipientFromClient(orgId, mid);
    if (!r) { skipped += 1; continue; }
    const result = await svc.send(type, r, data || {}, channels || ['inapp']);
    const outcomes = Object.values(result || {});
    if (outcomes.length && outcomes.every((o) => o?.status === 'suppressed')) suppressed += 1;
    sent.push(result);
  }
  res.json({ data: { count: sent.length, skipped, suppressed } });
}));

module.exports = router;

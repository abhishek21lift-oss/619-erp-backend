// src/modules/bookings/bookings.routes.js
const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { tenantScope } = require('../../lib/tenant-db');
const svc = require('./bookings.service');
const cal = require('../../lib/google-calendar');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// `client_id`, from pt_client_id — NOT member_id.
//
// Every member-facing path here read `req.user.member_id`, which
// middleware/rbac.js documents as always NULL for a real client account since
// migration 154. So a client listing their bookings got an empty array, and a
// client trying to book got 400 "member_id required" — before any of the schema
// problems below were even reached.
const ctx = (req) => ({
  user_id: req.user.id, user_name: req.user.name, organization_id: req.user.organization_id,
  role: req.user.role, trainer_id: req.user.trainer_id, client_id: req.user.pt_client_id,
});

// GET /api/v1/bookings  — current user's bookings
router.get('/', auth, wrap(async (req, res) => {
  // A member may only ever ask about themselves; the id is taken from the
  // session and any client_id in the query is ignored for them.
  let clientId = req.query.client_id || req.query.member_id;
  if (req.user.role === 'member') clientId = req.user.pt_client_id;
  if (!clientId) return res.json({ data: [] });
  const data = await svc.listForClient(clientId, req.query, tenantScope(req));
  res.json({ data });
}));

// POST /api/v1/bookings  — book a class
router.post('/', auth, wrap(async (req, res) => {
  let clientId = req.body.client_id || req.body.member_id;
  if (req.user.role === 'member') clientId = req.user.pt_client_id;
  if (!clientId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'client_id required' } });
  const booking = await svc.book({ session_id: req.body.session_id, client_id: clientId }, ctx(req));
  res.status(201).json({ data: booking });
  // Fire-and-forget: sync confirmed bookings to the user's Google Calendar.
  // A calendar failure must never fail the booking itself.
  if (booking.status === 'confirmed' && cal.isConfigured()) {
    cal.createBookingEvent(req.user.id, booking.id).catch(() => {});
  }
}));

// DELETE /api/v1/bookings/:id  — cancel
router.delete('/:id', auth, wrap(async (req, res) => {
  const bookingId = req.params.id;
  const result = await svc.cancel(bookingId, { reason: req.body?.reason }, ctx(req));
  res.json({ data: result });
  // Fire-and-forget: remove the cancelled booking from the user's Google Calendar.
  if (cal.isConfigured()) {
    cal.deleteBookingEvent(req.user.id, bookingId).catch(() => {});
  }
}));

// POST /api/v1/bookings/:id/check-in
router.post('/:id/check-in', auth, requireRole('admin','manager','trainer'), wrap(async (req, res) => {
  const booking = await svc.checkIn(req.params.id, { method: req.body?.method || 'manual' }, ctx(req));
  res.json({ data: booking });
}));

module.exports = router;

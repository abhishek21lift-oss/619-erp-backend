'use strict';
// /api/messages — the studio's side of member ↔ studio messaging.
//
// Mounted `auth, requireTrainer` in server.js: only the studio's trainer
// reaches this. Every client id from the URL is checked against the caller's
// own studio (studioClient) before anything is read or written, and a miss is
// a 404 whether the client is in another studio or does not exist at all.
//
// The member's side is /api/me/messages (client-portal.routes.js), which never
// takes a client id.

const router = require('express').Router();
const { orgIdOf } = require('../../lib/tenant-db');
const svc = require('./client-messages.service');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sendInputError(res, err) {
  return res.status(err.status || 400).json({ error: { code: err.code || 'BAD_REQUEST', message: err.message } });
}

// GET /api/messages — every conversation, most recent first
router.get('/', wrap(async (req, res) => {
  res.json({ data: await svc.inbox(orgIdOf(req)) });
}));

// GET /api/messages/unread-count — the nav badge
router.get('/unread-count', wrap(async (req, res) => {
  res.json({ data: { unread: await svc.studioUnread(orgIdOf(req)) } });
}));

// GET /api/messages/:clientId — one thread; opening it marks the member's messages read
router.get('/:clientId', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const client = await svc.studioClient(orgId, req.params.clientId);
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } });
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before))
    ? req.query.before : null;
  res.json({ data: await svc.studioThread(orgId, client, { before }) });
}));

// POST /api/messages/:clientId — reply { body, channel? }
router.post('/:clientId', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const client = await svc.studioClient(orgId, req.params.clientId);
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } });
  try {
    const { message, delivery } = await svc.studioSend(orgId, client, req.user.id, req.body?.body, {
      senderName: req.user.name,
      channel: req.body?.channel,
      requestId: req.id,
    });

    // 502 with the row: the message exists and is visible as failed, so the
    // trainer can retry it rather than wondering whether it was lost.
    if (!delivery.ok) {
      return res.status(502).json({
        error: {
          code: 'SEND_FAILED',
          message: 'WhatsApp could not deliver this message. Retry when the number or connection is fixed.',
        },
        data: message,
      });
    }

    res.status(201).json({ data: message });
  } catch (err) {
    if (err instanceof svc.MessageInputError) return sendInputError(res, err);
    throw err;
  }
}));

// POST /api/messages/:clientId/:messageId/retry — one failed WhatsApp row
router.post('/:clientId/:messageId/retry', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const client = await svc.studioClient(orgId, req.params.clientId);
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } });

  try {
    const out = await svc.retryWhatsApp(orgId, client, req.params.messageId, { requestId: req.id });
    if (!out) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found.' } });

    if (!out.delivery.ok) {
      return res.status(502).json({
        error: {
          code: 'SEND_FAILED',
          message: 'WhatsApp could not deliver this message. Retry when the number or connection is fixed.',
        },
        data: out.message,
      });
    }

    res.json({ data: out.message });
  } catch (err) {
    if (err instanceof svc.MessageInputError) return sendInputError(res, err);
    throw err;
  }
}));

module.exports = router;

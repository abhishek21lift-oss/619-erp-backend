// src/modules/devices/devices.routes.js
// Authenticated registration of an FCM token. Mounted at /api/v1/devices.
//
// The body carries the token and the platform — never a user id or an
// organization id. Both come from the session, so a caller cannot register a
// device into another tenant or onto another account.

const router = require('express').Router();
const { z } = require('zod');
const { auth } = require('../../middleware/auth');
const svc = require('./devices.service');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const tokenField = z.string()
  .min(20, 'token is too short')
  .max(4096, 'token is too long')
  // FCM registration tokens are URL-safe: letters, digits, '-' '_' and ':'
  .regex(/^[A-Za-z0-9_:-]+$/, 'token is not a valid FCM registration token');

const registerBody = z.object({
  token: tokenField,
  platform: z.enum(['android', 'ios']).default('android'),
}).strict();

const revokeBody = z.object({
  token: tokenField,
  platform: z.enum(['android', 'ios']).optional(),
}).strict();

// POST /api/v1/devices — register or refresh this device for the session user.
router.post('/', auth, wrap(async (req, res) => {
  const parsed = registerBody.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: parsed.error.issues[0]?.message || 'Invalid device' } });
  }
  if (!req.user.organization_id) {
    return res.status(403).json({ error: { code: 'NO_TENANT', message: 'This account has no studio.' } });
  }

  const row = await svc.register({
    userId: req.user.id,
    organizationId: req.user.organization_id,
    role: req.user.role,
    token: parsed.data.token,
    platform: parsed.data.platform,
  });

  // The token itself is not echoed: the client already has it, and a response
  // is one more place it could be logged.
  res.status(200).json({ data: { app: row.app, last_seen_at: row.last_seen_at } });
}));

// DELETE /api/v1/devices — revoke only the caller's own token (logout).
router.delete('/', auth, wrap(async (req, res) => {
  const parsed = revokeBody.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: parsed.error.issues[0]?.message || 'Invalid device' } });
  }
  await svc.revoke({ userId: req.user.id, token: parsed.data.token });
  res.status(204).end();
}));

module.exports = router;

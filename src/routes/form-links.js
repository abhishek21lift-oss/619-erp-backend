'use strict';
// The trainer's side of remote screening: issue a one-time signing link and
// send it, so an online client can complete their PAR-Q and consent on their
// own phone without a login.
//
// Mounted at /api/form-links behind auth + requireTrainer, so nothing here
// re-checks that the caller is staff. What it DOES re-check is that the client
// belongs to the caller's studio — the mount proves the caller is staff
// somewhere, not that they are staff HERE, and a client id is a value the
// caller chose.

const express = require('express');
const logger = require('../lib/logger');
const { auth, requireTrainer } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { z } = require('../lib/validation');
const { tenantScope } = require('../lib/tenant-db');
const { logActivity } = require('../lib/activityLog');
const { frontendUrl } = require('../lib/frontendUrl');
const email = require('../lib/email');
const formLinks = require('../lib/formLinks');
const remoteSigning = require('../modules/remote-signing/remote-signing.service');

const router = express.Router();
router.use(auth, requireTrainer);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const createSchema = { body: z.object({ client_id: z.string().min(1) }) };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/form-links { client_id }
//
// Returns the URL as well as sending it. The trainer may have the client on
// WhatsApp, or standing in front of them — the copyable link is the delivery
// method that always works, and the email is a convenience on top.
router.post('/', validate(createSchema), wrap(async (req, res) => {
  const { orgId } = tenantScope(req);
  const client = await remoteSigning.clientForLink(req.body.client_id, orgId);
  if (!client) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Client not found' } });

  const link = await formLinks.create({
    clientId: client.id, organizationId: orgId, createdBy: req.user.id,
  });
  const url = frontendUrl(`/sign?token=${link.token}`);
  const studio = client.studio_name || 'Your studio';

  const to = String(client.email || '').trim();
  let emailed = false;
  if (EMAIL_RE.test(to)) {
    const result = await email.sendRaw({
      to,
      subject: `${studio} — complete your health screening`,
      text: `Hi ${client.name},\n\n${studio} needs your PAR-Q health screening and informed consent before your first session.\n\nOpen this private link on your phone and sign:\n${url}\n\nThe link works once and expires in ${formLinks.EXPIRY_HOURS / 24} days.`,
      html: `<p>Hi ${esc(client.name)},</p>
<p>${esc(studio)} needs your PAR-Q health screening and informed consent before your first session.</p>
<p><a href="${esc(url)}">Open your private signing link</a></p>
<p>The link works once and expires in ${formLinks.EXPIRY_HOURS / 24} days.</p>`,
    });
    emailed = Boolean(result.sent);
    if (!emailed) logger.warn({ client: client.id, reason: result.reason }, 'form link email not sent');
  }

  await logActivity(req, 'form_link.create', 'pt_client', client.id, {
    link_id: link.id, emailed,
  });

  res.status(201).json({
    data: { url, emailed, email: to || null, expires_at: link.expiresAt },
  });
}));

module.exports = router;

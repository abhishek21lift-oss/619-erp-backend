'use strict';
// A broadcast is the one direct request that can name its channels. While the
// activation gate is off (or the studio is outside the staging allowlist) a
// request that names push is refused whole, rather than reporting a delivery
// that did not happen.

const request = require('supertest');

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-trainer', role: 'trainer', organization_id: 'org-self' };
    next();
  },
}));
jest.mock('../middleware/rbac', () => ({ requireTrainer: (_req, _res, next) => next() }));
jest.mock('../modules/notifications/notifications.service', () => ({
  templates: { class_reminder: {} },
  recipientFromClient: jest.fn(async () => ({ user_id: 'usr-member', organization_id: 'org-self', name: 'Member' })),
  send: jest.fn(async () => ({ inapp: { status: 'sent' } })),
}));

const svc = require('../modules/notifications/notifications.service');
const router = require('../modules/notifications/notifications.routes');

const express = require('express');
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/notifications', router);
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const BODY = { type: 'class_reminder', member_ids: ['cl-1'], data: { class_name: 'Yoga', time: '7:00 AM' } };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PUSH_ENABLED = 'false';
  delete process.env.PUSH_ALLOWED_ORGS;
});

afterAll(() => {
  delete process.env.PUSH_ENABLED;
  delete process.env.PUSH_ALLOWED_ORGS;
});

it('refuses a broadcast that names push while the gate is off', async () => {
  const res = await request(app())
    .post('/api/v1/notifications/broadcast')
    .send({ ...BODY, channels: ['inapp', 'push'] })
    .expect(409);

  expect(res.body.error.code).toBe('PUSH_DISABLED');
  expect(svc.send).not.toHaveBeenCalled();
});

it('refuses push for a studio outside the staging allowlist', async () => {
  process.env.PUSH_ENABLED = 'true';
  process.env.PUSH_ALLOWED_ORGS = 'org-other';

  const res = await request(app())
    .post('/api/v1/notifications/broadcast')
    .send({ ...BODY, channels: ['push'] })
    .expect(409);

  expect(res.body.error.code).toBe('PUSH_DISABLED');
  expect(svc.send).not.toHaveBeenCalled();
});

it('still delivers the inbox broadcast while the gate is off', async () => {
  await request(app())
    .post('/api/v1/notifications/broadcast')
    .send({ ...BODY, channels: ['inapp'] })
    .expect(200);

  expect(svc.send).toHaveBeenCalledWith('class_reminder', expect.any(Object), BODY.data, ['inapp']);
});

it('allows push for a studio inside the staging allowlist', async () => {
  process.env.PUSH_ENABLED = 'true';
  process.env.PUSH_ALLOWED_ORGS = 'org-other, org-self';

  await request(app())
    .post('/api/v1/notifications/broadcast')
    .send({ ...BODY, channels: ['inapp', 'push'] })
    .expect(200);

  expect(svc.send).toHaveBeenCalledWith('class_reminder', expect.any(Object), BODY.data, ['inapp', 'push']);
});

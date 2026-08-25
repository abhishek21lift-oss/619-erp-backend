'use strict';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL =
  process.env.FRONTEND_URL || 'https://example.com';

const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { ...global.__AI_TRAINER_TEST_USER };
    next();
  },
}));
const router = require('../routes/aiTrainer');

const MEMBER = {
  id: 'member-1',
  role: 'member',
  organization_id: '11111111-1111-4111-8111-111111111111',
  pt_client_id: 'client-1',
};

const ADMIN = {
  id: 'admin-1',
  role: 'admin',
  organization_id: '11111111-1111-4111-8111-111111111111',
};

const TRAINER = {
  id: 'trainer-1',
  role: 'trainer',
  organization_id: '11111111-1111-4111-8111-111111111111',
  trainer_id: 'trainer-1',
};

function buildApp(user) {
  global.__AI_TRAINER_TEST_USER = user;

  const app = express();

  app.use(express.json());

  app.use('/api/ai/trainer', router);

  return app;
}
describe('AI Trainer route authorization', () => {
  test('member is rejected from the pending queue', async () => {
    const app = buildApp(MEMBER);

    const res = await request(app)
      .get('/api/ai/trainer/pending');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('admin is rejected from the pending queue', async () => {
    const app = buildApp(ADMIN);

    const res = await request(app)
      .get('/api/ai/trainer/pending');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('trainer is allowed through role authorization', async () => {
    const app = buildApp(TRAINER);

    const res = await request(app)
      .get('/api/ai/trainer/pending');

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
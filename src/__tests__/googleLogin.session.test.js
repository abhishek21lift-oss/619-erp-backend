'use strict';
// Regression for the Google door returning a partial session user.
//
// The client adopts the sign-in response as the signed-in user without
// fetching /api/auth/me. A partial user made the shell fall back to
// "PT Studio", a generic mark, and no billing link until a hard reload.
// Pin the same session shape POST /api/auth/login returns.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

const userRow = {
  id: USER,
  name: 'Abhishek Katiyar',
  email: 'abhishekkatiyar@gmail.com',
  role: 'trainer',
  token_version: 0,
  trainer_id: 'trn-1',
  member_id: null,
  pt_client_id: null,
  is_active: true,
  organization_id: ORG,
  organization_name: 'ABHISHEK PT STUDIO',
  organization_logo_url: '/uploads/studio.png',
  is_founder: true,
  founder_number: 7,
  avatar_url: '/uploads/avatar.png',
};

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/loginEvents', () => ({ record: jest.fn(), OUTCOMES: { SUCCESS: 'success', UNKNOWN_USER: 'unknown_user' } }));
jest.mock('google-auth-library', () => ({
  OAuth2Client: class {
    async verifyIdToken() {
      return {
        getPayload: () => ({ email: 'abhishekkatiyar@gmail.com', email_verified: true }),
      };
    }
  },
}));

const pool = require('../db/pool');
const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', require('../routes/auth-google'));
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation(async (sql) => {
    if (/FROM users\b/.test(sql)) return { rows: [userRow] };
    return { rows: [], rowCount: 1 };
  });
});

it('returns the studio fields the shell needs, like password login', async () => {
  const res = await request(app())
    .post('/api/auth/google-login')
    .send({ credential: 'google-id-token' });

  expect(res.status).toBe(200);
  expect(res.body.user).toEqual(expect.objectContaining({
    id: USER,
    name: 'Abhishek Katiyar',
    email: 'abhishekkatiyar@gmail.com',
    role: 'trainer',
    organization_id: ORG,
    organization_name: 'ABHISHEK PT STUDIO',
    organization_logo_url: '/uploads/studio.png',
    is_founder: true,
    founder_number: 7,
    avatar_url: '/uploads/avatar.png',
  }));
});

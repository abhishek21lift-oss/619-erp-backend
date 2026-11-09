'use strict';
// Google login must issue exactly the password login's session, not the
// old 7-day access cookie with no refresh token.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const SUB = 'google-sub-1';

const userRow = {
  id: USER, name: 'Abhishek Katiyar', email: 'abhishekkatiyar@gmail.com',
  role: 'trainer', token_version: 0, trainer_id: 'trn-1', member_id: null,
  pt_client_id: null, is_active: true, deleted_at: null, google_sub: SUB,
  organization_id: ORG, organization_name: 'ABHISHEK PT STUDIO',
  organization_logo_url: '/uploads/studio.png', is_founder: true,
  founder_number: 7, avatar_url: '/uploads/avatar.png',
};

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/loginEvents', () => ({ record: jest.fn(), OUTCOMES: { SUCCESS: 'success', UNKNOWN_USER: 'unknown_user', INACTIVE: 'inactive', WRONG_PORTAL: 'wrong_portal' } }));
jest.mock('../lib/googleIdentity', () => ({
  verifyGoogleCredential: jest.fn(async () => ({
    sub: SUB, email: 'abhishekkatiyar@gmail.com', email_verified: true,
  })),
}));

const pool = require('../db/pool');
const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', require('../routes/auth-google'));
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation(async (sql) => {
    if (/FROM users u/.test(sql)) return { rows: [userRow] };
    return { rows: [], rowCount: 1 };
  });
});

it('returns the studio fields the shell needs, like password login', async () => {
  const res = await request(app())
    .post('/api/auth/google-login')
    .set('Origin', 'https://studio.example.com')
    .send({ credential: 'google-id-token' });

  expect(res.status).toBe(200);
  expect(res.body.user).toEqual(expect.objectContaining({
    id: USER, name: 'Abhishek Katiyar', email: 'abhishekkatiyar@gmail.com',
    role: 'trainer', organization_id: ORG, organization_name: 'ABHISHEK PT STUDIO',
    organization_logo_url: '/uploads/studio.png', is_founder: true,
    founder_number: 7, avatar_url: '/uploads/avatar.png',
  }));
});

it('sets a 15-minute access cookie and a rotating 7-day refresh cookie', async () => {
  const res = await request(app())
    .post('/api/auth/google-login')
    .set('Origin', 'https://studio.example.com')
    .send({ credential: 'google-id-token' });

  const cookies = res.headers['set-cookie'].join(';');
  expect(cookies).toMatch(/token=/);
  expect(cookies).toMatch(/Max-Age=900/);
  expect(cookies).toMatch(/refresh_token=/);
  expect(cookies).toMatch(/Path=\/api\/auth/);

  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO refresh_tokens'),
    [USER, expect.any(String), expect.any(Date), 'tenant']
  );
});

it('unified Google login writes the resolved namespace, not a unified cookie', async () => {
  const res = await request(app())
    .post('/api/auth/google-login')
    .send({ credential: 'stub', portal: 'unified' });

  expect(res.status).toBe(200);
  const cookies = (res.headers['set-cookie'] || []).join(';');
  expect(cookies).toContain('trainer_token=');
  expect(cookies).not.toContain('unified_token=');
});

it('does not put tokens in a browser response body', async () => {
  const res = await request(app())
    .post('/api/auth/google-login')
    .set('Origin', 'https://studio.example.com')
    .send({ credential: 'google-id-token' });

  expect(res.body).not.toHaveProperty('token');
  expect(res.body).not.toHaveProperty('refresh_token');
});

it('still returns body tokens to a cookieless caller', async () => {
  const res = await request(app())
    .post('/api/auth/google-login')
    .send({ credential: 'google-id-token' });

  expect(typeof res.body.token).toBe('string');
  expect(typeof res.body.refresh_token).toBe('string');
});

'use strict';
// The platform operator signs in with password + authenticator only
// (security audit 2026-10-08). Google sign-in never asks for TOTP; letting a
// super_admin through it opened a session that could reach /api/profile and
// replace the operator's authenticator.

let mockUser = null;
const queries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql), params });
    if (/FROM users WHERE LOWER\(email\)/i.test(sql)) return { rows: mockUser ? [mockUser] : [] };
    return { rows: [], rowCount: 0 };
  }),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/loginEvents', () => ({
  OUTCOMES: { SUCCESS: 'success', UNKNOWN_USER: 'unknown_user', WRONG_PORTAL: 'wrong_portal' },
  record: jest.fn(),
}));
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: jest.fn(async () => ({ getPayload: () => ({ email: 'op@studio.test', email_verified: true }) })),
  })),
}));

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'client-id';

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/api/auth', require('../routes/auth-google'));

const login = () => request(app).post('/api/auth/google-login').send({ credential: 'google-id-token' });
const user = (role) => ({ id: 'u1', name: 'X', email: 'op@studio.test', role, token_version: 0, is_active: true, organization_id: 'o1' });

beforeEach(() => { queries.length = 0; });

test('a super_admin is refused, and no session cookie is set', async () => {
  mockUser = user('super_admin');
  const res = await login();
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('OPERATOR_PASSWORD_ONLY');
  expect(String(res.headers['set-cookie'] || '')).not.toMatch(/token=/);
});

test('a trainer still signs in with Google', async () => {
  mockUser = user('trainer');
  const res = await login();
  expect(res.status).toBe(200);
  expect(String(res.headers['set-cookie'] || '')).toMatch(/token=/);
});

// A refresh token dies with the token_version it was issued under
// (security audit 2026-10-08, migration 228).
//
// "Sign out everywhere", deactivating a member, suspending a studio and an
// operator's password reset all end sessions by bumping users.token_version.
// That killed access tokens but not refresh tokens: /refresh minted a new
// access token with the user's CURRENT version, so a stolen refresh token
// outlived every one of them and renewed itself on each rotation.

let mockRow = null;
const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/FROM refresh_tokens rt JOIN users u/i.test(text)) return { rows: mockRow ? [mockRow] : [] };
    if (/^UPDATE refresh_tokens SET revoked_at/i.test(text)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));
jest.mock('otplib', () => ({ generateSecret: jest.fn(), verifySync: jest.fn(() => ({ valid: false })) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.FRONTEND_URL = 'https://test.example.com';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/auth', require('../routes/auth'));

const refresh = () => request(app).post('/api/auth/refresh').send({ refresh_token: 'rt-raw' });
const live = (extra) => ({ user_id: 'usr-1', audience: null, is_active: true, deleted_at: null, token_version: 3, ...extra });

beforeEach(() => { mockQueries.length = 0; mockRow = null; });

test('a token issued under the current version still refreshes', async () => {
  mockRow = live({ issued_version: 3 });
  const res = await refresh();
  expect(res.status).toBe(200);
  const insert = mockQueries.find((q) => /^INSERT INTO refresh_tokens/i.test(q.sql));
  // The new token is stamped from the user row, not from the old token.
  expect(insert.sql).toMatch(/\(SELECT token_version FROM users WHERE id = \$1\)/);
});

test('after "sign out everywhere" (version bumped) the old refresh token is refused and revoked', async () => {
  mockRow = live({ issued_version: 2 });
  const res = await refresh();
  expect(res.status).toBe(401);
  expect(mockQueries.some((q) => /^INSERT INTO refresh_tokens/i.test(q.sql))).toBe(false);
  expect(mockQueries.some((q) => /^UPDATE refresh_tokens SET revoked_at/i.test(q.sql) && q.params[0])).toBe(true);
});

test('a token minted by the previous release mid-deploy (no version) is not signed out', async () => {
  mockRow = live({ issued_version: null });
  expect((await refresh()).status).toBe(200);
});

test('a deactivated account is still refused, as before', async () => {
  mockRow = live({ issued_version: 3, is_active: false });
  expect((await refresh()).status).toBe(401);
});

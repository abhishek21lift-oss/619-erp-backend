'use strict';
// Changing the second factor needs the second factor (security audit
// 2026-10-08).
//
// /mfa/setup overwrote a live secret and DELETE /mfa turned MFA off from any
// session. Google and passkey logins never ask for TOTP, so whoever controlled
// the operator's mailbox could reset the password, sign in with Google and put
// their own authenticator on the platform account. These pin: no re-enrolment
// while MFA is on, turning it off needs a current code, and none of it is
// possible while impersonating.

let mockState = null;
const queries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: text, params });
    if (/^SELECT mfa_enabled, mfa_secret FROM user_profiles/.test(text)) return { rows: mockState ? [mockState] : [] };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('../lib/memberTrainer', () => ({ syncTrainerName: jest.fn(async () => {}) }));
jest.mock('../lib/mfaRecoveryCodes', () => ({ issueForUser: jest.fn(async () => ['a', 'b']) }));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'NEWSECRET'),
  verifySync: jest.fn(({ token }) => ({ valid: token === '123456' })),
}));

let mockImpersonation = null;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-op', role: 'super_admin', email: 'op@x.y' };
    if (mockImpersonation) req.impersonation = mockImpersonation;
    next();
  },
  requireTrainer: (_req, _res, next) => next(),
  invalidateUserCache: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/profile', require('../routes/profile'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}
const wrote = (re) => queries.some((q) => re.test(q.sql));

beforeEach(() => { queries.length = 0; mockState = null; mockImpersonation = null; });

describe('setting up an authenticator', () => {
  test('works when MFA is off', async () => {
    const res = await request(app()).post('/api/profile/mfa/setup');
    expect(res.status).toBe(200);
    expect(res.body.secret).toBe('NEWSECRET');
  });

  test('is refused while MFA is on, and the live secret is not overwritten', async () => {
    mockState = { mfa_enabled: true, mfa_secret: 'LIVE' };
    const res = await request(app()).post('/api/profile/mfa/setup');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MFA_ALREADY_ENABLED');
    expect(wrote(/^INSERT INTO user_profiles/)).toBe(false);
  });
});

describe('turning MFA off', () => {
  beforeEach(() => { mockState = { mfa_enabled: true, mfa_secret: 'LIVE' }; });

  test('needs a code', async () => {
    const res = await request(app()).delete('/api/profile/mfa');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MFA_CODE_REQUIRED');
    expect(wrote(/^UPDATE user_profiles SET mfa_enabled = FALSE/)).toBe(false);
  });

  test('refuses a wrong code', async () => {
    const res = await request(app()).delete('/api/profile/mfa').send({ code: '000000' });
    expect(res.status).toBe(400);
    expect(wrote(/^UPDATE user_profiles SET mfa_enabled = FALSE/)).toBe(false);
  });

  test('works with a current code', async () => {
    const res = await request(app()).delete('/api/profile/mfa').send({ code: '123456' });
    expect(res.status).toBe(200);
    expect(wrote(/^UPDATE user_profiles SET mfa_enabled = FALSE/)).toBe(true);
  });
});

test('no MFA change is possible while impersonating', async () => {
  mockImpersonation = { org: 'org-1', mode: 'full' };
  for (const call of [
    request(app()).post('/api/profile/mfa/setup'),
    request(app()).post('/api/profile/mfa/verify').send({ code: '123456' }),
    request(app()).delete('/api/profile/mfa').send({ code: '123456' }),
  ]) {
    const res = await call;
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('IMPERSONATION_FORBIDDEN');
  }
  expect(wrote(/^(INSERT|UPDATE) /)).toBe(false);
});

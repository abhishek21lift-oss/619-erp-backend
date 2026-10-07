'use strict';
// Changing the sign-in email needs the current password.
//
// PUT /api/profile/me used to write users.email on the strength of a session
// alone (SYSTEM-AUDIT-2026-09-28 item C). The email is the account's identity —
// password reset is sent to it and Google sign-in matches on it — so a stolen
// session could point the account at an attacker's address and keep it.
//
// These pin: an unchanged email (the form resends it on every save) needs no
// password; a changed one needs the right password, is refused under
// impersonation, cannot probe for registered addresses without the password,
// and notifies the OLD address once it succeeds.

const bcrypt = require('bcryptjs');

const queries = [];
let mockAccount = null;
let mockTaken = false;
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: text, params });
    if (/^SELECT email, password FROM users/.test(text)) return { rows: mockAccount ? [mockAccount] : [], rowCount: mockAccount ? 1 : 0 };
    if (/^SELECT id FROM users WHERE LOWER\(email\)/.test(text)) return { rows: mockTaken ? [{ id: 'usr-other' }] : [], rowCount: mockTaken ? 1 : 0 };
    // profileFor()'s read-back after a successful save.
    if (/^SELECT u\.id, u\.name, u\.email/.test(text)) return { rows: [{ id: 'usr', name: 'Owner', email: 'x@y.z', portfolio_count: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('../lib/memberTrainer', () => ({ syncTrainerName: jest.fn(async () => {}) }));
jest.mock('otplib', () => ({ generateSecret: jest.fn(), verifySync: jest.fn() }));
jest.mock('../lib/email', () => ({ sendEmailChangedNotice: jest.fn(async () => ({ sent: true })) }));

let mockUser;
let mockImpersonation;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = mockUser;
    if (mockImpersonation) req.impersonation = mockImpersonation;
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  invalidateUserCache: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { sendEmailChangedNotice } = require('../lib/email');
const { logActivity } = require('../lib/activityLog');

const PASSWORD = 'correct horse battery';
let HASH;

beforeAll(async () => { HASH = await bcrypt.hash(PASSWORD, 4); });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/profile', require('../routes/profile'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

let server;
beforeEach(() => {
  queries.length = 0;
  mockTaken = false;
  mockImpersonation = null;
  // A distinct user per test keeps the per-account rate limiter independent.
  mockUser = { id: `usr-${Math.random().toString(36).slice(2)}`, role: 'trainer', organization_id: 'org-1' };
  mockAccount = { email: 'Owner@Studio.com', password: HASH };
  jest.clearAllMocks();
  server = app();
});

const put = (body) => request(server).put('/api/profile/me').send({ name: 'Owner', ...body });
const emailWrites = () => queries.filter((q) => /^UPDATE users SET name = \$1, email = \$2/.test(q.sql));
const uniquenessProbes = () => queries.filter((q) => /^SELECT id FROM users WHERE LOWER\(email\)/.test(q.sql));

describe('an unchanged email', () => {
  test('saves without a password — the form resends the email on every save', async () => {
    const res = await put({ email: 'owner@studio.com' });
    expect(res.status).toBe(200);
    expect(emailWrites()).toHaveLength(1);
    expect(sendEmailChangedNotice).not.toHaveBeenCalled();
  });

  test('is compared case-insensitively and with whitespace trimmed', async () => {
    const res = await put({ email: '  OWNER@studio.COM ' });
    expect(res.status).toBe(200);
    expect(sendEmailChangedNotice).not.toHaveBeenCalled();
  });

  test('is allowed under impersonation, so an operator can still fix a typo in a name', async () => {
    mockImpersonation = { org: 'org-1', ro: false };
    const res = await put({ email: 'owner@studio.com' });
    expect(res.status).toBe(200);
  });
});

describe('a changed email', () => {
  test('without a password is refused with REAUTH_REQUIRED and writes nothing', async () => {
    const res = await put({ email: 'attacker@evil.com' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
    expect(emailWrites()).toHaveLength(0);
  });

  test('with the wrong password is refused with REAUTH_FAILED — a 403, never a 401 that signs the user out', async () => {
    const res = await put({ email: 'attacker@evil.com', currentPassword: 'guess' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTH_FAILED');
    expect(emailWrites()).toHaveLength(0);
  });

  test('cannot probe which addresses are registered without the password', async () => {
    mockTaken = true;
    const res = await put({ email: 'someone@else.com' });
    expect(res.status).toBe(403);
    expect(uniquenessProbes()).toHaveLength(0);
  });

  test('with the right password, to a taken address, is a 409', async () => {
    mockTaken = true;
    const res = await put({ email: 'someone@else.com', currentPassword: PASSWORD });
    expect(res.status).toBe(409);
    expect(emailWrites()).toHaveLength(0);
  });

  test('with the right password is saved, audited, and the OLD address is told', async () => {
    const res = await put({ email: 'new@studio.com', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(emailWrites()).toHaveLength(1);
    expect(emailWrites()[0].params.slice(0, 2)).toEqual(['Owner', 'new@studio.com']);
    expect(sendEmailChangedNotice).toHaveBeenCalledWith({ to: 'owner@studio.com', name: 'Owner', newEmail: 'new@studio.com' });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), 'profile.email.change', 'user', mockUser.id,
      { from: 'owner@studio.com', to: 'new@studio.com' });
  });

  test('still succeeds when the notice cannot be sent', async () => {
    sendEmailChangedNotice.mockRejectedValueOnce(new Error('smtp down'));
    const res = await put({ email: 'new@studio.com', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
  });

  test('is refused under impersonation even with a password', async () => {
    mockImpersonation = { org: 'org-1', ro: false };
    const res = await put({ email: 'new@studio.com', currentPassword: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_CHANGE_IMPERSONATION');
    expect(emailWrites()).toHaveLength(0);
  });

  test('is refused when the account has no password hash, rather than throwing', async () => {
    mockAccount = { email: 'owner@studio.com', password: null };
    const res = await put({ email: 'new@studio.com', currentPassword: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTH_FAILED');
  });
});

test('password attempts are rate-limited per account', async () => {
  for (let i = 0; i < 10; i += 1) {
    const r = await put({ email: 'attacker@evil.com', currentPassword: `guess-${i}` });
    expect(r.status).toBe(403);
  }
  const limited = await put({ email: 'attacker@evil.com', currentPassword: PASSWORD });
  expect(limited.status).toBe(429);
  expect(limited.body.error.code).toBe('REAUTH_RATE_LIMITED');
  expect(emailWrites()).toHaveLength(0);

  // Ordinary saves carry no password and are never counted against the limit.
  const save = await put({ email: 'owner@studio.com' });
  expect(save.status).toBe(200);
});

test('a soft-deleted or missing account is a 404, not a write', async () => {
  mockAccount = null;
  const res = await put({ email: 'owner@studio.com' });
  expect(res.status).toBe(404);
  expect(emailWrites()).toHaveLength(0);
});

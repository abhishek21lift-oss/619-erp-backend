// A soft-deleted account must never get a session it cannot use.
//
// Production, 2026-09-25: the studio's only member login had deleted_at set
// but is_active still TRUE. /api/auth/login filtered is_active and not
// deleted_at, so the password passed and a session was minted; middleware/
// auth.js does filter deleted_at, so every request after it was a 401 and the
// member was bounced back to the sign-in page. Thirteen activation emails
// later, "Resend" had not helped either — it re-used the row and never
// restored it. These tests pin each end of that loop.
'use strict';

const state = { handlers: [], log: [] };

function mockQuery(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  state.log.push({ sql: flat, params });
  for (const h of state.handlers) {
    if (h.match.test(flat)) return typeof h.result === 'function' ? h.result(params) : h.result;
  }
  return { rows: [], rowCount: 0 };
}

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => mockQuery(sql, params)),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => mockQuery(sql, params)),
    release: jest.fn(),
  })),
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn(async (plain) => plain === 'correct-password'),
  hash: jest.fn(async () => '$2a$12$hashedhashedhashedhashe'),
}));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: false })),
}));
jest.mock('../lib/email', () => ({
  sendPasswordReset: jest.fn(async () => ({ sent: true })),
  sendClientActivation: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../lib/clientInvitations', () => ({
  EXPIRY_HOURS: 72,
  resolve: jest.fn(async () => ({
    ok: true,
    row: { id: 'inv-1', user_id: 'usr-m', pt_client_id: 'ptc-1', organization_id: 'org-1' },
  })),
  markActivated: jest.fn(async () => {}),
  withinRateLimit: jest.fn(async () => ({ ok: true, max: 5 })),
  eligibility: jest.fn(() => ({ ok: true })),
  supersedeOpen: jest.fn(async () => {}),
  create: jest.fn(async () => ({ invitation: { id: 'inv-2' }, token: 'tok' })),
  markSent: jest.fn(async () => {}),
  markSendFailed: jest.fn(async () => {}),
}));

const mockUser = { id: 'usr-t', role: 'trainer', organization_id: 'org-1', name: 'Trainer' };
jest.mock('../middleware/auth', () => {
  const actual = jest.requireActual('../middleware/auth');
  return {
    ...actual,
    auth: (req, _res, next) => { req.user = mockUser; next(); },
    requireTrainer: (_req, _res, next) => next(),
    invalidateUserCache: jest.fn(),
  };
});

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.FRONTEND_URL = 'https://test.example.com';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', require('../routes/auth'));
  a.use('/api/client-activation', require('../routes/client-activation'));
  a.use('/api/client-login', require('../routes/client-login'));
  return a;
}

const on = (match, result) => state.handlers.push({ match, result });
const find = (re) => state.log.find((e) => re.test(e.sql));

beforeEach(() => {
  state.handlers = [];
  state.log = [];
});

describe('sign-in ignores a deleted account', () => {
  test('the login lookup filters deleted_at, and a deleted account is a plain 401', async () => {
    // Honour the filter the way Postgres would: the only row is deleted.
    on(/FROM users u LEFT JOIN organizations o/, { rows: [] });

    const res = await request(app()).post('/api/auth/login')
      .send({ email: 'member@example.com', password: 'correct-password', portal: 'member' });

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    const lookup = find(/FROM users u LEFT JOIN organizations o/);
    expect(lookup.sql).toMatch(/u\.is_active = true AND u\.deleted_at IS NULL/);
  });

  test('forgot-password never issues a reset for a deleted account', async () => {
    await request(app()).post('/api/auth/forgot-password').send({ email: 'member@example.com' });
    expect(find(/SELECT id FROM users WHERE btrim\(LOWER\(email\)\)/).sql).toMatch(/deleted_at IS NULL/);
  });

  test('reset-password never resolves a token to a deleted account', async () => {
    await request(app()).post('/api/auth/reset-password').send({ token: 't', password: 'longenough1' });
    expect(find(/WHERE password_reset_token = \$1/).sql).toMatch(/deleted_at IS NULL/);
  });
});

describe('activation cannot succeed into a deleted account', () => {
  test('a link for a since-deleted login is refused and nothing is committed', async () => {
    on(/FROM client_invitations WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'inv-1', status: 'sent' }] });
    on(/^UPDATE users SET password = \$1/, { rows: [], rowCount: 0 }); // deleted: no row matches

    const res = await request(app()).post('/api/client-activation/tok/accept')
      .send({ password: 'A-strong-passw0rd!' });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('INVALID');
    expect(find(/^UPDATE users SET password = \$1/).sql).toMatch(/WHERE id = \$2 AND deleted_at IS NULL/);
    expect(find(/UPDATE pt_clients SET login_activated = TRUE/)).toBeUndefined();
    expect(find(/^COMMIT$/)).toBeUndefined();
    expect(find(/^ROLLBACK$/)).toBeDefined();
  });

  test('a live login activates as before', async () => {
    on(/FROM client_invitations WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'inv-1', status: 'sent' }] });
    on(/^UPDATE users SET password = \$1/, { rows: [], rowCount: 1 });

    const res = await request(app()).post('/api/client-activation/tok/accept')
      .send({ password: 'A-strong-passw0rd!' });

    expect(res.status).toBeLessThan(300);
    expect(find(/UPDATE pt_clients SET login_activated = TRUE/)).toBeDefined();
    expect(find(/^COMMIT$/)).toBeDefined();
  });
});

describe('the trainer re-inviting a client restores their login', () => {
  test('Resend clears deleted_at on the linked account', async () => {
    on(/FROM pt_clients c LEFT JOIN organizations o/, {
      rows: [{ id: 'ptc-1', name: 'Rohit', email: 'member@example.com', organization_id: 'org-1',
               user_id: 'usr-m', login_activated: true, studio_name: 'Studio' }],
    });
    on(/SELECT user_id, login_activated FROM pt_clients/, { rows: [{ user_id: 'usr-m', login_activated: true }] });

    await request(app()).post('/api/client-login/ptc-1/resend').send({});

    const restore = find(/^UPDATE users SET is_active = FALSE/);
    expect(restore).toBeDefined();
    expect(restore.sql).toMatch(/deleted_at = NULL/);
    expect(restore.params[0]).toBe('usr-m');
  });
});

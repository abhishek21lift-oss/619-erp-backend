// Two properties of POST /api/auth/refresh that the existing suites do not
// cover, both found by the 2026-11-24 audit:
//
//   1. A refresh that loses the rotation race must NOT clear the winner's
//      cookies. Two tabs scheduling their own 12-minute renewals can present
//      the same token within milliseconds; the loser used to answer 401 and
//      call clearCookie, deleting the pair the winner had just set. The user
//      was signed out by a successful refresh.
//
//   2. A session must not slide forever. Every rotation issued a fresh 7-day
//      row, so a session that was used never expired. The absolute cap is
//      carried on the row (`session_started_at`) and survives rotation.
'use strict';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');

const RAW = crypto.randomBytes(48).toString('hex');

const USER = {
  user_id: 'usr-refresh-1',
  audience: null,
  role: 'trainer',
  organization_id: 'org-1',
  token_version: 1,
  is_active: true,
  deleted_at: null,
  session_started_at: null,
};

let mockLookupRows;
let mockClaimWins;
let mockInserted;
let mockClaimCalls;

jest.mock('../../db/pool', () => ({
  query: jest.fn(async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();

    if (/^INSERT INTO refresh_tokens/i.test(q)) {
      mockInserted.push({ sql: q, params });
      return { rows: [], rowCount: 1 };
    }

    if (/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE token_hash/i.test(q)) {
      mockClaimCalls.push(params[0]);
      return { rows: [], rowCount: mockClaimWins ? 1 : 0 };
    }

    if (/FROM refresh_tokens rt JOIN users u/i.test(q)) {
      return { rows: mockLookupRows };
    }

    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../../lib/email', () => ({ sendPasswordReset: jest.fn(async () => ({ sent: true })) }));
jest.mock('../../lib/loginEvents', () => ({ record: jest.fn() }));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: false })),
}));
jest.mock('../../middleware/auth', () => ({
  auth: (_q, _s, next) => next(),
  adminOnly: (_r, _s, n) => n(),
  adminOrManager: (_r, _s, n) => n(),
  invalidateUserCache: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use(require('cookie-parser')());
  a.use('/api/auth', require('../../routes/auth'));
  return a;
}

const refresh = () => request(app())
  .post('/api/auth/refresh')
  .set('Cookie', `refresh_token=${RAW}`)
  .send({});

const clearedCookies = (res) => (res.headers['set-cookie'] || [])
  .filter((c) => /^(refresh_token|token)=;/.test(c));

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  mockLookupRows = [{ ...USER, session_started_at: new Date() }];
  mockClaimWins = true;
  mockInserted = [];
  mockClaimCalls = [];
});

describe('the rotation race', () => {
  test('a request that loses the claim answers 409 and leaves the winner\'s cookies alone', async () => {
    mockClaimWins = false;

    const res = await refresh();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REFRESH_IN_PROGRESS');
    // The pair the winning tab just received must survive. Clearing here is
    // exactly the bug: the loser's 401 used to delete it from the jar.
    expect(clearedCookies(res)).toHaveLength(0);
  });

  test('a token the table says is revoked is still a 401 that clears the cookie', async () => {
    // The 409 must stay narrow. A replay of yesterday's token is not a race;
    // it is a dead credential and the stale cookie should go.
    mockLookupRows = [];

    const res = await refresh();

    expect(res.status).toBe(401);
    expect(mockClaimCalls).toHaveLength(0);
    expect(clearedCookies(res).length).toBeGreaterThan(0);
  });
});

describe('the absolute session cap', () => {
  test('refuses a session older than the cap and clears the cookie', async () => {
    mockLookupRows = [{ ...USER, session_started_at: daysAgo(31) }];

    const res = await refresh();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    expect(clearedCookies(res).length).toBeGreaterThan(0);
    // It must not mint a replacement on the way out.
    expect(mockInserted).toHaveLength(0);
  });

  test('rotates a session inside the cap and carries the start time forward', async () => {
    const startedAt = daysAgo(29);
    mockLookupRows = [{ ...USER, session_started_at: startedAt }];

    const res = await refresh();

    expect(res.status).toBe(200);
    expect(mockInserted).toHaveLength(1);
    const params = mockInserted[0].params;
    // The insert must carry the ORIGINAL start, not NOW(). Without this the
    // cap resets on every rotation and never fires.
    expect(new Date(params[4]).toISOString()).toBe(startedAt.toISOString());
  });
});

'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';

const bcrypt = require('bcryptjs');

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/loginEvents', () => {
  const actual = jest.requireActual('../lib/loginEvents');
  return { ...actual, record: jest.fn() };
});
jest.mock('../lib/googleIdentity', () => ({ verifyGoogleCredential: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const loginEvents = require('../lib/loginEvents');
const { verifyGoogleCredential } = require('../lib/googleIdentity');

const ORG = 'org-a';
const SUB = 'google-sub-1';
const PASSWORD = 'Str0ng!pass';
let HASH;

beforeAll(async () => { HASH = await bcrypt.hash(PASSWORD, 4); });

const row = (over = {}) => ({
  id: 'usr-1', name: 'Owner', email: 'owner@studio.com', role: 'trainer',
  password: HASH, token_version: 0, trainer_id: null, member_id: null,
  pt_client_id: null, is_active: true, deleted_at: null, google_sub: SUB,
  organization_id: ORG, organization_name: 'A Studio', is_founder: false,
  founder_number: null, avatar_url: null, ...over,
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', require('../routes/auth-google'));
  return a;
}

function mockUser(user) {
  pool.query.mockImplementation(async (sql) => {
    if (/FROM users u/.test(sql)) return { rows: user ? [user] : [] };
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  verifyGoogleCredential.mockResolvedValue({
    sub: SUB, email: 'owner@studio.com', email_verified: true,
  });
});

it('signs in a linked account', async () => {
  mockUser(row());
  const res = await request(app()).post('/api/auth/google-login').send({ credential: 'c' });
  expect(res.status).toBe(200);
});

it('asks for a password when the email belongs to an unlinked account', async () => {
  mockUser(row({ google_sub: null }));
  const res = await request(app()).post('/api/auth/google-login').send({ credential: 'c' });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('GOOGLE_LINK_REQUIRED');
  expect(res.headers['set-cookie']).toBeUndefined();
});

it('returns GOOGLE_NO_ACCOUNT for an unknown Google email', async () => {
  mockUser(null);
  const res = await request(app()).post('/api/auth/google-login').send({ credential: 'c' });
  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe('GOOGLE_NO_ACCOUNT');
  expect(res.body.error.email).toBe('owner@studio.com');
  expect(res.headers['set-cookie']).toBeUndefined();
});

it('refuses a disabled account', async () => {
  mockUser(row({ is_active: false }));
  const res = await request(app()).post('/api/auth/google-login').send({ credential: 'c' });
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  expect(res.headers['set-cookie']).toBeUndefined();
});

it('refuses super_admin before minting any session', async () => {
  mockUser(row({ role: 'super_admin', organization_id: null }));
  const res = await request(app()).post('/api/auth/google-login').send({ credential: 'c' });
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('GOOGLE_ACCOUNT_NOT_SUPPORTED');
  expect(res.headers['set-cookie']).toBeUndefined();
});

it('refuses a member at the trainer door and records wrong_portal', async () => {
  mockUser(row({ role: 'member' }));
  const res = await request(app()).post('/api/auth/google-login').send({ credential: 'c' });
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('WRONG_PORTAL');
  expect(res.headers['set-cookie']).toBeUndefined();
  expect(loginEvents.record).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'wrong_portal', method: 'google' })
  );
});

it('admits a member at the member door through the shared policy', async () => {
  mockUser(row({ role: 'member' }));
  const res = await request(app()).post('/api/auth/google-login')
    .send({ credential: 'c', portal: 'member' });
  expect(res.status).toBe(200);
});

it('refuses the platform door outright', async () => {
  mockUser(row());
  const res = await request(app()).post('/api/auth/google-login')
    .send({ credential: 'c', portal: 'platform' });
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('GOOGLE_ACCOUNT_NOT_SUPPORTED');
  expect(res.headers['set-cookie']).toBeUndefined();
});

it('refuses a Google email already linked to another user', async () => {
  mockUser(row({ google_sub: 'someone-elses-sub' }));
  const res = await request(app()).post('/api/auth/google-login').send({ credential: 'c' });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('GOOGLE_ALREADY_LINKED');
});

it('returns 401 for an invalid Google token', async () => {
  verifyGoogleCredential.mockRejectedValue(Object.assign(new Error('bad'), { code: 'GOOGLE_INVALID_CREDENTIAL' }));
  const res = await request(app()).post('/api/auth/google-login').send({ credential: 'c' });
  expect(res.status).toBe(401);
  expect(res.body.error.code).toBe('GOOGLE_INVALID_CREDENTIAL');
});

describe('POST /api/auth/google-link', () => {
  const link = (body = {}) => request(app()).post('/api/auth/google-link').send({
    credential: 'c', password: PASSWORD, ...body,
  });

  it('links and signs in when the Google token and password are both valid', async () => {
    mockUser(row({ google_sub: null }));
    const res = await link();

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('owner@studio.com');
    expect(res.headers['set-cookie'].join(';')).toMatch(/refresh_token=/);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('google_linked_at = NOW()'),
      ['usr-1', SUB]
    );
  });

  it('refuses the wrong password without linking or setting cookies', async () => {
    mockUser(row({ google_sub: null }));
    const res = await link({ password: 'not-the-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('GOOGLE_LINK_INVALID_PASSWORD');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('google_linked_at = NOW()'),
      expect.anything()
    );
  });

  it('refuses an account already linked to a different Google subject', async () => {
    mockUser(row({ google_sub: 'another-sub' }));
    const res = await link();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GOOGLE_ALREADY_LINKED');
  });

  it('refuses a super_admin', async () => {
    mockUser(row({ role: 'super_admin', organization_id: null, google_sub: null }));
    const res = await link();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GOOGLE_ACCOUNT_NOT_SUPPORTED');
  });

  it('refuses an account with no password to prove', async () => {
    mockUser(row({ google_sub: null, password: null }));
    const res = await link();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GOOGLE_LINK_UNAVAILABLE');
  });

  it('does not link an account at the wrong door', async () => {
    mockUser(row({ role: 'member', google_sub: null }));
    const res = await link();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WRONG_PORTAL');
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('google_linked_at = NOW()'),
      expect.anything()
    );
  });

  it('turns a unique violation into GOOGLE_ALREADY_LINKED', async () => {
    mockUser(row({ google_sub: null }));
    pool.query.mockImplementationOnce(async () => ({ rows: [row({ google_sub: null })] }));
    pool.query.mockImplementationOnce(async (sql) => {
      if (/google_linked_at = NOW\(\)/.test(sql)) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      return { rows: [], rowCount: 1 };
    });

    const res = await link();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GOOGLE_ALREADY_LINKED');
  });
});

it('puts google-link behind both login limiters', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf('const LOGIN_PATHS');
  const paths = src.slice(start, src.indexOf('];', start));
  expect(paths).toContain("'/api/auth/google-link'");
  expect(paths).toContain("'/api/v1/auth/google-link'");
});

it('selects every column the session payload and link flow need', () => {
  // The pool is mocked in every test here, so a column the real schema does
  // not have would 500 every Google sign-in with the suite still green. Pin
  // the selection to the names the rest of the auth code already uses.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'auth-google.js'), 'utf8',
  );
  for (const fragment of [
    'u.password', 'u.token_version', 'u.organization_id',
    'o.name AS organization_name', 'o.logo_url AS organization_logo_url',
    'o.is_founder', 'o.founder_number', 'up.avatar_url',
  ]) {
    expect(src).toContain(fragment);
  }
});

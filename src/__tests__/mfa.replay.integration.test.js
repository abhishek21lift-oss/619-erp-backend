'use strict';
// A TOTP code signs the operator in once, not once per request inside its
// window (Command Center audit 2026-09-28, CC-8).
//
// Real database, real login route: the protection is a conditional UPDATE on
// user_profiles.mfa_last_step (migration 216), and a mocked pool would return
// whatever the fixture said. otplib is stubbed because its ESM dependencies do
// not load under Jest (see auth.portal.test.js); the stub reports a valid code
// and the time-step it matched, which is exactly what the route reads.

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('TOTP replay at sign-in, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the TOTP replay proof would skip.');
    });
  });
}

let mockStep = 1000;
jest.mock('otplib', () => ({
  verifySync: jest.fn(({ token }) => ({ valid: token === '123456', timeStep: mockStep })),
  authenticator: { verify: jest.fn(() => false), generateSecret: jest.fn(() => 'S') },
}));

let mockRealPool;
jest.mock('../db/pool', () => ({
  query: (...args) => mockRealPool.query(...args),
  connect: (...args) => mockRealPool.connect(...args),
}));
jest.mock('../lib/loginEvents', () => {
  const actual = jest.requireActual('../lib/loginEvents');
  return { ...actual, record: jest.fn() };
});
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const request = require('supertest');
const express = require('express');

describeIf('TOTP replay at sign-in, against a real database', () => {
  const USER_ID = 'mfa-replay-operator';
  const EMAIL = 'mfa-replay-operator@example.test';
  const PASSWORD = 'correct horse battery staple';
  let app;

  const login = (code) => request(app).post('/api/auth/login')
    .send({ email: EMAIL, password: PASSWORD, portal: 'platform', mfa_code: code });

  beforeAll(async () => {
    mockRealPool = new Pool({ connectionString: DB_URL, max: 4 });
    const hash = await bcrypt.hash(PASSWORD, 4);
    await mockRealPool.query(
      `INSERT INTO users (id, name, email, password, role, is_active)
       VALUES ($1, 'Replay Operator', $2, $3, 'super_admin', TRUE)
       ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password, deleted_at = NULL, is_active = TRUE`,
      [USER_ID, EMAIL, hash]
    );
    await mockRealPool.query(
      `INSERT INTO user_profiles (user_id, mfa_enabled, mfa_secret) VALUES ($1, TRUE, 'SECRET')
       ON CONFLICT (user_id) DO UPDATE SET mfa_enabled = TRUE, mfa_secret = 'SECRET', mfa_last_step = NULL`,
      [USER_ID]
    );
    await mockRealPool.query(
      'INSERT INTO platform_owners (user_id, note) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [USER_ID, 'mfa.replay.integration.test']
    );
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
  });

  afterAll(async () => {
    await mockRealPool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [USER_ID]).catch(() => {});
    await mockRealPool.query('DELETE FROM platform_owners WHERE user_id = $1', [USER_ID]);
    await mockRealPool.query('DELETE FROM user_profiles WHERE user_id = $1', [USER_ID]);
    await mockRealPool.query('DELETE FROM users WHERE id = $1', [USER_ID]);
    await mockRealPool.end();
  });

  it('accepts a code once, then refuses the same code in the same step', async () => {
    mockStep = 5000;
    expect((await login('123456')).status).toBe(200);

    const replay = await login('123456');
    expect(replay.status).toBe(401);
    expect(replay.body.mfaRequired).toBe(true);
  });

  it('refuses a code from an earlier step once a later one has been used', async () => {
    mockStep = 6000;
    expect((await login('123456')).status).toBe(200);
    mockStep = 5999; // the previous step, still inside the tolerance window
    expect((await login('123456')).status).toBe(401);
  });

  it('accepts the next step normally', async () => {
    mockStep = 6001;
    expect((await login('123456')).status).toBe(200);
  });

  it('two concurrent logins with one code: exactly one succeeds', async () => {
    mockStep = 7000;
    const [a, b] = await Promise.all([login('123456'), login('123456')]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });
});

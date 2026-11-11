'use strict';
// Native device credentials live in user_webauthn_credentials but are not
// WebAuthn credentials: their ids are `native:<deviceId>` and the browser
// cannot sign with them. If they leak into excludeCredentials / allowCredentials
// every passkey ceremony silently breaks for that user.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.RP_ID = process.env.RP_ID || 'example.com';
process.env.WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://example.com';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/loginEvents', () => ({ record: jest.fn(), OUTCOMES: { SUCCESS: 'success' } }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: USER, organization_id: ORG, role: 'trainer', name: 'Test Trainer' }; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));
jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(async () => ({ challenge: 'reg-challenge' })),
  generateAuthenticationOptions: jest.fn(async () => ({ challenge: 'auth-challenge' })),
}));

const pool = require('../db/pool');
const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth/webauthn', require('../routes/auth-webauthn'));
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation(async (sql) => {
    if (/FROM users/.test(sql)) return { rows: [{ id: USER }] };
    if (/FROM user_webauthn_credentials/.test(sql)) {
      return { rows: [{ credential_id: 'passkey-1', transports: [], device_name: 'Pixel' }] };
    }
    return { rows: [], rowCount: 1 };
  });
});

function credentialSelects() {
  return pool.query.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => /FROM user_webauthn_credentials/.test(sql));
}

it('filters native rows out of registration excludeCredentials', async () => {
  const res = await request(app()).post('/api/auth/webauthn/register/options').send({});
  expect(res.status).toBe(200);
  const selects = credentialSelects();
  expect(selects.length).toBeGreaterThan(0);
  expect(selects[0]).toContain("NOT LIKE 'native:%'");
});

it('filters native rows out of login allowCredentials', async () => {
  const res = await request(app())
    .post('/api/auth/webauthn/login/options')
    .send({ email: 'trainer@example.com' });
  expect(res.status).toBe(200);
  const selects = credentialSelects();
  expect(selects.length).toBeGreaterThan(0);
  expect(selects.some((sql) => sql.includes("NOT LIKE 'native:%'"))).toBe(true);
});

it('filters native rows out of action allowCredentials', async () => {
  const res = await request(app()).post('/api/auth/webauthn/action/options').send({});
  expect(res.status).toBe(200);
  const selects = credentialSelects();
  expect(selects.some((sql) => sql.includes("NOT LIKE 'native:%'"))).toBe(true);
});

it('lists credential_id so the client can match this phone', async () => {
  const res = await request(app()).get('/api/auth/webauthn/credentials');
  expect(res.status).toBe(200);
  const select = credentialSelects()[0];
  expect(select).toMatch(/SELECT[^]*credential_id/);
  expect(res.body.credentials[0].credential_id).toBe('passkey-1');
});

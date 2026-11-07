'use strict';
// Regression for "fingerprint login shows PT Studio instead of the real studio".
//
// The client adopts the passkey login response as the signed-in user and does
// not fetch /api/auth/me afterwards. Returning a partial user therefore made
// the shell fall back to "PT Studio", a generic mark, and no billing link
// until a hard reload. This pins the response to the same session shape as
// POST /api/auth/login.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.RP_ID = process.env.RP_ID || 'example.com';
process.env.WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://example.com';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CRED = 'cred-1';

const userRow = {
  id: USER,
  name: 'Abhishek Katiyar',
  email: 'abhishekkatiyar@gmail.com',
  role: 'trainer',
  trainer_id: 'trn-1',
  pt_client_id: null,
  token_version: 0,
  organization_id: ORG,
  organization_name: 'ABHISHEK PT STUDIO',
  organization_logo_url: '/uploads/studio.png',
  is_founder: true,
  founder_number: 7,
  avatar_url: '/uploads/avatar.png',
};

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/loginEvents', () => ({ record: jest.fn(), OUTCOMES: { SUCCESS: 'success' } }));
jest.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: jest.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })),
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

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation(async (sql) => {
    if (/FROM user_webauthn_credentials/.test(sql)) {
      return {
        rows: [{
          credential_id: CRED,
          public_key: Buffer.from('key').toString('base64url'),
          counter: 0,
          transports: [],
          user_id: USER,
          is_active: true,
        }],
      };
    }
    if (/FROM webauthn_challenges/.test(sql)) return { rows: [{ challenge: 'challenge-1' }] };
    if (/FROM users\b/.test(sql)) return { rows: [userRow] };
    return { rows: [], rowCount: 1 };
  });
});

it('returns the studio fields the shell needs, like password login', async () => {
  const res = await request(app())
    .post('/api/auth/webauthn/login/verify')
    .send({
      authentication: {
        id: CRED,
        response: { clientDataJSON: b64url({ challenge: 'challenge-1' }) },
      },
    });

  expect(res.status).toBe(200);
  expect(res.body.user).toEqual(expect.objectContaining({
    id: USER,
    name: 'Abhishek Katiyar',
    email: 'abhishekkatiyar@gmail.com',
    role: 'trainer',
    organization_id: ORG,
    organization_name: 'ABHISHEK PT STUDIO',
    organization_logo_url: '/uploads/studio.png',
    is_founder: true,
    founder_number: 7,
    avatar_url: '/uploads/avatar.png',
  }));
});

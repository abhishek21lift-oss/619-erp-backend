'use strict';
// Registration ceremony for the Android device credential.
//
// The phone holds an EC P-256 key in the Android Keystore and sends only the
// public half. The server stores it in user_webauthn_credentials under
// credential_id = native:<deviceId>, which is why this test pins the exact id
// shape and the SPKI encoding the bridge produces.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const crypto = require('crypto');
const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

const mockState = { user: { id: USER, organization_id: ORG, role: 'trainer', name: 'Test Trainer' } };

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockState.user; next(); },
  requireTrainer: (_req, _res, next) => next(),
}));

const pool = require('../db/pool');
const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth/device', require('../routes/auth-device'));
  a.use(errorHandler);
  return a;
}

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, spki };
}

function sign(privateKey, message) {
  return crypto.sign('sha256', Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

let consumedRows = [{ user_id: USER }];

beforeEach(() => {
  jest.clearAllMocks();
  consumedRows = [{ user_id: USER }];
  pool.query.mockImplementation(async (sql) => {
    if (/INSERT INTO webauthn_challenges/.test(sql)) return { rows: [], rowCount: 1 };
    if (/DELETE FROM webauthn_challenges/.test(sql)) return { rows: consumedRows };
    if (/INSERT INTO user_webauthn_credentials/.test(sql)) return { rows: [{ id: 'cred-row-1' }] };
    return { rows: [], rowCount: 1 };
  });
});

it('register/options stores a device_registration challenge for the signed-in user', async () => {
  const res = await request(app()).post('/api/auth/device/register/options').send({});

  expect(res.status).toBe(200);
  expect(res.body.challenge).toMatch(/^[0-9a-f]{64}$/);
  const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO webauthn_challenges/.test(sql));
  expect(insert).toBeTruthy();
  expect(insert[1]).toEqual([res.body.challenge, USER, 'device_registration']);
});

it('register/verify stores the public key under native:<deviceId>', async () => {
  const { privateKey, spki } = keyPair();
  const opts = await request(app()).post('/api/auth/device/register/options').send({});
  const challenge = opts.body.challenge;
  const deviceId = 'ab'.repeat(16);

  const res = await request(app())
    .post('/api/auth/device/register/verify')
    .send({
      challenge,
      deviceId,
      publicKey: spki,
      signature: sign(privateKey, `MPS-DEVICE-REGISTER-V1\n${challenge}`),
      label: 'Pixel 8',
    });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, deviceId });

  const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO user_webauthn_credentials/.test(sql));
  expect(insert).toBeTruthy();
  expect(insert[0]).toMatch(/'native:'\s*\|\|\s*\$3/);
  expect(insert[0]).toContain("'android_native'");
  expect(insert[1][0]).toBe(USER);
  expect(insert[1][1]).toBe(ORG);
  expect(insert[1][2]).toBe(deviceId);
  expect(insert[1][4]).toBe('Pixel 8');
  const der = Buffer.from(insert[1][3], 'base64');
  expect(der[0]).toBe(0x30);
  expect(der[1]).toBe(0x59);
});

it('a signature over the login message does not register a credential', async () => {
  const { privateKey, spki } = keyPair();
  const opts = await request(app()).post('/api/auth/device/register/options').send({});
  const challenge = opts.body.challenge;

  const res = await request(app())
    .post('/api/auth/device/register/verify')
    .send({
      challenge,
      deviceId: 'cd'.repeat(16),
      publicKey: spki,
      signature: sign(privateKey, `MPS-DEVICE-LOGIN-V1\n${challenge}`),
    });

  expect(res.status).toBe(401);
  expect(pool.query.mock.calls.some(([sql]) => /INSERT INTO user_webauthn_credentials/.test(sql))).toBe(false);
});

it('rejects a deviceId that is not 32 lowercase hex characters', async () => {
  const { privateKey, spki } = keyPair();
  const opts = await request(app()).post('/api/auth/device/register/options').send({});
  const challenge = opts.body.challenge;

  const res = await request(app())
    .post('/api/auth/device/register/verify')
    .send({
      challenge,
      deviceId: 'NOT-HEX',
      publicKey: spki,
      signature: sign(privateKey, `MPS-DEVICE-REGISTER-V1\n${challenge}`),
    });

  expect(res.status).toBe(400);
});

it('rejects an expired or already consumed challenge', async () => {
  const { privateKey, spki } = keyPair();
  const opts = await request(app()).post('/api/auth/device/register/options').send({});
  const challenge = opts.body.challenge;
  consumedRows = [];

  const res = await request(app())
    .post('/api/auth/device/register/verify')
    .send({
      challenge,
      deviceId: 'ef'.repeat(16),
      publicKey: spki,
      signature: sign(privateKey, `MPS-DEVICE-REGISTER-V1\n${challenge}`),
    });

  expect(res.status).toBe(401);
});

it('refuses platform operators and accounts without a studio on both endpoints', async () => {
  mockState.user = { id: USER, organization_id: null, role: 'super_admin' };

  const options = await request(app()).post('/api/auth/device/register/options').send({});
  expect(options.status).toBe(403);

  const verify = await request(app()).post('/api/auth/device/register/verify').send({
    challenge: 'a'.repeat(64),
    deviceId: 'ab'.repeat(16),
    publicKey: 'x',
    signature: 'y',
  });
  expect(verify.status).toBe(403);

  mockState.user = { id: USER, organization_id: ORG, role: 'trainer', name: 'Test Trainer' };
});

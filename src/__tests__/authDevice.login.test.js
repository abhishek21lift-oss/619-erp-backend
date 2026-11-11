'use strict';
// Login ceremony for the Android device credential.
//
// The door takes no email: the device id selects the account. Two properties
// matter more than the happy path:
//   - DEVICE_CREDENTIAL_REVOKED is only revealed after a signature verifies,
//     so a guessed device id cannot be probed;
//   - the session is the same cookie session as password / passkey login.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const crypto = require('crypto');
const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = 'ab'.repeat(16);

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
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());

const pool = require('../db/pool');
const loginEvents = require('../lib/loginEvents');
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
  return {
    privateKey,
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

function sign(privateKey, message) {
  return crypto.sign('sha256', Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

let state;

beforeEach(() => {
  jest.clearAllMocks();
  state = {
    credential: { ...userRow, public_key: null, is_active: true, deleted_at: null, user_id: USER },
    knownDevice: true,
    consumed: [{ user_id: USER }],
  };
  pool.query.mockImplementation(async (sql, _params) => {
    if (/FROM user_webauthn_credentials/.test(sql)) {
      // /login/verify selects the public key; /login/options does not.
      if (/c\.public_key/.test(sql)) {
        return { rows: state.credential ? [state.credential] : [] };
      }
      // /login/options: known active device only.
      return { rows: state.knownDevice ? [{ user_id: USER }] : [] };
    }
    if (/INSERT INTO webauthn_challenges/.test(sql)) return { rows: [] };
    if (/DELETE FROM webauthn_challenges/.test(sql)) return { rows: state.consumed };
    if (/INSERT INTO refresh_tokens/.test(sql)) return { rows: [{ id: 'rt-1' }] };
    return { rows: [], rowCount: 1 };
  });
});

function requestCode(portal) {
  return request(app()).post('/api/auth/device/login/options').send({ deviceId: DEVICE_ID, portal });
}

function login(challenge, privateKey, extra = {}) {
  return request(app())
    .post('/api/auth/device/login/verify')
    .send({
      deviceId: DEVICE_ID,
      challenge,
      signature: sign(privateKey, `MPS-DEVICE-LOGIN-V1\n${challenge}`),
      ...extra,
    });
}

it('binds a known device challenge to the user and an unknown one to nobody', async () => {
  const known = await requestCode('trainer');
  expect(known.status).toBe(200);
  expect(known.body.challenge).toMatch(/^[0-9a-f]{64}$/);
  let insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO webauthn_challenges/.test(sql));
  expect(insert[1]).toEqual([known.body.challenge, USER, 'device_authentication']);

  state.knownDevice = false;
  const unknown = await requestCode('trainer');
  expect(unknown.status).toBe(200);
  expect(unknown.body.challenge).toMatch(/^[0-9a-f]{64}$/);
  insert = pool.query.mock.calls.filter(([sql]) => /INSERT INTO webauthn_challenges/.test(sql)).pop();
  expect(insert[1]).toEqual([unknown.body.challenge, null, 'device_authentication']);
});

it('signs in with a valid signature and issues the standard cookie session', async () => {
  const { privateKey, spki } = keyPair();
  state.credential.public_key = spki;

  const opts = await requestCode('trainer');
  const res = await login(opts.body.challenge, privateKey);

  expect(res.status).toBe(200);
  expect(res.body.user).toEqual(expect.objectContaining({
    id: USER,
    name: 'Abhishek Katiyar',
    email: 'abhishekkatiyar@gmail.com',
    role: 'trainer',
    organization_id: ORG,
    organization_name: 'ABHISHEK PT STUDIO',
    trainer_id: 'trn-1',
    pt_client_id: null,
    is_founder: true,
    founder_number: 7,
    avatar_url: '/uploads/avatar.png',
  }));
  const cookies = res.headers['set-cookie'] || [];
  expect(cookies.find((c) => c.startsWith('trainer_token='))).toBeTruthy();
  expect(cookies.find((c) => c.startsWith('trainer_refresh='))).toBeTruthy();
  expect(pool.query.mock.calls.some(([sql]) => /INSERT INTO refresh_tokens/.test(sql))).toBe(true);
  expect(loginEvents.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    outcome: 'success', method: 'passkey', userId: USER,
  }));
});

it('rejects a wrong signature without cookies or a refresh token', async () => {
  const good = keyPair();
  const other = keyPair();
  state.credential.public_key = good.spki;

  const opts = await requestCode('trainer');
  const res = await login(opts.body.challenge, other.privateKey);

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'Sign-in failed. Use your password.' });
  expect(res.headers['set-cookie']).toBeUndefined();
  expect(pool.query.mock.calls.some(([sql]) => /INSERT INTO refresh_tokens/.test(sql))).toBe(false);
});

it('says the credential was revoked only after its signature verifies', async () => {
  const { privateKey, spki } = keyPair();
  state.credential.public_key = spki;
  state.credential.deleted_at = '2026-11-01T00:00:00Z';

  const opts = await requestCode('trainer');
  const revoked = await login(opts.body.challenge, privateKey);

  expect(revoked.status).toBe(401);
  expect(revoked.body.error).toEqual(expect.objectContaining({
    code: 'DEVICE_CREDENTIAL_REVOKED',
    message: 'Fingerprint sign-in was turned off for this phone.',
  }));

  // Same revoked row, wrong key: the caller learns nothing.
  const other = keyPair();
  const opts2 = await requestCode('trainer');
  const probe = await login(opts2.body.challenge, other.privateKey);
  expect(probe.status).toBe(401);
  expect(probe.body).toEqual({ error: 'Sign-in failed. Use your password.' });
});

it('rejects a challenge that was already consumed or has expired', async () => {
  const { privateKey, spki } = keyPair();
  state.credential.public_key = spki;
  state.consumed = [];

  const opts = await requestCode('trainer');
  const res = await login(opts.body.challenge, privateKey);

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'Sign-in failed. Use your password.' });
});

it('mints a member session at the member door and refuses the trainer door', async () => {
  const { privateKey, spki } = keyPair();
  state.credential = { ...state.credential, role: 'member', public_key: spki };

  const memberOpts = await requestCode('member');
  const member = await login(memberOpts.body.challenge, privateKey, { portal: 'member' });
  expect(member.status).toBe(200);
  expect((member.headers['set-cookie'] || []).find((c) => c.startsWith('member_token='))).toBeTruthy();

  const trainerOpts = await requestCode('trainer');
  const wrong = await login(trainerOpts.body.challenge, privateKey, { portal: 'trainer' });
  expect(wrong.status).toBe(403);
  expect(wrong.body.error.code).toBe('WRONG_PORTAL');
});

it('rejects an inactive or deleted user as a generic failure', async () => {
  const { privateKey, spki } = keyPair();
  state.credential.public_key = spki;
  // The verify query joins an active user, so a disabled account looks absent.
  state.credential = null;

  const opts = await requestCode('trainer');
  const res = await login(opts.body.challenge, privateKey);

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'Sign-in failed. Use your password.' });
});

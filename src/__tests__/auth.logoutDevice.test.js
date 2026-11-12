// Logout must end the session and retire the device in the same request.
//
// The web client used to fire DELETE /api/v1/devices alongside POST
// /api/auth/logout; whichever lost the race left a live FCM token behind, and
// the next notification on a shared device reached the previous account. These
// tests pin the server half: ownership comes from the refresh token, never
// from the request body, and a retried logout still cleans up.

'use strict';

process.env.JWT_SECRET = 's'.repeat(64);
process.env.DATABASE_URL = 'postgres://test';
process.env.NODE_ENV = 'test';
process.env.TENANT_RLS_ENFORCE = 'off';

const crypto = require('crypto');

const DEVICE = 'fcm_token_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';

let mockRefreshRows; // token_hash -> { user_id, revoked_at }
let mockDeviceRows;  // token -> { user_id, revoked_at, revoked_reason }
let mockFailDeviceUpdate;
const mockQueries = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: q, params });

    if (q.startsWith('SELECT user_id FROM refresh_tokens')) {
      const row = mockRefreshRows.get(params[0]);
      return { rows: row ? [{ user_id: row.user_id }] : [], rowCount: row ? 1 : 0 };
    }

    if (q.startsWith('UPDATE refresh_tokens SET revoked_at')) {
      const row = mockRefreshRows.get(params[0]);
      if (row) row.revoked_at = new Date();
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (q.startsWith('UPDATE device_tokens')) {
      if (mockFailDeviceUpdate) throw new Error('device_tokens unavailable');
      // Real query: WHERE token = $1 AND user_id = $2 AND revoked_at IS NULL
      const row = mockDeviceRows.get(params[0]);
      const hit = row && row.user_id === params[1] && !row.revoked_at;
      if (hit) {
        row.revoked_at = new Date();
        row.revoked_reason = params[2];
      }
      return { rows: [], rowCount: hit ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../lib/loginEvents', () => ({ record: jest.fn() }));
jest.mock('../lib/email', () => ({ sendPasswordReset: jest.fn(async () => ({ sent: true })) }));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(() => 'JBSWY3DPEHPK3PXP'),
  verifySync: jest.fn(() => ({ valid: false })),
}));

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');

const logger = require('../lib/logger');

// middleware/auth derives everything from the pool; the logout route itself is
// unauthenticated, so only the module import needs to succeed.
require('../middleware/auth');

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/auth', require('../routes/auth'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

function seedRefresh({ userId, raw = 'refresh-raw' }) {
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  mockRefreshRows.set(hash, { user_id: userId, revoked_at: null });
  return raw;
}

beforeEach(() => {
  mockRefreshRows = new Map();
  mockDeviceRows = new Map();
  mockFailDeviceUpdate = false;
  mockQueries.length = 0;
  jest.clearAllMocks();
});

describe('POST /api/auth/logout device revocation', () => {
  it('revokes the session and its device token in one request', async () => {
    const raw = seedRefresh({ userId: 'usr-1' });
    mockDeviceRows.set(DEVICE, { user_id: 'usr-1', revoked_at: null });

    const res = await request(app())
      .post('/api/auth/logout')
      .send({ refresh_token: raw, device_token: DEVICE });

    expect(res.status).toBe(200);
    expect(mockRefreshRows.values().next().value.revoked_at).toBeInstanceOf(Date);
    expect(mockDeviceRows.get(DEVICE).revoked_at).toBeInstanceOf(Date);
    expect(mockDeviceRows.get(DEVICE).revoked_reason).toBe('logout');
  });

  it('a replayed logout still revokes a device the first response never confirmed', async () => {
    const raw = seedRefresh({ userId: 'usr-1' });
    mockRefreshRows.values().next().value.revoked_at = new Date(); // first attempt got this far
    mockDeviceRows.set(DEVICE, { user_id: 'usr-1', revoked_at: null });

    const res = await request(app())
      .post('/api/auth/logout')
      .send({ refresh_token: raw, device_token: DEVICE });

    expect(res.status).toBe(200);
    expect(mockDeviceRows.get(DEVICE).revoked_at).toBeInstanceOf(Date);
  });

  it('cannot revoke a token owned by another account', async () => {
    const raw = seedRefresh({ userId: 'usr-1' });
    mockDeviceRows.set(DEVICE, { user_id: 'usr-2', revoked_at: null });

    const res = await request(app())
      .post('/api/auth/logout')
      .send({ refresh_token: raw, device_token: DEVICE });

    expect(res.status).toBe(200);
    // The owner comes from the refresh token, so the update never matches.
    expect(mockDeviceRows.get(DEVICE).revoked_at).toBeNull();
    const update = mockQueries.find((x) => x.sql.startsWith('UPDATE device_tokens'));
    expect(update.params[1]).toBe('usr-1');
  });

  it('ignores a malformed device token instead of failing the logout', async () => {
    const raw = seedRefresh({ userId: 'usr-1' });

    const res = await request(app())
      .post('/api/auth/logout')
      .send({ refresh_token: raw, device_token: 'not a token!' });

    expect(res.status).toBe(200);
    expect(mockQueries.some((x) => x.sql.startsWith('UPDATE device_tokens'))).toBe(false);
    expect(mockRefreshRows.values().next().value.revoked_at).toBeInstanceOf(Date);
  });

  it('a device-table failure does not trap the user in the session', async () => {
    const raw = seedRefresh({ userId: 'usr-1' });
    mockDeviceRows.set(DEVICE, { user_id: 'usr-1', revoked_at: null });
    mockFailDeviceUpdate = true;

    const res = await request(app())
      .post('/api/auth/logout')
      .send({ refresh_token: raw, device_token: DEVICE });

    expect(res.status).toBe(200);
    expect(mockRefreshRows.values().next().value.revoked_at).toBeInstanceOf(Date);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'device_tokens unavailable' }),
      'logout device revoke failed'
    );
  });

  it('still answers 200 when the refresh token is absent or unknown', async () => {
    const res = await request(app()).post('/api/auth/logout').send({ device_token: DEVICE });
    expect(res.status).toBe(200);
    expect(mockQueries.some((x) => x.sql.startsWith('UPDATE device_tokens'))).toBe(false);
  });
});

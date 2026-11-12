'use strict';
// Device registration is authenticated and tenant-derived. The body may name a
// token; it may not name a user or an organization.

const TOKEN = 'fcm_token_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
const mockQueries = [];
let mockResponder = () => ({ rows: [], rowCount: 0 });
let mockCurrentUser = { id: 'usr-trainer', role: 'trainer', organization_id: 'org-self' };

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: normalized, params: params || [] });
    return mockResponder(normalized);
  }),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/devices', require('../modules/devices/devices.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

beforeEach(() => {
  mockQueries.length = 0;
  mockResponder = () => ({ rows: [], rowCount: 0 });
  mockCurrentUser = { id: 'usr-trainer', role: 'trainer', organization_id: 'org-self' };
});

describe('POST /api/v1/devices', () => {
  it('registers the token against the session user and tenant', async () => {
    mockResponder = () => ({ rows: [{ id: 'dev-1', app: 'studio', last_seen_at: '2026-11-10T00:00:00Z' }], rowCount: 1 });

    const res = await request(app())
      .post('/api/v1/devices')
      .send({ token: TOKEN, platform: 'android' })
      .expect(200);

    expect(res.body.data.app).toBe('studio');
    const insert = mockQueries.find((q) => q.sql.startsWith('INSERT INTO device_tokens'));
    expect(insert).toBeTruthy();
    expect(insert.params).toEqual(['usr-trainer', 'org-self', TOKEN, 'android', 'studio']);
    // Re-registering the same token moves it to the current account and
    // clears any earlier revocation instead of leaving a stale owner behind.
    expect(insert.sql).toContain('ON CONFLICT (token) DO UPDATE');
    expect(insert.sql).toContain('user_id = EXCLUDED.user_id');
    expect(insert.sql).toContain('organization_id = EXCLUDED.organization_id');
    expect(insert.sql).toContain('revoked_at = NULL');
  });

  it('moves a shared device to the second account that signs in', async () => {
    mockCurrentUser = { id: 'usr-second', role: 'member', organization_id: 'org-second' };
    mockResponder = () => ({ rows: [{ id: 'dev-1', app: 'member', last_seen_at: '2026-11-11T00:00:00Z' }], rowCount: 1 });

    await request(app())
      .post('/api/v1/devices')
      .send({ token: TOKEN })
      .expect(200);

    const insert = mockQueries.find((q) => q.sql.startsWith('INSERT INTO device_tokens'));
    expect(insert.params).toEqual(['usr-second', 'org-second', TOKEN, 'android', 'member']);
  });

  it('derives the member app from the role', async () => {
    mockCurrentUser = { id: 'usr-member', role: 'member', organization_id: 'org-self' };
    mockResponder = () => ({ rows: [{ id: 'dev-2', app: 'member', last_seen_at: '2026-11-10T00:00:00Z' }], rowCount: 1 });

    const res = await request(app())
      .post('/api/v1/devices')
      .send({ token: TOKEN })
      .expect(200);

    expect(res.body.data.app).toBe('member');
    const insert = mockQueries.find((q) => q.sql.startsWith('INSERT INTO device_tokens'));
    expect(insert.params[4]).toBe('member');
    expect(insert.params[3]).toBe('android');
  });

  it('refuses a body that tries to name the tenant or the user', async () => {
    await request(app())
      .post('/api/v1/devices')
      .send({ token: TOKEN, organization_id: 'org-other', user_id: 'usr-other' })
      .expect(400);

    expect(mockQueries).toHaveLength(0);
  });

  it('refuses a token that cannot be an FCM token', async () => {
    await request(app())
      .post('/api/v1/devices')
      .send({ token: 'not a token!' })
      .expect(400);

    expect(mockQueries).toHaveLength(0);
  });

  it('refuses an account with no studio', async () => {
    mockCurrentUser = { id: 'usr-x', role: 'trainer', organization_id: null };
    await request(app())
      .post('/api/v1/devices')
      .send({ token: TOKEN })
      .expect(403);
  });
});

describe('DELETE /api/v1/devices', () => {
  it('revokes only the caller own token', async () => {
    await request(app())
      .delete('/api/v1/devices')
      .send({ token: TOKEN })
      .expect(204);

    const update = mockQueries.find((q) => q.sql.startsWith('UPDATE device_tokens'));
    expect(update).toBeTruthy();
    expect(update.params).toEqual([TOKEN, 'usr-trainer', 'logout']);
    // The user filter is what stops a logout on one account revoking a token
    // that has since moved to another account on the same device.
    expect(update.sql).toContain('WHERE token = $1 AND user_id = $2 AND revoked_at IS NULL');
  });

  it('is silent for a token it does not own', async () => {
    mockResponder = () => ({ rows: [], rowCount: 0 });
    await request(app())
      .delete('/api/v1/devices')
      .send({ token: TOKEN })
      .expect(204);
  });
});

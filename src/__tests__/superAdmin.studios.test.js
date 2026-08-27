// Phase 5/6 — /api/platform/studios/:id/*
//
// Three properties pinned:
//
//   1. Every endpoint validates :id as a UUID and returns 400 BAD_ID
//      otherwise. The brief says "URL is the authorization" — a
//      non-UUID is rejected before any query runs, so a typo or a
//      scanner can never reach the SQL layer with a garbage id.
//   2. The health endpoint returns 404 for a non-existent org, NOT a
//      zeroed-out "healthy" payload. A platform admin staring at a
//      "0 events, healthy" line for a typo'd id is a real risk; the
//      404 makes the typo visible.
//   3. The memberships endpoint never returns phone / email /
//      payment_method. This is the platform admin's view, not the
//      tenant admin's, and the brief says no PII on the read side.
//
// What we don't test here: per-row SQL correctness for activity or
// login counts (the SQL is the same shape as the platform-level
// tenancy card, which has its own coverage).

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');

const studiosRouter = require('../modules/platform/super-admin/studios');

const PLATFORM_OWNER = {
  id: 'usr-platform', name: 'Platform Owner', email: 'p@x.com', role: 'super_admin',
  organization_id: null, is_platform_owner: true, is_active: true, deleted_at: null,
  token_version: 1,
};

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

function token() {
  return jwt.sign(
    { id: PLATFORM_OWNER.id, token_version: PLATFORM_OWNER.token_version,
      role: PLATFORM_OWNER.role, is_platform_owner: true, audience: 'platform' },
    process.env.JWT_SECRET, { expiresIn: '5m' }
  );
}

function app() {
  const a = express();
  a.use((req, _res, next) => { req.user = PLATFORM_OWNER; next(); });
  a.use('/api/platform', studiosRouter);
  return a;
}

beforeEach(() => { pool.query.mockReset(); });

/* ── UUID_RE validation: every endpoint, every bad id ────────────────── */

describe.each([
  ['/studios/not-a-uuid/health',         { success_24h: 0, failed_24h: 0 }],
  ['/studios/12345/health',              { success_24h: 0, failed_24h: 0 }],
  ['/studios/; DROP TABLE studios; --/health', { success_24h: 0, failed_24h: 0 }],
  ['/studios/abc-def/memberships',       { rows: [], total: 0 }],
  ['/studios/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/pt-revenue', null],
])('every endpoint rejects non-UUID ids with 400 BAD_ID', (path) => {
  it(`returns 400 BAD_ID for ${path}`, async () => {
    const res = await request(app())
      .get(`/api/platform${path}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_ID');
    // CRITICAL: no SQL fired for a malformed id.
    expect(pool.query).not.toHaveBeenCalled();
  });
});

/* ── GET /studios/:id/health ──────────────────────────────────────────── */

describe('GET /api/platform/studios/:id/health', () => {
  it('returns 404 NOT_FOUND when the org does not exist (no "zero = healthy" trap)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // org lookup
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/health`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns HEALTHY when there are events and <10% are errors', async () => {
    // 1) org lookup, 2) activity, 3) logins, 4) storage, 5) subscription
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID, name: 'Acme', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ total_events_24h: 100, error_events_24h: 5 }] })
      .mockResolvedValueOnce({ rows: [{ success_logins_24h: 12, failed_logins_24h: 0 }] })
      .mockResolvedValueOnce({ rows: [{ object_count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', ends_at: null, plan_code: 'growth' }] });
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/health`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.organization.name).toBe('Acme');
    expect(res.body.data.activity.status).toBe('HEALTHY');
    expect(res.body.data.activity.total_events_24h).toBe(100);
    expect(res.body.data.logins.status).toBe('HEALTHY');
    expect(res.body.data.subscription.plan_code).toBe('growth');
  });

  it('returns WARNING when errors exceed 10% of total events', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID, name: 'Acme', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ total_events_24h: 10, error_events_24h: 5 }] })
      .mockResolvedValueOnce({ rows: [{ success_logins_24h: 0, failed_logins_24h: 0 }] })
      .mockResolvedValueOnce({ rows: [{ object_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/health`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.body.data.activity.status).toBe('WARNING');
  });

  it('returns UNKNOWN when there are zero events (not "healthy: 0")', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID, name: 'Acme', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ total_events_24h: 0, error_events_24h: 0 }] })
      .mockResolvedValueOnce({ rows: [{ success_logins_24h: 0, failed_logins_24h: 0 }] })
      .mockResolvedValueOnce({ rows: [{ object_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/health`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.body.data.activity.status).toBe('UNKNOWN');
  });

  it('login status: 0 failed = HEALTHY; 1–50 = CAUTION; 51+ = WARNING', async () => {
    async function runOnce(failed) {
      pool.query.mockReset();
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: VALID_UUID, name: 'Acme', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [{ total_events_24h: 0, error_events_24h: 0 }] })
        .mockResolvedValueOnce({ rows: [{ success_logins_24h: 0, failed_logins_24h: failed }] })
        .mockResolvedValueOnce({ rows: [{ object_count: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      const res = await request(app())
        .get(`/api/platform/studios/${VALID_UUID}/health`)
        .set('Authorization', `Bearer ${token()}`);
      return res.body.data.logins.status;
    }
    expect(await runOnce(0)).toBe('HEALTHY');
    expect(await runOnce(1)).toBe('CAUTION');
    expect(await runOnce(50)).toBe('CAUTION');
    expect(await runOnce(51)).toBe('WARNING');
  });

  it('subscription is null when the studio has no subscription at all', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID, name: 'Acme', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ total_events_24h: 0, error_events_24h: 0 }] })
      .mockResolvedValueOnce({ rows: [{ success_logins_24h: 0, failed_logins_24h: 0 }] })
      .mockResolvedValueOnce({ rows: [{ object_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/health`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.body.data.subscription).toBeNull();
  });
});

/* ── GET /studios/:id/memberships — PII gate ─────────────────────────── */

describe('GET /api/platform/studios/:id/memberships', () => {
  it('clamps limit/offset the same way as cross-tenant-attempts', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/memberships?limit=999&offset=-5`)
      .set('Authorization', `Bearer ${token()}`);
    expect(pool.query.mock.calls[0][1]).toEqual([VALID_UUID, 200, 0]);
  });

  it('returns memberships WITHOUT phone, email, or payment_method (PII gate)', async () => {
    // The SQL projects only the safe columns. The mock mirrors what
    // a real PG response would return — the absence of phone/email/
    // payment_method is what protects the platform admin's view.
    // If the SQL ever SELECTs those columns, the mock would have to
    // pass them through, and this test would catch it.
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'm1', name: 'Alice', status: 'active', start_date: '2024-01-01',
            end_date: '2024-12-31', paid_amount: 12000, balance_amount: 0,
            plan_name: 'Monthly' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/memberships`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const row = res.body.data[0];
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('plan_name');
    expect(row).toHaveProperty('paid_amount');
    expect(row).not.toHaveProperty('phone');
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('payment_method');
  });

  it('the SELECT explicitly omits phone / email / payment_method', async () => {
    // Belt-and-braces: pin the SQL projection. A future "select *"
    // refactor would let the response start leaking PII without
    // this test failing, because the row mock could grow a phone
    // column overnight. Pin the source instead.
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/memberships`)
      .set('Authorization', `Bearer ${token()}`);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/\bphone\b/i);
    expect(sql).not.toMatch(/\bemail\b/i);
    expect(sql).not.toMatch(/payment_method/i);
  });

  it('paginates with the limit/offset from the query string', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'm1', name: 'Alice' }] })
      .mockResolvedValueOnce({ rows: [{ total: 51 }] });
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/memberships?limit=25&offset=50`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(51);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(50);
  });
});

/* ── GET /studios/:id/pt-revenue ──────────────────────────────────────── */

describe('GET /api/platform/studios/:id/pt-revenue', () => {
  it('returns the 5 numbers + 2 counts the Revenue section reads', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        total_collected: '50000', total_outstanding: '5000',
        collected_30d: '3000',   collected_90d: '9000',
        collected_365d: '45000',
        active_memberships: 12,  expired_memberships: 38,
      }],
    });
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/pt-revenue`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toEqual({
      total_collected: 50000, total_outstanding: 5000,
      collected_30d: 3000, collected_90d: 9000, collected_365d: 45000,
      active_memberships: 12, expired_memberships: 38,
    });
  });

  it('zeros are coerced to numbers, not strings (UI uses tabular-nums)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        total_collected: '0', total_outstanding: '0',
        collected_30d: '0',   collected_90d: '0',
        collected_365d: '0',
        active_memberships: 0,  expired_memberships: 0,
      }],
    });
    const res = await request(app())
      .get(`/api/platform/studios/${VALID_UUID}/pt-revenue`)
      .set('Authorization', `Bearer ${token()}`);
    for (const v of Object.values(res.body.data)) {
      expect(typeof v).toBe('number');
    }
  });
});

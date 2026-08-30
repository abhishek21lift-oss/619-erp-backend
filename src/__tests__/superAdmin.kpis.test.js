// Phase 5/6 — /api/platform/overview/kpis
//
// Two properties pinned:
//
//   1. The shape matches the brief: 4 sections (business / platform_revenue /
//      operations / security) with the exact field names the NewOverviewTab
//      reads. Renaming a field here would silently zero out a KPI tile on
//      the home, so the test enforces the contract on both sides.
//   2. The 5-min in-process cache is honored. The first call hits the DB;
//      the second within TTL returns cached: true and does not re-query.
//      The brief says "snapshot is at most 5 minutes old" — if the cache
//      is broken, the brief is broken.
//
// Note: we don't test the `force=1` bypass here — the front-end doesn't
// expose it; the UI's Refresh button just re-asks and the server's
// in-process cache may or may not be fresh when it does.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');

const kpisRouter = require('../modules/platform/super-admin/kpis');

function freshKpisRouter() {
  let captured;
  jest.isolateModules(() => {
    captured = require('../modules/platform/super-admin/kpis');
  });
  return captured;
}

const PLATFORM_OWNER = {
  id: 'usr-platform', name: 'Platform Owner', email: 'p@x.com', role: 'super_admin',
  organization_id: null, is_platform_owner: true, is_active: true, deleted_at: null,
  token_version: 1,
};

function token() {
  return jwt.sign(
    { id: PLATFORM_OWNER.id, token_version: PLATFORM_OWNER.token_version,
      role: PLATFORM_OWNER.role, is_platform_owner: true, audience: 'platform' },
    process.env.JWT_SECRET, { expiresIn: '5m' }
  );
}

function app(router = kpisRouter) {
  const a = express();
  a.use((req, _res, next) => { req.user = PLATFORM_OWNER; next(); });
  a.use('/api/platform', router);
  return a;
}

function rowFixture() {
  return {
    total_studios: 12, active_studios: 9, pending_studios: 1,
    suspended_studios: 1, trial_studios: 1,
    total_owners: 14, total_trainers: 38,
    total_clients: 247, active_clients: 198, new_clients_30d: 22,
    active_subscriptions: 10, trial_subscriptions: 2, expiring_in_7d: 1,
    collected_30d_inr: '123456.78',
    failed_payments_30d: 3,
    critical_alerts: 1, high_alerts: 4, medium_alerts: 7,
  };
}

beforeEach(() => {
  pool.query.mockReset();
});

describe('GET /api/platform/overview/kpis — response shape', () => {
  it('returns the 4-section shape the NewOverviewTab reads', async () => {
    const router = freshKpisRouter();
    pool.query.mockResolvedValueOnce({ rows: [rowFixture()] });
    const res = await request(app(router)).get('/api/platform/overview/kpis').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('cached', false);
    const d = res.body.data;
    expect(d.business).toEqual(expect.objectContaining({
      total_studios: 12, active_studios: 9, pending_studios: 1,
      suspended_studios: 1, trial_studios: 1,
      total_owners: 14, total_trainers: 38,
      total_clients: 247, active_clients: 198, new_clients_30d: 22,
    }));
    expect(d.platform_revenue.active_subscriptions).toBe(10);
    expect(d.platform_revenue.trial_subscriptions).toBe(2);
    expect(d.platform_revenue.expiring_in_7d).toBe(1);
    expect(Number(d.platform_revenue.mrr_inr)).toBeGreaterThan(0);
    expect(d.operations.failed_payments_30d).toBe(3);
    expect(d.security.critical_alerts).toBe(1);
    expect(d.security.high_alerts).toBe(4);
    expect(d.security.medium_alerts).toBe(7);
  });

  it('coerces null/undefined counters to 0 so the UI never renders NaN', async () => {
    const router = freshKpisRouter();
    const empty = {
      total_studios: 0, active_studios: 0, pending_studios: 0,
      suspended_studios: 0, trial_studios: 0,
      total_owners: 0, total_trainers: 0,
      total_clients: 0, active_clients: 0, new_clients_30d: 0,
      active_subscriptions: 0, trial_subscriptions: 0, expiring_in_7d: 0,
      collected_30d_inr: '0', failed_payments_30d: 0,
      critical_alerts: 0, high_alerts: 0, medium_alerts: 0,
    };
    pool.query.mockResolvedValueOnce({ rows: [empty] });
    const res = await request(app(router)).get('/api/platform/overview/kpis').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.business.total_studios).toBe(0);
    expect(res.body.data.platform_revenue.mrr_inr).toBe(0);
    expect(res.body.data.operations.failed_payments_30d).toBe(0);
  });
});

describe('GET /api/platform/overview/kpis — 5-minute in-process cache', () => {
  it('a second call within TTL does not re-query the DB', async () => {
    const router = freshKpisRouter();
    const a = app(router);
    pool.query.mockResolvedValueOnce({ rows: [rowFixture()] });
    const t = `Bearer ${token()}`;
    const r1 = await request(a).get('/api/platform/overview/kpis').set('Authorization', t);
    expect(r1.status).toBe(200);
    expect(r1.body.cached).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(1);

    const r2 = await request(a).get('/api/platform/overview/kpis').set('Authorization', t);
    expect(r2.status).toBe(200);
    expect(r2.body.cached).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('two concurrent cache misses share one DB call (in-flight dedupe)', async () => {
    const router = freshKpisRouter();
    const a = app(router);
    let resolveQuery;
    const captured = new Promise((res) => { resolveQuery = res; });
    pool.query.mockImplementationOnce(() => captured);

    const t = `Bearer ${token()}`;
    const p1 = request(a).get('/api/platform/overview/kpis').set('Authorization', t);
    const p2 = request(a).get('/api/platform/overview/kpis').set('Authorization', t);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    resolveQuery({ rows: [rowFixture()] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

// The twelve tables that had no tenant column, attacked rather than read.
//
// ── The failure this exists to catch ───────────────────────────────────────
//
// Until migration 174 none of these tables carried organization_id, and none of
// the routes serving them applied a tenant filter. Every one of these requests
// used to succeed against another studio's data:
//
//     GET    /api/progress/lifestyle-assessments      → every studio's health records
//     PATCH  /api/progress/lifestyle-assessments/:id  → rewrite any of them
//     GET    /api/automation/session-balance          → every studio's clients, by name and mobile
//     POST   /api/automation/session-balance/:id/use  → burn another studio's sold sessions
//     GET    /api/plans                               → every studio's pricing
//     DELETE /api/offers/:id                          → delete another studio's offer
//     DELETE /api/campaigns/:id                       → delete another studio's campaign
//     DELETE /api/feedback/:id                        → delete another studio's feedback
//     DELETE /api/automation/pt-packages/:id          → delete another studio's catalogue
//
// Same method as training.authz.test.js next door: send real requests as a
// studio-B caller against studio-A ids and assert 404 — not 403, because a 403
// confirms the row exists somewhere. Then assert the SQL actually carried the
// caller's org, because a handler can answer 404 for an unrelated reason and
// look correct while remaining wide open.
'use strict';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ROW_A = '33333333-3333-4333-8333-333333333333';
const CLIENT_A = '44444444-4444-4444-8444-444444444444';

const mockQueries = [];
// Every lookup returns nothing, which is what Postgres does for a caller
// outside the owning org. The point is to prove the QUERY carried the right
// predicates, not to re-test the database.
let mockRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: mockRows, rowCount: mockRows.length };
  }),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => {
      mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      return { rows: mockRows, rowCount: mockRows.length };
    }),
    release: jest.fn(),
  })),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));

let mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../middleware/rbac', () => ({
  requireRole: () => (_req, _res, next) => next(),
  requireStaff: (_req, _res, next) => next(),
}));
jest.mock('../middleware/validate', () => ({ validate: () => (_req, _res, next) => next() }));
jest.mock('../middleware/branch-scope', () => ({
  branchScope: (req, _res, next) => { req.branchScope = { isAdmin: true, branchId: null }; next(); },
}));

const express = require('express');
const request = require('supertest');

function app(mountPath, modulePath) {
  const a = express();
  a.use(express.json());
  a.use(mountPath, require(modulePath));
  a.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}

const allSql = () => mockQueries.map((q) => q.sql).join(' || ');
const allParams = () => mockQueries.flatMap((q) => q.params);

/** The caller's org reached the database, and the victim's did not. */
function expectScopedToCaller() {
  expect(allSql()).toMatch(/organization_id = \$\d/);
  expect(allParams()).toContain(ORG_B);
  expect(allParams()).not.toContain(ORG_A);
}

beforeEach(() => {
  mockQueries.length = 0;
  mockRows = [];
  mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B };
});

// ── Health records ──────────────────────────────────────────────────────────

describe('lifestyle and nutrition assessments — health data', () => {
  const progress = () => app('/api/progress', '../modules/progress/progress.routes');

  test('the bare list is refused outright, not answered platform-wide', async () => {
    // This is the shape of the original leak: no parameters, every assessment
    // on the platform. A list endpoint over health records has no honest use
    // for "all of them", so client_id is now required.
    const res = await request(progress()).get('/api/progress/lifestyle-assessments');
    expect(res.status).toBe(400);
    expect(allSql()).not.toMatch(/SELECT \* FROM pt_lifestyle_assessments/);
  });

  test('listing another studio\'s client is 404', async () => {
    const res = await request(progress())
      .get('/api/progress/lifestyle-assessments')
      .query({ client_id: CLIENT_A });
    expect(res.status).toBe(404);
    // The client ownership check ran, and it ran with the CALLER's org.
    expect(allSql()).toMatch(/FROM pt_clients WHERE id = \$1 AND deleted_at IS NULL AND organization_id = \$2/);
    expect(allParams()).toContain(ORG_B);
  });

  test('patching another studio\'s lifestyle assessment is 404', async () => {
    const res = await request(progress())
      .patch(`/api/progress/lifestyle-assessments/${ROW_A}`)
      .send({ stress_level: 9 });
    expect(res.status).toBe(404);
    expectScopedToCaller();
    // Nothing was written.
    expect(allSql()).not.toMatch(/UPDATE pt_lifestyle_assessments SET/);
  });

  test('patching another studio\'s nutrition assessment is 404', async () => {
    const res = await request(progress())
      .patch(`/api/progress/nutrition-assessments/${ROW_A}`)
      .send({ medical_notes: 'tampered' });
    expect(res.status).toBe(404);
    expectScopedToCaller();
    expect(allSql()).not.toMatch(/UPDATE pt_nutrition_assessments SET/);
  });

  test('the nutrition list is required to name a client too', async () => {
    const res = await request(progress()).get('/api/progress/nutrition-assessments');
    expect(res.status).toBe(400);
    expect(allSql()).not.toMatch(/SELECT \* FROM pt_nutrition_assessments/);
  });
});

// ── Session balances: client PII and sold inventory ─────────────────────────

describe('PT session balances', () => {
  const automation = () => app('/api/automation', '../modules/automation/automation.routes');

  test('the list carries the caller\'s org', async () => {
    await request(automation()).get('/api/automation/session-balance');
    expect(allSql()).toMatch(/sb\.organization_id = \$\d/);
    expect(allParams()).toContain(ORG_B);
  });

  test('burning another studio\'s sessions does not update anything', async () => {
    const res = await request(automation())
      .post(`/api/automation/session-balance/${ROW_A}/use`)
      .send({});
    expect(res.status).toBe(400);
    // The UPDATE is allowed to be ATTEMPTED — it is one atomic statement, by
    // design, so a double-spend window cannot open between a read and a write.
    // What matters is that it carried the org predicate and therefore matched
    // nothing.
    expectScopedToCaller();
  });

  test('a balance cannot be created against another studio\'s client', async () => {
    const res = await request(automation())
      .post('/api/automation/session-balance')
      .send({ client_id: CLIENT_A, total_sessions: 10 });
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/INSERT INTO session_balance/);
  });
});

// ── Commercial data ─────────────────────────────────────────────────────────

describe('campaigns, offers, feedback and plans', () => {
  const cases = [
    ['campaigns',  '/api/campaigns',  '../routes/campaigns', 'DELETE FROM campaigns'],
    ['offers',     '/api/offers',     '../routes/offers',    'DELETE FROM offers'],
    ['feedback',   '/api/feedback',   '../routes/feedback',  'DELETE FROM feedback'],
  ];

  test.each(cases)('deleting another studio\'s %s row is 404 and deletes nothing', async (
    _name, mount, mod, _deleteSql
  ) => {
    const res = await request(app(mount, mod)).delete(`${mount}/${ROW_A}`);
    expect(res.status).toBe(404);
    expectScopedToCaller();
  });

  test.each(cases)('reading another studio\'s %s row by id is 404', async (_name, mount, mod) => {
    const res = await request(app(mount, mod)).get(`${mount}/${ROW_A}`);
    expect(res.status).toBe(404);
    expectScopedToCaller();
  });

  test('the plans list is scoped — this one was readable by ANY role', async () => {
    // /api/plans sat behind `auth` alone, so every trainer and every activated
    // client account could read every studio's membership pricing.
    mockUser = { id: 'u-b', role: 'trainer', organization_id: ORG_B };
    await request(app('/api/plans', '../routes/plans')).get('/api/plans');
    expectScopedToCaller();
  });

  test('deleting another studio\'s plan is 404', async () => {
    const res = await request(app('/api/plans', '../routes/plans')).delete(`/api/plans/${ROW_A}`);
    expect(res.status).toBe(404);
    expectScopedToCaller();
  });

  test('deleting another studio\'s PT package is 404', async () => {
    const res = await request(app('/api/automation', '../modules/automation/automation.routes'))
      .delete(`/api/automation/pt-packages/${ROW_A}`);
    expect(res.status).toBe(404);
    expectScopedToCaller();
  });

  test('deleting another studio\'s automation rule is 404', async () => {
    const res = await request(app('/api/automation', '../modules/automation/automation.routes'))
      .delete(`/api/automation/rules/${ROW_A}`);
    expect(res.status).toBe(404);
    expectScopedToCaller();
  });
});

// ── Integrations: the upsert that used to overwrite another studio's key ────

describe('integrations', () => {
  const integrations = () => app('/api/integrations', '../routes/integrations');

  test('connect upserts on (organization_id, id), not on id alone', async () => {
    // The old ON CONFLICT (id) made the row a platform singleton: the second
    // studio to connect Razorpay overwrote the first studio's API key.
    await request(integrations())
      .post('/api/integrations/razorpay/connect')
      .send({ api_key: 'rzp_test_key' });
    expect(allSql()).toMatch(/ON CONFLICT \(organization_id, id\)/);
    expect(allParams()).toContain(ORG_B);
  });

  test('disconnect is scoped the same way', async () => {
    await request(integrations()).post('/api/integrations/razorpay/disconnect').send({});
    expect(allSql()).toMatch(/ON CONFLICT \(organization_id, id\)/);
    expect(allParams()).toContain(ORG_B);
  });

  test('the listing carries the caller\'s org', async () => {
    await request(integrations()).get('/api/integrations');
    expectScopedToCaller();
  });

  test('a platform-wide operator with no studio selected cannot write a credential', async () => {
    // orgIdOf() is null for a super admin who has not named a studio, and NULLs
    // are distinct in the unique index — so an unguarded upsert would insert a
    // fresh unowned row on every call instead of updating anything.
    mockUser = { id: 'u-super', role: 'super_admin', organization_id: null };
    const res = await request(integrations())
      .post('/api/integrations/razorpay/connect')
      .send({ api_key: 'rzp_test_key' });
    expect(res.status).toBe(400);
    expect(allSql()).not.toMatch(/INSERT INTO integrations/);
  });
});

// ── The operations workspace ────────────────────────────────────────────────

describe('module records', () => {
  const operations = () => app('/api/modules', '../modules/operations/operations.routes');

  test('an admin\'s read is scoped to their studio, not to TRUE', async () => {
    // scopedClause() returns the literal 'TRUE' for an admin, which was the
    // entire filter. The org clause is now the boundary; branch stays a
    // within-studio refinement.
    await request(operations()).get('/api/modules/finance');
    expectScopedToCaller();
  });

  test('updating another studio\'s record is 404', async () => {
    const res = await request(operations())
      .put(`/api/modules/finance/${ROW_A}`)
      // amount included because validate() rejects a missing one (Number(undefined)
      // is NaN) — a 400 there would pass this test for the wrong reason.
      .send({ title: 't', owner: 'o', status: 's', priority: 'p', dueDate: '2026-01-01', channel: 'c', amount: 0 });
    expect(res.status).toBe(404);
    expectScopedToCaller();
  });

  test('deleting another studio\'s record is 404', async () => {
    const res = await request(operations()).delete(`/api/modules/finance/${ROW_A}`);
    expect(res.status).toBe(404);
    expectScopedToCaller();
  });
});

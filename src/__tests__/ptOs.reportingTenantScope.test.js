// The PT-OS reporting aggregates are scoped to one studio.
//
// Regression test for a confirmed cross-tenant leak. Two handlers in
// pt-os.routes.js aggregated tenant-owned tables with no organization_id
// predicate at all:
//
//   GET /revenue              SUM(pt_payments.amount) for the whole platform
//   GET /trainer-performance  every trainer on the platform, with their
//                             incentive_rate and commission earned
//
// Both sat behind `requireStaff` (and adminOrManager for the second), which
// are ROLE gates — they answer "may this person see a report", never "whose
// report". So any staff account in any studio could read every other studio's
// revenue, and any admin could read a competitor's trainer roster and pay.
//
// ── Why this asserts on SQL text rather than on rows ────────────────────
//
// Same reasoning as the convention tests next door: CI has no database, and
// a runtime check would only catch the mistake after it shipped. What can be
// checked here is the thing that actually broke — whether the predicate is in
// the statement at all, and whether the caller's org id is bound to it.
//
// An aggregate leaks differently from a row read, which is why these are worth
// their own file. There is no id to guess and nothing to enumerate: one
// missing predicate returns the entire ledger in a single ordinary call, and
// the response looks perfectly normal to whoever receives it.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';

// The caller is a plain studio admin in ORG_A — the account that held the leak.
let mockUser = { id: 'usr-1', role: 'admin', organization_id: ORG_A, trainer_id: null };

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));

/** The statement issued by the handler under test, plus its bound params. */
function lastCall() {
  const calls = pool.query.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [sql, params] = calls[calls.length - 1];
  return { sql: String(sql), params: params || [] };
}

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockUser = { id: 'usr-1', role: 'admin', organization_id: ORG_A, trainer_id: null };
});

describe('GET /api/pt-os/revenue — tenant isolation', () => {
  it('filters pt_payments by the caller organization', async () => {
    await request(app).get('/api/pt-os/revenue').expect(200);
    const { sql, params } = lastCall();

    expect(sql).toMatch(/FROM pt_payments/i);
    expect(sql).toMatch(/organization_id = \$1/);
    expect(params).toContain(ORG_A);
  });

  it('binds the org id rather than inlining it into the SQL text', async () => {
    // A scoping layer that string-builds an id into a statement is the exact
    // injection shape this boundary must not introduce, however well-formed
    // org ids happen to be today.
    await request(app).get('/api/pt-os/revenue').expect(200);
    const { sql } = lastCall();
    expect(sql).not.toContain(ORG_A);
  });

  it('takes the org from the session, never from the query string', async () => {
    await request(app)
      .get('/api/pt-os/revenue?organization_id=22222222-2222-2222-2222-222222222222')
      .expect(200);
    const { params } = lastCall();

    expect(params).toContain(ORG_A);
    expect(params).not.toContain('22222222-2222-2222-2222-222222222222');
  });

  it('applies no filter for a platform super admin operating platform-wide', async () => {
    // The one caller who is allowed to see every studio, consistent with
    // tenantScope() everywhere else.
    mockUser = { id: 'ops-1', role: 'super_admin', organization_id: null };
    await request(app).get('/api/pt-os/revenue').expect(200);
    const { sql, params } = lastCall();

    expect(sql).not.toMatch(/organization_id/);
    expect(params).toHaveLength(0);
  });
});

describe('GET /api/pt-os/trainer-performance — tenant isolation', () => {
  it('scopes the trainer, and both joined arms', async () => {
    // All three matter independently. A correctly-scoped trainer LEFT JOINed
    // to an unscoped pt_payments still sums another studio's money into this
    // studio's row — which reads as a reconciliation bug, not a leak, and so
    // would be believed for a long time.
    await request(app).get('/api/pt-os/trainer-performance').expect(200);
    const { sql, params } = lastCall();

    expect(sql).toMatch(/t\.organization_id = \$\d/);
    expect(sql).toMatch(/c\.organization_id = \$\d/);
    expect(sql).toMatch(/p\.organization_id = \$\d/);
    expect(params.filter((p) => p === ORG_A)).toHaveLength(3);
  });

  it('constrains the joined tables in ON, not WHERE', async () => {
    // A LEFT JOIN whose right-hand table is constrained in WHERE silently
    // becomes an INNER JOIN. Every trainer with no clients yet — a new hire,
    // the reason a studio opens this screen — would vanish from the report.
    await request(app).get('/api/pt-os/trainer-performance').expect(200);
    const { sql } = lastCall();

    const joins = sql.split(/\n/).filter((l) => /LEFT JOIN/i.test(l));
    expect(joins).toHaveLength(2);
    for (const line of joins) expect(line).toMatch(/organization_id = \$\d/);

    // ...and the statement's own WHERE clause carries only the trainer filter.
    //
    // Matched as a line that STARTS with WHERE, not the first `WHERE` in the
    // text: the SELECT list is full of `FILTER (WHERE c.status = 'active')`
    // aggregates, and searching for the keyword alone lands inside the first
    // of those — which made a first draft of this test fail against correct SQL.
    const where = sql.split(/\n/).find((l) => /^\s*WHERE\b/i.test(l));
    expect(where).toBeDefined();
    expect(where).toMatch(/t\.organization_id/);
    expect(where).not.toMatch(/[cp]\.organization_id/);
  });

  it('qualifies every org column, so the JOIN cannot throw "ambiguous"', async () => {
    // pt_trainers, pt_clients and pt_payments all carry organization_id, so an
    // unqualified predicate here is a guaranteed 500 on every call. See
    // ptOs.orgWhereQualified.test.js for the outage that rule came from.
    await request(app).get('/api/pt-os/trainer-performance').expect(200);
    const { sql } = lastCall();

    for (const m of sql.matchAll(/(^|[^.\w])organization_id\s*=/g)) {
      throw new Error(`unqualified organization_id in a JOINed query: ...${m[0]}`);
    }
  });

  it('applies no filter for a platform super admin operating platform-wide', async () => {
    mockUser = { id: 'ops-1', role: 'super_admin', organization_id: null };
    await request(app).get('/api/pt-os/trainer-performance').expect(200);
    const { sql, params } = lastCall();

    expect(sql).not.toMatch(/organization_id/);
    expect(params).toHaveLength(0);
  });
});

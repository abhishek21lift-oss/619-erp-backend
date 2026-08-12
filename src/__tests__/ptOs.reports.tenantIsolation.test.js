// GET /api/pt-os/revenue and /api/pt-os/trainer-performance — tenant isolation.
//
// Both routes had no organization filter. /revenue summed pt_payments across
// every studio on the platform; /trainer-performance did the same for trainer
// names, incentive rates, client counts, commission and incentive totals.
//
// Aggregation is what kept it hidden. A leaked ROW looks like someone else's
// data; a leaked SUM just looks like a bigger number, and a studio has no way
// to know its revenue chart is counting a competitor's takings.
//
// Asserted on the SQL rather than only on returned rows — the same reasoning
// as ptOs.trainers.tenantIsolation.test.js, whose pattern this follows: a mock
// can be made to return the right thing by accident, but it cannot make an
// unfiltered query carry a filter.
'use strict';

const queries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

let mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  return a;
}

const revenueQuery = () => queries.find((q) => /FROM pt_payments/i.test(q.sql) && /DATE_TRUNC\('month', date\)/i.test(q.sql));
const perfQuery = () => queries.find((q) => /FROM pt_trainers t/i.test(q.sql) && /monthly_pt_revenue/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
});

describe('GET /pt-os/revenue tenant isolation', () => {
  test('filters pt_payments by the caller organization', async () => {
    await request(app()).get('/api/pt-os/revenue');
    const q = revenueQuery();

    expect(q).toBeTruthy();
    expect(q.sql).toMatch(/organization_id = \$1/);
    expect(q.params).toEqual([ORG_A]);
  });

  test('the predicate is in WHERE, so it applies before GROUP BY', async () => {
    // The distinction the fix turns on: filter then aggregate, not aggregate
    // then filter. If organization_id ever migrates into a HAVING clause or a
    // post-query .filter(), the sums are computed platform-wide first and the
    // leak is back in a form that returns the right-looking rows.
    await request(app()).get('/api/pt-os/revenue');
    const sql = revenueQuery().sql;

    const org = sql.indexOf('organization_id = $1');
    const group = sql.indexOf('GROUP BY');
    expect(org).toBeGreaterThan(-1);
    expect(org).toBeLessThan(group);
    expect(sql).not.toMatch(/HAVING/i);
  });

  test('another studio cannot be reached by asking for it', async () => {
    // The org comes from the authenticated user, never from the request.
    await request(app()).get(`/api/pt-os/revenue?organization_id=${ORG_B}`);
    expect(revenueQuery().params).toEqual([ORG_A]);
  });

  test('a platform super admin operating platform-wide is not filtered', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/pt-os/revenue');
    const q = revenueQuery();

    expect(q.sql).not.toMatch(/organization_id/);
    expect(q.params).toEqual([]);
  });

  test('a super admin targeting one org via x-org-id IS filtered to it', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/pt-os/revenue').set('x-org-id', ORG_B);
    expect(revenueQuery().params).toEqual([ORG_B]);
  });

  test('an org-less tenant user matches no rows rather than every row', async () => {
    // Fail-closed: organization_id = NULL is never true, so the query returns
    // nothing. The dangerous alternative is skipping the filter entirely.
    mockUser = { id: 'u9', role: 'admin', organization_id: null };
    await request(app()).get('/api/pt-os/revenue');
    const q = revenueQuery();

    expect(q.sql).toMatch(/organization_id = \$1/);
    expect(q.params).toEqual([null]);
  });
});

describe('GET /pt-os/trainer-performance tenant isolation', () => {
  test('filters the driving table AND both joins', async () => {
    await request(app()).get('/api/pt-os/trainer-performance');
    const q = perfQuery();

    expect(q).toBeTruthy();
    // Three, not one. The trainer id alone does not carry a tenant with it:
    // pt_clients.trainer_id references pt_trainers while pt_payments.trainer_id
    // references `trainers` (migration 072), and migration 018 seeded
    // pt_trainers from trainers preserving the primary key — so a client or a
    // payment belonging to another studio can join cleanly onto this trainer.
    expect(q.sql).toMatch(/t\.organization_id = \$1/);
    expect(q.sql).toMatch(/c\.organization_id = \$1/);
    expect(q.sql).toMatch(/p\.organization_id = \$1/);
    expect(q.params).toEqual([ORG_A]);
  });

  test('the join filters live in ON, not WHERE', async () => {
    // In WHERE they would collapse both LEFT JOINs into inner joins and drop
    // every trainer with no clients or no payments yet. A tenant fix that
    // silently removes rows from a report is not a tenant fix.
    await request(app()).get('/api/pt-os/trainer-performance');
    const sql = perfQuery().sql;

    const where = sql.indexOf('WHERE t.deleted_at');
    expect(sql.indexOf('c.organization_id = $1')).toBeLessThan(where);
    expect(sql.indexOf('p.organization_id = $1')).toBeLessThan(where);
    expect(sql.indexOf('t.organization_id = $1')).toBeGreaterThan(where);
    expect(sql).toMatch(/LEFT JOIN pt_clients c ON[^)]*organization_id = \$1/);
    expect(sql).toMatch(/LEFT JOIN pt_payments p ON[^)]*organization_id = \$1/);
  });

  test('every filter uses the same single parameter', async () => {
    // One org, one param. Three separate placeholders would still be correct
    // but would let a future edit set them to different values.
    await request(app()).get('/api/pt-os/trainer-performance');
    const q = perfQuery();

    expect(q.params).toHaveLength(1);
    expect(q.sql.match(/organization_id = \$1/g)).toHaveLength(3);
    expect(q.sql).not.toMatch(/organization_id = \$2/);
  });

  test('another studio cannot be reached by asking for it', async () => {
    await request(app()).get(`/api/pt-os/trainer-performance?organization_id=${ORG_B}&trainer_id=whatever`);
    expect(perfQuery().params).toEqual([ORG_A]);
  });

  test('a platform super admin operating platform-wide is not filtered', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/pt-os/trainer-performance');
    const q = perfQuery();

    expect(q.sql).not.toMatch(/organization_id/);
    expect(q.params).toEqual([]);
  });

  test('a super admin targeting one org via x-org-id IS filtered to it', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/pt-os/trainer-performance').set('x-org-id', ORG_B);
    const q = perfQuery();

    expect(q.params).toEqual([ORG_B]);
    expect(q.sql.match(/organization_id = \$1/g)).toHaveLength(3);
  });

  test('an org-less tenant user matches no rows rather than every row', async () => {
    mockUser = { id: 'u9', role: 'manager', organization_id: null };
    await request(app()).get('/api/pt-os/trainer-performance');
    expect(perfQuery().params).toEqual([null]);
  });
});

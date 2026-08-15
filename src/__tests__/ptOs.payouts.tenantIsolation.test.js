// POST /api/pt-os/payouts/mark-all-paid, PUT /payouts/:trainerId,
// POST /payouts/:id/approve, GET/POST /payouts, GET /commissions,
// POST /commissions/calculate — tenant isolation.
//
// mark-all-paid ran a bare UPDATE over every studio's pt_payouts for the
// month, with no organization filter anywhere in the query: any admin could
// mark every other studio's pending payouts paid in one call, and paid_at
// would silently move for money that studio never touched. The whole
// commission/payout surface in this file shared the same gap.
//
// pt_payouts and pt_commissions carry no organization_id of their own — the
// tenant boundary runs through pt_trainers.organization_id via trainer_id —
// so the fix is a subquery filter, not a plain WHERE column, and these tests
// assert on the SQL actually sent rather than only on the HTTP response: a
// mock can be made to return the right rows by accident, but it cannot fake
// the query carrying the filter.
'use strict';

const queries = [];
let mockQueryImpl = async (sql, params) => {
  queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  return { rows: [], rowCount: 0 };
};
jest.mock('../db/pool', () => ({
  query: jest.fn((...args) => mockQueryImpl(...args)),
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

beforeEach(() => {
  queries.length = 0;
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
  mockQueryImpl = async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
});

describe('POST /pt-os/payouts/mark-all-paid tenant isolation', () => {
  test('scopes the bulk UPDATE to trainers in the caller organization (Org A cannot touch Org B payouts)', async () => {
    await request(app()).post('/api/pt-os/payouts/mark-all-paid').send({ month: '2026-08' });
    const q = queries.find((x) => /UPDATE pt_payouts/i.test(x.sql) && /status != 'paid'/i.test(x.sql));

    expect(q).toBeTruthy();
    expect(q.sql).toMatch(/trainer_id IN \(SELECT id FROM pt_trainers WHERE organization_id = \$2\)/i);
    expect(q.params).toEqual(['2026-08-01', ORG_A]);
  });

  test('never runs the bulk UPDATE without an organization filter for a tenant admin', async () => {
    await request(app()).post('/api/pt-os/payouts/mark-all-paid').send({ month: '2026-08' });
    const unscoped = queries.find((x) => /UPDATE pt_payouts/i.test(x.sql) && !/organization_id/i.test(x.sql));
    expect(unscoped).toBeUndefined();
  });

  test('there is no request field that widens the scope beyond the authenticated org', async () => {
    await request(app())
      .post('/api/pt-os/payouts/mark-all-paid')
      .send({ month: '2026-08', organization_id: ORG_B });
    const q = queries.find((x) => /UPDATE pt_payouts/i.test(x.sql));
    expect(q.params).toEqual(['2026-08-01', ORG_A]);
  });

  test('a platform super admin operating platform-wide is not filtered', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).post('/api/pt-os/payouts/mark-all-paid').send({ month: '2026-08' });
    const q = queries.find((x) => /UPDATE pt_payouts/i.test(x.sql));
    expect(q.sql).not.toMatch(/organization_id/i);
    expect(q.params).toEqual(['2026-08-01']);
  });

  test('a super admin targeting one studio IS filtered to it', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app())
      .post('/api/pt-os/payouts/mark-all-paid')
      .set('x-org-id', ORG_A)
      .send({ month: '2026-08' });
    expect(queries.find((x) => /UPDATE pt_payouts/i.test(x.sql)).params).toEqual(['2026-08-01', ORG_A]);
  });
});

describe('PUT /pt-os/payouts/:trainerId tenant isolation', () => {
  test('404s and never issues the UPDATE for a trainer in another organization', async () => {
    // Default mock: the ownership SELECT finds no matching row (trainer is not in ORG_A).
    const res = await request(app())
      .put('/api/pt-os/payouts/org-b-trainer')
      .send({ payout_status: 'paid' });

    expect(res.status).toBe(404);
    expect(queries.find((x) => /UPDATE pt_payouts/i.test(x.sql))).toBeUndefined();
    const check = queries.find((x) => /SELECT 1 FROM pt_trainers/i.test(x.sql));
    expect(check.params).toEqual(['org-b-trainer', ORG_A]);
  });

  test('updates when the trainer belongs to the caller organization', async () => {
    mockQueryImpl = async (sql, params) => {
      const clean = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: clean, params });
      if (/SELECT 1 FROM pt_trainers/i.test(clean)) return { rows: [{ exists: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };

    const res = await request(app())
      .put('/api/pt-os/payouts/org-a-trainer')
      .send({ payout_status: 'paid' });

    expect(res.status).toBe(200);
    expect(queries.find((x) => /UPDATE pt_payouts/i.test(x.sql))).toBeTruthy();
  });
});

describe('POST /pt-os/payouts/:id/approve tenant isolation', () => {
  test('404s a payout id belonging to another organization instead of marking it paid', async () => {
    // markPayoutPaid's UPDATE ... RETURNING finds nothing once the subquery excludes the row.
    const res = await request(app())
      .post('/api/pt-os/payouts/org-b-payout/approve')
      .send({ payment_method: 'CASH' });

    expect(res.status).toBe(404);
    const update = queries.find((x) => /UPDATE pt_payouts/i.test(x.sql) && /RETURNING/i.test(x.sql));
    expect(update).toBeTruthy();
    expect(update.sql).toMatch(/trainer_id IN \(SELECT id FROM pt_trainers WHERE organization_id = \$5\)/i);
    expect(update.params[0]).toBe('org-b-payout');
    expect(update.params[4]).toBe(ORG_A);
  });
});

describe('GET /pt-os/payouts and POST /pt-os/commissions/calculate tenant isolation', () => {
  test('GET /payouts scopes the trainer roll-up by organization', async () => {
    await request(app()).get('/api/pt-os/payouts?month=2026-08');
    const q = queries.find((x) => /FROM pt_trainers t/i.test(x.sql) && /LEFT JOIN pt_payouts/i.test(x.sql));
    expect(q.sql).toMatch(/t\.organization_id = \$2/);
    expect(q.params).toEqual(['2026-08-01', ORG_A]);
  });

  test('POST /commissions/calculate only recalculates the caller organization\'s clients', async () => {
    await request(app()).post('/api/pt-os/commissions/calculate').send({ month: '2026-08' });
    const q = queries.find((x) => /FROM pt_clients c/i.test(x.sql) && /JOIN pt_trainers t/i.test(x.sql));
    expect(q.sql).toMatch(/c\.organization_id = \$3/);
    expect(q.params).toEqual(['2026-08-01', '2026-09-01', ORG_A]);
  });

  test('GET /commissions scopes commission history by organization', async () => {
    await request(app()).get('/api/pt-os/commissions');
    const q = queries.find((x) => /FROM pt_commissions pc/i.test(x.sql));
    expect(q.sql).toMatch(/c\.organization_id = \$1/);
    expect(q.params).toEqual([ORG_A]);
  });
});

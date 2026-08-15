// /api/leave — tenant isolation.
//
// leave_requests carried no organization_id at all (added in migration 168),
// so none of the four handlers in routes/leave.js could scope by tenant even
// in principle. `adminOrManager` on approve/reject is a ROLE gate, not a
// tenant gate — it answers "may this person approve leave", never "whose
// leave" — so before this fix an admin or manager in any studio could:
//
//   - list every studio's leave requests, with the trainer's name, email and
//     mobile that the LEFT JOIN on trainers adds to each row,
//   - read any one of them by id,
//   - approve or reject another studio's trainer's leave by id.
//
// The two writes are the sharp end: approving somebody else's staffing
// decision is not a read leak, it is a write into another business's roster.
//
// Asserted on the SQL and bound params rather than only on the response,
// matching the house convention (see ptOs.trainers.tenantIsolation.test.js):
// a mock can be made to return the right rows by accident, but it cannot fake
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
  a.use('/api/leave', require('../routes/leave'));
  return a;
}

const listQuery = () => queries.find((q) => /FROM leave_requests lr/i.test(q.sql) && /ORDER BY lr\.created_at/i.test(q.sql));
const updateQuery = () => queries.find((q) => /UPDATE leave_requests/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
  mockQueryImpl = async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
});

// ── Test 4 and 5: the list endpoint returns only the caller's studio ──────
describe('GET /api/leave list isolation', () => {
  test('Org A list is filtered to Org A', async () => {
    await request(app()).get('/api/leave');
    const q = listQuery();
    expect(q.sql).toMatch(/lr\.organization_id = \$1/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('Org B list is filtered to Org B', async () => {
    mockUser = { id: 'u2', role: 'admin', organization_id: ORG_B };
    await request(app()).get('/api/leave');
    expect(listQuery().params[0]).toBe(ORG_B);
  });

  test('the org filter survives alongside the optional status/trainer filters', async () => {
    await request(app()).get('/api/leave?status=pending&trainer_id=tr-9');
    const q = listQuery();
    expect(q.sql).toMatch(/lr\.organization_id = \$1/);
    expect(q.sql).toMatch(/lr\.status = \$2/);
    expect(q.sql).toMatch(/lr\.trainer_id = \$3/);
    expect(q.params.slice(0, 3)).toEqual([ORG_A, 'pending', 'tr-9']);
  });

  test('no query parameter widens the scope past the authenticated org', async () => {
    await request(app()).get(`/api/leave?organization_id=${ORG_B}`);
    expect(listQuery().params[0]).toBe(ORG_A);
  });

  test('a platform super admin operating platform-wide is not filtered', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/leave');
    expect(listQuery().sql).not.toMatch(/organization_id/);
  });

  test('a super admin targeting one studio IS filtered to it', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    await request(app()).get('/api/leave').set('x-org-id', ORG_B);
    expect(listQuery().params[0]).toBe(ORG_B);
  });
});

// ── Test 1: reading another studio's request by id ───────────────────────
describe('GET /api/leave/:id isolation', () => {
  test("404s Org B's leave request for an Org A admin", async () => {
    const res = await request(app()).get('/api/leave/lv-b');
    expect(res.status).toBe(404);
    const q = queries.find((x) => /WHERE lr\.id = \$1/i.test(x.sql));
    expect(q.sql).toMatch(/lr\.organization_id = \$2/);
    expect(q.params).toEqual(['lv-b', ORG_A]);
  });
});

// ── Tests 2 and 3: approving / rejecting another studio's request ────────
describe('POST /api/leave/:id/approve isolation', () => {
  test("404s Org B's leave request and leaves it unchanged", async () => {
    const res = await request(app()).post('/api/leave/lv-b/approve').send({ admin_note: 'ok' });

    expect(res.status).toBe(404);
    // The UPDATE is still issued, but its WHERE excludes the row, so it
    // matches nothing and RETURNING comes back empty — the 404 above.
    const q = updateQuery();
    expect(q.sql).toMatch(/organization_id = \$6/);
    expect(q.params[3]).toBe('lv-b');
    expect(q.params[5]).toBe(ORG_A);
  });

  test('approves a request in the caller\'s own organization', async () => {
    mockQueryImpl = async (sql, params) => {
      const clean = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: clean, params });
      if (/UPDATE leave_requests/i.test(clean)) {
        return { rows: [{ id: 'lv-a', status: 'approved' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const res = await request(app()).post('/api/leave/lv-a/approve').send({});
    expect(res.status).toBe(200);
    expect(updateQuery().params[5]).toBe(ORG_A);
  });
});

describe('POST /api/leave/:id/reject isolation', () => {
  test("404s Org B's leave request and leaves it unchanged", async () => {
    const res = await request(app()).post('/api/leave/lv-b/reject').send({ admin_note: 'no' });

    expect(res.status).toBe(404);
    const q = updateQuery();
    expect(q.sql).toMatch(/organization_id = \$6/);
    expect(q.params[3]).toBe('lv-b');
    expect(q.params[5]).toBe(ORG_A);
  });
});

// ── Creation must stamp the org, and must not cross studios ──────────────
describe('POST /api/leave creation', () => {
  test('rejects a trainer belonging to another organization', async () => {
    // The trainer-ownership SELECT finds nothing for an Org B trainer.
    const res = await request(app()).post('/api/leave').send({
      trainer_id: 'tr-b', from_date: '2026-08-01', to_date: '2026-08-02',
    });

    expect(res.status).toBe(404);
    const check = queries.find((x) => /SELECT 1 FROM trainers/i.test(x.sql));
    expect(check.sql).toMatch(/organization_id = \$2/);
    expect(check.params).toEqual(['tr-b', ORG_A]);
    expect(queries.find((x) => /INSERT INTO leave_requests/i.test(x.sql))).toBeUndefined();
  });

  test('stamps organization_id on the inserted row', async () => {
    mockQueryImpl = async (sql, params) => {
      const clean = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: clean, params });
      if (/SELECT 1 FROM trainers/i.test(clean)) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (/INSERT INTO leave_requests/i.test(clean)) {
        return { rows: [{ id: 'lv-new', trainer_id: 'tr-a', status: 'pending' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const res = await request(app()).post('/api/leave').send({
      trainer_id: 'tr-a', from_date: '2026-08-01', to_date: '2026-08-02',
    });

    expect(res.status).toBe(201);
    const insert = queries.find((x) => /INSERT INTO leave_requests/i.test(x.sql));
    expect(insert.sql).toMatch(/organization_id/);
    expect(insert.params).toContain(ORG_A);
  });

  test('the overlap check is scoped too, so another studio\'s leave cannot block a booking', async () => {
    mockQueryImpl = async (sql, params) => {
      const clean = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: clean, params });
      if (/SELECT 1 FROM trainers/i.test(clean)) return { rows: [{ ok: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    await request(app()).post('/api/leave').send({
      trainer_id: 'tr-a', from_date: '2026-08-01', to_date: '2026-08-02',
    });
    const overlap = queries.find((x) => /SELECT lr\.id FROM leave_requests/i.test(x.sql));
    expect(overlap.sql).toMatch(/lr\.organization_id = \$5/);
    expect(overlap.params[4]).toBe(ORG_A);
  });
});

// GET /api/pt-os/trainers — tenant isolation.
//
// This route had no organization filter at all. Every studio saw every trainer
// on the platform: the Book PT Session dialog listed four trainers belonging to
// four different studios, and the payload carried email, mobile, specialization
// and incentive_rate alongside the names — one studio's commission terms,
// readable by its competitors.
//
// Asserted on the SQL rather than only on the returned rows, because a mock can
// be made to return the right thing by accident. If the filter is dropped again,
// the query itself stops carrying organization_id and these fail.
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

// Impersonates whoever the test needs to be, in place of the real JWT middleware.
let mockUser = { id: 'u1', role: 'trainer', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
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

/** The trainer-profile listing query. */
function trainerQuery() {
  return queries.find((q) => /FROM trainers/i.test(q.sql) && /status = 'active'/i.test(q.sql));
}

beforeEach(() => {
  queries.length = 0;
  mockUser = { id: 'u1', role: 'trainer', organization_id: ORG_A };
});

describe('GET /pt-os/trainers tenant isolation', () => {
  test('lists this studio\'s trainer profile only, bound to the caller organization', async () => {
    await request(app()).get('/api/pt-os/trainers');
    const q = trainerQuery();

    expect(q).toBeTruthy();
    expect(q.sql).toMatch(/organization_id = \$1/);
    expect(q.params).toEqual([ORG_A]);
    // The legacy pt_trainers union is gone: it held no rows, and a second
    // table is a second place a filter can be forgotten.
    expect(q.sql).not.toMatch(/pt_trainers/i);
  });

  test('a trainer from another studio cannot be reached by asking', async () => {
    // There is no parameter a caller can set to widen the scope: the org comes
    // from the authenticated user, never from the request.
    await request(app()).get('/api/pt-os/trainers?organization_id=22222222-2222-2222-2222-222222222222');
    expect(trainerQuery().params).toEqual([ORG_A]);
  });

  test('an x-org-id header cannot retarget it either', async () => {
    await request(app()).get('/api/pt-os/trainers').set('x-org-id', '22222222-2222-2222-2222-222222222222');
    expect(trainerQuery().params).toEqual([ORG_A]);
  });

  test('the platform operator is refused rather than listing every studio', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    const res = await request(app()).get('/api/pt-os/trainers');
    expect(res.status).toBe(403);
    expect(trainerQuery()).toBeUndefined();
  });

  test('there is no create: a studio has one trainer profile, made with the studio', async () => {
    const res = await request(app()).post('/api/pt-os/trainers').send({ name: 'New Coach' });
    expect([404, 405]).toContain(res.status);
    expect(queries.find((q) => /INSERT INTO trainers/i.test(q.sql))).toBeUndefined();
  });
});

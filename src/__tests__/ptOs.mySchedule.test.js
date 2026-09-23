// GET /api/pt-os/sessions/my — the trainer's schedule.
//
// This used to resolve "who am I as a trainer": the linked trainer_id plus an
// email match across the trainers and pt_trainers tables, because an owner
// (an 'admin') was often not linked to their own coach profile and saw "ask an
// admin to link your login" while BEING the admin.
//
// In the Trainer → Members model the question is gone. The studio has one
// trainer — its owner — so the trainer's schedule is the studio's sessions,
// scoped to their organization and nothing narrower. What these tests pin is
// that it stays exactly that: org-bound, windowed, ordered, and not open to a
// member.
//
// Asserted on the emitted SQL and its bound parameters, not only on returned
// rows: the query either carries the org filter or it does not.
'use strict';

const queries = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params });
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';

let mockUser;
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

/** The schedule query itself. */
const scheduleQuery = () =>
  queries.find((q) => /FROM pt_sessions/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  mockUser = {
    id: 'u1', role: 'trainer', email: 'owner@studio.com',
    trainer_id: null, organization_id: ORG_A,
  };
});

describe('the trainer sees the studio schedule', () => {
  test('whether or not their account is linked to a coach profile', async () => {
    for (const trainer_id of [null, 'tr-1']) {
      queries.length = 0;
      mockUser = { ...mockUser, trainer_id };
      const res = await request(app()).get('/api/pt-os/sessions/my');
      expect(res.status).toBe(200);
      expect(res.body.trainer_linked).toBe(true);
      const q = scheduleQuery();
      expect(q.sql).not.toMatch(/trainer_id = ANY/);
      expect(q.params).toEqual([ORG_A]);
    }
  });

  test('no identity lookup over the trainer tables runs any more', async () => {
    await request(app()).get('/api/pt-os/sessions/my');
    expect(queries.some((q) => /LOWER\(email\)/i.test(q.sql))).toBe(false);
    expect(queries.some((q) => /FROM pt_trainers/i.test(q.sql))).toBe(false);
  });
});

describe('tenant isolation', () => {
  test('the schedule query is bound to the caller organization', async () => {
    await request(app()).get('/api/pt-os/sessions/my?organization_id=22222222-2222-2222-2222-222222222222');
    const q = scheduleQuery();
    expect(q.sql).toMatch(/s\.organization_id = \$1/);
    expect(q.params[0]).toBe(ORG_A);
  });

  test('the joined client comes from the same studio only', async () => {
    await request(app()).get('/api/pt-os/sessions/my');
    expect(scheduleQuery().sql).toMatch(/LEFT JOIN pt_clients c ON c\.id = s\.client_id AND c\.organization_id = s\.organization_id/);
  });

  test('a member is refused and no schedule is read', async () => {
    mockUser = { id: 'm1', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-1' };
    const res = await request(app()).get('/api/pt-os/sessions/my');
    expect(res.status).toBe(403);
    expect(scheduleQuery()).toBeUndefined();
  });
});

describe('the date window the page asks for', () => {
  test('from/to are passed through and numbered after the organization', async () => {
    await request(app())
      .get('/api/pt-os/sessions/my?from=2026-08-10&to=2026-08-16');

    const q = scheduleQuery();
    expect(q.sql).toMatch(/s\.session_date >= \$2/);
    expect(q.sql).toMatch(/s\.session_date <= \$3/);
    expect(q.params).toEqual([ORG_A, '2026-08-10', '2026-08-16']);
  });

  test('sessions come back in chronological order for a day agenda', async () => {
    await request(app()).get('/api/pt-os/sessions/my');

    // The page groups by day and renders the list as-is, so an unordered
    // result shows a 6pm session above a 7am one.
    expect(scheduleQuery().sql).toMatch(/ORDER BY s\.session_date ASC, s\.start_time ASC/);
  });

  test('client name and mobile ride along for the agenda row', async () => {
    await request(app()).get('/api/pt-os/sessions/my');

    const q = scheduleQuery();
    expect(q.sql).toMatch(/c\.name AS client_name/);
    expect(q.sql).toMatch(/c\.mobile AS client_mobile/);
  });
});

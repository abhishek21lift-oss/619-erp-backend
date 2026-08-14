// The training API's authorization boundary, attacked rather than read.
//
// ── The failure this exists to catch ───────────────────────────────────────
//
// set_performances, cardio_performances and exercise_performances carry no
// organization_id. Their tenancy is inherited: a set belongs to a performance
// belongs to a session belongs to a client belongs to a studio.
//
// That makes a whole class of query look safe and be wrong:
//
//     UPDATE set_performances SET actual_weight = $2 WHERE id = $1
//
// It names one row, so it reads as scoped. It is completely unscoped — any
// authenticated trainer in any studio can pass any id. The only defence is
// joining back to pt_clients on every single write, and the only way to know
// that defence is present is to try the attack.
//
// So these tests send real requests as a trainer from studio B against rows
// owned by studio A, and assert 404 — not 403, because a 403 confirms the row
// exists. They also assert the SQL carried the org and trainer predicates,
// since a handler could return 404 for an unrelated reason and look correct.
'use strict';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SESSION_A = '33333333-3333-4333-8333-333333333333';
const PERF_A = '44444444-4444-4444-8444-444444444444';
const SET_A = '55555555-5555-4555-8555-555555555555';
const TEMPLATE_A = '66666666-6666-4666-8666-666666666666';

const mockQueries = [];
// Every ownership lookup returns nothing, which is what the database does for
// a caller outside the owning org — the point is to prove the QUERY carried
// the right predicates, not to re-test Postgres.
let mockOwnershipRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: mockOwnershipRows, rowCount: mockOwnershipRows.length };
  }),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => {
      mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      return { rows: mockOwnershipRows, rowCount: mockOwnershipRows.length };
    }),
    release: jest.fn(),
  })),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/screeningGate', () => ({
  checkScreeningGate: jest.fn(async () => ({ blocked: null, warnings: [] })),
}));

let mockUser = { id: 'u-b', role: 'trainer', organization_id: ORG_B, trainer_id: 't-b' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireStaff: (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));
jest.mock('../middleware/rbac', () => ({
  requireRole: () => (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/training', require('../modules/training/training.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

/** Every query this request ran, joined — for asserting predicates. */
const allSql = () => mockQueries.map((q) => q.sql).join(' || ');
const allParams = () => mockQueries.flatMap((q) => q.params);

beforeEach(() => {
  mockQueries.length = 0;
  mockOwnershipRows = [];
  mockUser = { id: 'u-b', role: 'trainer', organization_id: ORG_B, trainer_id: 't-b' };
});

describe('a trainer from another studio cannot reach a session', () => {
  test('GET /sessions/:id is 404, not 403', async () => {
    // 403 would confirm the session exists. 404 says nothing.
    const res = await request(app()).get(`/api/training/sessions/${SESSION_A}`);
    expect(res.status).toBe(404);
  });

  test('the lookup carried the caller\'s org, not the row\'s', async () => {
    await request(app()).get(`/api/training/sessions/${SESSION_A}`);
    expect(allSql()).toMatch(/s\.organization_id = \$\d/);
    expect(allParams()).toContain(ORG_B);
    expect(allParams()).not.toContain(ORG_A);
  });

  test('and the trainer predicate, since this caller is not an admin', async () => {
    await request(app()).get(`/api/training/sessions/${SESSION_A}`);
    expect(allSql()).toMatch(/c\.trainer_id = \$\d/);
    expect(allParams()).toContain('t-b');
  });

  test('completing another studio\'s session is refused', async () => {
    const res = await request(app()).post(`/api/training/sessions/${SESSION_A}/complete`).send({});
    expect(res.status).toBe(404);
    // Nothing was written. A completion that got as far as UPDATE would have
    // closed another studio's assignment.
    expect(allSql()).not.toMatch(/UPDATE training_sessions SET status = 'COMPLETED'/);
  });

  test('starting another studio\'s session is refused', async () => {
    const res = await request(app()).post(`/api/training/sessions/${SESSION_A}/start`);
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/UPDATE training_sessions SET status = 'IN_PROGRESS'/);
  });
});

describe('child rows are reached through the client, never by id alone', () => {
  test('logging a set walks back to pt_clients', async () => {
    // The whole point of the file. Without this join the handler would accept
    // any performance id from any studio.
    const res = await request(app()).post(`/api/training/performances/${PERF_A}/sets`)
      .send({ set_number: 1, actual_reps: 8, actual_weight: 100 });
    expect(res.status).toBe(404);
    expect(allSql()).toMatch(/JOIN training_sessions s ON s\.id = ep\.session_id/);
    expect(allSql()).toMatch(/JOIN pt_clients c ON c\.id = s\.client_id/);
    expect(allSql()).not.toMatch(/INSERT INTO set_performances/);
  });

  test('logging cardio does the same walk', async () => {
    const res = await request(app()).post(`/api/training/performances/${PERF_A}/cardio`)
      .send({ cardio_type: 'TREADMILL', duration_seconds: 1200 });
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/INSERT INTO cardio_performances/);
  });

  test('editing a set by id alone is refused', async () => {
    const res = await request(app()).patch(`/api/training/sets/${SET_A}`).send({ actual_weight: 200 });
    expect(res.status).toBe(404);
    expect(allSql()).toMatch(/JOIN exercise_performances ep ON ep\.id = sp\.exercise_performance_id/);
    expect(allSql()).not.toMatch(/UPDATE set_performances SET/);
  });

  test('deleting a set by id alone is refused', async () => {
    const res = await request(app()).delete(`/api/training/sets/${SET_A}`);
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/DELETE FROM set_performances/);
  });

  test('adding an exercise to another studio\'s session is refused', async () => {
    const res = await request(app()).post(`/api/training/sessions/${SESSION_A}/exercises`)
      .send({ exercise_id: 'ex-1' });
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/INSERT INTO exercise_performances/);
  });
});

describe('templates and programs are org-scoped', () => {
  test('another studio\'s template is not readable', async () => {
    const res = await request(app()).get(`/api/training/templates/${TEMPLATE_A}`);
    expect(res.status).toBe(404);
    expect(allParams()).toContain(ORG_B);
  });

  test('an exercise cannot be added to another studio\'s template', async () => {
    const res = await request(app()).post(`/api/training/templates/${TEMPLATE_A}/exercises`)
      .send({ exercise_id: 'ex-1', target_sets: 3, target_reps_min: 8 });
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/INSERT INTO workout_template_exercises/);
  });

  test('reordering another studio\'s template is refused', async () => {
    const res = await request(app()).put(`/api/training/templates/${TEMPLATE_A}/order`)
      .send({ exercise_ids: ['77777777-7777-4777-8777-777777777777'] });
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/UPDATE workout_template_exercises wte/);
  });
});

describe('a client cannot be reached across the boundary', () => {
  test('creating a session for another studio\'s client is refused', async () => {
    const res = await request(app()).post('/api/training/sessions').send({ client_id: 'client-a' });
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/INSERT INTO training_sessions/);
  });

  test('assigning a workout to another studio\'s client is refused', async () => {
    const res = await request(app()).post('/api/training/assignments')
      .send({ client_id: 'client-a', workout_template_id: TEMPLATE_A });
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/INSERT INTO training_assignments/);
  });

  test('reading records requires a client the caller can access', async () => {
    const res = await request(app()).get('/api/training/records?client_id=client-a');
    expect(res.status).toBe(404);
    expect(allSql()).not.toMatch(/SELECT \* FROM personal_records/);
  });

  test('reading records without a client_id is a 400, not everyone\'s records', async () => {
    const res = await request(app()).get('/api/training/records');
    expect(res.status).toBe(400);
    expect(allSql()).not.toMatch(/personal_records/);
  });
});

describe('an admin sees the whole studio, a trainer only their own clients', () => {
  test('an admin\'s query carries no trainer predicate', async () => {
    mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B, trainer_id: null };
    await request(app()).get('/api/training/sessions');
    expect(allSql()).toMatch(/s\.organization_id = \$\d/);
    expect(allSql()).not.toMatch(/c\.trainer_id = \$\d/);
  });

  test('a trainer\'s does', async () => {
    await request(app()).get('/api/training/sessions');
    expect(allSql()).toMatch(/c\.trainer_id = \$\d/);
  });

  test('a trainer with no trainer_id is still org-scoped', async () => {
    // An un-provisioned staff login must not fall through to "sees everything"
    // just because there is no trainer id to filter on.
    mockUser = { id: 'u-b', role: 'trainer', organization_id: ORG_B, trainer_id: null };
    await request(app()).get('/api/training/sessions');
    expect(allSql()).toMatch(/s\.organization_id = \$\d/);
    expect(allParams()).toContain(ORG_B);
  });
});

describe('validation runs before anything is written', () => {
  test('a set with no set_number is rejected', async () => {
    const res = await request(app()).post(`/api/training/performances/${PERF_A}/sets`)
      .send({ actual_reps: 8 });
    expect(res.status).toBe(400);
  });

  test('an RPE of 14 is rejected', async () => {
    const res = await request(app()).post(`/api/training/performances/${PERF_A}/sets`)
      .send({ set_number: 1, actual_rpe: 14 });
    expect(res.status).toBe(400);
  });

  test('cardio distance without a unit is rejected before the database sees it', async () => {
    const res = await request(app()).post(`/api/training/performances/${PERF_A}/cardio`)
      .send({ distance: 5 });
    expect(res.status).toBe(400);
    expect(allSql()).not.toMatch(/INSERT INTO cardio_performances/);
  });

  test('a template bound to a week must name its day', async () => {
    const res = await request(app()).post('/api/training/templates')
      .send({ name: 'Push A', week_id: '88888888-8888-4888-8888-888888888888' });
    expect(res.status).toBe(400);
  });

  test('a phase ending before it starts is rejected', async () => {
    const res = await request(app()).post(`/api/training/programs/${TEMPLATE_A}/phases`)
      .send({ name: 'Peak', week_start: 9, week_end: 4 });
    expect(res.status).toBe(400);
  });
});

describe('the meta endpoint publishes the vocabulary rather than duplicating it', () => {
  // The builder changes its field set when a trainer switches an exercise
  // from SETS_REPS to TIME_DISTANCE. Hard-coding that map in the frontend
  // would put a second copy in another repository, and the two would drift
  // the first time a type gained a field — quietly, into a UI that offers a
  // field the API ignores.
  test('every prescription type reports its fields and where it logs', async () => {
    const res = await request(app()).get('/api/training/meta');
    expect(res.status).toBe(200);
    const types = res.body.data.prescription_types;
    expect(types.length).toBeGreaterThan(10);
    for (const t of types) {
      expect([t.type, Array.isArray(t.fields)]).toEqual([t.type, true]);
      expect([t.type, ['sets', 'cardio', 'either'].includes(t.logs_as)])
        .toEqual([t.type, true]);
    }
  });

  test('TIME_DISTANCE offers distance and incline, and does not offer sets', async () => {
    const res = await request(app()).get('/api/training/meta');
    const td = res.body.data.prescription_types.find((t) => t.type === 'TIME_DISTANCE');
    expect(td.fields).toContain('target_distance');
    expect(td.fields).toContain('target_incline');
    expect(td.fields).not.toContain('target_sets');
    expect(td.logs_as).toBe('cardio');
  });

  test('SETS_REPS is the mirror image', async () => {
    const res = await request(app()).get('/api/training/meta');
    const sr = res.body.data.prescription_types.find((t) => t.type === 'SETS_REPS');
    expect(sr.fields).toContain('target_sets');
    expect(sr.fields).not.toContain('target_distance');
    expect(sr.logs_as).toBe('sets');
  });

  test('it reads no tables, so it cannot leak across studios', async () => {
    await request(app()).get('/api/training/meta');
    expect(allSql()).toBe('');
  });
});

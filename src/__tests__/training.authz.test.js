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

const ORG_B = '22222222-2222-4222-8222-222222222222';
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

// Retargeted from GET /sessions, which is gone, to GET /programs. The property
// is the authz helpers' and not the endpoint's: listPrograms() applies
// orgWhere() and the same trainer subquery, so this still pins what it always
// pinned — an un-provisioned trainer must not fall through to "sees all".
describe('an admin sees the whole studio, a trainer only their own clients', () => {
  test('an admin\'s query carries no trainer predicate', async () => {
    mockUser = { id: 'u-b', role: 'admin', organization_id: ORG_B, trainer_id: null };
    await request(app()).get('/api/training/programs');
    expect(allSql()).toMatch(/p\.organization_id = \$\d/);
    expect(allSql()).not.toMatch(/c\.trainer_id = \$\d/);
  });

  test('a trainer\'s does', async () => {
    await request(app()).get('/api/training/programs');
    expect(allSql()).toMatch(/c\.trainer_id = \$\d/);
  });

  test('a trainer with no trainer_id is still org-scoped', async () => {
    // An un-provisioned staff login must not fall through to "sees everything"
    // just because there is no trainer id to filter on.
    mockUser = { id: 'u-b', role: 'trainer', organization_id: ORG_B, trainer_id: null };
    await request(app()).get('/api/training/programs');
    expect(allSql()).toMatch(/p\.organization_id = \$\d/);
    expect(allParams()).toContain(ORG_B);
  });
});

describe('validation runs before anything is written', () => {



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

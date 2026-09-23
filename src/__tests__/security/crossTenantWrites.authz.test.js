// Writes that reached ANOTHER studio's rows, and the predicates that stop them.
//
// Every case here was live. They share one shape: the handler had an
// organization filter on the READ it did first, and none on the WRITE it did
// second — so the boundary held for anything the caller could see and not for
// anything they could name.
//
//   1. POST /pt-os/clients with a body `client_id`
//      The create endpoint doubles as "enrol this existing client". The final
//      UPDATE was keyed on that id alone, so posting another studio's client id
//      rewrote their package, price, dates and trainer — and returned the row,
//      so it was a read as well as a write.
//
//   2. POST /attendance  (ON CONFLICT (ref_id, ref_type, date))
//      The conflict key carries no organization. An INSERT naming another
//      studio's client id conflicted with THEIR row and took the DO UPDATE
//      branch, overwriting somebody else's register entry.
//
//   3. POST /workouts/assign  (ON CONFLICT (workout_plan_id, client_id))
//      The same shape: re-assigning revives an existing row, and the existing
//      row could be another studio's.
//
//   4. A `trainer_id` in any request body
//      `trainers` rows are found by primary key. An unscoped lookup let one
//      studio attach another studio's coach profile to its own client — and
//      then read that profile's name and incentive rate back through joins.
//
// The assertions are on the STATEMENT, not only on the status code. A handler
// that fetched every studio's rows and filtered them in JavaScript would pass a
// status-code-only test while still doing the unscoped write.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
/** Queued answers, one per query, in order. */
let mockAnswers;

function mockAnswer(sql) {
  const next = mockAnswers.shift();
  const rows = typeof next === 'function' ? next(sql) : (next ?? []);
  return { rows, rowCount: rows.length };
}

jest.mock('../../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return mockAnswer(String(sql));
  }),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => {
      mockLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      return mockAnswer(String(sql));
    }),
    release: jest.fn(),
  })),
}));

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../../lib/screeningGate', () => ({
  checkScreeningGate: jest.fn(async () => ({ blocked: null, warnings: [] })),
}));
jest.mock('../../modules/automation/automation.engine', () => ({
  memberCreated: jest.fn(async () => {}),
  clientRenewed: jest.fn(async () => {}),
}), { virtual: true });

let mockUser;
jest.mock('../../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  // The real guard, so these exercise production authorization.
  requireTrainer: (...a) => jest.requireActual('../../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../../middleware/rbac').requireTrainerOrSelf(...a),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../middleware/errorHandler');

const TRAINER_A = {
  id: 'usr-a', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a',
};

/** An app with one router mounted, and the central error handler behind it. */
function app(mountPath, modulePath) {
  const a = express();
  a.use(express.json());
  a.use(mountPath, require(modulePath));
  a.use(errorHandler);
  return a;
}

/** The first recorded statement matching `re`. */
const stmt = (re) => mockLog.find((q) => re.test(q.sql));

beforeEach(() => {
  jest.clearAllMocks();
  mockLog.length = 0;
  mockAnswers = [];
  mockUser = { ...TRAINER_A };
});

// ── 1. Enrolling a client by id ────────────────────────────────────────────

describe('POST /pt-os/clients — the body client_id is not a key to another studio', () => {
  const ptOs = () => app('/api/pt-os', '../../modules/pt-os/pt-os.routes');
  const FOREIGN = 'ptc-belongs-to-b';

  test('the update that enrols an existing client is bound to the caller organization', async () => {
    mockAnswers = [
      [],   // trainer lookup (no trainer_id sent)
      [],   // the UPDATE: no row in THIS studio with that id
    ];

    const res = await request(ptOs())
      .post('/api/pt-os/clients')
      .send({ client_id: FOREIGN, name: 'X', base_amount: 50000, duration_months: 3 });

    // 404, not 403: confirming the id exists elsewhere is itself a disclosure.
    expect(res.status).toBe(404);

    const update = stmt(/UPDATE pt_clients SET/i);
    expect(update).toBeTruthy();
    expect(update.sql).toMatch(/WHERE id = \$1 AND deleted_at IS NULL AND organization_id = \$20/);
    expect(update.params[19]).toBe(ORG_A);
    expect(update.params).not.toContain(ORG_B);
  });

  test('no INSERT is attempted for a client_id the caller supplied', async () => {
    // The create branch runs only when no id was sent. If a foreign id fell
    // through to it, the studio would get a copy of somebody else's client.
    mockAnswers = [[], []];
    await request(ptOs())
      .post('/api/pt-os/clients')
      .send({ client_id: FOREIGN, name: 'X' });

    expect(stmt(/INSERT INTO pt_clients/i)).toBeUndefined();
  });
});

// ── 2. Attendance ──────────────────────────────────────────────────────────

describe('POST /attendance — ON CONFLICT cannot cross the boundary', () => {
  const attendance = () => app('/api/attendance', '../../routes/attendance');

  test('the upsert refuses to update a row owned by another studio', async () => {
    mockAnswers = [
      [{ id: 'ptc-a', name: 'Mine' }],  // the client exists, in THIS studio
      [],                                // the upsert
    ];

    const res = await request(attendance())
      .post('/api/attendance')
      .send({ ref_id: 'ptc-a', ref_type: 'client', date: '2026-02-02', status: 'present' });

    expect(res.status).toBe(201);

    const upsert = stmt(/INSERT INTO attendance_logs/i);
    expect(upsert).toBeTruthy();
    // The conflict key is (ref_id, ref_type, date) — no organization in it —
    // so the DO UPDATE branch carries the predicate instead.
    expect(upsert.sql).toMatch(/ON CONFLICT \(ref_id, ref_type, date\) DO UPDATE/);
    expect(upsert.sql).toMatch(/WHERE attendance_logs\.organization_id IS NULL OR attendance_logs\.organization_id = \$12/);
    expect(upsert.params[11]).toBe(ORG_A);
  });

  test('the client it names is looked up inside the caller studio first', async () => {
    mockAnswers = [[]];   // no such client here

    const res = await request(attendance())
      .post('/api/attendance')
      .send({ ref_id: 'ptc-belongs-to-b', ref_type: 'client', date: '2026-02-02', status: 'present' });

    expect(res.status).toBe(404);
    expect(stmt(/INSERT INTO attendance_logs/i)).toBeUndefined();
    const lookup = stmt(/FROM pt_clients/i);
    expect(lookup.sql).toMatch(/organization_id = \$/);
    expect(lookup.params).toContain(ORG_A);
  });
});

// ── 3. Assigning a workout plan ────────────────────────────────────────────

describe('POST /workouts/assign — ON CONFLICT cannot cross the boundary', () => {
  const workouts = () => app('/api/workouts', '../../routes/workouts');

  test('the assignment upsert is bound to the caller organization', async () => {
    mockAnswers = [
      [{ id: 'plan-1' }],                       // the plan is visible here
      [{ id: 'ptc-a', trainer_id: 'trn-a' }],   // the client is in this studio
      [{ id: 'asg-1' }],                        // the upsert
    ];

    const res = await request(workouts())
      .post('/api/workouts/assign')
      .send({ workout_plan_id: 'plan-1', client_id: 'ptc-a' });

    expect(res.status).toBe(201);

    const upsert = stmt(/INSERT INTO workout_assignments/i);
    expect(upsert).toBeTruthy();
    expect(upsert.sql).toMatch(/ON CONFLICT \(workout_plan_id, client_id\)/);
    expect(upsert.sql).toMatch(/WHERE workout_assignments\.organization_id IS NULL OR workout_assignments\.organization_id = EXCLUDED\.organization_id/);
    expect(upsert.params).toContain(ORG_A);
  });

  test('a client outside the studio is 404 and nothing is written', async () => {
    mockAnswers = [
      [{ id: 'plan-1' }],  // plan visible
      [],                  // client not in this studio
    ];

    const res = await request(workouts())
      .post('/api/workouts/assign')
      .send({ workout_plan_id: 'plan-1', client_id: 'ptc-belongs-to-b' });

    expect(res.status).toBe(404);
    expect(stmt(/INSERT INTO workout_assignments/i)).toBeUndefined();
  });
});

// ── 4. trainer_id, wherever it arrives ─────────────────────────────────────

describe('a trainer_id from a request body is resolved inside the studio', () => {
  const { resolveTrainerId, trainerForOrg, InvalidTrainerError } = require('../../lib/studioTrainer');

  const db = (rows) => ({ query: jest.fn(async (sql, params) => { mockLog.push({ sql, params }); return { rows, rowCount: rows.length }; }) });

  test('the lookup filters by organization and by deleted_at', async () => {
    const d = db([{ id: 'trn-a', name: 'Coach', incentive_rate: 0.1 }]);
    await trainerForOrg(d, ORG_A, 'trn-a');

    const [sql, params] = d.query.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toMatch(/WHERE id = \$1 AND organization_id = \$2 AND deleted_at IS NULL/);
    expect(params).toEqual(['trn-a', ORG_A]);
  });

  test('another studio\'s trainer id is refused, not silently stored', async () => {
    // Refusing rather than dropping the value: a client saved with a trainer
    // the caller did not intend is worse than a clear 400.
    const d = db([]);
    await expect(resolveTrainerId(d, ORG_A, 'trn-belongs-to-b')).rejects.toBeInstanceOf(InvalidTrainerError);
  });

  test('an absent trainer_id is null, and asks the database nothing', async () => {
    const d = db([]);
    for (const empty of [undefined, null, '']) {
      expect(await resolveTrainerId(d, ORG_A, empty)).toBeNull();
    }
    expect(d.query).not.toHaveBeenCalled();
  });

  test('an org-less caller matches nothing, whatever id they name', async () => {
    const d = db([{ id: 'trn-a' }]);
    expect(await trainerForOrg(d, null, 'trn-a')).toBeNull();
    expect(d.query).not.toHaveBeenCalled();
  });

  test('the error is a 400 through the central handler, not a 500', async () => {
    const a = express();
    a.use(express.json());
    a.get('/boom', (_req, _res, next) => next(new InvalidTrainerError()));
    a.use(errorHandler);

    const res = await request(a).get('/boom');
    // 400 with the reason, rather than the 500 a plain Error would produce —
    // "something went wrong" on a validation failure sends the studio looking
    // for an outage instead of fixing the field.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong to this studio/);
  });
});

// POST /api/workouts/plans/from-generation — saving an AI proposal.
//
// ── The property this endpoint exists to have ─────────────────────────────
//
// It takes a generation ID, not a plan. The obvious API would accept the
// generated plan in the request body, and that shape has a hole: any caller
// could post any plan and have it filed as an accepted AI proposal — including
// exercises the safety screen excluded, with that screen's own frozen record
// attached saying they were not there.
//
// Reading the plan back from the ledger closes it. What gets saved is exactly
// what was generated, screened and audited, and the accept link cannot be
// wrong because there is nothing to correlate.
//
// The other property is atomicity. A half-saved programme is worse than a
// failed save: the trainer sees a plan with three of nine exercises and no way
// to tell which six are missing.
'use strict';

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

// The pooled client's query and the pool's own share ONE implementation, so a
// test can route every statement from one place — but they are recorded
// separately as well. Without that, a write moved OUT of the transaction and
// onto the pool is invisible: both land in the same call list, in the same
// order, and every assertion about BEGIN/COMMIT still passes. That mutation
// survived the first round of this suite.
jest.mock('../db/pool', () => {
  const query = jest.fn();
  const release = jest.fn();
  const onClient = [];
  const client = {
    query: jest.fn((...args) => { onClient.push(String(args[0])); return query(...args); }),
    release,
  };
  return { query, connect: jest.fn(async () => client), __client: client, __onClient: onClient };
});

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../lib/screeningGate', () => ({ checkScreeningGate: jest.fn(async () => ({ blocked: null, warnings: [] })) }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/workouts', require('../routes/workouts'));

const ORG = '11111111-1111-1111-1111-111111111111';
const TRAINER = { id: 'u-tr', role: 'trainer', organization_id: ORG, trainer_id: 'tr-1' };

const PROPOSED = {
  name: 'Hypertrophy Block', goal: 'muscle_gain', level: 'intermediate',
  weeks: 8, days_per_week: 2,
  weekly_schedule: {
    Monday: { exercises: [{ name: 'Bench Press', sets: 4, reps: '8-10', rir_or_rpe: 'RIR 2', rest_seconds: 120 }] },
    Thursday: { exercises: [{ name: 'Overhead Press', sets: 3, reps: '10' }] },
  },
};

/** Only Bench Press is in the library — the one-in-eight case, on purpose. */
const LIBRARY = [{ id: 'ex-bench', name: 'Bench Press' }];

function mockDb({ generation = { id: 'gen-1', client_id: 'cl-1', proposed_plan: PROPOSED, accepted_plan_id: null },
  library = LIBRARY, acceptRows = 1 } = {}) {
  pool.query.mockReset();
  pool.connect.mockClear();
  pool.__onClient.length = 0;
  pool.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/FROM ai_workout_generations/.test(s)) return Promise.resolve({ rows: generation ? [generation] : [] });
    if (/FROM exercises/.test(s)) return Promise.resolve({ rows: library });
    if (/UPDATE ai_workout_generations/.test(s)) return Promise.resolve({ rowCount: acceptRows, rows: [] });
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

const sqls = () => pool.query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' '));
/** Only the statements issued on the TRANSACTION's connection. */
const txSqls = () => pool.__onClient.map((s) => s.replace(/\s+/g, ' '));
const post = (body = { generation_id: 'gen-1' }) =>
  request(app).post('/api/workouts/plans/from-generation').send(body);

beforeEach(() => { mockUser = TRAINER; mockDb(); });

describe('saving a proposal', () => {
  it('writes the plan, its exercises and the accept stamp', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(1);
    expect(res.body.client_id).toBe('cl-1');

    const all = sqls();
    expect(all.some((s) => /INSERT INTO workout_plans/.test(s))).toBe(true);
    expect(all.some((s) => /INSERT INTO workout_exercises/.test(s))).toBe(true);
    expect(all.some((s) => /UPDATE ai_workout_generations/.test(s))).toBe(true);
  });

  it('does all three in one transaction', async () => {
    await post();
    const all = sqls();
    // A half-saved programme — a plan with some of its exercises, or a plan
    // whose proposal still reads as rejected — is the one state the memory
    // cannot recover from.
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK');
    expect(all.indexOf('BEGIN')).toBeLessThan(all.findIndex((s) => /INSERT INTO workout_plans/.test(s)));
    expect(all.findIndex((s) => /UPDATE ai_workout_generations/.test(s)))
      .toBeLessThan(all.indexOf('COMMIT'));
  });

  it('reports what it could not save instead of shortening the session quietly', async () => {
    const res = await post();
    // Overhead Press is not in the library. Trigram similarity would file it
    // under "Overhead Lat"; this reports it instead.
    expect(res.body.unresolved).toEqual([
      { day: 'Thursday', position: 1, name: 'Overhead Press', reason: 'not in the exercise library' },
    ]);
    // And it is a 201, not an error: one name in eight is the expected rate.
    expect(res.status).toBe(201);
  });

  it('lets the trainer name the programme', async () => {
    const res = await post({ generation_id: 'gen-1', name: '  Priya — Block 2  ' });
    expect(res.body.name).toBe('Priya — Block 2');
  });
});

describe('what it refuses', () => {
  it('takes an id, never a plan', async () => {
    // The security model of the endpoint. A body-shaped API would let a caller
    // post exercises the screen excluded and have them filed as an accepted
    // AI proposal.
    const res = await post({
      generation_id: 'gen-1',
      plan: { weekly_schedule: { Monday: { exercises: [{ name: 'Smuggled' }] } } },
    });
    expect(res.status).toBe(201);
    const inserted = pool.query.mock.calls
      .filter(([s]) => /INSERT INTO workout_exercises/.test(String(s)))
      .map(([, p]) => p[2]);
    // Only the ledger's own plan was saved.
    expect(inserted).toEqual(['ex-bench']);
  });

  it('scopes the ledger read to the studio', async () => {
    await post();
    const read = pool.query.mock.calls.find(([s]) => /FROM ai_workout_generations/.test(String(s)));
    expect(String(read[0])).toMatch(/organization_id = \$2/);
    expect(read[1][1]).toBe(ORG);
  });

  it('answers the same way for another studio\'s id and one that never existed', async () => {
    mockDb({ generation: null });
    const res = await post();
    // One answer for both, so the endpoint cannot be used to probe which
    // generation ids exist.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Generation not found');
  });

  it('will not save the same proposal twice', async () => {
    mockDb({ generation: { id: 'gen-1', client_id: 'cl-1', proposed_plan: PROPOSED, accepted_plan_id: 'plan-old' } });
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ACCEPTED');
    // The existing plan comes back so the UI navigates to it rather than
    // showing a failure for work that succeeded.
    expect(res.body.plan_id).toBe('plan-old');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back when another request accepts it first', async () => {
    // The stamp is conditional on accepted_plan_id IS NULL, so a race loses
    // here rather than leaving two plans for one proposal.
    mockDb({ acceptRows: 0 });
    const res = await post();
    expect(res.status).toBe(409);
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
  });

  it('refuses rather than saving an empty programme', async () => {
    mockDb({ library: [] });
    const res = await post();
    // Saving nothing and calling the proposal accepted would poison the
    // memory: it would diff a full proposal against an empty plan and read
    // every exercise as one the trainer removed.
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NOTHING_RESOLVED');
    expect(res.body.unresolved).toHaveLength(2);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('requires a generation id', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('the proposal has to actually reach the client', () => {
  // ── The bug this describes ──────────────────────────────────────────────
  //
  // Accepting a proposal used to write a workout_plans row and stop. Nothing
  // assigned it to anybody, and three things followed that nobody had noticed:
  //
  //   · Today lists clients by ACTIVE ASSIGNMENT whose plan prescribes the
  //     weekday, so the programme the AI wrote could not be started from the
  //     screen a trainer actually uses;
  //   · workout_sessions.workout_assignment_id could never point at it;
  //   · so no logged session could ever be attributed back to the proposal,
  //     which made the outcome half of the loop structurally impossible
  //     rather than merely unbuilt.
  //
  // Measured on production at the time: 6 recorded generations, 0 accepted,
  // and 29 of 34 clients with no active assignment at all.

  it('assigns the plan to the client, in the same transaction', async () => {
    const res = await post();
    const all = sqls();

    expect(all.some((s) => /INSERT INTO workout_assignments/.test(s))).toBe(true);
    expect(res.body.assigned).toBe(true);
    expect(res.body.assignment_id).toEqual(expect.any(String));

    // On the TRANSACTION's own connection, between BEGIN and COMMIT. Asserting
    // the position in the combined call list is not enough on its own: a write
    // moved onto the pool appears in exactly the same place there, so it would
    // still read as transactional while rolling back would leave it behind.
    const tx = txSqls();
    const assignAt = tx.findIndex((s) => /INSERT INTO workout_assignments/.test(s));
    expect(assignAt).toBeGreaterThan(-1);
    expect(tx.indexOf('BEGIN')).toBeLessThan(assignAt);
    expect(assignAt).toBeLessThan(tx.indexOf('COMMIT'));
    // And the plan a rollback would have to take with it.
    expect(tx.some((s) => /INSERT INTO workout_plans/.test(s))).toBe(true);
  });

  it('takes the trainer from the client record rather than the caller', async () => {
    await post();
    const assign = sqls().find((s) => /INSERT INTO workout_assignments/.test(s));
    expect(assign).toMatch(/SELECT trainer_id FROM pt_clients/);
  });

  it('adds an assignment and retires nothing', async () => {
    await post();
    const all = sqls();
    // The engine never overwrites a programme a trainer chose. Anything that
    // completed or cancelled the client's existing assignments would be this
    // system deciding for them.
    expect(all.some((s) => /UPDATE workout_assignments/.test(s))).toBe(false);
    expect(all.some((s) => /DELETE FROM workout_assignments/.test(s))).toBe(false);
  });

  it('tells the trainer what else the client is already on', async () => {
    // Above zero, the session log can no longer auto-link this client to one
    // plan — it links only when there is exactly one active assignment — so
    // attribution becomes theirs to make by hand. They are told, not guessed for.
    pool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM ai_workout_generations/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'gen-1', client_id: 'cl-1', proposed_plan: PROPOSED, accepted_plan_id: null }] });
      }
      if (/FROM exercises/.test(s)) return Promise.resolve({ rows: LIBRARY });
      if (/UPDATE ai_workout_generations/.test(s)) return Promise.resolve({ rowCount: 1, rows: [] });
      if (/COUNT\(\*\)::int AS n/.test(s)) return Promise.resolve({ rows: [{ n: 4 }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const res = await post();
    expect(res.body.other_active_assignments).toBe(4);
  });

  it('excludes the assignment it just made from that count', async () => {
    await post();
    const count = sqls().find((s) => /COUNT\(\*\)::int AS n/.test(s));
    expect(count).toMatch(/status = 'active'/);
    expect(count).toMatch(/id <> \$2/);
  });

  it('writes no assignment when the save fails', async () => {
    // Nothing in the proposal resolves against the library, so the save is
    // rejected before the transaction opens. The property worth pinning: a
    // failed save leaves no orphan assignment pointing at a plan that was
    // never written.
    mockDb({ library: [] });
    const res = await post();

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NOTHING_RESOLVED');
    expect(sqls().some((s) => /INSERT INTO workout_assignments/.test(s))).toBe(false);
    expect(sqls().some((s) => /INSERT INTO workout_plans/.test(s))).toBe(false);
  });

  it('refuses a trainer account with no studio before touching anything', async () => {
    // acceptGeneration still guards on orgId — it is exported and other
    // callers could reach it — but through this route the router guard
    // refuses an org-less caller first.
    mockUser = { id: 'u-tr', role: 'trainer', organization_id: null, trainer_id: 'tr-1' };
    const res = await post();

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

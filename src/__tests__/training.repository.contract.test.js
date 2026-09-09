// What the training adapter asks the database for, and with which values.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Phase 5 moved every query out of training.routes.js into
// training.repository.js. A move like that is the easy kind of change to get
// wrong in the one way nothing catches: the SQL text survives review because
// it is copied verbatim, and the BIND LIST is retyped. Swap two parameters of
// the same type — a template id and a prescription id, a client id and a
// trainer id — and every existing test still passes, because they assert on
// predicates and status codes rather than on values.
//
// training.authz.test.js attacks the boundary and proves the org and trainer
// predicates are present. It deliberately makes every ownership lookup return
// nothing, so it never reaches the second query. This file is the other half:
// ownership succeeds, the handler runs to completion, and each moved endpoint
// is checked against the statement it must issue and the exact arguments it
// must pass.
//
// Together they say: the right rows, for the right caller, with the right
// values.
'use strict';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '99999999-9999-4999-8999-999999999999';
const TEMPLATE = '66666666-6666-4666-8666-666666666666';
const PRESCRIPTION = '77777777-7777-4777-8777-777777777777';
const SESSION = '33333333-3333-4333-8333-333333333333';
const SET = '55555555-5555-4555-8555-555555555555';
const CARDIO = '88888888-8888-4888-8888-888888888888';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASSIGNMENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXERCISE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROGRAM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WEEK = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const queries = [];

/**
 * Every query answers with one row.
 *
 * The ownership lookups this makes succeed are exactly the ones
 * training.authz.test.js makes fail, which is why the two files reach
 * different statements from the same requests.
 */
const row = { id: 'row', prescription_type: 'SETS_REPS', target_sets: 3, target_reps_min: 8 };

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: [row], rowCount: 1 };
  }),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      return { rows: [row], rowCount: 1 };
    }),
    release: jest.fn(),
  })),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/screeningGate', () => ({
  checkScreeningGate: jest.fn(async () => ({ blocked: null, warnings: [] })),
}));

// An admin, so authz's trainer clause is absent and the parameter lists below
// are the handler's own values rather than a mix of those and a trainer id.
// The `mock` prefix is required: jest.mock is hoisted, and only names spelled
// that way may be referenced from a factory.
const mockUser = { id: USER, role: 'admin', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../middleware/rbac', () => ({ requireRole: () => (_req, _res, next) => next() }));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/training', require('../modules/training/training.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

beforeEach(() => { queries.length = 0; });

/** The last query the request issued — the one the handler is actually for. */
const last = () => queries[queries.length - 1];

/** The first query whose text matches — for handlers that issue several. */
const matching = (re) => queries.find((q) => re.test(q.sql));

describe('templates', () => {
  test('GET /templates binds the org and both optional filters, in order', async () => {
    const res = await request(app())
      .get('/api/training/templates?program_id=p-1&week_id=w-1');
    expect(res.status).toBe(200);
    expect(last().sql).toContain('FROM workout_templates');
    expect(last().params).toEqual([ORG, 'p-1', 'w-1']);
  });

  test('GET /templates/:id reads the prescriptions of the template that was authorised', async () => {
    await request(app()).get(`/api/training/templates/${TEMPLATE}`);
    const q = matching(/FROM workout_template_exercises wte/);
    // row.id, not the path parameter: the id comes from the row ownership
    // returned, which is what stops a caller reaching a template by id alone.
    expect(q.params).toEqual([row.id]);
  });

  test('POST /templates writes the caller\'s org and user, then the body in column order', async () => {
    // program_id and week_id are adjacent columns of the same type, which is
    // the pair a retyped bind list gets wrong without anything noticing.
    const res = await request(app()).post('/api/training/templates').send({
      program_id: PROGRAM, week_id: WEEK,
      name: 'Push A', description: 'chest', day_number: 1, day_label: 'Mon',
      goal: 'HYPERTROPHY', estimated_duration_minutes: 60, notes: 'n',
    });
    expect(res.status).toBe(201);
    expect(last().sql).toContain('INSERT INTO workout_templates');
    expect(last().params).toEqual([
      ORG, PROGRAM, WEEK, USER, 'Push A', 'chest', 1, 'Mon', 'HYPERTROPHY', 60, 'n',
    ]);
  });

  test('POST /templates/:id/exercises inserts only the columns the body named', async () => {
    const res = await request(app()).post(`/api/training/templates/${TEMPLATE}/exercises`).send({
      exercise_id: EXERCISE, target_sets: 4, target_reps_min: 6, target_reps_max: 8,
    });
    expect(res.status).toBe(201);
    // prescription_type is defaulted by the handler, so it is written even
    // though the body omitted it; nothing else absent from the body appears.
    expect(last().sql).toBe(
      'INSERT INTO workout_template_exercises (workout_template_id, exercise_id, prescription_type, '
      + 'target_sets, target_reps_min, target_reps_max) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *'
    );
    expect(last().params).toEqual([row.id, EXERCISE, 'SETS_REPS', 4, 6, 8]);
  });

  test('PATCH a prescription reads it scoped to its template — id first, template second', async () => {
    await request(app())
      .patch(`/api/training/templates/${TEMPLATE}/exercises/${PRESCRIPTION}`)
      .send({ target_sets: 5 });
    const read = matching(/SELECT \* FROM workout_template_exercises WHERE id = \$1 AND workout_template_id = \$2/);
    expect(read.params).toEqual([PRESCRIPTION, row.id]);
  });

  test('PATCH a prescription updates only the fields the body named', async () => {
    const res = await request(app())
      .patch(`/api/training/templates/${TEMPLATE}/exercises/${PRESCRIPTION}`)
      .send({ target_sets: 5, notes: 'deload' });
    expect(res.status).toBe(200);
    expect(last().sql).toBe(
      'UPDATE workout_template_exercises SET target_sets = $2, notes = $3, updated_at = NOW() WHERE id = $1 RETURNING *'
    );
    expect(last().params).toEqual([PRESCRIPTION, 5, 'deload']);
  });

  test('PATCH with nothing patchable issues no UPDATE and answers with the row as it stands', async () => {
    const res = await request(app())
      .patch(`/api/training/templates/${TEMPLATE}/exercises/${PRESCRIPTION}`)
      .send({});
    expect(res.status).toBe(200);
    expect(queries.some((q) => /UPDATE workout_template_exercises/.test(q.sql))).toBe(false);
    expect(res.body.data).toEqual(row);
  });

  test('DELETE a prescription is scoped to its template', async () => {
    const res = await request(app())
      .delete(`/api/training/templates/${TEMPLATE}/exercises/${PRESCRIPTION}`);
    expect(res.status).toBe(200);
    expect(last().sql).toBe(
      'DELETE FROM workout_template_exercises WHERE id = $1 AND workout_template_id = $2'
    );
    expect(last().params).toEqual([PRESCRIPTION, row.id]);
  });

  test('PUT /templates/:id/order reorders inside a transaction and reports the count', async () => {
    const ids = [PRESCRIPTION, EXERCISE];
    const res = await request(app())
      .put(`/api/training/templates/${TEMPLATE}/order`)
      .send({ exercise_ids: ids });
    expect(res.status).toBe(200);
    expect(res.body.data.reordered).toBe(2);
    expect(queries.map((q) => q.sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    const update = matching(/unnest\(\$2::uuid\[\]\)/);
    expect(update.params).toEqual([row.id, ids]);
  });
});

describe('assignments', () => {
  test('GET /assignments binds the org then each filter in the order the query names them', async () => {
    const res = await request(app())
      .get('/api/training/assignments?client_id=c-1&date=2026-01-02&status=SCHEDULED');
    expect(res.status).toBe(200);
    expect(last().params).toEqual([ORG, 'c-1', '2026-01-02', 'SCHEDULED']);
  });

  test('POST /assignments passes the client id twice — once as a value, once for the trainer fallback', async () => {
    const res = await request(app()).post('/api/training/assignments').send({
      client_id: CLIENT, workout_template_id: TEMPLATE, scheduled_date: '2026-01-02',
    });
    expect(res.status).toBe(201);
    // $4 is the client id and the COALESCE subselect reads it again, so a
    // swap here would silently assign to whoever $4 happened to name.
    expect(last().sql).toContain('COALESCE($5,(SELECT trainer_id FROM pt_clients WHERE id=$4))');
    expect(last().params).toEqual([
      ORG, null, TEMPLATE, CLIENT, null, USER, '2026-01-02', null, null,
    ]);
  });

  test('PATCH /assignments/:id patches only status, scheduled_date and notes', async () => {
    const res = await request(app())
      .patch(`/api/training/assignments/${ASSIGNMENT}`)
      .send({ status: 'COMPLETED', notes: 'done', client_id: 'someone-elses-client' });
    expect(res.status).toBe(200);
    // client_id is NOT in the allow-list: re-pointing an assignment at another
    // studio's client must be impossible, not merely unchecked.
    expect(last().sql).toBe(
      'UPDATE training_assignments SET status = $2, notes = $3, updated_at = NOW() WHERE id = $1 RETURNING *'
    );
    expect(last().params).toEqual([ASSIGNMENT, 'COMPLETED', 'done']);
  });

  test('PATCH /assignments/:id with nothing patchable is a 404 and writes nothing', async () => {
    const res = await request(app()).patch(`/api/training/assignments/${ASSIGNMENT}`).send({});
    expect(res.status).toBe(404);
    expect(queries.some((q) => /UPDATE training_assignments/.test(q.sql))).toBe(false);
  });
});

describe('sessions', () => {
  test('GET /sessions binds the clamped limit last, after the org and the filters', async () => {
    const res = await request(app()).get('/api/training/sessions?client_id=c-1&status=DRAFT&limit=25');
    expect(res.status).toBe(200);
    expect(last().params).toEqual([ORG, 'c-1', 'DRAFT', 25]);
    expect(last().sql).toMatch(/LIMIT \$4$/);
  });

  test('a hostile limit never reaches SQL', async () => {
    // Postgres rejects a negative LIMIT outright (SQLSTATE 2201W), so this is
    // a 500 any caller could trigger from the query string.
    await request(app()).get('/api/training/sessions?limit=-1');
    expect(last().params[last().params.length - 1]).toBe(1);
    queries.length = 0;
    await request(app()).get('/api/training/sessions?limit=99999');
    expect(last().params[last().params.length - 1]).toBe(200);
  });

  test('PATCH /sessions/:id patches only the note fields', async () => {
    const res = await request(app()).patch(`/api/training/sessions/${SESSION}`).send({
      trainer_notes: 'good', overall_rpe: 8, client_id: 'not-patchable',
    });
    expect(res.status).toBe(200);
    expect(last().sql).toBe(
      'UPDATE training_sessions SET trainer_notes = $2, overall_rpe = $3, updated_at = NOW() WHERE id = $1 RETURNING *'
    );
    expect(last().params).toEqual([SESSION, 'good', 8]);
  });
});

describe('performances, sets and cardio', () => {
  test('POST /sessions/:id/exercises snapshots the name and defaults the order index', async () => {
    const res = await request(app())
      .post(`/api/training/sessions/${SESSION}/exercises`)
      .send({ exercise_id: EXERCISE, section: 'MAIN' });
    expect(res.status).toBe(201);
    expect(last().sql).toContain("COALESCE((SELECT name FROM exercises WHERE id = $2), 'Exercise')");
    expect(last().sql).toContain('SELECT COALESCE(MAX(order_index),-1)+1 FROM exercise_performances WHERE session_id=$1');
    expect(last().params).toEqual([row.id, EXERCISE, null, 'MAIN', null, null]);
  });

  test('PATCH /sets/:id patches only set columns', async () => {
    const res = await request(app()).patch(`/api/training/sets/${SET}`).send({
      actual_reps: 10, actual_weight: 60, session_id: 'not-patchable',
    });
    expect(res.status).toBe(200);
    expect(last().sql).toBe(
      'UPDATE set_performances SET actual_reps = $2, actual_weight = $3, updated_at = NOW() WHERE id = $1 RETURNING *'
    );
    expect(last().params).toEqual([SET, 10, 60]);
  });

  test('DELETE /sets/:id deletes the set named in the path', async () => {
    const res = await request(app()).delete(`/api/training/sets/${SET}`);
    expect(res.status).toBe(200);
    expect(last().sql).toBe('DELETE FROM set_performances WHERE id = $1');
    expect(last().params).toEqual([SET]);
  });

  test('PATCH /cardio/:id patches only cardio columns', async () => {
    const res = await request(app()).patch(`/api/training/cardio/${CARDIO}`).send({
      distance: 5, duration_seconds: 1800, exercise_performance_id: 'not-patchable',
    });
    expect(res.status).toBe(200);
    expect(last().sql).toBe(
      'UPDATE cardio_performances SET duration_seconds = $2, distance = $3, updated_at = NOW() WHERE id = $1 RETURNING *'
    );
    expect(last().params).toEqual([CARDIO, 1800, 5]);
  });
});

describe('records', () => {
  test('GET /records hides superseded records by default', async () => {
    const res = await request(app()).get(`/api/training/records?client_id=${CLIENT}`);
    expect(res.status).toBe(200);
    expect(last().sql).toContain('AND superseded_at IS NULL');
    expect(last().params).toEqual([CLIENT]);
  });

  test('?history=1 includes them', async () => {
    await request(app()).get(`/api/training/records?client_id=${CLIENT}&history=1`);
    expect(last().sql).not.toContain('superseded_at');
    expect(last().params).toEqual([CLIENT]);
  });
});

describe('the adapter is no longer a data layer', () => {
  test('training.routes.js does not import the pool', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules/training/training.routes.js'), 'utf8');
    // The layering test counts SQL literals; this states the stronger fact
    // that the adapter cannot reach the database at all, which is what makes
    // a future regression a syntax error rather than a budget increase.
    expect(src).not.toMatch(/require\(['"]\.\.\/\.\.\/db\/pool['"]\)/);
  });
});

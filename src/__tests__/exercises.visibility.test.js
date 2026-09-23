// Who can see a custom exercise.
//
// A trainer's custom exercises are their own — their cues, their naming, their
// half-finished experiments. Another trainer in the same studio must not see
// them, and no other studio can reach them at all. Built-in exercises (the 890
// seeded rows, organization_id NULL) stay shared by everybody.
//
// This replaced a three-way `visibility` column that let the author widen the
// audience to the whole studio or to every studio on the platform. The column
// still exists but nothing reads it, so there is no value anyone could set
// that would share a custom exercise.
//
// The tests below read the SQL the route actually builds rather than standing
// up a database: the predicate IS the security boundary, and it is reused by
// the list, count and facet queries, so what matters is that every read
// carries it and that no read still consults `visibility`.
'use strict';

const queries = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params });
    // /meta reads totals.rows[0] unguarded, so that one query has to come back
    // with a row or the handler 500s before the assertions get a look in.
    if (/COUNT\(\*\)::int AS total,/i.test(flat)) {
      return { rows: [{ total: 0, custom: 0, compound: 0, isolation: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rows: [{ id: 'e1' }], rowCount: 1 };
    }),
    release: jest.fn(),
  })),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';
const mockUser = { id: 'trainer-a', role: 'trainer', organization_id: ORG_A };
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
  a.use('/api/exercises', require('../routes/exercises'));
  return a;
}

/** Every SELECT the request issued against `exercises`. */
const reads = () => queries.filter((q) => /FROM exercises e/i.test(q.sql));

beforeEach(() => { queries.length = 0; });

describe('reading exercises', () => {
  it('scopes custom exercises to the studio that wrote them', async () => {
    await request(app()).get('/api/exercises').expect(200);

    const r = reads();
    expect(r.length).toBeGreaterThan(0);
    for (const q of r) {
      // Built-ins stay shared…
      expect(q.sql).toMatch(/e\.organization_id IS NULL/);
      // …and anything owned by a studio must match the caller's studio. The
      // studio has one trainer, so there is no per-author narrowing to apply.
      expect(q.sql).toMatch(/e\.organization_id = \$\d+::uuid/);
      expect(q.sql).not.toMatch(/e\.created_by = \$\d+/);
    }
  });

  it('no longer lets the visibility column widen the audience', async () => {
    // The bug this closes: `visibility <> 'private'` meant the default made a
    // custom exercise readable by everyone in the studio.
    await request(app()).get('/api/exercises').expect(200);
    for (const q of reads()) {
      expect(q.sql).not.toMatch(/visibility <> 'private'/);
      expect(q.sql).not.toMatch(/WHERE[\s\S]*e\.visibility\s*=/);
    }
  });

  it('passes the caller org into every scoped read', async () => {
    await request(app()).get('/api/exercises').expect(200);
    for (const q of reads()) {
      expect(q.params).toContain(ORG_A);
    }
  });

  it('applies the same predicate to the facet counts', async () => {
    // Counts are built from a separate query. If it drifted, the filter rail
    // would advertise exercises the list refuses to show — which is both a
    // leak of names and a confusing dead end.
    await request(app()).get('/api/exercises/meta').expect(200);
    for (const q of reads()) {
      expect(q.sql).toMatch(/e\.organization_id IS NULL OR e\.organization_id = \$\d+::uuid/);
    }
  });
});

// ── Cross-studio writes ────────────────────────────────────────────────────
//
// The by-id routes used to look an exercise up with `WHERE id = $1` alone,
// and canEdit() admitted any "full access" role — which, once every studio
// owner was a trainer, meant any trainer could edit, archive or delete
// ANOTHER studio's custom exercise, and edit the shared built-in library for
// every studio at once. The pool below behaves like the table: it applies the
// visibility predicate from the query's own bound parameters.
describe('writes by id stay inside the caller\'s studio', () => {
  const pool = require('../db/pool');
  const ORG_B = '22222222-2222-2222-2222-222222222222';
  const ROWS = {
    'ex-builtin': { id: 'ex-builtin', created_by: null, is_custom: false, organization_id: null },
    'ex-own': { id: 'ex-own', created_by: 'trainer-a', is_custom: true, organization_id: ORG_A },
    'ex-foreign': { id: 'ex-foreign', created_by: 'trainer-b', is_custom: true, organization_id: ORG_B },
  };

  beforeEach(() => {
    pool.query.mockImplementation(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: flat, params });
      if (/FROM exercises e WHERE e\.id = \$1/i.test(flat)) {
        const row = ROWS[params[0]];
        const visible = row && (row.organization_id === null || row.organization_id === params[1]);
        return visible ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/UPDATE exercises/i.test(flat)) return { rows: [{ id: params[1] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  const writes = () => queries.filter((q) => /UPDATE exercises/i.test(q.sql));

  it.each([
    ['put', '/api/exercises/ex-foreign', { name: 'Taken over' }],
    ['post', '/api/exercises/ex-foreign/archive', {}],
    ['delete', '/api/exercises/ex-foreign', undefined],
    ['post', '/api/exercises/ex-foreign/duplicate', {}],
    ['post', '/api/exercises/ex-foreign/favorite', {}],
    ['get', '/api/exercises/ex-foreign/versions', undefined],
  ])('%s %s on another studio\'s custom exercise is a 404, and writes nothing', async (verb, url, body) => {
    const res = await request(app())[verb](url).send(body);
    expect(res.status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['put', '/api/exercises/ex-builtin', { name: 'Renamed for everyone' }],
    ['post', '/api/exercises/ex-builtin/archive', {}],
    ['delete', '/api/exercises/ex-builtin', undefined],
  ])('%s %s on the shared built-in library is refused', async (verb, url, body) => {
    const res = await request(app())[verb](url).send(body);
    expect(res.status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it('archiving the studio\'s own custom exercise is scoped to its organization in the UPDATE itself', async () => {
    await request(app()).post('/api/exercises/ex-own/archive').send({}).expect(200);
    const [upd] = writes();
    expect(upd.sql).toMatch(/WHERE id = \$2 AND organization_id = \$3/);
    expect(upd.params).toEqual(['trainer-a', 'ex-own', ORG_A]);
  });
});

describe('creating an exercise', () => {
  const body = { name: 'Copenhagen Plank' };

  it('stamps the author and their org onto the row', async () => {
    await request(app()).post('/api/exercises').send(body).expect(201);
    const insert = queries.find((q) => /INSERT INTO exercises/i.test(q.sql));
    expect(insert).toBeTruthy();
    expect(insert.params).toContain(ORG_A);
    expect(insert.params).toContain('trainer-a');
  });

  it('stores it as private regardless of what the client asks for', async () => {
    // There is no longer a choice to make, so a caller sending visibility
    // 'public' must not get one. The literal is in the SQL, not the params.
    await request(app()).post('/api/exercises').send({ ...body, visibility: 'public' }).expect(201);
    const insert = queries.find((q) => /INSERT INTO exercises/i.test(q.sql));
    expect(insert.sql).toMatch(/'private'/);
    expect(insert.params).not.toContain('public');
    expect(insert.params).not.toContain('organization');
  });
});

'use strict';
// The name rule is a visibility rule.
//
// The 2026-11-24 audit found `GET /api/exercises/check-name` answering from
// the whole table: no visibility clause, and a `conflict` payload carrying the
// other studio's row id and exact name. A member could probe a name and learn
// that another studio's private custom exercise existed. It also treated a
// slug collision as a name collision, so a name whose slug happened to be
// taken was refused even though create/duplicate suffix the slug.
//
// These tests pin the shared rule the check-name, create, update and duplicate
// routes now use: trimmed, case-insensitive, built-ins plus the caller's own
// studio, never another studio's private row. They also pin the list response
// carrying the structured muscle map, which is what the card reads before it
// falls back to the legacy `secondary_muscles` text.

const queries = [];
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const OWN_A = '33333333-3333-3333-3333-333333333333';

const mockRows = [
  {
    id: 'builtin-squat', name: 'Barbell Squat', organization_id: null,
    created_by: null, is_custom: false, slug: 'barbell-squat',
  },
  {
    id: OWN_A, name: 'Studio A Private', organization_id: ORG_A,
    created_by: 'trainer-a', is_custom: true, slug: 'studio-a-private',
  },
  {
    id: 'own-b', name: 'Studio B Private', organization_id: ORG_B,
    created_by: 'trainer-b', is_custom: true, slug: 'studio-b-private',
  },
];

let mockUser = { id: 'trainer-a', role: 'trainer', organization_id: ORG_A };

/** Apply the visibility rule the real query carries, from its own params. */
function mockConflictRow(params) {
  const wanted = String(params[0] ?? '').trim().toLowerCase();
  const orgId = params[1];
  const excludeId = params[2];
  return mockRows.find((r) => (
    r.name.trim().toLowerCase() === wanted
    && (r.organization_id === null || r.organization_id === orgId)
    && r.id !== excludeId
  )) || null;
}

function mockRespond(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: flat, params });

  if (/^BEGIN$|^COMMIT$|^ROLLBACK$/i.test(flat)) return { rows: [], rowCount: 0 };
  if (/SELECT e\.id, e\.name FROM exercises e/i.test(flat)) {
    const row = mockConflictRow(params);
    return row ? { rows: [{ id: row.id, name: row.name }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/FROM exercises e WHERE e\.id = \$1 AND e\.deleted_at IS NULL/i.test(flat)) {
    const row = mockRows.find((r) => r.id === params[0]
      && (r.organization_id === null || r.organization_id === params[1]));
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/COUNT\(\*\) OVER \(\) AS total_count/i.test(flat)) {
    return {
      rows: [{
        id: OWN_A, name: 'Studio A Private', slug: 'studio-a-private',
        organization_id: ORG_A, is_custom: true, can_edit: true,
        muscles: [
          { slug: 'chest', name: 'Chest', body_region: 'chest', role: 'primary' },
          { slug: 'triceps', name: 'Triceps', body_region: 'arms', role: 'secondary' },
        ],
        total_count: 1,
      }],
      rowCount: 1,
    };
  }
  if (/FROM exercises e LEFT JOIN muscles/i.test(flat)) {
    return {
      rows: [{
        id: OWN_A, name: 'Studio A Private', organization_id: ORG_A,
        is_custom: true, created_by: 'trainer-a',
      }],
      rowCount: 1,
    };
  }
  if (/FROM exercise_muscles em JOIN muscles/i.test(flat)) return { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
}

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => mockRespond(sql, params)),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => mockRespond(sql, params)),
    release: jest.fn(),
  })),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
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

const insert = () => queries.find((q) => /INSERT INTO exercises/i.test(q.sql));
const update = () => queries.find((q) => /UPDATE exercises SET/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  mockUser = { id: 'trainer-a', role: 'trainer', organization_id: ORG_A };
});

describe('check-name is scoped to what the caller can see', () => {
  it('finds a built-in name for every studio', async () => {
    const res = await request(app()).get('/api/exercises/check-name').query({ name: 'barbell squat' });

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.conflict).toEqual({ id: 'builtin-squat', name: 'Barbell Squat' });
  });

  it('finds the caller\'s own custom name', async () => {
    const res = await request(app()).get('/api/exercises/check-name').query({ name: 'Studio A Private' });

    expect(res.body.available).toBe(false);
    expect(res.body.conflict).toEqual({ id: OWN_A, name: 'Studio A Private' });
  });

  it('does not disclose another studio\'s private name', async () => {
    mockUser = { id: 'trainer-b', role: 'trainer', organization_id: ORG_B };

    const res = await request(app()).get('/api/exercises/check-name').query({ name: 'Studio A Private' });

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.conflict).toBeNull();
  });

  it('carries the visibility predicate and the caller org into the query', async () => {
    mockUser = { id: 'trainer-b', role: 'trainer', organization_id: ORG_B };

    await request(app()).get('/api/exercises/check-name').query({ name: 'Studio A Private' });

    const check = queries.find((q) => /SELECT e\.id, e\.name FROM exercises e/i.test(q.sql));
    expect(check.sql).toMatch(/e\.organization_id IS NULL OR e\.organization_id = \$2/i);
    expect(check.params[1]).toBe(ORG_B);
  });

  it('matches names, not slugs', async () => {
    // The old query was `e.slug = $1 OR lower(e.name) = lower($2)`. Create
    // and duplicate suffix a colliding slug, so a slug is not an identity.
    await request(app()).get('/api/exercises/check-name').query({ name: 'Pull-Up' });

    const check = queries.find((q) => /SELECT e\.id, e\.name FROM exercises e/i.test(q.sql));
    expect(check.sql).not.toMatch(/e\.slug\s*=/i);
    expect(check.sql).toMatch(/lower\(btrim\(e\.name\)\) = lower\(btrim\(\$1\)\)/i);
  });

  it('ignores the row being edited', async () => {
    const res = await request(app())
      .get('/api/exercises/check-name')
      .query({ name: 'Studio A Private', exclude_id: OWN_A });

    expect(res.body.available).toBe(true);
    expect(res.body.conflict).toBeNull();
  });
});

describe('create applies the same name rule', () => {
  it('refuses a built-in name', async () => {
    const res = await request(app()).post('/api/exercises').send({ name: 'Barbell Squat' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAME_TAKEN');
    expect(res.body.conflict).toEqual({ id: 'builtin-squat', name: 'Barbell Squat' });
    expect(insert()).toBeUndefined();
    expect(queries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
  });

  it('refuses a name the caller\'s own studio already has', async () => {
    const res = await request(app()).post('/api/exercises').send({ name: '  studio a private  ' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAME_TAKEN');
    expect(insert()).toBeUndefined();
  });

  it('allows a name only another studio uses privately', async () => {
    mockUser = { id: 'trainer-b', role: 'trainer', organization_id: ORG_B };

    const res = await request(app()).post('/api/exercises').send({ name: 'Studio A Private' });

    expect(res.status).toBe(201);
    expect(insert()).toBeTruthy();
    expect(insert().params[1]).toBe('Studio A Private');
  });

  it('rebuilds the legacy secondary text from the map', async () => {
    await request(app()).post('/api/exercises').send({
      name: 'Copenhagen Plank',
      primary_muscle_id: 'm-hip',
      secondary_muscle_ids: ['m-adductor'],
    });

    expect(queries.some((q) => /SET secondary_muscles = \(SELECT value FROM text\)/i.test(q.sql))).toBe(true);
  });
});

describe('update applies the same name rule', () => {
  it('refuses renaming a row to a built-in name', async () => {
    const res = await request(app()).put(`/api/exercises/${OWN_A}`).send({ name: 'Barbell Squat' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAME_TAKEN');
    expect(update()).toBeUndefined();
  });

  it('allows a name only another studio uses privately', async () => {
    const res = await request(app()).put(`/api/exercises/${OWN_A}`).send({ name: 'Studio B Private' });

    expect(res.status).toBe(200);
    expect(update()).toBeTruthy();
    expect(update().params).toContain('Studio B Private');
  });

  it('does not conflict with the row being edited', async () => {
    const res = await request(app()).put(`/api/exercises/${OWN_A}`).send({ name: 'Studio A Private' });

    expect(res.status).toBe(200);
    expect(update()).toBeTruthy();
  });
});

describe('the list carries the muscle map', () => {
  it('returns muscles so the card does not need the legacy text', async () => {
    const res = await request(app()).get('/api/exercises').expect(200);

    expect(res.body.exercises[0].muscles).toEqual([
      { slug: 'chest', name: 'Chest', body_region: 'chest', role: 'primary' },
      { slug: 'triceps', name: 'Triceps', body_region: 'arms', role: 'secondary' },
    ]);
  });
});

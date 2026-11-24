'use strict';
// Duplicating an exercise must not mint a second identity.
//
// The 2026-11-24 audit found `Pullups`/`Pushups` sitting beside `Pull Ups`/
// `Push Ups`, and `Ab Roller (Copy)` beside `Ab Roller`. The duplicate route
// was one source: it defaulted the name to `${name} (Copy)` and accepted any
// name, including one the library already had. The frontend now asks for a
// name and opens a create form for a built-in instead of copying it on sight;
// the server refuses a blank name and a name the library already has. These
// tests pin that contract.

const queries = [];
let mockSource;
let mockClashRows;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params });
    if (/FROM exercises e WHERE e\.id = \$1 AND e\.deleted_at IS NULL/i.test(flat)) {
      return { rows: mockSource ? [mockSource] : [], rowCount: mockSource ? 1 : 0 };
    }
    if (/SELECT .* FROM exercises e LEFT JOIN muscles/i.test(flat)) {
      return { rows: [{ id: 'new-id', name: 'Created', organization_id: 'org-1', is_custom: true }], rowCount: 1 };
    }
    if (/FROM exercise_muscles em JOIN muscles/i.test(flat)) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: flat, params });
      if (/SELECT e\.id, e\.name FROM exercises e/i.test(flat)) {
        return { rows: mockClashRows, rowCount: mockClashRows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  })),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORG_A = '11111111-1111-1111-1111-111111111111';
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'trainer-a', role: 'trainer', organization_id: ORG_A }; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/exercises', require('../routes/exercises'));
  return app;
}

beforeEach(() => {
  queries.length = 0;
  mockClashRows = [];
  mockSource = {
    id: 'src', name: 'Bench Press', created_by: null, is_custom: false, organization_id: null,
  };
});

const insert = () => queries.find((q) => /INSERT INTO exercises/i.test(q.sql));

describe('duplicating an exercise', () => {
  it('uses the name the trainer typed, trimmed', async () => {
    const res = await request(makeApp())
      .post('/api/exercises/src/duplicate')
      .send({ name: '  Bench Press (Custom)  ' });

    expect(res.status).toBe(201);
    expect(insert().params[1]).toBe('Bench Press (Custom)');
  });

  it('refuses a blank name instead of minting a copy name', async () => {
    // `${name} (Copy)` is the default that created `Ab Roller (Copy)` and the
    // no-space duplicate spellings. A blank name is a client bug, not a request
    // to invent one.
    const res = await request(makeApp())
      .post('/api/exercises/src/duplicate')
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
    expect(insert()).toBeUndefined();
    expect(queries.some((q) => q.sql === 'BEGIN')).toBe(false);
  });

  it('refuses a missing name too', async () => {
    const res = await request(makeApp())
      .post('/api/exercises/src/duplicate')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
    expect(insert()).toBeUndefined();
  });

  it('refuses a name the caller can already see', async () => {
    mockClashRows = [{ id: 'existing', name: 'Bench Press (Custom)' }];

    const res = await request(makeApp())
      .post('/api/exercises/src/duplicate')
      .send({ name: 'Bench Press (Custom)' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAME_TAKEN');
    expect(res.body.conflict).toEqual({ id: 'existing', name: 'Bench Press (Custom)' });
    expect(insert()).toBeUndefined();
    // The transaction must be abandoned, not left open on the pooled client.
    expect(queries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
  });

  it('scopes the collision check to built-ins and the caller\'s own studio', async () => {
    // Another studio's custom exercise is not this caller's conflict; its
    // name must not make an otherwise valid duplicate fail.
    await request(makeApp())
      .post('/api/exercises/src/duplicate')
      .send({ name: 'Bench Press (Custom)' });

    const check = queries.find((q) => /SELECT e\.id, e\.name FROM exercises e/i.test(q.sql));
    expect(check.sql).toMatch(/e\.organization_id IS NULL OR e\.organization_id = \$2/i);
    expect(check.params[1]).toBe(ORG_A);
  });
});

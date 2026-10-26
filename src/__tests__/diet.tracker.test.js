'use strict';
// PUT /api/diet/tracker — a partial upsert, not a six-column overwrite.
//
// The route used to write `parseInt(...) || 0` for every field. Tapping
// "+ Glass" therefore wrote 0 kcal and 0 g of every macro over a day that had
// already been logged. These tests pin the two facts that fix it:
//   · only supplied fields appear in the UPDATE
//   · absent is not zero, and a supplied blank clears rather than zeroes

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];
let mockRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    if (/FROM pt_clients/i.test(flat)) return { rows: [{ ok: 1 }], rowCount: 1 };
    return { rows: mockRows, rowCount: mockRows.length };
  }),
}));

let mockCurrentUser = { id: 'usr-1', role: 'trainer', organization_id: ORG_A, trainer_id: null };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/diet', require('../routes/diet'));

const trackerWrites = () =>
  mockQueries.filter((q) => /^INSERT INTO nutrition_logs\b/i.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockRows = [];
  mockCurrentUser = { id: 'usr-1', role: 'trainer', organization_id: ORG_A, trainer_id: null };
});

describe('PUT /api/diet/tracker writes only what was sent', () => {
  it('a water-only update does not touch calories or macros', async () => {
    mockRows = [{ id: 'nl-1', water_glasses: 3 }];
    await request(app).put('/api/diet/tracker').send({
      client_id: 'cl-1', log_date: '2026-10-26', water_glasses: 3,
    }).expect(200);

    const [q] = trackerWrites();
    expect(q).toBeDefined();
    expect(q.sql).toMatch(/water_glasses = \$5/i);
    expect(q.sql).not.toMatch(/calories_consumed =/i);
    expect(q.sql).not.toMatch(/protein_g =/i);
    expect(q.sql).not.toMatch(/carbs_g =/i);
    expect(q.sql).not.toMatch(/fats_g =/i);
    expect(q.params).toEqual(expect.arrayContaining([3]));
  });

  it('a supplied blank clears the column instead of writing zero', async () => {
    mockRows = [{ id: 'nl-1', protein_g: null }];
    await request(app).put('/api/diet/tracker').send({
      client_id: 'cl-1', log_date: '2026-10-26', protein_g: '',
    }).expect(200);

    const [q] = trackerWrites();
    expect(q.sql).toMatch(/protein_g = \$5/i);
    expect(q.params[4]).toBeNull();
  });

  it('an absent field is not in the insert either', async () => {
    mockRows = [{ id: 'nl-1' }];
    await request(app).put('/api/diet/tracker').send({
      client_id: 'cl-1', log_date: '2026-10-26', calories_consumed: 1800,
    }).expect(200);

    const [q] = trackerWrites();
    expect(q.sql).toMatch(/calories_consumed/i);
    expect(q.sql).not.toMatch(/water_glasses/i);
  });

  it('refuses a negative value before writing', async () => {
    const res = await request(app).put('/api/diet/tracker').send({
      client_id: 'cl-1', log_date: '2026-10-26', calories_consumed: -1,
    });
    expect(res.status).toBe(400);
    expect(trackerWrites()).toHaveLength(0);
  });

  it('refuses a fractional calorie count', async () => {
    const res = await request(app).put('/api/diet/tracker').send({
      client_id: 'cl-1', log_date: '2026-10-26', calories_consumed: 18.5,
    });
    expect(res.status).toBe(400);
    expect(trackerWrites()).toHaveLength(0);
  });

  it('refuses a malformed date', async () => {
    const res = await request(app).put('/api/diet/tracker').send({
      client_id: 'cl-1', log_date: '2026-02-31', calories_consumed: 1800,
    });
    expect(res.status).toBe(400);
    expect(trackerWrites()).toHaveLength(0);
  });

});

describe('GET /api/diet/tracker does not invent a zero day', () => {
  it('returns today: null when there is no row', async () => {
    mockRows = [];
    const res = await request(app)
      .get('/api/diet/tracker?client_id=cl-1&date=2026-10-26')
      .expect(200);
    expect(res.body.today).toBeNull();
    expect(res.body.history).toEqual([]);
  });

  it('returns the real row when one exists', async () => {
    mockRows = [{ id: 'nl-1', calories_consumed: 1800, protein_g: '120.0' }];
    const res = await request(app)
      .get('/api/diet/tracker?client_id=cl-1&date=2026-10-26')
      .expect(200);
    expect(res.body.today.calories_consumed).toBe(1800);
  });

  it('refuses a malformed date', async () => {
    const res = await request(app).get('/api/diet/tracker?client_id=cl-1&date=nope');
    expect(res.status).toBe(400);
  });
});

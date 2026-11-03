'use strict';
// Assignment lifecycle — one current programme per client.
//
// The schema has always allowed several `active` rows for one client (the
// unique key is plan+client). Nothing retired the previous block when a new one
// was assigned, and every read resolved the ambiguity differently. These tests
// pin the write rule (assign retires the others by default), the escape hatch
// (keep_existing), and the explicit retire/patch routes.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => {
  const query = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

jest.mock('../lib/screeningGate', () => ({
  checkTrainingEligibility: jest.fn(async () => ({ blocked: null, warnings: [] })),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { pickCurrent, isLive } = require('../modules/pt-os/assignment-lifecycle');

const app = express();
app.use(express.json());
app.use('/api/workouts', require('../routes/workouts'));

const ORG = '11111111-1111-1111-1111-111111111111';
const TRAINER = { id: 'u-tr', role: 'trainer', organization_id: ORG, trainer_id: 'tr-1' };

const sqls = () => pool.query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' '));

beforeEach(() => {
  mockUser = TRAINER;
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [{ id: 'a1', client_id: 'c1', organization_id: ORG }], rowCount: 1 });
});

describe('pickCurrent', () => {
  const row = (over = {}) => ({
    id: 'a', status: 'active', start_date: '2026-01-01', created_at: '2026-01-01T00:00:00Z', ...over,
  });

  it('ignores assignments outside their date window', () => {
    expect(isLive(row({ start_date: '2026-02-01' }), '2026-01-15')).toBe(false);
    expect(isLive(row({ end_date: '2026-01-10' }), '2026-01-15')).toBe(false);
    expect(isLive(row(), '2026-01-15')).toBe(true);
  });

  it('reads DATE columns the driver returns as Date objects', () => {
    // node-postgres returns DATE as a JS Date. String(date).slice(0, 10) is
    // "Thu Jan 01", which made every live assignment look like it started in
    // the future — the member saw no programme at all.
    const start = new Date('2026-01-01T00:00:00Z');
    expect(isLive(row({ start_date: start }), '2026-01-15')).toBe(true);
    expect(isLive(row({ start_date: start, end_date: new Date('2026-01-10T00:00:00Z') }), '2026-01-15')).toBe(false);
  });

  it('prefers the assignment that prescribes today', () => {
    const out = pickCurrent([
      row({ id: 'newest', start_date: '2026-01-10' }),
      row({ id: 'today', start_date: '2026-01-01', prescribes_dow: true }),
    ], { today: '2026-01-15', prescribesDow: 3 });
    expect(out.id).toBe('today');
  });

  it('falls back to the newest live assignment, deterministically', () => {
    const out = pickCurrent([
      row({ id: 'old', start_date: '2026-01-01' }),
      row({ id: 'new', start_date: '2026-01-10' }),
    ], { today: '2026-01-15' });
    expect(out.id).toBe('new');
  });

  it('returns null when nothing is live', () => {
    expect(pickCurrent([row({ status: 'completed' })], { today: '2026-01-15' })).toBeNull();
  });
});

describe('POST /api/workouts/assign', () => {
  const body = { workout_plan_id: 'p1', client_id: 'c1' };

  it('retires the client\'s other active assignments by default', async () => {
    const res = await request(app).post('/api/workouts/assign').send(body).expect(201);

    const retire = sqls().find((s) => /UPDATE workout_assignments/.test(s) && /retired_at/.test(s));
    expect(retire).toBeDefined();
    expect(retire).toMatch(/id <> \$3/);
    expect(res.body.retired_assignments).toBe(1);
  });

  it('leaves them alone when the trainer explicitly keeps both', async () => {
    const res = await request(app).post('/api/workouts/assign')
      .send({ ...body, keep_existing: true }).expect(201);

    expect(sqls().some((s) => /retired_at = NOW\(\)/.test(s))).toBe(false);
    expect(res.body.retired_assignments).toBe(0);
  });

  it('does not retire when the insert was refused by another studio\'s row', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/INSERT INTO workout_assignments/.test(String(sql))) return { rows: [], rowCount: 0 };
      return { rows: [{ id: 'p1', duration_weeks: 4, ok: 1 }], rowCount: 1 };
    });

    const res = await request(app).post('/api/workouts/assign').send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another studio/);
    expect(sqls().some((s) => /retired_at = NOW\(\)/.test(s))).toBe(false);
  });
});

describe('POST /api/workouts/assignments/:id/retire', () => {
  it('records when and why, and refuses to delete the row', async () => {
    const res = await request(app).post('/api/workouts/assignments/a1/retire')
      .send({ status: 'cancelled', reason: 'client moved' }).expect(200);

    const update = sqls().find((s) => /UPDATE workout_assignments/.test(s));
    expect(update).toMatch(/retired_at = COALESCE\(retired_at, NOW\(\)\)/);
    expect(update).toMatch(/retire_reason = \$2/);
    expect(res.body.assignment.id).toBe('a1');
  });

  it('rejects a status that would un-retire through this route', async () => {
    await request(app).post('/api/workouts/assignments/a1/retire')
      .send({ status: 'active' }).expect(400);
  });
});

describe('PATCH /api/workouts/assignments/:id', () => {
  it('re-activating retires the others', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'a1', client_id: 'c1', status: 'active' }], rowCount: 1 });
    const res = await request(app).patch('/api/workouts/assignments/a1')
      .send({ status: 'active' }).expect(200);

    expect(sqls().some((s) => /retired_at/.test(s) && /id <> \$/.test(s))).toBe(true);
    expect(res.body.retired_assignments).toBe(1);
  });

  it('marks a completed assignment with a retirement time', async () => {
    await request(app).patch('/api/workouts/assignments/a1')
      .send({ status: 'completed' }).expect(200);

    const update = sqls().find((s) => /UPDATE workout_assignments/.test(s));
    expect(update).toMatch(/retired_at = COALESCE\(retired_at, NOW\(\)\)/);
    expect(sqls().some((s) => /id <> \$/.test(s))).toBe(false);
  });

  it('rejects an unknown status', async () => {
    await request(app).patch('/api/workouts/assignments/a1')
      .send({ status: 'archived' }).expect(400);
  });
});

'use strict';
// The client's side of booking. The only identity that exists here is
// req.user.pt_client_id — these tests assert that a body field cannot change it,
// that the cutoff is enforced, and that a lost race never overwrites the
// original booking.

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = {
      id: 'usr-client-1', role: 'member', organization_id: 'org-1', pt_client_id: 'c1',
    };
    next();
  },
  requireClient: (_req, _res, next) => next(),
  requireTrainer: (_req, _res, next) => next(),
}));
jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/screeningGate', () => ({
  checkTrainingEligibility: jest.fn().mockResolvedValue({ blocked: null, warnings: [] }),
}));
jest.mock('../modules/pt-os/availability.service', () => {
  const actual = jest.requireActual('../modules/pt-os/availability.service');
  return { ...actual, freeSlots: jest.fn(), slotIsFree: jest.fn() };
});

const express = require('express');
const request = require('supertest');
const pool = require('../db/pool');
const availability = require('../modules/pt-os/availability.service');
const { checkTrainingEligibility } = require('../lib/screeningGate');

const app = express();
app.use(express.json());
app.use('/api/me', require('../modules/client-portal/client-booking.routes'));

const sqlLike = (fn, re) => fn.mock.calls.find((c) => re.test(String(c[0])));

const sessionRow = (over = {}) => ({
  id: 's1',
  session_date: '2026-11-01',
  start_time: '12:00',
  end_time: '13:00',
  duration_minutes: 60,
  status: 'scheduled',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2026-11-01T01:00:00Z')); // 06:30 IST
  checkTrainingEligibility.mockResolvedValue({ blocked: null, warnings: [] });
  availability.slotIsFree.mockResolvedValue(true);
  availability.freeSlots.mockResolvedValue({
    days: [{ date: '2026-11-02', slots: [{ start: '07:00', end: '08:00' }] }],
    settings: { slot_minutes: 60, cancel_cutoff_hours: 12, horizon_days: 30 },
  });
  pool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM pt_clients/.test(s)) return { rows: [{ trainer_id: 't1' }] };
    if (/INSERT INTO pt_sessions/.test(s)) return { rows: [sessionRow({ session_date: '2026-11-02', start_time: '07:00', end_time: '08:00' })] };
    return { rows: [] };
  });
});

afterEach(() => jest.useRealTimers());

describe('POST /api/me/booking', () => {
  it('takes the client from the token, not the body', async () => {
    const res = await request(app).post('/api/me/booking').send({
      date: '2026-11-02', start: '07:00', client_id: 'someone-else',
    });

    expect(res.status).toBe(201);
    const insert = sqlLike(pool.query, /INSERT INTO pt_sessions/);
    expect(insert[1][0]).toBe('c1');
    expect(insert[1]).not.toContain('someone-else');
  });

  it('refuses a slot the trainer does not offer', async () => {
    availability.slotIsFree.mockResolvedValue(false);
    const res = await request(app).post('/api/me/booking').send({ date: '2026-11-02', start: '03:00' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OUTSIDE_AVAILABILITY');
    expect(sqlLike(pool.query, /INSERT INTO pt_sessions/)).toBeUndefined();
  });

  it('turns the unique-index race into SLOT_TAKEN', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM pt_clients/.test(s)) return { rows: [{ trainer_id: 't1' }] };
      if (/INSERT INTO pt_sessions/.test(s)) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      return { rows: [] };
    });

    const res = await request(app).post('/api/me/booking').send({ date: '2026-11-02', start: '07:00' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_TAKEN');
  });
});

describe('DELETE /api/me/booking/:id', () => {
  it('refuses to cancel inside the cutoff and writes nothing', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM pt_clients/.test(s)) return { rows: [{ trainer_id: 't1' }] };
      if (/SELECT/.test(s) && /FROM pt_sessions/.test(s)) return { rows: [sessionRow()] };
      return { rows: [] };
    });

    const res = await request(app).delete('/api/me/booking/s1');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCEL_CUTOFF_PASSED');
    expect(sqlLike(pool.query, /UPDATE pt_sessions/)).toBeUndefined();
  });

  it('refuses when the studio has no trainer profile', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/SELECT/.test(s) && /FROM pt_sessions/.test(s)) return { rows: [sessionRow()] };
      return { rows: [] };
    });

    const res = await request(app).delete('/api/me/booking/s1');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_TRAINER');
    expect(sqlLike(pool.query, /UPDATE pt_sessions/)).toBeUndefined();
  });
});

describe('PATCH /api/me/booking/:id', () => {
  it('refuses a taken slot and never runs the UPDATE', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM pt_clients/.test(s)) return { rows: [{ trainer_id: 't1' }] };
      if (/SELECT/.test(s) && /FROM pt_sessions/.test(s)) return { rows: [sessionRow({ session_date: '2026-11-05' })] };
      return { rows: [] };
    });
    availability.slotIsFree.mockResolvedValue(false);

    const res = await request(app).patch('/api/me/booking/s1').send({ date: '2026-11-06', start: '07:00' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_TAKEN');
    expect(sqlLike(pool.query, /UPDATE pt_sessions/)).toBeUndefined();
  });

  it('refuses when the session was cancelled between the read and the update', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM pt_clients/.test(s)) return { rows: [{ trainer_id: 't1' }] };
      if (/SELECT/.test(s) && /FROM pt_sessions/.test(s)) return { rows: [sessionRow({ session_date: '2026-11-05' })] };
      return { rows: [] }; // the guarded UPDATE matched nothing
    });

    const res = await request(app).patch('/api/me/booking/s1').send({ date: '2026-11-06', start: '07:00' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_SCHEDULED');
    expect(sqlLike(pool.query, /UPDATE pt_sessions/)[0]).toMatch(/status = 'scheduled'/);
  });
});

describe('GET /api/me/booking', () => {
  it('marks a session inside the cutoff as not cancellable', async () => {
    pool.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM pt_sessions/.test(s)) return { rows: [sessionRow()] };
      return { rows: [] };
    });

    const res = await request(app).get('/api/me/booking');
    expect(res.status).toBe(200);
    expect(res.body.data[0].can_cancel).toBe(false);
  });
});

describe('GET /api/me/booking/availability', () => {
  it('returns the computed days and only the settings the client needs', async () => {
    const res = await request(app).get('/api/me/booking/availability');
    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(1);
    expect(res.body.data.settings).toEqual({
      slot_minutes: 60, cancel_cutoff_hours: 12, horizon_days: 30,
    });
  });
});

'use strict';
// Trainer-side booking configuration: weekly windows, time off and settings.
// The rules here are the ones a client's free-slot list depends on, so they are
// asserted at the route boundary: overlapping windows are refused, a time-off
// range over real bookings is refused, and settings are range-checked.

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = {
      id: 'u1', role: 'trainer', organization_id: 'org-1', trainer_id: 't1',
    };
    next();
  },
  requireTrainer: (_req, _res, next) => next(),
}));
jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/availability.routes'));

const callsOf = (fn) => fn.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [] });
  pool.connect.mockReset();
});

describe('PUT /api/pt-os/availability', () => {
  it('refuses overlapping windows on the same weekday without writing', async () => {
    const res = await request(app).put('/api/pt-os/availability').send({
      windows: [
        { weekday: 1, start_time: '07:00', end_time: '10:00' },
        { weekday: 1, start_time: '09:00', end_time: '12:00' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WINDOWS_OVERLAP');
    expect(callsOf(pool.query).some((s) => /INSERT INTO trainer_availability/i.test(s))).toBe(false);
  });

  it('refuses a window that ends before it starts', async () => {
    const res = await request(app).put('/api/pt-os/availability').send({
      windows: [{ weekday: 2, start_time: '10:00', end_time: '10:00' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WINDOWS_INVALID');
  });

  it('replaces the week inside one transaction', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    pool.connect.mockResolvedValue(client);

    const res = await request(app).put('/api/pt-os/availability').send({
      windows: [
        { weekday: 1, start_time: '07:00', end_time: '10:00' },
        { weekday: 3, start_time: '18:00', end_time: '20:00' },
      ],
    });

    expect(res.status).toBe(200);
    const sqls = callsOf(client.query);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls).toContainEqual(expect.stringMatching(
      /DELETE FROM trainer_availability WHERE trainer_id = \$1 AND organization_id = \$2/,
    ));
    expect(sqls.some((s) => /INSERT INTO trainer_availability/i.test(s))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('POST /api/pt-os/time-off', () => {
  it('refuses a range that covers booked sessions and names them', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 's1', session_date: '2026-11-03', start_time: '07:00' }],
    });

    const res = await request(app).post('/api/pt-os/time-off').send({
      starts_on: '2026-11-02', ends_on: '2026-11-04', reason: 'Travel',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIME_OFF_CONFLICT');
    expect(res.body.conflicts).toEqual([
      { id: 's1', session_date: '2026-11-03', start_time: '07:00' },
    ]);
    expect(callsOf(pool.query).some((s) => /INSERT INTO trainer_time_off/i.test(s))).toBe(false);
  });

  it('refuses an inverted date range', async () => {
    const res = await request(app).post('/api/pt-os/time-off').send({
      starts_on: '2026-11-04', ends_on: '2026-11-02',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TIME_OFF_INVALID');
  });
});

describe('PUT /api/pt-os/booking-settings', () => {
  it('refuses a slot length outside 15..240 minutes', async () => {
    const res = await request(app).put('/api/pt-os/booking-settings').send({
      slot_minutes: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SETTINGS_INVALID');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('upserts without ever rotating the ICS token', async () => {
    pool.query.mockResolvedValue({
      rows: [{ trainer_id: 't1', slot_minutes: 45, ics_token: 'tok' }],
    });

    const res = await request(app).put('/api/pt-os/booking-settings').send({
      slot_minutes: 45, buffer_minutes: 15, min_notice_hours: 24,
      horizon_days: 60, cancel_cutoff_hours: 24,
    });

    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(organization_id, trainer_id\) DO UPDATE/);
    expect(sql).not.toMatch(/DO UPDATE SET[\s\S]*ics_token\s*=/);
    expect(params[7]).toMatch(/^[0-9a-f]{64}$/); // minted only on first insert
  });
});

describe('GET /api/pt-os/booking-settings', () => {
  it('returns the documented defaults when the trainer never saved', async () => {
    const res = await request(app).get('/api/pt-os/booking-settings');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      slot_minutes: 60, buffer_minutes: 0, min_notice_hours: 12,
      horizon_days: 30, cancel_cutoff_hours: 12,
    });
  });
});

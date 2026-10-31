'use strict';
// The read-only calendar feed. Anyone holding the token can read it, so the
// tests assert the two things that matter when it leaks: the token is the only
// credential (unknown token → 404), and cancelled sessions never appear.

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db/pool');

const app = express();
app.use('/api/public', require('../routes/calendar-feed'));

const TOKEN = 'a'.repeat(64);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/public/calendar/:token.ics', () => {
  it('is a 404 for an unknown or malformed token, without echoing it', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const unknown = await request(app).get(`/api/public/calendar/${'b'.repeat(64)}.ics`);
    expect(unknown.status).toBe(404);
    expect(unknown.text).not.toContain('b'.repeat(64));

    const malformed = await request(app).get('/api/public/calendar/not-a-token.ics');
    expect(malformed.status).toBe(404);
  });

  it('serves a floating-time VEVENT for a scheduled session', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM trainer_booking_settings/.test(String(sql))) {
        return { rows: [{ organization_id: 'org-1', trainer_id: 't1' }] };
      }
      if (/FROM pt_sessions/.test(String(sql))) {
        return {
          rows: [{
            id: 's1', title: 'PT Session', session_date: '2026-11-02',
            start_time: '07:00', end_time: '08:00',
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/public/calendar/${TOKEN}.ics`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/calendar/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('BEGIN:VCALENDAR');
    expect(res.text).toContain('SUMMARY:PT Session');
    expect(res.text).toContain('UID:s1@myptstudio');
    // Floating local time, deliberately: the trainer's wall clock is the fact.
    expect(res.text).toContain('DTSTART:20261102T070000');
    expect(res.text).toContain('DTEND:20261102T080000');
    expect(res.text).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
    expect(res.text).toContain('END:VCALENDAR');
  });

  it('only ever selects scheduled sessions', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM trainer_booking_settings/.test(String(sql))) {
        return { rows: [{ organization_id: 'org-1', trainer_id: 't1' }] };
      }
      return { rows: [] };
    });

    await request(app).get(`/api/public/calendar/${TOKEN}.ics`);

    const sessions = pool.query.mock.calls.find((c) => /FROM pt_sessions/.test(String(c[0])));
    expect(sessions[0]).toMatch(/status = 'scheduled'/);
    expect(sessions[0]).toMatch(/deleted_at IS NULL/);
  });

  it('escapes commas, semicolons and backslashes in text fields', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM trainer_booking_settings/.test(String(sql))) {
        return { rows: [{ organization_id: 'org-1', trainer_id: 't1' }] };
      }
      if (/FROM pt_sessions/.test(String(sql))) {
        return {
          rows: [{
            id: 's1', title: 'PT; Legs, Back\\Chest', session_date: '2026-11-02',
            start_time: '07:00', end_time: '08:00',
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app).get(`/api/public/calendar/${TOKEN}.ics`);
    expect(res.text).toContain('SUMMARY:PT\\; Legs\\, Back\\\\Chest');
  });
});

'use strict';
// Start / resume / autosave / discard for a member's own workout.
//
// The properties that matter:
//   · starting requires the trainer's permission, checked server-side;
//   · one open session at a time — a second tap resumes, never duplicates;
//   · the prescription is snapshotted from what the member was shown;
//   · autosave and discard are bound to the session's own client and studio;
//   · a submitted session can no longer be autosaved or discarded;
//   · discarding keeps the row as 'abandoned' and deletes nothing.

const CLIENT = 'cl-self';
const ORG = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-11-13';

const mockQueries = [];
let mockResponder = () => ({ rows: [] });

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    return mockResponder(flat, params || []);
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/appTime', () => ({ ...jest.requireActual('../lib/appTime'), today: () => TODAY }));

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: 'usr-m', role: 'member', pt_client_id: CLIENT, organization_id: ORG };
  next();
});
app.use('/api/me', require('../modules/client-portal/client-portal.routes'));

beforeEach(() => {
  mockQueries.length = 0;
  mockResponder = () => ({ rows: [] });
});

const permission = (allow) => (sql) => {
  if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: allow }] };
  if (/FROM workout_assignments a/.test(sql)) {
    return { rows: [{
      assignment_id: 'a1', plan_id: 'p1', name: 'Base', duration_weeks: 8,
      start_date: '2026-11-01', status: 'active', created_at: '2026-11-01', prescribes_dow: true,
    }] };
  }
  if (/FROM workout_exercises we/.test(sql)) {
    return { rows: [{
      workout_plan_id: 'p1', exercise_id: 'e1', day_of_week: 4, week_number: 1,
      sort_order: 1, sets: 3, reps: 8, target_weight: '60', name: 'Squat', config: null,
    }] };
  }
  return { rows: [] };
};

const sessionRow = (over = {}) => ({
  id: 'ws1', started_at: '2026-11-13T10:00:00Z', draft: { version: 1, current: 0, exercises: [] },
  prescribed: { plan_name: 'Base', exercises: [{ name: 'Squat' }] },
  workout_assignment_id: 'a1', program_name: 'Base', workout_day: 'Thursday',
  ...over,
});

describe('POST /api/me/workout/sessions', () => {
  it('refuses to start when the permission is off, and creates nothing', async () => {
    mockResponder = permission(false);
    const res = await request(app).post('/api/me/workout/sessions').send({}).expect(403);
    expect(res.body.error.code).toBe('SELF_WORKOUT_NOT_ALLOWED');
    expect(mockQueries.some((q) => /INSERT INTO workout_sessions/.test(q.sql))).toBe(false);
  });

  it('creates one open session with the prescription snapshot', async () => {
    mockResponder = (sql, params) => {
      if (/INSERT INTO workout_sessions/.test(sql)) return { rows: [sessionRow()] };
      return permission(true)(sql, params);
    };
    const res = await request(app).post('/api/me/workout/sessions').send({}).expect(201);
    expect(res.body.data).toMatchObject({ resumed: false });
    expect(res.body.data.session.id).toBe('ws1');

    const insert = mockQueries.find((q) => /INSERT INTO workout_sessions/.test(q.sql));
    expect(insert.params[0]).toBe(CLIENT);
    expect(insert.params[8]).toBe(ORG);
    expect(insert.params[3]).toBe('Base');
    expect(insert.params[4]).toBe('Thursday');
    const prescribed = JSON.parse(insert.params[5]);
    expect(prescribed.exercises[0]).toMatchObject({ name: 'Squat', sets: 3, reps: 8, target_weight: 60 });
    expect(prescribed.current_week).toBe(2);
    expect(JSON.parse(insert.params[6])).toMatchObject({ version: 1, exercises: [] });
    expect(insert.sql).toMatch(/status, source, started_at/);
    expect(insert.sql).toMatch(/'in_progress', 'member', NOW\(\)/);
  });

  it('resumes the open session instead of inserting a second one', async () => {
    mockResponder = (sql, params) => {
      if (/FROM workout_sessions/.test(sql) && /INTERVAL '24 hours'/.test(sql)) {
        return { rows: [sessionRow({ draft: { version: 1, exercises: [{ name: 'Squat' }] } })] };
      }
      return permission(true)(sql, params);
    };
    const res = await request(app).post('/api/me/workout/sessions').send({}).expect(200);
    expect(res.body.data.resumed).toBe(true);
    expect(res.body.data.session.draft.exercises[0].name).toBe('Squat');
    expect(mockQueries.some((q) => /INSERT INTO workout_sessions/.test(q.sql))).toBe(false);
  });

  it('returns the winner when two starts race past the open-session read', async () => {
    let openReads = 0;
    mockResponder = (sql, params) => {
      if (/FROM workout_sessions/.test(sql) && /INTERVAL '24 hours'/.test(sql)) {
        openReads += 1;
        return { rows: openReads === 1 ? [] : [sessionRow()] };
      }
      if (/INSERT INTO workout_sessions/.test(sql)) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      return permission(true)(sql, params);
    };
    const res = await request(app).post('/api/me/workout/sessions').send({}).expect(200);
    expect(res.body.data).toMatchObject({ resumed: true });
    expect(res.body.data.session.id).toBe('ws1');
  });

  it('retires a draft older than a day without deleting it', async () => {
    mockResponder = permission(true);
    await request(app).post('/api/me/workout/sessions').send({}).expect(201).catch(() => {});
    const retire = mockQueries.find((q) => /SET status = 'abandoned', draft = NULL/.test(q.sql));
    expect(retire).toBeTruthy();
    expect(retire.sql).toMatch(/started_at <= NOW\(\) - INTERVAL '24 hours'/);
    expect(mockQueries.some((q) => /DELETE FROM workout_sessions/.test(q.sql))).toBe(false);
  });

  it('refuses a day the programme does not prescribe', async () => {
    mockResponder = permission(true);
    const res = await request(app).post('/api/me/workout/sessions').send({ day_of_week: 2 }).expect(400);
    expect(res.body.error.code).toBe('NO_EXERCISES');
  });
});

describe('PATCH /api/me/workout/sessions/:id', () => {
  it('autosaves the draft on the member’s own open session', async () => {
    mockResponder = (sql) => {
      if (/SELECT status, submitted_at FROM workout_sessions/.test(sql)) {
        return { rows: [{ status: 'in_progress', submitted_at: null }] };
      }
      if (/UPDATE workout_sessions SET draft/.test(sql)) {
        return { rows: [{ updated_at: '2026-11-13T10:05:00Z' }] };
      }
      return { rows: [] };
    };
    const res = await request(app)
      .patch('/api/me/workout/sessions/ws1')
      .send({ draft: { version: 1, current: 0, exercises: [{ name: 'Squat' }] } })
      .expect(200);
    expect(res.body.data.saved_at).toBe('2026-11-13T10:05:00Z');
    const update = mockQueries.find((q) => /UPDATE workout_sessions SET draft/.test(q.sql));
    expect(update.params.slice(0, 3)).toEqual(['ws1', CLIENT, ORG]);
  });

  it('is 404 for a session that is not this member’s', async () => {
    mockResponder = () => ({ rows: [] });
    const res = await request(app).patch('/api/me/workout/sessions/someone-elses').send({ draft: {} }).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockQueries.some((q) => /UPDATE workout_sessions/.test(q.sql))).toBe(false);
  });

  it('is 409 after submission', async () => {
    mockResponder = (sql) => {
      if (/SELECT status, submitted_at FROM workout_sessions/.test(sql)) {
        return { rows: [{ status: 'completed', submitted_at: '2026-11-13T11:00:00Z' }] };
      }
      return { rows: [] };
    };
    const res = await request(app).patch('/api/me/workout/sessions/ws1').send({ draft: {} }).expect(409);
    expect(res.body.error.code).toBe('WORKOUT_SUBMITTED');
    expect(mockQueries.some((q) => /UPDATE workout_sessions/.test(q.sql))).toBe(false);
  });

  it('rejects a draft that is not an object', async () => {
    const res = await request(app).patch('/api/me/workout/sessions/ws1').send({ draft: 'nope' }).expect(400);
    expect(res.body.error.code).toBe('INVALID_DRAFT');
  });
});

describe('DELETE /api/me/workout/sessions/:id', () => {
  it('marks the session abandoned and deletes nothing', async () => {
    mockResponder = (sql) => {
      if (/SELECT status, submitted_at FROM workout_sessions/.test(sql)) {
        return { rows: [{ status: 'in_progress', submitted_at: null }] };
      }
      return { rows: [] };
    };
    await request(app).delete('/api/me/workout/sessions/ws1').expect(204);
    const update = mockQueries.find((q) => /SET status = 'abandoned'/.test(q.sql));
    expect(update.params.slice(0, 3)).toEqual(['ws1', CLIENT, ORG]);
    expect(mockQueries.some((q) => /DELETE FROM workout_sessions/.test(q.sql))).toBe(false);
  });

  it('is 409 for a submitted workout', async () => {
    mockResponder = (sql) => {
      if (/SELECT status, submitted_at FROM workout_sessions/.test(sql)) {
        return { rows: [{ status: 'completed', submitted_at: '2026-11-13T11:00:00Z' }] };
      }
      return { rows: [] };
    };
    await request(app).delete('/api/me/workout/sessions/ws1').expect(409);
    expect(mockQueries.some((q) => /SET status = 'abandoned'/.test(q.sql))).toBe(false);
  });
});

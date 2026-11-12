'use strict';
// Submitting a self workout.
//
// The draft the member autosaved becomes the canonical record: exercises and
// sets are written once, in one transaction, and the session is stamped
// submitted + pending review. From then on the member cannot write it again,
// and revoking the permission does not stop a session already under way.

const CLIENT = 'cl-self';
const ORG = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-11-13';

const mockQueries = [];
let mockResponder = () => ({ rows: [] });

jest.mock('../db/pool', () => {
  const query = jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    return mockResponder(flat, params || []);
  });
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

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

const openSession = (over = {}) => ({
  id: 'ws1',
  client_request_id: null,
  status: 'in_progress',
  submitted_at: null,
  started_at: '2026-11-13T10:00:00Z',
  workout_assignment_id: 'a1',
  prescribed: { plan_name: 'Base', exercises: [{ name: 'Squat' }] },
  draft: {
    version: 1,
    exercises: [{ name: 'Squat', sets: [{ weight_kg: 60, reps: 8, completed: true }] }],
  },
  ...over,
});

const submitResponder = (session) => (sql) => {
  if (/FROM workout_sessions WHERE id = \$1[\s\S]*FOR UPDATE/.test(sql)) return { rows: [session] };
  if (/INSERT INTO workout_session_exercises/.test(sql)) return { rows: [{ id: 'wse1' }] };
  if (/UPDATE workout_sessions SET status = 'completed'/.test(sql)) return { rows: [{ id: 'ws1' }] };
  return { rows: [] };
};

describe('POST /api/me/workout/sessions/:id/submit', () => {
  it('materialises the draft once and marks the session pending review', async () => {
    mockResponder = submitResponder(openSession());
    const res = await request(app).post('/api/me/workout/sessions/ws1/submit').send({}).expect(200);
    expect(res.body.data).toMatchObject({ created: true, session_id: 'ws1' });

    const exercise = mockQueries.find((q) => /INSERT INTO workout_session_exercises/.test(q.sql));
    expect(exercise.params.slice(0, 3)).toEqual(['ws1', null, 'Squat']);
    expect(exercise.sql).toMatch(/prescribed_index/);

    const set = mockQueries.find((q) => /INSERT INTO workout_sets/.test(q.sql));
    expect(set.params.slice(0, 4)).toEqual(['wse1', 1, 60, 8]);

    const completed = mockQueries.find((q) => /UPDATE workout_sessions SET status = 'completed'/.test(q.sql));
    expect(completed.sql).toMatch(/submitted_at = NOW\(\)/);
    expect(completed.sql).toMatch(/review_status = 'pending'/);
    expect(completed.sql).toMatch(/draft = NULL/);
  });

  it('uses the body draft when one is sent', async () => {
    mockResponder = submitResponder(openSession());
    await request(app).post('/api/me/workout/sessions/ws1/submit')
      .send({ draft: { exercises: [{ name: 'Bench Press', sets: [{ weight_kg: 40, reps: 10 }] }] } })
      .expect(200);
    const exercise = mockQueries.find((q) => /INSERT INTO workout_session_exercises/.test(q.sql));
    expect(exercise.params[2]).toBe('Bench Press');
  });

  it('refuses a second submit without writing any set', async () => {
    mockResponder = submitResponder(openSession({ status: 'completed', submitted_at: '2026-11-13T11:00:00Z' }));
    const res = await request(app).post('/api/me/workout/sessions/ws1/submit').send({}).expect(409);
    expect(res.body.error.code).toBe('WORKOUT_SUBMITTED');
    expect(mockQueries.some((q) => /INSERT INTO workout_sets/.test(q.sql))).toBe(false);
  });

  it('is 404 for a session that is not this member’s', async () => {
    mockResponder = () => ({ rows: [] });
    await request(app).post('/api/me/workout/sessions/someone-elses/submit').send({}).expect(404);
    expect(mockQueries.some((q) => /INSERT INTO workout_sets/.test(q.sql))).toBe(false);
  });

  it('still submits after the trainer revokes the permission', async () => {
    mockResponder = (sql) => {
      if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: false }] };
      return submitResponder(openSession())(sql);
    };
    await request(app).post('/api/me/workout/sessions/ws1/submit').send({}).expect(200);
  });

  it('tells the trainer there is a workout to review', async () => {
    mockResponder = submitResponder(openSession());
    await request(app).post('/api/me/workout/sessions/ws1/submit').send({}).expect(200);
    const notification = mockQueries.find((q) => /INSERT INTO notifications/.test(q.sql));
    expect(notification).toBeTruthy();
    expect(notification.sql).toContain("'/pt-os/clients/' || c.id || '/workout-log/' || $4");
    expect(notification.params[3]).toBe('ws1');
  });
});

describe('POST /api/me/workouts — the legacy one-shot log', () => {
  const body = {
    request_id: 'req-12345678',
    assignment_id: 'a1',
    program_name: 'Base',
    workout_day: 'Thursday',
    duration_minutes: 45,
    exercises: [{ name: 'Squat', sets: [{ weight_kg: 60, reps: 8 }] }],
  };

  it('is refused when the trainer has not enabled self workouts', async () => {
    mockResponder = (sql) => {
      if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: false }] };
      return { rows: [] };
    };
    const res = await request(app).post('/api/me/workouts').send(body).expect(403);
    expect(res.body.error.code).toBe('SELF_WORKOUT_NOT_ALLOWED');
    expect(mockQueries.some((q) => /INSERT INTO workout_sessions/.test(q.sql))).toBe(false);
  });

  it('records timestamps and the review state when allowed', async () => {
    mockResponder = (sql) => {
      if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: true }] };
      if (/FROM workout_sessions WHERE client_id = \$1 AND organization_id = \$2 AND client_request_id/.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT COUNT\(\*\)::int AS n FROM workout_sessions/.test(sql)) return { rows: [{ n: 0 }] };
      if (/INSERT INTO workout_sessions/.test(sql)) return { rows: [{ id: 'ws-legacy' }] };
      if (/INSERT INTO workout_session_exercises/.test(sql)) return { rows: [{ id: 'wse-l' }] };
      return { rows: [] };
    };
    await request(app).post('/api/me/workouts').send(body).expect(201);

    const insert = mockQueries.find((q) => /INSERT INTO workout_sessions/.test(q.sql));
    expect(insert.sql).toMatch(/started_at/);
    expect(insert.sql).toMatch(/submitted_at/);
    expect(insert.sql).toMatch(/review_status/);
    expect(insert.params.join(' ')).toContain('Base');
  });
});

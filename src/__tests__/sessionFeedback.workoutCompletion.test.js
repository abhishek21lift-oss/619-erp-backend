'use strict';

// "Finish Workout" is the normal way a trainer completes a studio session.
// This pins the one write that turns that completion into the client's feedback
// prompt: only a real in_progress → completed transition, only for a
// trainer-led (source = 'studio') session, and never twice.

const queries = [];
const ORG = '11111111-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const TRAINER = '44444444-4444-4444-8444-444444444444';
const FEEDBACK = '55555555-5555-4555-8555-555555555555';

let mockCurrent;
let mockUpdated;
let mockFeedbackCreated;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params: params || [] });
    if (/^SELECT status, source FROM workout_sessions/i.test(flat)) {
      return { rows: mockCurrent ? [mockCurrent] : [], rowCount: mockCurrent ? 1 : 0 };
    }
    if (/^SELECT source, status, submitted_at FROM workout_sessions/i.test(flat)) {
      return { rows: [{ source: 'studio', status: 'in_progress', submitted_at: null }], rowCount: 1 };
    }
    if (/^UPDATE workout_sessions SET/i.test(flat)) {
      return { rows: [mockUpdated], rowCount: 1 };
    }
    if (/^INSERT INTO pt_session_feedback/i.test(flat)) {
      return { rows: mockFeedbackCreated, rowCount: mockFeedbackCreated.length };
    }
    if (/^INSERT INTO notifications/i.test(flat)) {
      return { rows: [{ id: 'n1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
  withTenantSession: jest.fn(async (fn) => fn()),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'u1', role: 'trainer', organization_id: '11111111-1111-4111-8111-111111111111' };
    next();
  },
  requireTrainer: (_req, _res, next) => next(),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db/pool');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));
  return a;
}

const preRead = () => queries.find((q) => /^SELECT status, source FROM workout_sessions/i.test(q.sql));
const requestInsert = () => queries.find((q) => /^INSERT INTO pt_session_feedback/i.test(q.sql));
const notificationInsert = () => queries.find((q) => /^INSERT INTO notifications/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  jest.clearAllMocks();
  mockCurrent = { status: 'in_progress', source: 'studio' };
  mockUpdated = {
    id: SESSION, client_id: CLIENT, trainer_id: TRAINER,
    session_date: '2026-11-06', program_name: 'Upper body',
    source: 'studio', status: 'completed',
    updated_at: '2026-11-06T10:00:00.000Z',
    workout_assignment_id: null,
  };
  mockFeedbackCreated = [{ id: FEEDBACK, workout_session_id: SESSION, client_id: CLIENT }];
});

describe('finishing a studio workout asks the client for feedback', () => {
  it('creates one request and one notification on the real transition', async () => {
    const res = await request(app())
      .patch(`/api/pt-os/workout-log/sessions/${SESSION}`)
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(preRead().params).toEqual([SESSION, ORG]);

    const insert = requestInsert();
    expect(insert).toBeTruthy();
    expect(insert.sql).toMatch(/organization_id, workout_session_id, client_id, trainer_id, completed_at/);
    expect(insert.sql).toMatch(/ON CONFLICT \(workout_session_id\) DO NOTHING/);
    expect(insert.sql).toMatch(/JOIN pt_sessions s ON s\.id = f\.session_id/);
    expect(insert.params).toEqual([
      ORG, SESSION, CLIENT, TRAINER, '2026-11-06T10:00:00.000Z', '2026-11-06',
    ]);

    const notify = notificationInsert();
    expect(notify).toBeTruthy();
    expect(notify.sql).toMatch(/session_feedback_request/);
    expect(notify.params).toContain(FEEDBACK);
    expect(notify.params).toContain(CLIENT);
    expect(pool.withTenantSession).toHaveBeenCalledTimes(1);
  });

  it('a retried completion creates no second request or notification', async () => {
    mockCurrent = { status: 'completed', source: 'studio' };

    const res = await request(app())
      .patch(`/api/pt-os/workout-log/sessions/${SESSION}`)
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(requestInsert()).toBeUndefined();
    expect(notificationInsert()).toBeUndefined();
  });

  it('a member self-logged session never asks for trainer feedback', async () => {
    mockCurrent = { status: 'in_progress', source: 'member' };

    const res = await request(app())
      .patch(`/api/pt-os/workout-log/sessions/${SESSION}`)
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(requestInsert()).toBeUndefined();
    expect(notificationInsert()).toBeUndefined();
  });

  it('editing notes creates no request', async () => {
    const res = await request(app())
      .patch(`/api/pt-os/workout-log/sessions/${SESSION}`)
      .send({ notes: 'Bring bands' });

    expect(res.status).toBe(200);
    expect(preRead()).toBeUndefined();
    expect(requestInsert()).toBeUndefined();
    expect(notificationInsert()).toBeUndefined();
  });

  it('does not notify when the unique request already exists', async () => {
    mockFeedbackCreated = [];

    const res = await request(app())
      .patch(`/api/pt-os/workout-log/sessions/${SESSION}`)
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(requestInsert()).toBeTruthy();
    expect(notificationInsert()).toBeUndefined();
  });
});

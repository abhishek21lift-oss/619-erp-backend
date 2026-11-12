'use strict';
// Trainer review of a submitted member workout, and the lock that keeps the
// submission immutable.
//
//   · the pending queue is the studio's, and only member sessions in it;
//   · approving / requesting changes records who and when, and tells the
//     member;
//   · a submitted member session refuses every trainer exercise/set write;
//   · a session in another studio is a 404, not a leak.

const CLIENT = 'cl-1';
const ORG = '11111111-1111-4111-8111-111111111111';

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

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-t', role: 'trainer', organization_id: '11111111-1111-4111-8111-111111111111', name: 'Trainer' };
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));

beforeEach(() => {
  mockQueries.length = 0;
  mockResponder = () => ({ rows: [] });
});

describe('GET /api/pt-os/workout-log/pending-review', () => {
  it('lists only pending member sessions in the studio', async () => {
    await request(app).get('/api/pt-os/workout-log/pending-review').expect(200);
    const query = mockQueries[0];
    expect(query.sql).toMatch(/ws\.source = 'member'/);
    expect(query.sql).toMatch(/ws\.status = 'completed'/);
    expect(query.sql).toMatch(/ws\.review_status = 'pending'/);
    expect(query.params).toEqual([ORG]);
  });

  it('narrows by client without ever dropping the studio filter', async () => {
    await request(app).get('/api/pt-os/workout-log/pending-review?client_id=cl-1').expect(200);
    expect(mockQueries[0].params).toEqual([ORG, CLIENT]);
    expect(mockQueries[0].sql).toMatch(/ws\.organization_id = \$1/);
  });
});

describe('POST /api/pt-os/workout-log/sessions/:id/review', () => {
  it('approves with feedback and notifies the member', async () => {
    mockResponder = (sql) => {
      if (/UPDATE workout_sessions SET review_status/.test(sql)) {
        return { rows: [{ id: 'ws1', client_id: CLIENT, review_status: 'approved', review_feedback: 'Good depth.' }] };
      }
      return { rows: [] };
    };
    const res = await request(app)
      .post('/api/pt-os/workout-log/sessions/ws1/review')
      .send({ decision: 'approved', feedback: 'Good depth, add 2.5 kg next week.' })
      .expect(200);
    expect(res.body.data.review_status).toBe('approved');

    const update = mockQueries.find((q) => /UPDATE workout_sessions SET review_status/.test(q.sql));
    expect(update.sql).toMatch(/reviewed_by = \$4/);
    expect(update.sql).toMatch(/reviewed_at = NOW\(\)/);
    expect(update.params.slice(0, 5)).toEqual([
      'ws1', ORG, 'approved', 'usr-t', 'Good depth, add 2.5 kg next week.',
    ]);

    const notification = mockQueries.find((q) => /INSERT INTO notifications/.test(q.sql));
    expect(notification).toBeTruthy();
    expect(notification.sql).toMatch(/u\.pt_client_id = \$1/);
    expect(notification.params[0]).toBe(CLIENT);

    const audit = mockQueries.find((q) => /INSERT INTO activity_log/.test(q.sql));
    expect(audit.params[2]).toBe('workout_log.member.review');
  });

  it('records changes requested with the feedback', async () => {
    mockResponder = (sql) => {
      if (/UPDATE workout_sessions SET review_status/.test(sql)) {
        return { rows: [{ id: 'ws1', client_id: CLIENT, review_status: 'changes_requested', review_feedback: 'Depth.' }] };
      }
      return { rows: [] };
    };
    await request(app)
      .post('/api/pt-os/workout-log/sessions/ws1/review')
      .send({ decision: 'changes_requested', feedback: 'Depth.' })
      .expect(200);
    const update = mockQueries.find((q) => /UPDATE workout_sessions SET review_status/.test(q.sql));
    expect(update.params[2]).toBe('changes_requested');
  });

  it('refuses an unknown decision without writing', async () => {
    await request(app)
      .post('/api/pt-os/workout-log/sessions/ws1/review')
      .send({ decision: 'looks_fine' })
      .expect(400);
    expect(mockQueries).toHaveLength(0);
  });

  it('is 404 when the session is not a submitted member session in this studio', async () => {
    mockResponder = () => ({ rows: [] });
    await request(app)
      .post('/api/pt-os/workout-log/sessions/ws1/review')
      .send({ decision: 'approved' })
      .expect(404);
  });
});

describe('the submitted-workout lock', () => {
  const submitted = (sql) => {
    if (/SELECT wse\.exercise_id/.test(sql)) {
      return { rows: [{ exercise_id: 'ex1', exercise_name: 'Squat', client_id: CLIENT, session_id: 'ws1' }] };
    }
    if (/SELECT source, status, submitted_at FROM workout_sessions/.test(sql)) {
      return { rows: [{ source: 'member', status: 'completed', submitted_at: '2026-11-13T11:00:00Z' }] };
    }
    return { rows: [] };
  };

  it('refuses a trainer set edit on a submitted member session', async () => {
    mockResponder = submitted;
    const res = await request(app)
      .post('/api/pt-os/workout-log/exercises/e1/sets')
      .send({ set_number: 1, reps: 5 })
      .expect(409);
    expect(res.body.error.code).toBe('SUBMITTED_WORKOUT_LOCKED');
    expect(mockQueries.some((q) => /INSERT INTO workout_sets/.test(q.sql))).toBe(false);
  });

  it('refuses adding an exercise to a submitted member session', async () => {
    mockResponder = (sql) => {
      if (/SELECT source, status, submitted_at FROM workout_sessions/.test(sql)) {
        return { rows: [{ source: 'member', status: 'completed', submitted_at: '2026-11-13T11:00:00Z' }] };
      }
      return { rows: [] };
    };
    const res = await request(app)
      .post('/api/pt-os/workout-log/sessions/ws1/exercises')
      .send({ exercise_name: 'Bench Press' })
      .expect(409);
    expect(res.body.error.code).toBe('SUBMITTED_WORKOUT_LOCKED');
    expect(mockQueries.some((q) => /INSERT INTO workout_session_exercises/.test(q.sql))).toBe(false);
  });

  it('still allows a trainer-led session', async () => {
    mockResponder = (sql) => {
      if (/SELECT source, status, submitted_at FROM workout_sessions/.test(sql)) {
        return { rows: [{ source: 'studio', status: 'in_progress', submitted_at: null }] };
      }
      if (/SELECT id FROM workout_sessions WHERE id = \$1/.test(sql)) return { rows: [{ id: 'ws2' }] };
      if (/COALESCE\(MAX\(sort_order\)/.test(sql)) return { rows: [{ next_order: 0 }] };
      if (/INSERT INTO workout_session_exercises/.test(sql)) return { rows: [{ id: 'wse1' }] };
      return { rows: [] };
    };
    await request(app)
      .post('/api/pt-os/workout-log/sessions/ws2/exercises')
      .send({ exercise_name: 'Squat' })
      .expect(201);
  });
});

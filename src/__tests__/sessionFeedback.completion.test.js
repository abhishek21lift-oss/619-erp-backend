'use strict';

// Marking a session completed is the one write that creates the client's
// feedback request. These tests pin the three properties that make it safe to
// retry: the stamp is set once, the request is deduped by UNIQUE(session_id),
// and the client's notification is deduped by ref_id.

const queries = [];
const ORG = '11111111-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const FEEDBACK = '55555555-5555-4555-8555-555555555555';

let mockUser;
let mockCreated;
let mockCurrentSession;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params: params || [] });
    if (/^SELECT start_time, duration_minutes, status, client_id FROM pt_sessions/i.test(flat)) {
      return { rows: [mockCurrentSession], rowCount: 1 };
    }
    if (/^UPDATE pt_sessions SET/i.test(flat)) {
      return {
        rows: [{
          ...mockCurrentSession,
          id: SESSION,
          status: 'completed',
          title: 'Upper body',
          trainer_id: 'tr-1',
          organization_id: ORG,
          completed_at: '2026-11-06T10:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    if (/^INSERT INTO pt_session_feedback/i.test(flat)) {
      return { rows: mockCreated, rowCount: mockCreated.length };
    }
    if (/^INSERT INTO notifications/i.test(flat)) {
      return { rows: [{ id: 'n1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
  withTenantSession: jest.fn(async (fn) => fn()),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/screeningGate', () => ({
  checkTrainingEligibility: jest.fn(async () => ({ blocked: null, warnings: [] })),
  screeningSummary: jest.fn(() => ({})),
  screeningGaps: jest.fn(() => []),
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  return a;
}

const completion = () => queries.find((q) => /^UPDATE pt_sessions SET/i.test(q.sql));
const requestInsert = () => queries.find((q) => /^INSERT INTO pt_session_feedback/i.test(q.sql));
const notificationInsert = () => queries.find((q) => /^INSERT INTO notifications/i.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  mockCreated = [{ id: FEEDBACK, session_id: SESSION, client_id: CLIENT }];
  mockCurrentSession = { status: 'scheduled', client_id: CLIENT, start_time: '10:00:00', duration_minutes: 60, session_date: '2026-11-05' };
  mockUser = { id: 'u1', role: 'trainer', name: 'Owner', organization_id: ORG };
});

describe('completing a session creates one feedback request', () => {
  it('stamps completion and asks the client once', async () => {
    const res = await request(app()).patch(`/api/pt-os/sessions/${SESSION}`).send({ status: 'completed' });

    expect(res.status).toBe(200);

    const update = completion();
    expect(update.sql).toMatch(/completed_at = COALESCE\(completed_at, NOW\(\)\)/);
    expect(update.params).toContain(ORG);

    const insert = requestInsert();
    expect(insert).toBeTruthy();
    expect(insert.sql).toMatch(/ON CONFLICT \(session_id\) DO NOTHING/);
    expect(insert.sql).toMatch(/organization_id, session_id, client_id, trainer_id, completed_at/);
    expect(insert.sql).toMatch(/JOIN workout_sessions ws/);
    expect(insert.params).toEqual([ORG, SESSION, CLIENT, 'tr-1', '2026-11-06T10:00:00.000Z', '2026-11-05']);

    const notify = notificationInsert();
    expect(notify).toBeTruthy();
    expect(notify.sql).toMatch(/session_feedback_request/);
    expect(notify.sql).toMatch(/NOT EXISTS/);
    expect(notify.params).toContain(FEEDBACK);
    expect(notify.params).toContain(CLIENT);
  });

  it('a retried completion does not send a second notification', async () => {
    // The request already existed, so ON CONFLICT returned no row.
    mockCreated = [];

    const res = await request(app()).patch(`/api/pt-os/sessions/${SESSION}`).send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(requestInsert()).toBeTruthy();
    expect(notificationInsert()).toBeUndefined();
  });

  it('editing a scheduled session creates no request', async () => {
    const res = await request(app()).patch(`/api/pt-os/sessions/${SESSION}`).send({ notes: 'Bring bands' });

    expect(res.status).toBe(200);
    expect(completion().sql).not.toMatch(/completed_at/);
    expect(requestInsert()).toBeUndefined();
    expect(notificationInsert()).toBeUndefined();
  });
});

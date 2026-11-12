'use strict';
// The trainer's permission, end to end at the HTTP boundary:
//
//   · GET /api/me/workout tells the member whether they may start a workout,
//     and hands back the session they already have open;
//   · PATCH /api/pt-os/clients/:id/self-workout is the only writer, it is
//     trainer-only, org-scoped, and leaves old + new in activity_log.
//
// The member identity is always the session's. A client_id in the query
// changes nothing — the same rule every /api/me route obeys.

const CLIENT = 'cl-self';
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

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');

const memberApp = express();
memberApp.use(express.json());
memberApp.use((req, _res, next) => {
  req.user = { id: 'usr-m', role: 'member', pt_client_id: CLIENT, organization_id: ORG };
  next();
});
memberApp.use('/api/me', require('../modules/client-portal/client-portal.routes'));

const trainerApp = express();
trainerApp.use(express.json());
trainerApp.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));

beforeEach(() => {
  mockQueries.length = 0;
  mockResponder = () => ({ rows: [] });
  mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG, name: 'Trainer' };
});

describe('GET /api/me/workout — the permission and the open session', () => {
  it('reports OFF and no open session by default', async () => {
    mockResponder = (sql) => {
      if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: false }] };
      return { rows: [] };
    };
    const res = await request(memberApp).get('/api/me/workout?client_id=someone-else').expect(200);
    expect(res.body).toMatchObject({ allow_self_workout: false, open_session: null });
    expect(mockQueries.every((q) => !q.params.includes('someone-else'))).toBe(true);
  });

  it('returns the open member session with its autosaved draft', async () => {
    mockResponder = (sql) => {
      if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: true }] };
      if (/FROM workout_sessions/.test(sql) && /source = 'member'/.test(sql)) {
        return { rows: [{
          id: 'ws-open', started_at: '2026-11-13T10:00:00Z', draft: { version: 1 },
          prescribed: { name: 'Base', exercises: [] }, workout_assignment_id: 'a1',
          program_name: 'Base', workout_day: 'Thursday',
        }] };
      }
      return { rows: [] };
    };
    const res = await request(memberApp).get('/api/me/workout').expect(200);
    expect(res.body.allow_self_workout).toBe(true);
    expect(res.body.open_session).toMatchObject({ id: 'ws-open', draft: { version: 1 } });
  });
});

describe('PATCH /api/pt-os/clients/:id/self-workout', () => {
  it('turns the permission on and records old and new values', async () => {
    mockResponder = (sql) => {
      if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: false }] };
      if (/UPDATE pt_clients SET allow_self_workout/.test(sql)) {
        return { rows: [{ id: CLIENT, allow_self_workout: true }] };
      }
      return { rows: [] };
    };
    const res = await request(trainerApp)
      .patch(`/api/pt-os/clients/${CLIENT}/self-workout`)
      .send({ allow_self_workout: true })
      .expect(200);
    expect(res.body.data).toMatchObject({ allow_self_workout: true });

    const update = mockQueries.find((q) => /UPDATE pt_clients SET allow_self_workout/.test(q.sql));
    expect(update.params).toEqual([CLIENT, ORG, true]);

    const audit = mockQueries.find((q) => /INSERT INTO activity_log/.test(q.sql));
    expect(audit.params[2]).toBe('client.self_workout.update');
    expect(JSON.parse(audit.params[5])).toEqual({ allow_self_workout: false });
    expect(JSON.parse(audit.params[6])).toEqual({ allow_self_workout: true });
  });

  it('turns it back off without touching the client session', async () => {
    mockResponder = (sql) => {
      if (/SELECT allow_self_workout FROM pt_clients/.test(sql)) return { rows: [{ allow_self_workout: true }] };
      if (/UPDATE pt_clients SET allow_self_workout/.test(sql)) {
        return { rows: [{ id: CLIENT, allow_self_workout: false }] };
      }
      return { rows: [] };
    };
    await request(trainerApp)
      .patch(`/api/pt-os/clients/${CLIENT}/self-workout`)
      .send({ allow_self_workout: false })
      .expect(200);
    expect(mockQueries.some((q) => /UPDATE workout_sessions/.test(q.sql))).toBe(false);
  });

  it('refuses a non-boolean without writing anything', async () => {
    await request(trainerApp)
      .patch(`/api/pt-os/clients/${CLIENT}/self-workout`)
      .send({ allow_self_workout: 'yes' })
      .expect(400);
    expect(mockQueries).toHaveLength(0);
  });

  it('is 404 for a client in another studio', async () => {
    mockResponder = () => ({ rows: [] });
    await request(trainerApp)
      .patch(`/api/pt-os/clients/${CLIENT}/self-workout`)
      .send({ allow_self_workout: true })
      .expect(404);
    expect(mockQueries.some((q) => /UPDATE pt_clients SET allow_self_workout/.test(q.sql))).toBe(false);
  });
});

'use strict';
// The member's own session history carries the trainer's review.
//
// A member who submits a workout should be able to see the outcome without a
// second screen or a message: approved, changes requested, and the feedback
// the trainer wrote. The identity rule is unchanged — the client id comes from
// the session, never the request.

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

describe('GET /api/me/sessions', () => {
  it('returns the trainer review on the member session', async () => {
    mockResponder = (sql) => {
      if (/FROM workout_sessions/.test(sql)) {
        return { rows: [{
          id: 'ws1', session_date: '2026-11-13', program_name: 'Base', workout_day: 'Thursday',
          duration_minutes: 45, status: 'completed', source: 'member',
          review_status: 'approved', review_feedback: 'Nice work',
        }] };
      }
      return { rows: [] };
    };
    const res = await request(app).get('/api/me/sessions').expect(200);
    expect(res.body.data[0]).toMatchObject({
      id: 'ws1',
      review_status: 'approved',
      review_feedback: 'Nice work',
    });
    expect(mockQueries[0].params[0]).toBe(CLIENT);
    expect(mockQueries[0].params).toContain(ORG);
  });

  it('leaves the review fields null for a session the trainer has not reviewed', async () => {
    mockResponder = (sql) => {
      if (/FROM workout_sessions/.test(sql)) {
        return { rows: [{
          id: 'ws2', session_date: '2026-11-12', program_name: 'Base', workout_day: 'Wednesday',
          duration_minutes: 30, status: 'completed', source: 'studio',
          review_status: null, review_feedback: null,
        }] };
      }
      return { rows: [] };
    };
    const res = await request(app).get('/api/me/sessions').expect(200);
    expect(res.body.data[0]).toMatchObject({ review_status: null, review_feedback: null });
  });
});

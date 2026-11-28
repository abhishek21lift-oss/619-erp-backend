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

  // A repeat rebuilds the workout from this history. Without the mode and the
  // timed/distance targets a run comes back as kg × reps.
  it('returns the tracking mode and targets the prescription had', async () => {
    mockResponder = (sql) => {
      if (/FROM workout_sessions/.test(sql)) {
        return { rows: [{
          id: 'ws3', session_date: '2026-11-11', program_name: 'Base', workout_day: 'Tuesday',
          duration_minutes: 25, status: 'completed', source: 'member',
          review_status: null, review_feedback: null,
          prescribed: {
            day_of_week: 2,
            exercises: [{
              name: 'Run', tracking_mode: 'TIME_DISTANCE',
              target_duration_seconds: 1200, target_distance: 5, target_distance_unit: 'km',
            }],
          },
        }] };
      }
      if (/FROM workout_session_exercises e/.test(sql)) {
        return { rows: [{
          session_id: 'ws3', exercise_row_id: 'wse1', exercise_name: 'Run', sort_order: 1,
          prescribed_index: 0, exercise_id: 'e9', exercise_type: 'cardio',
          prescription_mode_primary: 'TIME_DISTANCE',
          set_number: 1, weight_kg: null, reps: null, rpe: 6, completed: true,
          is_pr_weight: false, is_pr_reps: false, is_pr_volume: false,
          duration_seconds: 1200, distance: 5, distance_unit: 'km',
        }] };
      }
      return { rows: [] };
    };
    const res = await request(app).get('/api/me/sessions').expect(200);
    expect(res.body.data[0].exercises[0]).toMatchObject({
      name: 'Run',
      tracking_mode: 'TIME_DISTANCE',
      target_duration_seconds: 1200,
      target_distance: 5,
      target_distance_unit: 'km',
    });
  });

  // The tracking fields exist for the repeat. A strength session that never
  // had a mode keeps the shape it always had: no new null keys in the payload.
  it('leaves the tracking keys off a session that never had a mode', async () => {
    mockResponder = (sql) => {
      if (/FROM workout_sessions/.test(sql)) {
        return { rows: [{
          id: 'ws4', session_date: '2026-11-10', program_name: 'Base', workout_day: 'Monday',
          duration_minutes: 40, status: 'completed', source: 'member',
          review_status: null, review_feedback: null,
          prescribed: { day_of_week: 1, exercises: [{ name: 'Back squat' }] },
        }] };
      }
      if (/FROM workout_session_exercises e/.test(sql)) {
        return { rows: [{
          session_id: 'ws4', exercise_row_id: 'wse2', exercise_name: 'Back squat', sort_order: 1,
          prescribed_index: 0, exercise_id: 'e1', exercise_type: 'strength',
          prescription_mode_primary: null,
          set_number: 1, weight_kg: 60, reps: 8, rpe: null, completed: true,
          is_pr_weight: false, is_pr_reps: false, is_pr_volume: false,
          duration_seconds: null, distance: null, distance_unit: null,
        }] };
      }
      return { rows: [] };
    };
    const res = await request(app).get('/api/me/sessions').expect(200);
    const exercise = res.body.data[0].exercises[0];
    expect(exercise).toMatchObject({ name: 'Back squat' });
    expect(exercise).not.toHaveProperty('tracking_mode');
    expect(exercise).not.toHaveProperty('target_duration_seconds');
  });
});

'use strict';
// The live programme day behind a session.
//
// A member session's `planned` is a snapshot of what they were shown. The
// trainer still needs to edit the PLAN from that screen, so the detail
// response carries `programme`: the current plan row ids, the session's
// weekday and week, and whether this studio may write to the plan.
//
// The two must never be confused. A test that only checked `programme` exists
// would pass while the snapshot was silently overwritten, and the review
// screen would start showing today's plan as what the member was prescribed.

const CLIENT = 'cl-1';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';

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
    req.user = { id: 'usr-t', role: 'trainer', organization_id: ORG, name: 'Trainer' };
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));

const PLAN_ROW = {
  plan_id: 'plan-1', plan_name: 'PPL', duration_weeks: 8,
  progression_type: 'weight', progression_amount: 2.5, progression_every_weeks: 1,
  periodization_model: 'linear', block_phases: null,
  deload_every_weeks: null, deload_intensity_pct: null,
  plan_org: ORG, start_date: '2026-11-01',
};

const PLAN_EXERCISES = [
  {
    row_id: 'we-1', exercise_id: 'ex-bench', name: 'Bench Press',
    prescription_mode_primary: 'WEIGHT_REPS', week_number: 1, sets: 3, reps: 8,
    rest_seconds: 90, sort_order: 0, notes: null, target_weight: 60,
    tempo: null, rpe: 7, rir: null, warmup_sets: 1, superset_group: null, config: null,
  },
  {
    row_id: 'we-2', exercise_id: 'ex-row', name: 'Barbell Row',
    prescription_mode_primary: 'WEIGHT_REPS', week_number: 1, sets: 3, reps: 10,
    rest_seconds: 60, sort_order: 1, notes: null, target_weight: 40,
    tempo: null, rpe: 7, rir: null, warmup_sets: 1, superset_group: null, config: null,
  },
];

const MEMBER_SESSION = {
  id: 'ws-1', client_id: CLIENT, organization_id: ORG, source: 'member',
  status: 'completed', workout_assignment_id: 'wa-1',
  session_date: '2026-11-20', workout_day: 'Friday',
  prescribed: {
    plan_name: 'PPL', current_week: 3, day_of_week: 5,
    exercises: [{
      exercise_id: 'ex-bench', name: 'Bench Press', sets: 3, reps: 8,
      rest_seconds: 90, target_weight: 55,
    }],
  },
};

function responder({ session = MEMBER_SESSION, plan = PLAN_ROW, exercises = PLAN_EXERCISES } = {}) {
  return (sql) => {
    if (/^SELECT \* FROM workout_sessions WHERE id = \$1/.test(sql)) return { rows: session ? [session] : [] };
    if (/FROM workout_session_exercises wse/.test(sql)) return { rows: [] };
    if (/FROM workout_assignments wa/.test(sql)) return { rows: plan ? [plan] : [] };
    if (/FROM workout_exercises we/.test(sql)) return { rows: exercises };
    return { rows: [] };
  };
}

beforeEach(() => {
  mockQueries.length = 0;
  mockResponder = responder();
});

describe('GET /api/pt-os/workout-log/sessions/:id — programme', () => {
  it('returns the live programme beside the member snapshot', async () => {
    const res = await request(app)
      .get('/api/pt-os/workout-log/sessions/ws-1')
      .expect(200);

    // The snapshot is still what the trainer reviews.
    expect(res.body.data.planned.source).toBe('snapshot');
    expect(res.body.data.planned.week).toBe(3);
    expect(res.body.data.planned.exercises[0].target_weight).toBe(55);

    // The live programme is separate, editable, and carries row ids.
    const programme = res.body.data.programme;
    expect(programme.plan_id).toBe('plan-1');
    expect(programme.assignment_id).toBe('wa-1');
    expect(programme.day_of_week).toBe(5);
    expect(programme.week).toBe(3);
    expect(programme.editable).toBe(true);
    expect(programme.exercises.map((x) => x.row_id)).toEqual(['we-1', 'we-2']);
    // Week 3 of "+2.5 kg/week": 60 + 2 × 2.5, not week 1's 60.
    expect(programme.exercises[0].target_weight).toBe(65);
  });

  it('scopes the assignment read to the session client', async () => {
    await request(app).get('/api/pt-os/workout-log/sessions/ws-1').expect(200);
    const assignment = mockQueries.find((q) => /FROM workout_assignments wa/.test(q.sql));
    expect(assignment.sql).toMatch(/wa\.client_id = \$2/);
    expect(assignment.sql).toMatch(/wa\.organization_id = \$3/);
    expect(assignment.params).toEqual(['wa-1', CLIENT, ORG]);
  });

  it('marks a shared platform template read-only', async () => {
    mockResponder = responder({ plan: { ...PLAN_ROW, plan_org: null } });
    const res = await request(app)
      .get('/api/pt-os/workout-log/sessions/ws-1')
      .expect(200);
    expect(res.body.data.programme.editable).toBe(false);
  });

  it('marks another studio’s plan read-only rather than leaking an edit path', async () => {
    mockResponder = responder({ plan: { ...PLAN_ROW, plan_org: OTHER_ORG } });
    const res = await request(app)
      .get('/api/pt-os/workout-log/sessions/ws-1')
      .expect(200);
    expect(res.body.data.programme.editable).toBe(false);
  });

  it('falls back to the snapshot weekday when the session has no day name', async () => {
    mockResponder = responder({ session: { ...MEMBER_SESSION, workout_day: null } });
    const res = await request(app)
      .get('/api/pt-os/workout-log/sessions/ws-1')
      .expect(200);
    expect(res.body.data.programme.day_of_week).toBe(5);
  });

  it('uses the session date, not today, to choose the week', async () => {
    // 2026-11-20 is 19 days after 2026-11-01: week 3. A resolver using today
    // would be a different number by the time this test runs.
    const res = await request(app)
      .get('/api/pt-os/workout-log/sessions/ws-1')
      .expect(200);
    expect(res.body.data.programme.week).toBe(3);
  });

  it('keeps the studio session shape: planned is the live prescription', async () => {
    const studio = {
      ...MEMBER_SESSION, source: 'studio', prescribed: null,
      workout_day: 'Friday',
    };
    mockResponder = responder({ session: studio });
    const res = await request(app)
      .get('/api/pt-os/workout-log/sessions/ws-1')
      .expect(200);

    expect(res.body.data.planned.plan_id).toBe('plan-1');
    expect(res.body.data.planned.source).toBe('derived');
    expect(res.body.data.planned.exercises[0].row_id).toBe('we-1');
    // `editable` is an edit-surface flag, not part of the prescription.
    expect(res.body.data.planned.editable).toBeUndefined();
    expect(res.body.data.programme.editable).toBe(true);
  });

  it('has no programme for a freestyle session', async () => {
    const freestyle = {
      ...MEMBER_SESSION, workout_assignment_id: null, prescribed: null,
    };
    mockResponder = responder({ session: freestyle });
    const res = await request(app)
      .get('/api/pt-os/workout-log/sessions/ws-1')
      .expect(200);
    expect(res.body.data.programme).toBeNull();
    expect(res.body.data.planned).toBeNull();
  });

  it('reads only: a programme view never writes the member log', async () => {
    await request(app).get('/api/pt-os/workout-log/sessions/ws-1').expect(200);
    expect(mockQueries.length).toBeGreaterThan(0);
    expect(mockQueries.every((q) => /^SELECT/i.test(q.sql))).toBe(true);
  });

  it('is 404 for a session outside the studio', async () => {
    mockResponder = responder({ session: null });
    await request(app).get('/api/pt-os/workout-log/sessions/ws-1').expect(404);
    expect(mockQueries[0].params).toEqual(['ws-1', ORG]);
  });
});

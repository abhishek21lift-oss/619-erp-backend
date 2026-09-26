'use strict';
// /api/me/workout, /api/me/diet, /api/me/checkins — the member app's own data.
//
// What is held here:
//   · identity comes from the session only: a client_id, organization_id or
//     week in the request changes nothing
//   · every query is bounded by the session's client AND studio
//   · a member's check-in can never overwrite what the trainer wrote
//     (trainer_notes, adherence, calories) and never selects trainer_notes
//   · the programme shows the week the client has reached, grouped by day

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

// Wednesday 2026-09-23 → the week starts Monday 2026-09-21.
// Pin "today"; everything else (dbDate for DATE columns) is the real module.
jest.mock('../lib/appTime', () => ({ ...jest.requireActual('../lib/appTime'), today: () => '2026-09-23' }));

const express = require('express');
const request = require('supertest');
const { mondayOf, weekNumberSince, normaliseCheckin, weekStreaks } = require('../modules/client-portal/client-portal.service');

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

const boundToSelf = (q) => {
  expect(q.params[0]).toBe(CLIENT);
  expect(q.params).toContain(ORG);
};

describe('GET /api/me/workout', () => {
  it('reads only the session client in the session studio, whatever the query says', async () => {
    await request(app).get('/api/me/workout?client_id=someone-else&organization_id=other').expect(200);
    expect(mockQueries).toHaveLength(1); // no assignments → no exercise query
    boundToSelf(mockQueries[0]);
    expect(mockQueries[0].params).not.toContain('someone-else');
    expect(mockQueries[0].sql).toMatch(/a\.status = 'active'/);
  });

  it("groups the current week's exercises by day, carrying the last written week forward", async () => {
    mockResponder = (sql) => {
      if (/FROM workout_assignments/.test(sql)) {
        return { rows: [{ assignment_id: 'as1', plan_id: 'p1', name: 'Base Phase', start_date: '2026-09-02', duration_weeks: 8 }] };
      }
      return {
        rows: [
          { workout_plan_id: 'p1', week_number: 1, day_of_week: 1, sort_order: 0, name: 'Squat', sets: 3, reps: 5 },
          { workout_plan_id: 'p1', week_number: 2, day_of_week: 1, sort_order: 0, name: 'Squat', sets: 4, reps: 5 },
          { workout_plan_id: 'p1', week_number: 2, day_of_week: 3, sort_order: 0, name: 'Bench', sets: 3, reps: 8 },
        ],
      };
    };
    const res = await request(app).get('/api/me/workout').expect(200);
    const [plan] = res.body.data;
    // Started 2026-09-02, today 2026-09-23 → week 4. Only weeks 1-2 are
    // written, so week 4 is week 2's prescription (no rule on this plan).
    expect(plan.current_week).toBe(4);
    expect(plan.days.map((d) => d.day_of_week)).toEqual([1, 3]);
    expect(plan.days[0].exercises[0]).toMatchObject({ name: 'Squat', sets: 4 });
  });
});

describe('GET /api/me/diet', () => {
  it('is bounded to the session client and studio and returns meals per plan', async () => {
    mockResponder = (sql) => {
      if (/FROM diet_assignments/.test(sql)) {
        return { rows: [{ assignment_id: 'd1', template_id: 't1', name: 'Lean', daily_calories: 2000, daily_protein_g: '150.0' }] };
      }
      return { rows: [{ diet_template_id: 't1', name: 'Oats', meal_type: 'breakfast', calories: 400, protein_g: '20.0' }] };
    };
    const res = await request(app).get('/api/me/diet?client_id=someone-else').expect(200);
    boundToSelf(mockQueries[0]);
    expect(res.body.data[0].daily.protein_g).toBe(150);
    expect(res.body.data[0].meals[0]).toMatchObject({ name: 'Oats', protein_g: 20 });
  });
});

describe('GET /api/me/checkins', () => {
  it('never selects the trainer notes', async () => {
    const res = await request(app).get('/api/me/checkins').expect(200);
    expect(mockQueries[0].sql).not.toMatch(/trainer_notes/);
    boundToSelf(mockQueries[0]);
    expect(res.body.data.this_week).toBe('2026-09-21');
  });
});

describe('POST /api/me/checkins', () => {
  beforeEach(() => {
    mockResponder = (sql) => (/INSERT INTO weekly_checkins/.test(sql) ? { rows: [{ id: 'wc1' }] } : { rows: [] });
  });

  it("writes this week's row for the session client, ignoring any client, studio or week sent", async () => {
    await request(app).post('/api/me/checkins')
      .send({ client_id: 'someone-else', organization_id: 'other', week_start_date: '2020-01-06', weight: 72.5, mood: 'good' })
      .expect(201);
    const q = mockQueries[0];
    expect(q.params[0]).toBe(CLIENT);
    expect(q.params[1]).toBe('2026-09-21');
    expect(q.params).toContain(ORG);
    expect(q.params).not.toContain('someone-else');
    expect(q.params).not.toContain('2020-01-06');
  });

  it("does not touch the trainer's fields when updating an existing week", async () => {
    await request(app).post('/api/me/checkins').send({ weight: 72 }).expect(201);
    const setClause = mockQueries[0].sql.split('DO UPDATE SET')[1];
    expect(setClause).not.toMatch(/trainer_notes|adherence_pct|calories_avg|workout_count/);
  });

  it.each([
    ['an unknown mood', { mood: 'ecstatic' }],
    ['an impossible weight', { weight: 900 }],
    ['a stress reading off the scale', { stress_level: 12 }],
    ['nothing at all', {}],
  ])('refuses %s with 400 and writes nothing', async (_l, body) => {
    const res = await request(app).post('/api/me/checkins').send(body);
    expect(res.status).toBe(400);
    expect(mockQueries).toHaveLength(0);
  });
});

describe('helpers', () => {
  it.each([
    ['2026-09-21', '2026-09-21'], // Monday
    ['2026-09-27', '2026-09-21'], // Sunday
    ['2026-09-23', '2026-09-21'],
  ])('mondayOf(%s) is %s', (d, m) => expect(mondayOf(d)).toBe(m));

  it('counts weeks from the start date, and a future start is week 1', () => {
    expect(weekNumberSince('2026-09-21', '2026-09-27')).toBe(1);
    expect(weekNumberSince('2026-09-14', '2026-09-21')).toBe(2);
    expect(weekNumberSince('2026-10-01', '2026-09-21')).toBe(1);
    // node-postgres hands a DATE column back as a Date, not a string. This was
    // NaN, and a programme's every exercise was filtered out of the member app.
    expect(weekNumberSince(new Date('2026-09-14T00:00:00Z'), '2026-09-21')).toBe(2);
    expect(weekNumberSince(new Date(2026, 8, 14), '2026-09-21')).toBe(2);
  });

  describe('weekStreaks', () => {
    const NOW = '2026-09-24'; // a Thursday; this week starts 2026-09-21

    it('counts back from this week when this week is active', () => {
      expect(weekStreaks(['2026-09-21', '2026-09-14', '2026-09-07'], NOW))
        .toEqual({ current: 3, longest: 3, this_week: true });
    });

    it('keeps the streak alive through a week that has not happened yet', () => {
      expect(weekStreaks(['2026-09-14', '2026-09-07'], NOW))
        .toEqual({ current: 2, longest: 2, this_week: false });
    });

    it('breaks once a whole week is missed, but remembers the longest run', () => {
      expect(weekStreaks(['2026-08-31', '2026-08-24', '2026-08-17', '2026-08-10'], NOW))
        .toEqual({ current: 0, longest: 4, this_week: false });
    });

    it('is all zeros with nothing logged', () => {
      expect(weekStreaks([], NOW)).toEqual({ current: 0, longest: 0, this_week: false });
    });

    it('runs across a year boundary', () => {
      expect(weekStreaks(['2025-12-22', '2025-12-29', '2026-01-05'], '2026-01-07'))
        .toEqual({ current: 3, longest: 3, this_week: true });
    });
  });

  it('trims notes and keeps only member-writable fields', () => {
    const c = normaliseCheckin({ client_notes: '  felt strong  ', trainer_notes: 'x', adherence_pct: 90 });
    expect(c.client_notes).toBe('felt strong');
    expect(c).not.toHaveProperty('trainer_notes');
    expect(c).not.toHaveProperty('adherence_pct');
  });
});

'use strict';
// The trainer's workout system — plans, assignment, starting and finishing a
// session, and the numbers read back from it — against a real migrated
// database.
//
// Every bug this suite pins down passed its unit tests, because the unit tests
// handed the code strings where node-postgres hands it Dates, or never ran the
// SQL at all:
//   - a session's planned workout was always week 1 (weekOf could not read
//     the assignment's start_date), so a progression rule never reached the
//     gym floor;
//   - adherence and this week's missed days were always empty;
//   - asking for one client's plans matched nothing (a placeholder pointed at
//     the organization id);
//   - Start twice made two logs, a log was dated by the database server's UTC
//     day, and an assignment id was trusted from the body;
//   - a log never finished stayed "in progress" forever, so the workout never
//     counted;
//   - every first-ever set was a personal record.
//
// Gated on RLS_TEST_DATABASE_URL like the other real-database suites.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('workout system against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the workout system suite would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 4 });
});

// Unique to this suite (the real-database suites share one database).
const ORG = 'c1e70000-0000-4000-8000-000000000214';
const OTHER_ORG = 'c1e70000-0000-4000-8000-000000000215';
const TRAINER = 'ws-int-trainer';
const TRAINER_USER = 'ws-int-trainer-user';
const CLIENT = 'ws-int-client';
const SECOND = 'ws-int-second';
const FOREIGN = 'ws-int-foreign';

const mockSession = { id: TRAINER_USER, role: 'trainer', organization_id: ORG, trainer_id: TRAINER };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockSession; next(); },
  requireTrainer: (req, res, next) => (req.user?.role === 'trainer'
    ? next() : res.status(403).json({ error: { code: 'FORBIDDEN' } })),
}));

const request = require('supertest');

describeIf('workout system against a real database', () => {
  let pool;
  let app;
  const { today } = require('../lib/appTime');
  const ymd = (offsetDays) => {
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };
  const isoDow = (date) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  async function cleanup() {
    const orgs = [ORG, OTHER_ORG];
    await pool.query(`DELETE FROM activity_logs WHERE user_id = $1`, [TRAINER_USER]).catch(() => {});
    await pool.query(`DELETE FROM workout_sessions WHERE organization_id = ANY($1::uuid[])`, [orgs]);
    await pool.query(`DELETE FROM workout_assignments WHERE organization_id = ANY($1::uuid[])`, [orgs]);
    await pool.query(
      `DELETE FROM workout_exercises WHERE workout_plan_id IN
         (SELECT id FROM workout_plans WHERE organization_id = ANY($1::uuid[]))`, [orgs]);
    await pool.query(`DELETE FROM workout_plans WHERE organization_id = ANY($1::uuid[])`, [orgs]);
    await pool.query(`DELETE FROM exercises WHERE id IN ('ws-int-squat', 'ws-int-row')`);
    await pool.query(`DELETE FROM users WHERE id = $1`, [TRAINER_USER]);
    await pool.query(`DELETE FROM pt_clients WHERE id = ANY($1)`, [[CLIENT, SECOND, FOREIGN]]);
    await pool.query(`DELETE FROM trainers WHERE id = $1`, [TRAINER]);
    await pool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [orgs]);
  }

  /** A plan with one exercise on `dow`, assigned to `clientId` from `startDate`. */
  async function planFor(clientId, { id, dow, startDate, orgId = ORG, rule = null, targetWeight = 60 }) {
    await pool.query(
      `INSERT INTO workout_plans (id, name, sessions_per_week, duration_weeks, organization_id,
                                  progression_type, progression_amount, progression_every_weeks)
       VALUES ($1, $1, 1, 8, $2, $3, $4, 1)`,
      [id, orgId, rule ? 'weight' : 'none', rule]);
    await pool.query(
      `INSERT INTO workout_exercises (workout_plan_id, exercise_id, day_of_week, week_number, sort_order, sets, reps, target_weight)
       VALUES ($1, 'ws-int-squat', $2, 1, 0, 3, 8, $3)`, [id, dow, targetWeight]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO workout_assignments (id, workout_plan_id, client_id, start_date, status, organization_id)
       VALUES ($1, $2, $3, $4, 'active', $5) RETURNING id`,
      [`${id}-a`, id, clientId, startDate, orgId]);
    return a.id;
  }

  async function addSet(sessionId, exercise, { weight, reps, completed = true }) {
    const { rows: [e] } = await pool.query(
      `INSERT INTO workout_session_exercises (session_id, exercise_id, exercise_name, sort_order)
       VALUES ($1, 'ws-int-squat', $2, 0) RETURNING id`, [sessionId, exercise]);
    return request(app).post(`/api/pt-os/workout-log/exercises/${e.id}/sets`)
      .send({ set_number: 1, weight_kg: weight, reps, completed });
  }

  beforeAll(async () => {
    pool = require('../db/pool');
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Workout Studio', 'workout-int'),
              ($2, 'Other Studio', 'workout-int-other')`, [ORG, OTHER_ORG]);
    await pool.query(`INSERT INTO trainers (id, name, organization_id) VALUES ($1, 'Tara', $2)`, [TRAINER, ORG]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id, trainer_id, status)
       VALUES ($1, 'Asha', '+919000021401', $4, $5, 'active'),
              ($2, 'Bina', '+919000021402', $4, $5, 'active'),
              ($3, 'Far',  '+919000021403', $6, NULL, 'active')`,
      [CLIENT, SECOND, FOREIGN, ORG, TRAINER, OTHER_ORG]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, trainer_id, is_active)
       VALUES ($1, 'Tara', 'tara@workout.test', '!', 'trainer', $2, $3, TRUE)`, [TRAINER_USER, ORG, TRAINER]);
    await pool.query(
      `INSERT INTO exercises (id, name, muscle_group) VALUES ('ws-int-squat', 'WS Squat', 'Legs'),
              ('ws-int-row', 'WS Row', 'Back') ON CONFLICT (id) DO NOTHING`);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/pt-os', require('../modules/pt-os/workout-log.routes'));
    app.use('/api/workouts', require('../routes/workouts'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM workout_sessions WHERE organization_id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await pool.query(`DELETE FROM workout_assignments WHERE organization_id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
    await pool.query(
      `DELETE FROM workout_exercises WHERE workout_plan_id IN
         (SELECT id FROM workout_plans WHERE organization_id = ANY($1::uuid[]))`, [[ORG, OTHER_ORG]]);
    await pool.query(`DELETE FROM workout_plans WHERE organization_id = ANY($1::uuid[])`, [[ORG, OTHER_ORG]]);
  });

  describe('starting a session', () => {
    it("is dated in the studio's zone and links today's programme, with its weekday", async () => {
      await planFor(CLIENT, { id: 'ws-int-p1', dow: isoDow(today()), startDate: ymd(-3) });
      const res = await request(app).post('/api/pt-os/workout-log/sessions').send({ client_id: CLIENT });
      expect(res.status).toBe(201);
      const { rows: [s] } = await pool.query(
        `SELECT to_char(session_date, 'YYYY-MM-DD') AS d, workout_assignment_id, workout_day
           FROM workout_sessions WHERE id = $1`, [res.body.data.id]);
      expect(s).toEqual({ d: today(), workout_assignment_id: 'ws-int-p1-a', workout_day: WEEKDAYS[isoDow(today()) - 1] });
    });

    it('resumes the open log instead of starting a second one', async () => {
      const first = await request(app).post('/api/pt-os/workout-log/sessions').send({ client_id: CLIENT });
      const again = await request(app).post('/api/pt-os/workout-log/sessions').send({ client_id: CLIENT });
      expect(again.status).toBe(200);
      expect(again.body.resumed).toBe(true);
      expect(again.body.data.id).toBe(first.body.data.id);

      // Two taps at the same moment still make one log.
      await pool.query(`DELETE FROM workout_sessions WHERE client_id = $1`, [CLIENT]);
      const both = await Promise.all([1, 2].map(() =>
        request(app).post('/api/pt-os/workout-log/sessions').send({ client_id: CLIENT })));
      expect(new Set(both.map((r) => r.body.data.id)).size).toBe(1);

      // A finished log is not reopened: the next Start is a new workout.
      await pool.query(`UPDATE workout_sessions SET status = 'completed' WHERE client_id = $1`, [CLIENT]);
      const next = await request(app).post('/api/pt-os/workout-log/sessions').send({ client_id: CLIENT });
      expect(next.status).toBe(201);
      expect(next.body.data.id).not.toBe(both[0].body.data.id);
    });

    it("prefers the assignment that prescribes today over a newer one that doesn't", async () => {
      const dow = isoDow(today());
      await planFor(CLIENT, { id: 'ws-int-today', dow, startDate: ymd(-30) });
      await planFor(CLIENT, { id: 'ws-int-other', dow: (dow % 7) + 1, startDate: ymd(-2) });
      const res = await request(app).post('/api/pt-os/workout-log/sessions').send({ client_id: CLIENT });
      expect(res.body.data.workout_assignment_id).toBe('ws-int-today-a');
    });

    it("refuses another client's or another studio's assignment, and a malformed date", async () => {
      await planFor(SECOND, { id: 'ws-int-second', dow: 1, startDate: ymd(-3) });
      await planFor(FOREIGN, { id: 'ws-int-foreign', dow: 1, startDate: ymd(-3), orgId: OTHER_ORG });
      for (const id of ['ws-int-second-a', 'ws-int-foreign-a']) {
        const res = await request(app).post('/api/pt-os/workout-log/sessions')
          .send({ client_id: CLIENT, workout_assignment_id: id });
        expect(res.status).toBe(404);
      }
      const bad = await request(app).post('/api/pt-os/workout-log/sessions')
        .send({ client_id: CLIENT, session_date: 'next tuesday' });
      expect(bad.status).toBe(400);
      const { rows } = await pool.query(`SELECT 1 FROM workout_sessions WHERE client_id = $1`, [CLIENT]);
      expect(rows).toHaveLength(0);
    });
  });

  it("shows the week the client is in, with the rule applied", async () => {
    // 15 days in → week 3 → two +2.5 kg steps on 60.
    await planFor(CLIENT, { id: 'ws-int-prog', dow: isoDow(today()), startDate: ymd(-15), rule: 2.5 });
    const start = await request(app).post('/api/pt-os/workout-log/sessions').send({ client_id: CLIENT });
    const res = await request(app).get(`/api/pt-os/workout-log/sessions/${start.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.planned.week).toBe(3);
    expect(Number(res.body.data.planned.exercises[0].target_weight)).toBe(65);
  });

  it("finishes yesterday's log that has work in it, and leaves an empty one alone", async () => {
    await planFor(CLIENT, { id: 'ws-int-close', dow: 1, startDate: ymd(-10) });
    const { rows: [worked] } = await pool.query(
      `INSERT INTO workout_sessions (client_id, workout_assignment_id, session_date, status, organization_id)
       VALUES ($1, 'ws-int-close-a', $2, 'in_progress', $3) RETURNING id`, [CLIENT, ymd(-1), ORG]);
    const { rows: [empty] } = await pool.query(
      `INSERT INTO workout_sessions (client_id, session_date, status, organization_id)
       VALUES ($1, $2, 'in_progress', $3) RETURNING id`, [SECOND, ymd(-1), ORG]);
    const { rows: [live] } = await pool.query(
      `INSERT INTO workout_sessions (client_id, session_date, status, organization_id)
       VALUES ($1, $2, 'in_progress', $3) RETURNING id`, [SECOND, today(), ORG]);
    await addSet(worked.id, 'WS Squat', { weight: 50, reps: 8 });
    await addSet(live.id, 'WS Squat', { weight: 50, reps: 8 });

    const { closeStaleSessions } = require('../modules/pt-os/workout-log.service');
    expect(await closeStaleSessions(ORG)).toBe(1);

    const { rows } = await pool.query(
      `SELECT id, status FROM workout_sessions WHERE id = ANY($1)`, [[worked.id, empty.id, live.id]]);
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status).toEqual({ [worked.id]: 'completed', [empty.id]: 'in_progress', [live.id]: 'in_progress' });
    // 1 of 8 planned sessions (1/week × 8 weeks).
    const { rows: [a] } = await pool.query(`SELECT progress_pct FROM workout_assignments WHERE id = 'ws-int-close-a'`);
    expect(a.progress_pct).toBe(13);
  });

  it("lists one client's plans with their progress", async () => {
    await planFor(CLIENT, { id: 'ws-int-mine', dow: 1, startDate: ymd(-3) });
    await planFor(SECOND, { id: 'ws-int-theirs', dow: 1, startDate: ymd(-3) });
    await pool.query(`UPDATE workout_assignments SET progress_pct = 40 WHERE id = 'ws-int-mine-a'`);
    const res = await request(app).get(`/api/workouts/plans?client_id=${CLIENT}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((p) => p.id);
    expect(ids).toContain('ws-int-mine');
    expect(ids).not.toContain('ws-int-theirs');
    expect(res.body.find((p) => p.id === 'ws-int-mine').progress).toBe(40);
  });

  it('reports adherence and this week from real session dates', async () => {
    await planFor(CLIENT, { id: 'ws-int-adh', dow: 1, startDate: ymd(-14) });
    await pool.query(
      `INSERT INTO workout_sessions (client_id, workout_assignment_id, session_date, status, organization_id)
       VALUES ($1, 'ws-int-adh-a', $2, 'completed', $3)`, [CLIENT, ymd(-7), ORG]);
    const res = await request(app).get(`/api/pt-os/workout-log/analytics?client_id=${CLIENT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.adherence.pct).not.toBeNull();
    expect(res.body.data.adherence.completed).toBe(1);
    expect(res.body.data.this_week.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a first-ever lift is a baseline; beating it later is a record', async () => {
    const day1 = await pool.query(
      `INSERT INTO workout_sessions (client_id, session_date, status, organization_id)
       VALUES ($1, $2, 'completed', $3) RETURNING id`, [CLIENT, ymd(-2), ORG]);
    const first = await addSet(day1.rows[0].id, 'WS Squat', { weight: 60, reps: 5 });
    expect(first.body.data).toMatchObject({ is_pr_weight: false, is_pr_reps: false, is_pr_volume: false });

    const day2 = await pool.query(
      `INSERT INTO workout_sessions (client_id, session_date, status, organization_id)
       VALUES ($1, $2, 'in_progress', $3) RETURNING id`, [CLIENT, today(), ORG]);
    const second = await addSet(day2.rows[0].id, 'WS Squat', { weight: 65, reps: 5 });
    expect(second.body.data.is_pr_weight).toBe(true);
  });

  it("charts an exercise's progress by real date", async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO workout_sessions (client_id, session_date, status, organization_id)
       VALUES ($1, $2, 'completed', $3) RETURNING id`, [CLIENT, ymd(-1), ORG]);
    await addSet(s.id, 'WS Squat', { weight: 70, reps: 5 });
    const res = await request(app).get(`/api/pt-os/workout-log/progress?client_id=${CLIENT}&exercise_name=ws%20squat`);
    expect(res.body.data).toEqual([expect.objectContaining({ session_date: ymd(-1), best_weight: 70 })]);
  });
});

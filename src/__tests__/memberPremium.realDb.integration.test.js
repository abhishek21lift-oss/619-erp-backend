'use strict';
// Guided workout, goals and the monthly recap, against a real migrated
// database, as a real member.
//
// What is proved here that a mocked pool cannot prove:
//   - a finished workout lands as ONE completed session, source = 'member',
//     with sets, PR flags from the trainer log's own rule, and a retry with
//     the same request id does not log it twice;
//   - a PAR-Q block stops self-logging;
//   - goal progress is read from the records, and reaching the target stamps
//     achieved_at once and tells the trainer;
//   - the recap counts a PR only when an earlier day's record was beaten, and
//     never includes another client's training.
//
// Gated on RLS_TEST_DATABASE_URL like the other real-database suites.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('member premium features against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the member premium suite would skip.');
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
const ORG = 'c1e70000-0000-4000-8000-000000000212';
const CLIENT = 'mp-int-client';
const OTHER = 'mp-int-other';
const USER = 'mp-int-user';
const TRAINER = 'mp-int-trainer';
const TRAINER_USER = 'mp-int-trainer-user';

const request = require('supertest');

describeIf('member premium features against a real database', () => {
  let pool;
  let app;
  let asClient = CLIENT;
  const { today } = require('../lib/appTime');
  const ymd = (offsetDays) => {
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  /** A studio-logged session with one exercise and the given sets. */
  async function studioSession(clientId, date, exercise, sets) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO workout_sessions (client_id, session_date, status, organization_id)
       VALUES ($1, $2, 'completed', $3) RETURNING id`, [clientId, date, ORG]);
    const { rows: [e] } = await pool.query(
      `INSERT INTO workout_session_exercises (session_id, exercise_name, sort_order)
       VALUES ($1, $2, 0) RETURNING id`, [s.id, exercise]);
    for (const [i, [kg, reps, pr]] of sets.entries()) {
      await pool.query(
        `INSERT INTO workout_sets (session_exercise_id, set_number, weight_kg, reps, completed, is_pr_weight)
         VALUES ($1, $2, $3, $4, TRUE, $5)`, [e.id, i + 1, kg, reps, Boolean(pr)]);
    }
    return s.id;
  }

  async function cleanup() {
    await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [TRAINER_USER]);
    await pool.query(`DELETE FROM member_goals WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM workout_sessions WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM weekly_checkins WHERE organization_id = $1`, [ORG]);
    await pool.query(`DELETE FROM pt_parq_forms WHERE client_id = ANY($1)`, [[CLIENT, OTHER]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, TRAINER_USER]]);
    await pool.query(`DELETE FROM pt_clients WHERE id = ANY($1)`, [[CLIENT, OTHER]]);
    await pool.query(`DELETE FROM trainers WHERE id = $1`, [TRAINER]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
  }

  beforeAll(async () => {
    pool = require('../db/pool');
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Premium Studio', 'premium-int')`, [ORG]);
    await pool.query(`INSERT INTO trainers (id, name, organization_id) VALUES ($1, 'Tara', $2)`, [TRAINER, ORG]);
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id, trainer_id)
       VALUES ($1, 'Mina Rao', '+919000021201', $3, $4), ($2, 'Other', '+919000021202', $3, $4)`,
      [CLIENT, OTHER, ORG, TRAINER]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, pt_client_id, is_active)
       VALUES ($1, 'Mina', 'mina@premium.test', '!', 'member', $2, $3, TRUE)`, [USER, ORG, CLIENT]);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, trainer_id, is_active)
       VALUES ($1, 'Tara', 'tara@premium.test', '!', 'trainer', $2, $3, TRUE)`, [TRAINER_USER, ORG, TRAINER]);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/me', (req, _res, next) => {
      req.user = { id: USER, role: 'member', organization_id: ORG, pt_client_id: asClient };
      next();
    }, require('../modules/client-portal/client-portal.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(() => { asClient = CLIENT; });

  // ── Guided workout ────────────────────────────────────────────────────────

  describe('POST /api/me/workouts', () => {
    const workout = (requestId, sets = [[60, 8], [70, 5]]) => ({
      request_id: requestId,
      program_name: 'Strength base',
      workout_day: 'Monday',
      duration_minutes: 48,
      exercises: [{ name: 'Back Squat', sets: sets.map(([weight_kg, reps]) => ({ weight_kg, reps })) }],
    });

    it('logs one completed member session with server-computed personal bests', async () => {
      await studioSession(CLIENT, ymd(-10), 'Back squat', [[65, 5]]);

      const res = await request(app).post('/api/me/workouts').send(workout('req-aaaaaaaa-0001'));
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ exercises: 1, sets: 2, volume_kg: 60 * 8 + 70 * 5 });
      // 60×8 beats 65×5 on reps and volume; 70 beats 65 on weight.
      expect(res.body.data.prs.map((p) => p.kind)).toEqual(['reps', 'weight']);

      const { rows } = await pool.query(
        `SELECT status, source, duration_minutes, session_date::text AS d FROM workout_sessions
          WHERE id = $1`, [res.body.data.session_id]);
      expect(rows[0]).toEqual({ status: 'completed', source: 'member', duration_minutes: 48, d: today() });

      const notes = await pool.query(
        `SELECT title, body, link FROM notifications WHERE user_id = $1 AND type = 'member_workout'`, [TRAINER_USER]);
      expect(notes.rows[0].title).toBe('Mina Rao logged a workout');
      expect(notes.rows[0].body).toBe('1 exercise, 2 sets, 2 personal bests.');
      expect(notes.rows[0].link).toBe(`/pt-os/clients/${CLIENT}/workout-log`);
    });

    it('returns the same session for a retried request instead of logging twice', async () => {
      const first = await request(app).post('/api/me/workouts').send(workout('req-bbbbbbbb-0002'));
      const retry = await request(app).post('/api/me/workouts').send(workout('req-bbbbbbbb-0002'));
      expect(first.status).toBe(201);
      expect(retry.status).toBe(200);
      expect(retry.body.data.session_id).toBe(first.body.data.session_id);
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM workout_sessions WHERE client_request_id = 'req-bbbbbbbb-0002'`);
      expect(rows[0].n).toBe(1);
    });

    it('rejects a workout with no real sets, and bad numbers', async () => {
      expect((await request(app).post('/api/me/workouts')
        .send({ request_id: 'req-cccccccc-0003', exercises: [{ name: 'Row', sets: [{ reps: 0 }] }] })).status).toBe(400);
      expect((await request(app).post('/api/me/workouts')
        .send(workout('req-cccccccc-0004', [[-5, 8]]))).status).toBe(400);
      expect((await request(app).post('/api/me/workouts')
        .send({ ...workout('x'), request_id: 'short' })).status).toBe(400);
    });

    it('stops at the daily limit', async () => {
      // Two logged above; two more reach the limit of four.
      await request(app).post('/api/me/workouts').send(workout('req-dddddddd-0005'));
      await request(app).post('/api/me/workouts').send(workout('req-dddddddd-0006'));
      const res = await request(app).post('/api/me/workouts').send(workout('req-dddddddd-0007'));
      expect(res.status).toBe(429);
    });

    it('is refused while the PAR-Q blocks training', async () => {
      asClient = OTHER;
      await pool.query(
        `INSERT INTO pt_parq_forms (client_id, full_name, organization_id, risk_level, status, parq_yes_count, workout_gate_status)
         VALUES ($1, 'Other', $2, 'high', 'reviewed', 3, 'blocked')`, [OTHER, ORG]);
      const res = await request(app).post('/api/me/workouts').send(workout('req-eeeeeeee-0008'));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PARQ_BLOCKED');
    });

    it('returns last time\'s sets for the named exercises, case-insensitively', async () => {
      const res = await request(app).get('/api/me/workout/last').query({ name: ['back squat', 'Deadlift'] });
      expect(res.status).toBe(200);
      expect(res.body.data['back squat'].sets.length).toBeGreaterThan(0);
      expect(res.body.data['back squat'].best_kg).toBe(70);
      expect(res.body.data.deadlift).toBeUndefined();
    });
  });

  // ── Goals ─────────────────────────────────────────────────────────────────

  describe('goals', () => {
    it('creates a lift goal from the current best and reports progress from the records', async () => {
      const res = await request(app).post('/api/me/goals')
        .send({ kind: 'lift', exercise_name: 'Back squat', target_value: 80, target_date: ymd(60) });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ kind: 'lift', start_value: 70, current_value: 70, target_value: 80, progress_pct: 0, reached: false });
    });

    it('refuses a lift target already beaten, and a past date', async () => {
      expect((await request(app).post('/api/me/goals')
        .send({ kind: 'lift', exercise_name: 'Back squat', target_value: 60 })).status).toBe(400);
      expect((await request(app).post('/api/me/goals')
        .send({ kind: 'sessions', target_value: 10, target_date: ymd(-1) })).status).toBe(400);
    });

    it('stamps a goal achieved once, and tells the trainer', async () => {
      const created = await request(app).post('/api/me/goals').send({ kind: 'sessions', target_value: 1 });
      expect(created.status).toBe(201);
      // Today's member sessions count toward a goal set today.
      const first = await request(app).get('/api/me/goals');
      const goal = first.body.data.goals.find((g) => g.id === created.body.data.id);
      expect(goal).toMatchObject({ reached: true, progress_pct: 100, just_achieved: true });
      const again = await request(app).get('/api/me/goals');
      expect(again.body.data.goals.find((g) => g.id === goal.id).just_achieved).toBeUndefined();
      const notes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'member_goal'`, [TRAINER_USER]);
      expect(notes.rows[0].n).toBe(1);
    });

    it('archives a goal, and cannot archive another client\'s', async () => {
      const { body } = await request(app).post('/api/me/goals').send({ kind: 'sessions', target_value: 50 });
      asClient = OTHER;
      expect((await request(app).delete(`/api/me/goals/${body.data.id}`)).status).toBe(404);
      asClient = CLIENT;
      expect((await request(app).delete(`/api/me/goals/${body.data.id}`)).status).toBe(204);
      const list = await request(app).get('/api/me/goals');
      expect(list.body.data.goals.some((g) => g.id === body.data.id)).toBe(false);
    });

    it('shows the trainer\'s weight target as the studio goal', async () => {
      await pool.query(
        `INSERT INTO pt_goals (client_id, goal_type, target_weight, starting_weight, is_active, organization_id)
         VALUES ($1, 'fat_loss', 68, 74, TRUE, $2)`, [CLIENT, ORG]);
      await pool.query(
        `INSERT INTO weekly_checkins (client_id, organization_id, week_start_date, weight)
         VALUES ($1, $2, $3, 72)`, [CLIENT, ORG, ymd(-3)]);
      const res = await request(app).get('/api/me/goals');
      expect(res.body.data.studio).toMatchObject({ kind: 'weight', target_value: 68, start_value: 74, current_value: 72, progress_pct: 33 });
      await pool.query(`DELETE FROM pt_goals WHERE client_id = $1`, [CLIENT]);
    });
  });

  // ── Monthly recap ─────────────────────────────────────────────────────────

  describe('GET /api/me/recap', () => {
    it('counts the month from the records, and a PR only when an earlier record was beaten', async () => {
      // Another client's heavy month must not leak in.
      await studioSession(OTHER, today(), 'Deadlift', [[200, 1, true]]);

      const month = today().slice(0, 7);
      const res = await request(app).get('/api/me/recap').query({ month });
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.month).toBe(month);
      expect(d.first_name).toBe('Mina');
      expect(d.studio_name).toBe('Premium Studio');
      expect(d.top_lift.exercise).not.toBe('Deadlift');
      expect(d.top_lift.weight_kg).toBe(70);
      // Back squat was logged 10 days ago, so today's PRs are real records —
      // unless 10 days ago fell in the previous month, in which case still real.
      expect(d.records.map((r) => r.exercise.toLowerCase())).toEqual(['back squat']);
      expect(d.totals.self_logged).toBeGreaterThanOrEqual(4);
      expect(d.weekdays).toHaveLength(7);
      expect(d.months).toContain(month);
    });

    it('does not call a first-ever set a personal best', async () => {
      asClient = OTHER;
      const res = await request(app).get('/api/me/recap');
      expect(res.body.data.top_lift.weight_kg).toBe(200);
      expect(res.body.data.records).toEqual([]);
    });

    it('rejects a malformed or future month', async () => {
      expect((await request(app).get('/api/me/recap').query({ month: '2026-13' })).status).toBe(400);
      expect((await request(app).get('/api/me/recap').query({ month: '2999-01' })).status).toBe(400);
    });
  });
});

'use strict';
// Phase 1 — one canonical writer per duplicated fact, pinned against a real
// database and the real routers.
//
// Every assertion here is about what a legacy caller is told (422 FIELD_MOVED,
// naming the owner) and what the database actually stores afterwards. The
// moved columns stay readable; nothing in this suite drops data.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('client data ownership Phase 1, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the Phase 1 ownership proof would skip.');
    });
  });
}

const mockDbUrl = DB_URL;
jest.mock('../db/pool', () => {
  if (!mockDbUrl) return { query: jest.fn(), connect: jest.fn() };
  const { Pool } = jest.requireActual('pg');
  return new Pool({ connectionString: mockDbUrl, max: 6 });
});
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../modules/automation/automation.triggers', () => new Proxy({}, {
  get: () => async () => {},
}));
jest.mock('../lib/subscription', () => ({
  ...jest.requireActual('../lib/subscription'),
  clientLimitStatus: async () => ({ limit: null, count: 0, atLimit: false }),
}));

const ORG = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const USER = 'phase1-owner-trainer';
const mockUser = { id: USER, name: 'Phase 1 Ownership', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  invalidateUserCache: jest.fn(),
}));

const { randomUUID } = require('crypto');
const logger = require('../lib/logger');
const { calcBmr } = require('../modules/progress/fitness-scoring');
const { resolveAlcohol, resolveNutritionHabits } = require('../modules/progress/assessment-facts');

describeIf('client data ownership Phase 1, against a real database', () => {
  let pool;
  let request;

  const clients = [];
  const movedWarnings = () => logger.warn.mock.calls
    .filter(([payload]) => payload && payload.event === 'ownership.field_moved');
  const movedReads = () => logger.info.mock.calls
    .filter(([payload]) => payload && payload.event === 'ownership.deprecated_read');

  const newClient = async (name = 'Phase 1 Client') => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id)
       VALUES ($1, $2, $3, $4)`,
      [id, name, `96${String(Date.now() + clients.length).slice(-8)}`, ORG],
    );
    clients.push(id);
    return id;
  };

  const parqAnswers = () => Array.from({ length: 10 }, (_, i) => ({ question_id: i + 1, answer: 'no' }));

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug)
      VALUES ($1, 'Phase 1 Ownership', 'phase1-ownership') ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'Phase 1 Ownership', 'phase1@test.invalid', '!x', 'trainer', $2, TRUE)
      ON CONFLICT (id) DO NOTHING`, [USER, ORG]);

    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
    app.use('/api/pt-os', require('../modules/pt-os/client-journey.routes'));
    app.use('/api/pt-os', require('../modules/pt-os/parq.routes'));
    app.use('/api/progress', require('../modules/progress/progress.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);
  });

  beforeEach(() => {
    logger.warn.mockClear();
    logger.info.mockClear();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM pt_family_medical_history WHERE parq_form_id IN (SELECT id FROM pt_parq_forms WHERE client_id = ANY($1))', [clients]);
    for (const table of [
      'pt_parq_forms', 'pt_client_interviews', 'pt_nutrition_assessments',
      'pt_lifestyle_assessments', 'pt_mobility_performance_assessments',
      'pt_goals', 'pt_assessments',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE client_id = ANY($1)`, [clients]);
    }
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [clients]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [ORG]);
    await pool.end();
  });

  // ─── Interview ────────────────────────────────────────────────────────────
  describe('Client Interview owns only the quick screen', () => {
    test('a write to a Lifestyle field is refused before anything is stored', async () => {
      const clientId = await newClient('Interview Refuse');
      const r = await request().post(`/api/pt-os/clients/${clientId}/interviews`).send({
        lifestyle_sleep_hours: 7, lifestyle_smoking: 'never',
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('FIELD_MOVED');
      expect(r.body.error.fields.map((f) => f.field).sort())
        .toEqual(['lifestyle_sleep_hours', 'lifestyle_smoking']);
      const { rows } = await pool.query('SELECT * FROM pt_client_interviews WHERE client_id = $1', [clientId]);
      expect(rows).toHaveLength(0);
      expect(movedWarnings()).toHaveLength(1);
    });

    test('sitting hours, meal regularity and training days are stored', async () => {
      const clientId = await newClient('Interview Own');
      const r = await request().post(`/api/pt-os/clients/${clientId}/interviews`).send({
        lifestyle_sitting_hours: '6', lifestyle_meal_regularity: 'regular', lifestyle_training_days: 4,
        occupation_other_details: 'Site supervisor',
      });
      expect(r.status).toBe(201);
      expect(Number(r.body.data.lifestyle_sitting_hours)).toBe(6);
      expect(r.body.data.lifestyle_meal_regularity).toBe('regular');
      expect(r.body.data.lifestyle_training_days).toBe(4);
      expect(r.body.data.lifestyle_sleep_hours).toBeNull();
    });

    test('a legacy draft whose only answer is in a moved column can still be completed', async () => {
      const clientId = await newClient('Interview Legacy');
      const { rows: [row] } = await pool.query(
        `INSERT INTO pt_client_interviews (organization_id, client_id, status, lifestyle_occupation)
         VALUES ($1, $2, 'draft', 'desk_job') RETURNING id`, [ORG, clientId]);
      const r = await request().patch(`/api/pt-os/interviews/${row.id}`).send({ status: 'completed' });
      expect(r.status).toBe(200);
      expect(r.body.data.status).toBe('completed');
      expect(r.body.data.lifestyle_occupation).toBe('desk_job');
    });

    test('an edit cannot write a moved field', async () => {
      const clientId = await newClient('Interview Edit');
      const c = await request().post(`/api/pt-os/clients/${clientId}/interviews`)
        .send({ lifestyle_meal_regularity: 'irregular' });
      const p = await request().patch(`/api/pt-os/interviews/${c.body.data.id}`)
        .send({ lifestyle_screen_time: '<2' });
      expect(p.status).toBe(422);
      expect(p.body.error.fields[0]).toEqual({
        field: 'lifestyle_screen_time', owner: 'Lifestyle',
        endpoint: 'POST/PATCH /api/progress/lifestyle-assessments',
      });
    });
  });

  // ─── PAR-Q ────────────────────────────────────────────────────────────────
  describe('PAR-Q stores only the medical answers it owns', () => {
    test('create strips habit keys, logs them, and keeps the medical answers', async () => {
      const clientId = await newClient('PARQ Create');
      const r = await request().post('/api/pt-os/parq/forms').send({
        client_id: clientId, full_name: 'PARQ Create', status: 'draft',
        parq_answers: parqAnswers(),
        current_health: {
          known_disease: true, medications: false,
          smoking: true, alcohol: true, sleep_hours: 5, water_intake: 2,
        },
        past_history: { back_pain: true, occupation: 'desk_job', daily_sitting_hours: 8 },
      });
      expect(r.status).toBe(201);
      expect(r.body.data.current_health).toEqual({ known_disease: true, medications: false });
      expect(r.body.data.past_history).toEqual({ back_pain: true });
      const ignored = logger.warn.mock.calls
        .filter(([p]) => p && p.event === 'parq.habit_field_ignored')
        .flatMap(([p]) => p.fields);
      expect(ignored.sort()).toEqual(['alcohol', 'daily_sitting_hours', 'occupation', 'sleep_hours', 'smoking', 'water_intake'].sort());
    });

    test('edit merges medical keys and never drops or overwrites a legacy habit answer', async () => {
      const clientId = await newClient('PARQ Edit');
      const { rows: [legacy] } = await pool.query(
        `INSERT INTO pt_parq_forms
           (client_id, full_name, parq_answers, current_health, past_history, status, organization_id)
         VALUES ($1, 'PARQ Edit', $2::jsonb, $3::jsonb, $4::jsonb, 'draft', $5) RETURNING id`,
        [clientId, JSON.stringify(parqAnswers()),
          JSON.stringify({ sleep_hours: 8, smoking: false, medications: false }),
          JSON.stringify({ occupation: 'teacher', back_pain: false }), ORG]);

      const p = await request().patch(`/api/pt-os/parq/forms/${legacy.id}`).send({
        current_health: { sleep_hours: 4, medications: true },
        past_history: { occupation: 'driver', knee_pain: true },
      });
      expect(p.status).toBe(200);
      expect(p.body.data.current_health).toEqual({ sleep_hours: 8, smoking: false, medications: true });
      expect(p.body.data.past_history).toEqual({ occupation: 'teacher', back_pain: false, knee_pain: true });
      expect(logger.warn.mock.calls.some(([x]) => x && x.event === 'parq.habit_field_ignored')).toBe(true);
    });
  });

  // ─── Lifestyle ────────────────────────────────────────────────────────────
  describe('Lifestyle assessment writes only its own facts', () => {
    const movedPayload = {
      water_intake_liters: 3, meal_frequency: 4, breakfast_habit: 'daily',
      late_night_eating: true, workout_experience_level: 'advanced',
      food_preferences: ['vegetarian'], motivation_to_exercise: 8,
    };

    test('a duplicate write is refused and nothing is stored', async () => {
      const clientId = await newClient('Lifestyle Refuse');
      const r = await request().post('/api/progress/lifestyle-assessments')
        .send({ client_id: clientId, ...movedPayload });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('FIELD_MOVED');
      expect(new Set(r.body.error.fields.map((f) => f.field))).toEqual(new Set(Object.keys(movedPayload)));
      const { rows } = await pool.query('SELECT * FROM pt_lifestyle_assessments WHERE client_id = $1', [clientId]);
      expect(rows).toHaveLength(0);
    });

    test('a valid create leaves the retired duplicate columns null', async () => {
      const clientId = await newClient('Lifestyle Valid');
      const r = await request().post('/api/progress/lifestyle-assessments').send({
        client_id: clientId,
        sleep_duration_hours: 7, sleep_quality: 7, stress_level: 4,
        occupation_type: 'desk_job', daily_steps_bracket: '5000_8000',
        smoking_status: 'never', alcohol_status: 'never', drinks_per_week: 0,
        screen_time_bracket: '4_6', energy_level: 6, recovery_quality: 'good',
      });
      expect(r.status).toBe(201);
      const { rows: [row] } = await pool.query(
        `SELECT water_intake_liters, workout_experience_level, food_preferences,
                meal_frequency, breakfast_habit, late_night_eating, motivation_to_exercise
           FROM pt_lifestyle_assessments WHERE client_id = $1`, [clientId]);
      expect(row).toEqual({
        water_intake_liters: null, workout_experience_level: null, food_preferences: null,
        meal_frequency: null, breakfast_habit: null, late_night_eating: null, motivation_to_exercise: null,
      });
    });

    test('an edit cannot write a Nutrition or Goal field', async () => {
      const clientId = await newClient('Lifestyle Edit');
      const c = await request().post('/api/progress/lifestyle-assessments')
        .send({ client_id: clientId, sleep_quality: 6 });
      const p = await request().patch(`/api/progress/lifestyle-assessments/${c.body.data.id}`)
        .send({ meal_frequency: 5 });
      expect(p.status).toBe(422);
      expect(p.body.error.fields[0].owner).toBe('Nutrition');
    });
  });

  // ─── Nutrition ────────────────────────────────────────────────────────────
  describe('Nutrition assessment writes only its own facts', () => {
    test('a duplicate write is refused', async () => {
      const clientId = await newClient('Nutrition Refuse');
      const r = await request().post('/api/progress/nutrition-assessments').send({
        client_id: clientId, meal_timing_consistency: 'consistent',
        alcoholic_drinks_per_week: 4, medical_conditions: ['asthma'],
      });
      expect(r.status).toBe(422);
      expect(r.body.error.fields.map((f) => f.field).sort())
        .toEqual(['alcoholic_drinks_per_week', 'meal_timing_consistency', 'medical_conditions']);
    });

    test('a valid create leaves the retired duplicate columns null', async () => {
      const clientId = await newClient('Nutrition Valid');
      const r = await request().post('/api/progress/nutrition-assessments').send({
        client_id: clientId, meals_per_day: 3, water_intake_liters: 2.5,
        breakfast_regularity: 'daily', late_night_eating: false,
      });
      expect(r.status).toBe(201);
      const { rows: [row] } = await pool.query(
        `SELECT meal_timing_consistency, alcoholic_drinks_per_week, medical_conditions,
                water_intake_liters, meals_per_day
           FROM pt_nutrition_assessments WHERE client_id = $1`, [clientId]);
      expect(row.meal_timing_consistency).toBeNull();
      expect(row.alcoholic_drinks_per_week).toBeNull();
      expect(row.medical_conditions).toBeNull();
      expect(Number(row.water_intake_liters)).toBe(2.5);
      expect(row.meals_per_day).toBe(3);
    });

    test('a PAR-Q condition drives the risk score even with a legacy Nutrition list', async () => {
      const withParq = await newClient('Nutrition PARQ');
      const control = await newClient('Nutrition No PARQ');
      await pool.query(
        `INSERT INTO pt_parq_forms
           (client_id, full_name, parq_answers, current_health, past_history, status, organization_id)
         VALUES ($1, 'Nutrition PARQ', $2::jsonb, $3::jsonb, $4::jsonb, 'submitted', $5)`,
        [withParq, JSON.stringify(parqAnswers()),
          JSON.stringify({ known_disease: false }),
          JSON.stringify({ heart_disease: true }), ORG]);

      const payload = {
        meals_per_day: 3, water_intake_liters: 2.5,
        breakfast_regularity: 'daily', late_night_eating: false,
      };
      const a = await request().post('/api/progress/nutrition-assessments')
        .send({ client_id: withParq, ...payload });
      const b = await request().post('/api/progress/nutrition-assessments')
        .send({ client_id: control, ...payload });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(Number(a.body.data.nutrition_risk_score) - Number(b.body.data.nutrition_risk_score)).toBe(10);
    });

    test('the legacy list counts only when no submitted PAR-Q answers for the client', async () => {
      const clientId = await newClient('Nutrition Fallback');
      const c = await request().post('/api/progress/nutrition-assessments')
        .send({ client_id: clientId, meals_per_day: 3, water_intake_liters: 2.5 });
      const baseline = Number(c.body.data.nutrition_risk_score);
      await pool.query(
        'UPDATE pt_nutrition_assessments SET medical_conditions = ARRAY[$2] WHERE id = $1',
        [c.body.data.id, 'Asthma']);

      logger.info.mockClear();
      const listed = await request().get(`/api/progress/nutrition-assessments?client_id=${clientId}`);
      expect(Number(listed.body.data[0].nutrition_risk_score)).toBe(baseline + 10);
      expect(movedReads().some(([p]) => p.field === 'medical_conditions' && p.client_id === clientId)).toBe(true);

      await pool.query(
        `INSERT INTO pt_parq_forms
           (client_id, full_name, parq_answers, current_health, past_history, status, organization_id)
         VALUES ($1, 'Nutrition Fallback', $2::jsonb, '{}'::jsonb, '{}'::jsonb, 'submitted', $3)`,
        [clientId, JSON.stringify(parqAnswers()), ORG]);

      logger.info.mockClear();
      const after = await request().get(`/api/progress/nutrition-assessments?client_id=${clientId}`);
      expect(Number(after.body.data[0].nutrition_risk_score)).toBe(baseline);
      expect(movedReads().some(([p]) => p.field === 'medical_conditions')).toBe(false);
    });

    test('an edit cannot write a Lifestyle, Interview or PAR-Q field', async () => {
      const clientId = await newClient('Nutrition Edit');
      const c = await request().post('/api/progress/nutrition-assessments')
        .send({ client_id: clientId, meals_per_day: 3 });
      for (const [field, value, owner] of [
        ['alcoholic_drinks_per_week', 3, 'Lifestyle'],
        ['meal_timing_consistency', 'consistent', 'Client Interview'],
        ['medical_conditions', ['asthma'], 'PAR-Q'],
      ]) {
        const p = await request().patch(`/api/progress/nutrition-assessments/${c.body.data.id}`)
          .send({ [field]: value });
        expect([field, p.status, p.body.error.fields[0].owner]).toEqual([field, 422, owner]);
      }
    });
  });

  // ─── Mobility ─────────────────────────────────────────────────────────────
  describe('Mobility no longer writes sit-and-reach', () => {
    test('a positive value is refused; null is allowed to clear a legacy value', async () => {
      const clientId = await newClient('Mobility');
      const refused = await request().post('/api/progress/mobility-performance-assessments')
        .send({ client_id: clientId, sit_reach_cm: 20 });
      expect(refused.status).toBe(422);
      expect(refused.body.error.fields[0].owner).toBe('Fitness Testing');

      const created = await request().post('/api/progress/mobility-performance-assessments')
        .send({ client_id: clientId, sit_reach_cm: null, balance_test_seconds: 30 });
      expect(created.status).toBe(201);
      expect(created.body.data.sit_reach_cm).toBeNull();

      await pool.query('UPDATE pt_mobility_performance_assessments SET sit_reach_cm = 22 WHERE id = $1', [created.body.data.id]);
      const patchRefused = await request().patch(`/api/progress/mobility-performance-assessments/${created.body.data.id}`)
        .send({ sit_reach_cm: 29 });
      expect(patchRefused.status).toBe(422);

      const cleared = await request().patch(`/api/progress/mobility-performance-assessments/${created.body.data.id}`)
        .send({ sit_reach_cm: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.sit_reach_cm).toBeNull();
    });
  });

  // ─── Goal baseline ────────────────────────────────────────────────────────
  describe('Goal starting values are write-once evidence', () => {
    test('the latest assessment wins per measure, and manual values are ignored', async () => {
      const clientId = await newClient('Goal Weight');
      await pool.query(
        `INSERT INTO pt_assessments (id, client_id, assessment_date, assessment_type, weight, body_fat_pct, organization_id)
         VALUES ($1, $2, '2026-01-01', 'initial', 80, 25, $3)`,
        [randomUUID(), clientId, ORG]);
      await pool.query(
        `INSERT INTO pt_assessments (id, client_id, assessment_date, assessment_type, weight, body_fat_pct, organization_id)
         VALUES ($1, $2, '2026-02-01', 'follow_up', 78, NULL, $3)`,
        [randomUUID(), clientId, ORG]);

      const r = await request().post('/api/progress/goals').send({
        client_id: clientId, goal_type: 'fat_loss',
        starting_weight: 90, starting_body_fat_pct: 30, target_weight: 70,
      });
      expect(r.status).toBe(201);
      expect(Number(r.body.data.starting_weight)).toBe(78);
      expect(Number(r.body.data.starting_body_fat_pct)).toBe(25);
    });

    test('manual starting values are stored only when no assessment has them', async () => {
      const clientId = await newClient('Goal Manual');
      const r = await request().post('/api/progress/goals').send({
        client_id: clientId, goal_type: 'general_fitness',
        starting_weight: 90, starting_body_fat_pct: 30,
      });
      expect(r.status).toBe(201);
      expect(Number(r.body.data.starting_weight)).toBe(90);
      expect(Number(r.body.data.starting_body_fat_pct)).toBe(30);
    });

    test('an edit cannot rewrite the starting snapshot', async () => {
      const clientId = await newClient('Goal Edit');
      const c = await request().post('/api/progress/goals').send({
        client_id: clientId, goal_type: 'fat_loss', starting_weight: 90, starting_body_fat_pct: 30,
      });
      const p = await request().patch(`/api/progress/goals/${c.body.data.id}`)
        .send({ starting_weight: 70, starting_body_fat_pct: 20, notes: 'new note' });
      expect(p.status).toBe(422);
      expect(p.body.error.fields.map((f) => f.field).sort())
        .toEqual(['starting_body_fat_pct', 'starting_weight']);
      const { rows: [row] } = await pool.query(
        'SELECT starting_weight, starting_body_fat_pct, notes FROM pt_goals WHERE id = $1', [c.body.data.id]);
      expect(Number(row.starting_weight)).toBe(90);
      expect(Number(row.starting_body_fat_pct)).toBe(30);
      expect(row.notes).toBeNull();
    });
  });

  // ─── Read precedence ──────────────────────────────────────────────────────
  describe('canonical-first reads with a logged legacy fallback', () => {
    test('the owner wins; the fallback is read and logged when the owner is empty', () => {
      expect(resolveAlcohol(
        { drinks_per_week: null },
        { alcoholic_drinks_per_week: 3 },
        { client_id: 'read-client' },
      )).toEqual({ status: null, drinksPerWeek: 3 });
      expect(movedReads().some(([p]) => p.field === 'drinks_per_week' && p.client_id === 'read-client')).toBe(true);

      expect(resolveNutritionHabits(
        { water_intake_liters: 1.5, meal_frequency: 2 },
        {},
        { client_id: 'read-client' },
      )).toEqual({
        water_intake_liters: 1.5, meal_frequency: 2, breakfast_habit: null, late_night_eating: null,
      });
      expect(movedReads().filter(([p]) => p.owner === 'Nutrition').map(([p]) => p.field))
        .toEqual(['water_intake_liters', 'meal_frequency']);
    });
  });

  // ─── BMR ─────────────────────────────────────────────────────────────────
  describe('BMR is not guessed for an unsupported sex', () => {
    test('Male and Female use their own equation', () => {
      expect(calcBmr(80, 175, 30, 'Male')).toBe(1749);
      expect(calcBmr(80, 175, 30, 'Female')).toBe(1583);
    });

    test('Other is null rather than a confident value from the wrong equation', () => {
      expect(calcBmr(80, 175, 30, 'Other')).toBeNull();
      expect(calcBmr(80, 175, 30, 'Prefer not to say')).toBeNull();
      expect(calcBmr(80, 175, 30, null)).toBeNull();
    });
  });
});

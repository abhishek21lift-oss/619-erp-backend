'use strict';
// Phase 2 — the last second writer is retired, and every remaining read of a
// duplicated fact prefers the module that owns it.
//
// Real database, real loader and real resolvers. Only the logger and the
// infrastructure the AI module pulls in at require-time are mocked. Every
// assertion is about a value the studio would actually generate from, or a
// row the database still holds afterwards.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('client data ownership Phase 2, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the Phase 2 ownership proof would skip.');
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

const ORG = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const USER = 'phase2-owner-trainer';
const mockUser = { id: USER, name: 'Phase 2 Ownership', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  requireClient: (...a) => jest.requireActual('../middleware/rbac').requireClient(...a),
  requireTrainerOrSelf: (...a) => jest.requireActual('../middleware/rbac').requireTrainerOrSelf(...a),
  invalidateUserCache: jest.fn(),
}));

const { randomUUID } = require('crypto');
const logger = require('../lib/logger');

describeIf('client data ownership Phase 2, against a real database', () => {
  let pool;
  let request;
  let ai;
  let readService;

  const clients = [];

  const movedWarnings = () => logger.warn.mock.calls
    .filter(([payload]) => payload && payload.event === 'ownership.field_moved');
  const movedReads = () => logger.info.mock.calls
    .filter(([payload]) => payload && payload.event === 'ownership.deprecated_read');
  const legacyRead = (field, clientId) => movedReads()
    .some(([payload]) => payload.field === field && payload.client_id === clientId);

  const newClient = async (name, fields = {}) => {
    const id = randomUUID();
    const columns = ['id', 'name', 'mobile', 'organization_id'];
    const values = [id, name, `95${String(Date.now() + clients.length).slice(-8)}`, ORG];
    for (const [column, value] of Object.entries(fields)) {
      columns.push(column);
      values.push(value);
    }
    await pool.query(
      `INSERT INTO pt_clients (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
    clients.push(id);
    return id;
  };

  const addProfile = (clientId, fields = {}) => {
    const columns = ['client_id', 'organization_id'];
    const values = [clientId, ORG];
    for (const [column, value] of Object.entries(fields)) {
      columns.push(column);
      values.push(value);
    }
    return pool.query(
      `INSERT INTO client_fitness_profiles (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
  };

  const addAssessment = (clientId, { on, weight = null, height = null, bodyFat = null }) =>
    pool.query(
      `INSERT INTO pt_assessments (client_id, assessment_date, assessment_type, weight, height_cm, body_fat_pct, organization_id)
       VALUES ($1, $2, 'follow_up', $3, $4, $5, $6)`,
      [clientId, on, weight, height, bodyFat, ORG],
    );

  const addGoal = (clientId, goalType) =>
    pool.query(
      `INSERT INTO pt_goals (client_id, goal_type, is_active, organization_id)
       VALUES ($1, $2, TRUE, $3)`,
      [clientId, goalType, ORG],
    );

  const addParq = (clientId, { status = 'submitted', currentHealth = {}, pastHistory = {} } = {}) =>
    pool.query(
      `INSERT INTO pt_parq_forms
         (client_id, full_name, parq_answers, current_health, past_history, status, organization_id)
       VALUES ($1, 'Phase 2', $2::jsonb, $3::jsonb, $4::jsonb, $5, $6)`,
      [clientId, JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({ question_id: i + 1, answer: 'no' })),
      ), JSON.stringify(currentHealth), JSON.stringify(pastHistory), status, ORG],
    );

  const addNutrition = (clientId, fields = {}) => {
    const columns = ['client_id', 'organization_id'];
    const values = [clientId, ORG];
    for (const [column, value] of Object.entries(fields)) {
      columns.push(column);
      values.push(value);
    }
    return pool.query(
      `INSERT INTO pt_nutrition_assessments (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
  };

  const addCheckin = (clientId, weight) =>
    pool.query(
      `INSERT INTO weekly_checkins (client_id, week_start_date, weight, organization_id)
       VALUES ($1, '2026-10-19', $2, $3)`,
      [clientId, weight, ORG],
    );

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug)
      VALUES ($1, 'Phase 2 Ownership', 'phase2-ownership') ON CONFLICT (id) DO NOTHING`, [ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'Phase 2 Ownership', 'phase2@test.invalid', '!x', 'trainer', $2, TRUE)
      ON CONFLICT (id) DO NOTHING`, [USER, ORG]);

    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use('/api/diet', require('../routes/diet'));
    app.use('/api/ai', require('../routes/ai'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    request = () => require('supertest')(app);

    ai = require('../routes/ai');
    readService = require('../modules/pt-os/client-read.service');
  });

  beforeEach(() => {
    logger.warn.mockClear();
    logger.info.mockClear();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM pt_os_measurements WHERE client_id = ANY($1)', [clients]);
    await pool.query('DELETE FROM weekly_checkins WHERE client_id = ANY($1)', [clients]);
    await pool.query('DELETE FROM client_fitness_profiles WHERE client_id = ANY($1)', [clients]);
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

  // ─── The last second writer ───────────────────────────────────────────────
  describe('PUT /api/diet/fitness-profile is retired', () => {
    test('refuses every supplied field, names its owner, and changes no row', async () => {
      const clientId = await newClient('Second Writer');
      await addProfile(clientId, {
        goal: 'muscle_gain', height_cm: 160, body_fat_pct: 20,
        health_conditions: ['Asthma'], injuries: 'old knee',
        emergency_contact: 'Old Contact', emergency_phone: '9876543210',
        fitness_level: 'intermediate', sleep_hours: 7, stress_level: 'low',
        diet_preference: 'vegetarian',
      });

      const r = await request().put(`/api/diet/fitness-profile/${clientId}`).send({
        goal: 'weight_loss', height_cm: 175, body_fat_pct: 12,
        health_conditions: ['None'], sleep_hours: 9,
      });

      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('FIELD_MOVED');
      const owners = Object.fromEntries(r.body.error.fields.map((f) => [f.field, f.owner]));
      expect(owners).toEqual({
        goal: 'Goal', height_cm: 'Fitness Testing', body_fat_pct: 'Fitness Testing',
        health_conditions: 'PAR-Q', sleep_hours: 'Lifestyle',
      });
      expect(movedWarnings().some(([p]) => p.client_id === clientId)).toBe(true);

      const { rows: [row] } = await pool.query(
        'SELECT * FROM client_fitness_profiles WHERE client_id = $1', [clientId]);
      expect(row.goal).toBe('muscle_gain');
      expect(Number(row.height_cm)).toBe(160);
      expect(Number(row.body_fat_pct)).toBe(20);
      expect(row.health_conditions).toEqual(['Asthma']);
      expect(Number(row.sleep_hours)).toBe(7);
    });

    test('an empty or null-only body cannot blank a legacy row', async () => {
      const clientId = await newClient('Second Writer Empty');
      await addProfile(clientId, { goal: 'endurance', height_cm: 161, diet_preference: 'vegan' });

      for (const body of [{}, { goal: null, height_cm: null, diet_preference: null }]) {
        const r = await request().put(`/api/diet/fitness-profile/${clientId}`).send(body);
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('FIELD_MOVED');
        expect(r.body.error.fields.map((f) => f.field).sort())
          .toEqual(Object.keys({
            goal: 1, goal_other: 1, height_cm: 1, body_fat_pct: 1, health_conditions: 1,
            injuries: 1, emergency_contact: 1, emergency_phone: 1, fitness_level: 1,
            sleep_hours: 1, stress_level: 1, diet_preference: 1,
          }).sort());
      }

      const { rows: [row] } = await pool.query(
        'SELECT goal, height_cm, diet_preference FROM client_fitness_profiles WHERE client_id = $1',
        [clientId]);
      expect(row).toEqual({ goal: 'endurance', height_cm: '161.0', diet_preference: 'vegan' });
    });

    test('the legacy row stays readable and the read is logged', async () => {
      const clientId = await newClient('Second Writer Read');
      await addProfile(clientId, { goal: 'endurance', height_cm: 159 });

      const r = await request().get(`/api/diet/fitness-profile/${clientId}`);
      expect(r.status).toBe(200);
      expect(r.body.goal).toBe('endurance');
      expect(Number(r.body.height_cm)).toBe(159);
      expect(movedReads().some(([p]) => (
        p.client_id === clientId && p.source === 'client_fitness_profiles'
      ))).toBe(true);
    });
  });

  // ─── Canonical-first facts ────────────────────────────────────────────────
  describe('the workout generator reads the owner before the legacy copy', () => {
    test('height: latest assessment, then the client cache, then the profile', async () => {
      const clientId = await newClient('Height Canonical', { height: 170 });
      await addProfile(clientId, { height_cm: 160 });
      await addAssessment(clientId, { on: '2026-01-01', weight: 80, height: 175 });

      logger.info.mockClear();
      let ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      let { facts } = ai.resolveClientFacts(ctx);
      expect(facts.height_cm).toMatchObject({ value: 175, source: 'pt_assessments.height_cm' });
      expect(legacyRead('height_cm', clientId)).toBe(false);

      await pool.query('DELETE FROM pt_assessments WHERE client_id = $1', [clientId]);
      logger.info.mockClear();
      ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      ({ facts } = ai.resolveClientFacts(ctx));
      expect(facts.height_cm).toMatchObject({ value: 170, source: 'pt_clients.height' });
      expect(legacyRead('height_cm', clientId)).toBe(false);

      await pool.query('UPDATE pt_clients SET height = NULL WHERE id = $1', [clientId]);
      logger.info.mockClear();
      ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      ({ facts } = ai.resolveClientFacts(ctx));
      expect(facts.height_cm).toMatchObject({ value: 160, source: 'client_fitness_profiles.height_cm' });
      expect(legacyRead('height_cm', clientId)).toBe(true);
    });

    test('goal: active Goal row, then the profile, then the enrolment column', async () => {
      const clientId = await newClient('Goal Canonical', { goal: 'general_fitness' });
      await addProfile(clientId, { goal: 'endurance' });
      await addGoal(clientId, 'muscle_gain');

      logger.info.mockClear();
      let ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      let { facts } = ai.resolveClientFacts(ctx);
      expect(facts.goal).toMatchObject({ value: 'hypertrophy', source: 'pt_goals.goal_type' });
      expect(legacyRead('goal', clientId)).toBe(false);

      await pool.query('DELETE FROM pt_goals WHERE client_id = $1', [clientId]);
      logger.info.mockClear();
      ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      ({ facts } = ai.resolveClientFacts(ctx));
      expect(facts.goal).toMatchObject({ value: 'endurance', source: 'client_fitness_profiles.goal' });
      expect(legacyRead('goal', clientId)).toBe(true);

      await pool.query('DELETE FROM client_fitness_profiles WHERE client_id = $1', [clientId]);
      logger.info.mockClear();
      ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      ({ facts } = ai.resolveClientFacts(ctx));
      expect(facts.goal).toMatchObject({ value: 'general_fitness', source: 'pt_clients.goal' });
      expect(legacyRead('goal', clientId)).toBe(true);
    });

    test('weekly check-in weight is the last fallback and is logged', async () => {
      const clientId = await newClient('Weight Fallback');
      await addCheckin(clientId, 72.5);

      logger.info.mockClear();
      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const { facts } = ai.resolveClientFacts(ctx);
      expect(facts.weight_kg).toMatchObject({ value: 72.5, source: 'weekly_checkins.weight' });
      expect(legacyRead('weight_kg', clientId)).toBe(true);
    });

    test('the client row beats the retired profile for injuries and conditions', async () => {
      const clientId = await newClient('Injury Canonical', {
        injuries: 'client note', health_conditions: 'client condition',
      });
      await addProfile(clientId, { injuries: 'profile note', health_conditions: ['profile condition'] });

      logger.info.mockClear();
      let ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      let extras = ai.resolveWorkoutExtras(ctx, {});
      expect(extras.injuries).toBe('client note');
      expect(extras.health_conditions).toBe('client condition');
      expect(legacyRead('injuries', clientId)).toBe(false);

      await pool.query('UPDATE pt_clients SET injuries = NULL, health_conditions = NULL WHERE id = $1', [clientId]);
      logger.info.mockClear();
      ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      extras = ai.resolveWorkoutExtras(ctx, {});
      expect(extras.injuries).toBe('profile note');
      expect(extras.health_conditions).toBe('profile condition');
      expect(legacyRead('injuries', clientId)).toBe(true);
      expect(legacyRead('health_conditions', clientId)).toBe(true);
    });
  });

  // ─── Diet inputs agree with the owners ────────────────────────────────────
  describe('diet inputs read Goal, Fitness Testing and PAR-Q', () => {
    test('the owners win over the profile and the nutrition copy', async () => {
      const clientId = await newClient('Diet Canonical', { height: 170, goal: 'weight_loss' });
      await addProfile(clientId, {
        goal: 'endurance', height_cm: 160, diet_preference: 'vegan',
        health_conditions: ['profile condition'],
      });
      await addAssessment(clientId, { on: '2026-02-01', weight: 82, height: 175 });
      await addGoal(clientId, 'muscle_gain');
      await addParq(clientId, {
        currentHealth: { known_disease: true },
        pastHistory: { heart_disease: false },
      });
      await addNutrition(clientId, {
        diet_preferences: ['vegetarian'], medical_conditions: ['Asthma'], meals_per_day: 4,
      });

      logger.info.mockClear();
      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const inputs = ai.resolveDietInputs(ctx, {});

      expect(inputs.goal).toBe('muscle_gain');
      expect(Number(inputs.height_cm)).toBe(175);
      expect(Number(inputs.weight_kg)).toBe(82);
      expect(inputs.medical_conditions).toBe('Known disease');
      expect(legacyRead('goal', clientId)).toBe(false);
      expect(legacyRead('height_cm', clientId)).toBe(false);
      expect(legacyRead('medical_conditions', clientId)).toBe(false);
    });

    test('a legacy nutrition list is read only when no submitted PAR-Q answers', async () => {
      const clientId = await newClient('Diet Legacy');
      await addNutrition(clientId, { medical_conditions: ['Asthma'], meals_per_day: 3 });

      logger.info.mockClear();
      let ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      let inputs = ai.resolveDietInputs(ctx, {});
      expect(inputs.medical_conditions).toBe('Asthma');
      expect(legacyRead('medical_conditions', clientId)).toBe(true);

      await addParq(clientId);
      logger.info.mockClear();
      ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      inputs = ai.resolveDietInputs(ctx, {});
      expect(inputs.medical_conditions).toBeNull();
      expect(legacyRead('medical_conditions', clientId)).toBe(false);
    });

    test('a profile-only diet preference is a logged fallback', async () => {
      const clientId = await newClient('Diet Preference Legacy');
      await addProfile(clientId, { diet_preference: 'vegan' });

      logger.info.mockClear();
      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const inputs = ai.resolveDietInputs(ctx, {});
      expect(inputs.dietary_preferences).toBe('vegan');
      expect(legacyRead('diet_preference', clientId)).toBe(true);
    });

    test('a draft PAR-Q answers nothing, so the legacy list still fills the gap', async () => {
      const clientId = await newClient('Diet Draft PARQ');
      await addNutrition(clientId, { medical_conditions: ['Asthma'] });
      await addParq(clientId, { status: 'draft' });

      logger.info.mockClear();
      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const inputs = ai.resolveDietInputs(ctx, {});
      expect(inputs.medical_conditions).toBe('Asthma');
      expect(legacyRead('medical_conditions', clientId)).toBe(true);
    });
  });

  // ─── Agreement with the PT-OS snapshot ────────────────────────────────────
  describe('the AI and the PT-OS snapshot read the same body', () => {
    test('the newest assessment weight is what both report', async () => {
      const clientId = await newClient('Snapshot Agreement');
      await addGoal(clientId, 'fat_loss');
      await addAssessment(clientId, { on: '2026-02-01', weight: 82 });
      await pool.query(
        `INSERT INTO pt_os_measurements (client_id, weight_kg, measured_at)
         VALUES ($1, 70, '2026-01-01T09:00:00Z')`,
        [clientId],
      );

      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const inputs = ai.resolveDietInputs(ctx, {});
      const snapshot = await readService.getClientSnapshot(ORG, clientId);

      expect(Number(inputs.weight_kg)).toBe(82);
      expect(snapshot.goal.current_kg).toBe(82);
    });
  });
});

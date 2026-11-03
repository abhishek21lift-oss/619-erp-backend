'use strict';
// Phase 3 — canonical client facts across every AI consumer.
//
// Real database, real shared loader, real resolvers and the real brief /
// snapshot builders. The point of the suite is agreement: the generator, the
// digital twin, the training brief and the profile snapshot must read the same
// body on the same day, including when a row was entered late and when the
// only record is too old to trust.

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('AI client context Phase 3, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the Phase 3 context proof would skip.');
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

const { randomUUID } = require('crypto');
const { describeFacts } = require('../modules/pt-os/client-facts');

jest.setTimeout(30000);

const ORG = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
const OTHER_ORG = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
const USER = 'phase3-owner-trainer';

describeIf('AI client context Phase 3, against a real database', () => {
  let pool;
  let ai;
  let readService;
  let loadDigitalTwin;

  const clients = [];

  const newClient = async (name, fields = {}) => {
    const id = randomUUID();
    const columns = ['id', 'name', 'mobile', 'organization_id'];
    const values = [id, name, `93${String(Date.now() + clients.length).slice(-8)}`, ORG];
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

  const addAssessment = (clientId, { on, weight = null, height = null, createdAt = null }) =>
    pool.query(
      `INSERT INTO pt_assessments
         (client_id, assessment_date, assessment_type, weight, height_cm, organization_id, created_at)
       VALUES ($1, $2, 'follow_up', $3, $4, $5, COALESCE($6::timestamptz, NOW()))`,
      [clientId, on, weight, height, ORG, createdAt],
    );

  const addCheckin = (clientId, { weekStart, weight, createdAt = null }) =>
    pool.query(
      `INSERT INTO weekly_checkins (client_id, week_start_date, weight, organization_id, created_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))`,
      [clientId, weekStart, weight, ORG, createdAt],
    );

  const addGoal = (clientId, goalType, createdAt = null) =>
    pool.query(
      `INSERT INTO pt_goals (client_id, goal_type, is_active, organization_id, created_at)
       VALUES ($1, $2, TRUE, $3, COALESCE($4::timestamptz, NOW()))`,
      [clientId, goalType, ORG, createdAt],
    );

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

  beforeAll(async () => {
    pool = require('../db/pool');
    await pool.query(`INSERT INTO organizations (id, name, slug)
      VALUES ($1, 'Phase 3 Context', 'phase3-context'), ($2, 'Phase 3 Other', 'phase3-context-other')
      ON CONFLICT (id) DO NOTHING`, [ORG, OTHER_ORG]);
    await pool.query(`INSERT INTO users (id, name, email, password, role, organization_id, is_active)
      VALUES ($1, 'Phase 3 Context', 'phase3@test.invalid', '!x', 'trainer', $2, TRUE)
      ON CONFLICT (id) DO NOTHING`, [USER, ORG]);

    ai = require('../routes/ai');
    readService = require('../modules/pt-os/client-read.service');
    ({ loadDigitalTwin } = require('../modules/pt-os/client-context'));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM pt_os_measurements WHERE client_id = ANY($1)', [clients]);
    await pool.query('DELETE FROM weekly_checkins WHERE client_id = ANY($1)', [clients]);
    await pool.query('DELETE FROM client_fitness_profiles WHERE client_id = ANY($1)', [clients]);
    for (const table of ['pt_goals', 'pt_assessments']) {
      await pool.query(`DELETE FROM ${table} WHERE client_id = ANY($1)`, [clients]);
    }
    await pool.query('DELETE FROM activity_log WHERE user_id = $1', [USER]);
    await pool.query('DELETE FROM pt_clients WHERE id = ANY($1)', [clients]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG, OTHER_ORG]]);
    await pool.end();
  });

  describe('canonical "latest" is the content date, not the typing date', () => {
    test('an assessment entered late about an older test does not become the latest', async () => {
      const clientId = await newClient('Phase 3 Backdated', { goal: 'fat_loss' });
      // Entered in August, about a June test — under the old
      // `ORDER BY created_at DESC` this row won every AI surface.
      await addAssessment(clientId, {
        on: '2026-06-01', weight: 80, height: 170, createdAt: '2026-08-01T10:00:00Z',
      });
      // The genuinely newer test, entered the day after it was taken.
      await addAssessment(clientId, {
        on: '2026-07-15', weight: 76, height: 171, createdAt: '2026-07-16T10:00:00Z',
      });
      await addGoal(clientId, 'fat_loss');

      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const { facts, data_quality: quality } = ai.resolveClientFacts(ctx);

      expect(facts.weight_kg).toMatchObject({
        value: 76,
        source: 'pt_assessments.weight',
        at: '2026-07-15',
      });
      expect(facts.height_cm).toMatchObject({
        value: 171,
        source: 'pt_assessments.height_cm',
        at: '2026-07-15',
      });
      expect(facts.weight_kg.stale).toBeUndefined();
      expect(quality.recorded).toContainEqual({
        field: 'weight_kg', source: 'pt_assessments.weight', at: '2026-07-15',
      });

      // Provenance reaches the prompt, so the model can see how old the fact is.
      const prompt = describeFacts(facts);
      expect(prompt).toMatch(/- Weight \(kg\): 76 \[recorded 2026-07-15, \d+ days ago\]/);
    });

    test('the same content date is broken by insertion time, newest first', async () => {
      const clientId = await newClient('Phase 3 Tie Break');
      await addAssessment(clientId, {
        on: '2026-07-01', weight: 70, createdAt: '2026-07-02T09:00:00Z',
      });
      await addAssessment(clientId, {
        on: '2026-07-01', weight: 72, createdAt: '2026-07-03T09:00:00Z',
      });

      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      expect(Number(ctx.latestAssessment.weight)).toBe(72);
      const { facts } = ai.resolveClientFacts(ctx);
      expect(facts.weight_kg.value).toBe(72);
    });

    test('a check-in entered late about an older week does not out-rank the newer week', async () => {
      const clientId = await newClient('Phase 3 Backdated Checkin');
      await addCheckin(clientId, {
        weekStart: '2026-06-01', weight: 73, createdAt: '2026-08-01T10:00:00Z',
      });
      await addCheckin(clientId, {
        weekStart: '2026-07-20', weight: 71, createdAt: '2026-07-21T10:00:00Z',
      });

      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      expect(ctx.latestCheckin.week_start_date.toISOString().slice(0, 10)).toBe('2026-07-20');
      expect(Number(ctx.latestCheckin.weight)).toBe(71);
      const { facts } = ai.resolveClientFacts(ctx);
      expect(facts.weight_kg).toMatchObject({
        value: 71,
        source: 'weekly_checkins.weight',
        at: '2026-07-20',
      });
    });
  });

  describe('every consumer reads the same body', () => {
    test('generator, twin, training brief and snapshot agree on the canonical weight', async () => {
      const clientId = await newClient('Phase 3 Agreement', { goal: 'fat_loss' });
      await addAssessment(clientId, {
        on: '2026-06-01', weight: 80, createdAt: '2026-08-01T10:00:00Z',
      });
      await addAssessment(clientId, {
        on: '2026-07-15', weight: 76, createdAt: '2026-07-16T10:00:00Z',
      });
      await addGoal(clientId, 'fat_loss');

      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const generator = ai.resolveDietInputs(ctx, {});
      expect(Number(generator.weight_kg)).toBe(76);

      const twin = await loadDigitalTwin(clientId, ORG);
      expect(twin.brief.sections.body).toMatchObject({
        present: true, weight_kg: 76, as_of: '2026-07-15',
      });

      const brief = await readService.getClientTrainingBrief(ORG, clientId);
      expect(brief.sections.body).toMatchObject({
        present: true, weight_kg: 76, as_of: '2026-07-15',
      });

      const snapshot = await readService.getClientSnapshot(ORG, clientId);
      expect(snapshot.goal).toMatchObject({ present: true, current_kg: 76 });
    });

    test('an outdated assessment is still the latest, but is flagged stale everywhere', async () => {
      const clientId = await newClient('Phase 3 Stale');
      await addAssessment(clientId, { on: '2024-01-01', weight: 90 });

      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const { facts, data_quality: quality } = ai.resolveClientFacts(ctx);

      expect(facts.weight_kg).toMatchObject({
        value: 90, source: 'pt_assessments.weight', at: '2024-01-01', stale: true,
      });
      expect(facts.weight_kg.age_days).toBeGreaterThan(365);
      expect(quality.stale).toContainEqual(expect.objectContaining({
        field: 'weight_kg', source: 'pt_assessments.weight', at: '2024-01-01',
      }));

      const prompt = describeFacts(facts);
      expect(prompt).toContain('STALE; confirm with the client');
      expect(prompt).toContain('STALE means the record is more than a year old');
    });
  });

  describe('missing and conflicting facts stay explicit', () => {
    test('a thin record reports missing facts instead of inventing them', async () => {
      const clientId = await newClient('Phase 3 Missing', {
        dob: '1990-01-01', gender: 'female',
      });

      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const { facts, data_quality: quality } = ai.resolveClientFacts(ctx);

      expect(facts.weight_kg).toMatchObject({ value: null, origin: 'missing' });
      expect(facts.height_cm).toMatchObject({ value: null, origin: 'missing' });
      expect(facts.goal).toMatchObject({ value: null, origin: 'missing' });
      expect(quality.blocking).toEqual(['goal', 'experience_level', 'training_days']);
      expect(quality.missing.map((m) => m.field)).toEqual(
        expect.arrayContaining(['weight_kg', 'height_cm', 'goal']),
      );

      const prompt = describeFacts(facts);
      expect(prompt).toContain('- Weight (kg): NOT RECORDED');
      expect(prompt).toContain('- Goal: NOT RECORDED');
      expect(prompt).toContain('Do not infer it');

      const snapshot = await readService.getClientSnapshot(ORG, clientId);
      expect(snapshot.goal).toEqual({ present: false });
      expect(snapshot.alerts.map((a) => a.id)).toContain('never_measured');
    });

    test('two sources that disagree keep the winner and name the loser', async () => {
      const clientId = await newClient('Phase 3 Conflict', {
        goal: 'general_fitness', weight: 88,
      });
      await addProfile(clientId, { goal: 'endurance' });
      await addAssessment(clientId, { on: '2026-07-15', weight: 76 });
      await addCheckin(clientId, { weekStart: '2026-07-20', weight: 73 });
      await addGoal(clientId, 'muscle_gain');

      const ctx = await ai.loadAuthoritativeClient(clientId, ORG);
      const { facts, data_quality: quality } = ai.resolveClientFacts(ctx);

      expect(facts.weight_kg.value).toBe(76);
      expect(facts.weight_kg.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'pt_clients.weight', value: 88 }),
        expect.objectContaining({ source: 'weekly_checkins.weight', value: 73 }),
      ]));
      expect(facts.goal.value).toBe('muscle_gain');
      expect(facts.goal.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'client_fitness_profiles.goal', value: 'endurance' }),
        expect.objectContaining({ source: 'pt_clients.goal', value: 'general_fitness' }),
      ]));

      expect(quality.conflicting.map((c) => c.field)).toEqual(
        expect.arrayContaining(['weight_kg', 'goal']),
      );
      expect(describeFacts(facts)).toContain('DISPUTED');
    });
  });

  describe('the tenant boundary is the first query', () => {
    test('an unknown client and a client in another org resolve to nothing', async () => {
      const unknown = randomUUID();
      expect(await ai.loadAuthoritativeClient(unknown, ORG)).toBeNull();
      expect(await loadDigitalTwin(unknown, ORG)).toBeNull();
      expect(await readService.getClientSnapshot(ORG, unknown)).toBeNull();
      expect(await readService.getClientTrainingBrief(ORG, unknown)).toBeNull();

      const clientId = await newClient('Phase 3 Tenant');
      expect(await ai.loadAuthoritativeClient(clientId, OTHER_ORG)).toBeNull();
      expect(await loadDigitalTwin(clientId, OTHER_ORG)).toBeNull();
      expect(await readService.getClientSnapshot(OTHER_ORG, clientId)).toBeNull();
      expect(await readService.getClientTrainingBrief(OTHER_ORG, clientId)).toBeNull();
    });
  });
});

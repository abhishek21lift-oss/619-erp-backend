process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

jest.mock('../db/pool', () => {
  const query = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release: () => {} })) };
});

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

const app = express();
app.use(express.json());
app.use('/api/pt-os', require('../modules/pt-os/workout-generator.routes'));

const ORG_A = '11111111-1111-1111-1111-111111111111';
const CLIENT = 'client-1';
const TRAINER = { id: 'u-1', role: 'trainer', organization_id: ORG_A };

const sqls = () => pool.query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' '));

beforeEach(() => {
  mockUser = TRAINER;
  pool.query.mockReset();
});

function clientRow(over = {}) {
  return { id: CLIENT, name: 'Asha', goal: 'muscle_gain', workout_experience_level: 'intermediate', injuries: null, organization_id: ORG_A, ...over };
}
function poolRows() {
  return [
    { id: 'squat', name: 'Back Squat', mechanic: 'compound', movementPattern: 'Squat', primaryMuscle: 'Quadriceps', equipment: 'Barbell', category: 'Strength', difficulty: 'intermediate' },
    { id: 'bench', name: 'Bench Press', mechanic: 'compound', movementPattern: 'Horizontal Push', primaryMuscle: 'Chest', equipment: 'Barbell', category: 'Strength', difficulty: 'intermediate' },
  ];
}

/**
 * The four reads the route makes before the exercise pool: the client, then
 * the three records the shared fact resolver also consults.
 */
function queueSources({ client = clientRow(), profile = null, goals = [], lifestyle = null } = {}) {
  pool.query.mockResolvedValueOnce({ rows: client ? [client] : [] });
  pool.query.mockResolvedValueOnce({ rows: profile ? [profile] : [] });
  pool.query.mockResolvedValueOnce({ rows: goals });
  pool.query.mockResolvedValueOnce({ rows: lifestyle ? [lifestyle] : [] });
}

test('scopes the client lookup to the caller\'s organization', async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({});
  expect(res.status).toBe(404);
  const clientQuery = sqls().find((s) => /FROM pt_clients/.test(s));
  expect(clientQuery).toMatch(/c\.organization_id = \$\d/);
  expect(pool.query.mock.calls[0][1]).toEqual([CLIENT, ORG_A]);
});

test('returns a complete draft with reasons and validation', async () => {
  queueSources();
  pool.query.mockResolvedValueOnce({ rows: poolRows() });
  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({});
  expect(res.status).toBe(200);
  const { draft, validation } = res.body.data;
  expect(draft.goal).toBe('hypertrophy'); // muscle_gain maps
  expect(draft.experience).toBe('intermediate');
  expect(draft.warmup.length).toBeGreaterThan(0);
  expect(draft.mainWork.length).toBeGreaterThan(0);
  expect(draft.mainWork.every((e) => e.prescription && e.reason)).toBe(true);
  expect(draft.explanations.length).toBe(draft.mainWork.length);
  expect(validation.ok).toBe(true);
});

test('restrictions exclude exercises and say why', async () => {
  queueSources();
  pool.query.mockResolvedValueOnce({ rows: poolRows() });
  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({ avoidPatterns: ['Squat'] });
  expect(res.status).toBe(200);
  expect(res.body.data.draft.mainWork.map((e) => e.id)).not.toContain('squat');
  expect(res.body.data.draft.excluded.some((e) => /Squat/.test(e.reason))).toBe(true);
});

test('rejects an unknown goal with a validation error', async () => {
  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({ goal: 'get-swole' });
  expect(res.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test('only reads live library rows for the caller\'s org', async () => {
  queueSources();
  pool.query.mockResolvedValueOnce({ rows: poolRows() });
  await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({});
  const libQuery = sqls().find((s) => /FROM exercises e/.test(s));
  expect(libQuery).toMatch(/deleted_at IS NULL/);
  expect(libQuery).toMatch(/archived_at IS NULL/);
  expect(libQuery).toMatch(/e\.organization_id IS NULL OR e\.organization_id = \$1/);
});

test('passes structured cardio inputs through and returns a heart-rate target', async () => {
  queueSources();
  pool.query.mockResolvedValueOnce({ rows: poolRows() });
  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({
    includeCardio: true,
    cardioMinutes: 30,
    modality: 'Running',
    cardioIntensity: 'high',
    cardioMethod: 'karvonen',
    cardioFrequencyPerWeek: 4,
    cardioProgramType: 'hiit',
    age: 40,
    restingHeartRate: 60,
  });
  expect(res.status).toBe(200);
  expect(res.body.data.draft.conditioning.fitt).toMatchObject({
    frequencyPerWeek: 4,
    programType: 'hiit',
    modalityCategory: 'weight-bearing-high-impact',
  });
  expect(res.body.data.draft.conditioning.targetHeartRate).toEqual({
    method: 'karvonen',
    minBpm: 144,
    maxBpm: 162,
    basisLabel: '% HRR',
  });
});

test('rejects invalid cardio inputs at the request boundary', async () => {
  const badBodies = [
    { age: 40.5 },
    { age: 121 },
    { restingHeartRate: 0 },
    { measuredMaxHeartRate: -1 },
    { cardioFrequencyPerWeek: 15 },
    { cardioFrequencyPerWeek: 3.5 },
    { cardioIntensity: 'max' },
    { cardioMethod: 'estimated' },
    { cardioProgramType: 'sprint' },
  ];
  for (const body of badBodies) {
    const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send(body);
    expect(res.status).toBe(400);
  }
  expect(pool.query).not.toHaveBeenCalled();
});

// ── The same facts the AI generator reads ──────────────────────────────────
//
// This route used to read pt_clients.goal and pt_clients.workout_experience_level
// and, when either was blank, quietly generate for general_fitness/beginner.
// The AI generator had already been taught that the ACTIVE pt_goals row is the
// goal a trainer maintains and that a blank fact is MISSING, not a default.
// Two doors, two answers for the same client. These pin the rules door to the
// same resolver — and to refusing rather than inventing.
test('reads the active goal and profile level the AI generator reads', async () => {
  queueSources({
    client: clientRow({ goal: null, workout_experience_level: null }),
    profile: { goal: 'muscle_gain', fitness_level: 'advanced' },
    goals: [{ goal_type: 'strength' }],
  });
  pool.query.mockResolvedValueOnce({ rows: poolRows() });

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({});
  expect(res.status).toBe(200);
  expect(res.body.data.draft.goal).toBe('strength');
  expect(res.body.data.draft.experience).toBe('advanced');
  const goalQuery = sqls().find((s) => /FROM pt_goals/.test(s));
  expect(goalQuery).toMatch(/is_active = true/);
});

test('refuses rather than inventing a goal or experience level', async () => {
  queueSources({ client: clientRow({ goal: null, workout_experience_level: null }) });

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({});
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('MISSING_CLIENT_DATA');
  expect(res.body.error.missing).toEqual(['goal', 'experience_level']);
  // The refusal comes before the exercise pool is read: no work for a session
  // that cannot be written.
  expect(sqls().some((s) => /FROM exercises e/.test(s))).toBe(false);
});

test('an explicit request still overrides the record', async () => {
  queueSources();
  pool.query.mockResolvedValueOnce({ rows: poolRows() });

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`)
    .send({ goal: 'fat_loss', experience: 'advanced' });
  expect(res.status).toBe(200);
  expect(res.body.data.draft.goal).toBe('fat_loss');
  expect(res.body.data.draft.experience).toBe('advanced');
});

test('a request can supply a fact the record does not hold', async () => {
  queueSources({ client: clientRow({ goal: null, workout_experience_level: null }) });
  pool.query.mockResolvedValueOnce({ rows: poolRows() });

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`)
    .send({ goal: 'strength', experience: 'beginner' });
  expect(res.status).toBe(200);
  expect(res.body.data.draft.goal).toBe('strength');
  expect(res.body.data.draft.experience).toBe('beginner');
});

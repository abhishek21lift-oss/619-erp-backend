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
 * The reads the route makes before the exercise pool: the client, the three
 * records the shared fact resolver also consults, then the two screening
 * reads (latest PAR-Q and latest consent). Empty rows mean "nothing on file",
 * which is not a hard stop.
 */
function queueSources({
  client = clientRow(), profile = null, goals = [], lifestyle = null,
  parq = null, consent = null,
} = {}) {
  pool.query.mockResolvedValueOnce({ rows: client ? [client] : [] });
  pool.query.mockResolvedValueOnce({ rows: profile ? [profile] : [] });
  pool.query.mockResolvedValueOnce({ rows: goals });
  pool.query.mockResolvedValueOnce({ rows: lifestyle ? [lifestyle] : [] });
  pool.query.mockResolvedValueOnce({ rows: parq ? [parq] : [] });
  pool.query.mockResolvedValueOnce({ rows: consent ? [consent] : [] });
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

// ── The week the client actually trains ────────────────────────────────────
//
// The draft used to be one session and the save path wrote sessions_per_week:
// 1 for every programme. The record now supplies the frequency and the
// weekdays, and a request may plan a different block on purpose.
test('builds one session per recorded training day, on the recorded weekdays', async () => {
  queueSources({
    client: clientRow({
      sessions_per_week: 3,
      preferred_training_days: 'Mon, Wed, Fri',
    }),
  });
  pool.query.mockResolvedValueOnce({ rows: poolRows() });

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({});
  expect(res.status).toBe(200);
  const { draft } = res.body.data;
  expect(draft.daysPerWeek).toBe(3);
  expect(draft.sessions).toHaveLength(3);
  expect(draft.sessions.map((s) => s.day_of_week)).toEqual([1, 3, 5]);
  expect(draft.sessions.map((s) => s.day_name)).toEqual(['Monday', 'Wednesday', 'Friday']);
  // The first session is still the top-level draft, for old callers.
  expect(draft.mainWork).toEqual(draft.sessions[0].mainWork);
});

test('fits the session inside the recorded slot instead of prescribing past it', async () => {
  queueSources({
    client: clientRow({ sessions_per_week: 1, session_minutes: 30 }),
  });
  pool.query.mockResolvedValueOnce({ rows: poolRows() });

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({});
  expect(res.status).toBe(200);
  const { draft } = res.body.data;
  expect(draft.sessionMinutes).toBe(30);
  expect(draft.sessions[0].estimated_minutes).toBeLessThanOrEqual(30);
  // 30 minutes leaves no room for the goal's default 10-minute conditioning.
  expect(draft.sessions[0].conditioning).toBeNull();
});

test('refuses to draft for a client whose screening is a hard stop', async () => {
  queueSources({ consent: { status: 'revoked', physician_block: false } });

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({});
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('NOT_CLEARED');
  // No pool read for a session that cannot be trained.
  expect(sqls().some((s) => /FROM exercises e/.test(s))).toBe(false);
});

// ── Powerlifting blocks ────────────────────────────────────────────────────
//
// A block is not a week with a label: the preview returns every week, each
// main lift is a percentage of the trainer's max, and the phases run in
// order. These pin the route wiring — the arithmetic itself is tested in
// powerlifting.test.js.
test('returns a whole powerlifting block, loaded from the training maxes', async () => {
  queueSources({ client: clientRow({ goal: 'powerlifting' }) });
  pool.query.mockResolvedValueOnce({ rows: poolRows() });
  pool.query.mockResolvedValueOnce({ rows: [{ exercise_id: 'squat', training_max_kg: '200' }] });

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({
    periodization: 'powerlifting_block',
    blockWeeks: 12,
    daysPerWeek: 2,
  });
  expect(res.status).toBe(200);
  const { draft, validation } = res.body.data;
  expect(draft.periodization.model).toBe('powerlifting_block');
  expect(draft.periodization.block_weeks).toBe(12);
  expect(draft.periodization.weeks).toHaveLength(12);
  expect(draft.periodization.phases.map((p) => p.phase))
    .toEqual(['base', 'strength', 'intensification', 'peaking', 'taper']);
  // Week one is still the top-level draft, for callers that read one week.
  expect(draft.sessions).toEqual(draft.periodization.weeks[0].sessions);

  const squatWeek1 = draft.sessions[0].mainWork.find((e) => e.id === 'squat');
  expect(squatWeek1.prescription.target_weight).toBe(130); // 65% of 200
  expect(squatWeek1.prescription.basis).toBe('training_max');

  // The lift with no max is prescribed by RPE and named in the warnings.
  const benchWeek1 = draft.sessions[0].mainWork.find((e) => e.id === 'bench');
  expect(benchWeek1.prescription.target_weight).toBeNull();
  expect(benchWeek1.prescription.basis).toBe('rpe');
  expect(draft.periodization.missing_training_maxes.map((m) => m.exercise_id)).toContain('bench');
  expect(draft.warnings.join(' ')).toMatch(/No training max recorded/);
  expect(validation.ok).toBe(true);
});

test('falls back to a generic week when the pool has no competition lift', async () => {
  queueSources({ client: clientRow({ goal: 'powerlifting' }) });
  pool.query.mockResolvedValueOnce({
    rows: [{ id: 'legpress', name: 'Leg Press', mechanic: 'compound', movementPattern: 'Squat', primaryMuscle: 'Quadriceps', equipment: 'Machine', category: 'Strength', difficulty: 'intermediate' }],
  });
  pool.query.mockResolvedValueOnce({ rows: [] }); // training maxes

  const res = await request(app).post(`/api/pt-os/clients/${CLIENT}/workout-generator/preview`).send({
    periodization: 'powerlifting_block',
    blockWeeks: 12,
  });
  expect(res.status).toBe(200);
  expect(res.body.data.draft.periodization).toBeUndefined();
  expect(res.body.data.draft.mainWork.length).toBeGreaterThan(0);
});

// ── Training maxes ─────────────────────────────────────────────────────────
test('lists training maxes with an e1RM suggestion that is never applied', async () => {
  pool.query.mockResolvedValueOnce({ rows: [clientRow()] });       // client
  pool.query.mockResolvedValueOnce({ rows: [{ exercise_id: 'squat', training_max_kg: '150', source: 'manual' }] });
  pool.query.mockResolvedValueOnce({ rows: poolRows() });          // library pool
  pool.query.mockResolvedValueOnce({
    rows: [{ exercise_id: 'squat', weight_kg: '150', reps: 5, rpe: '8', session_date: '2026-10-01' }],
  });

  const res = await request(app).get(`/api/pt-os/clients/${CLIENT}/training-maxes`);
  expect(res.status).toBe(200);
  const { lifts } = res.body.data;
  const squat = lifts.find((l) => l.exercise_id === 'squat');
  expect(squat.training_max_kg).toBe(150);
  expect(squat.best_e1rm_kg).toBe(175); // 150 × (1 + 5/30)
  expect(squat.suggestion.applied).toBe(false);
  expect(squat.suggestion.suggested_kg).toBe(157.5); // 90% of e1RM, rounded

  // A competition lift with no max still gets a suggestion from the sets.
  const bench = lifts.find((l) => l.exercise_id === 'bench');
  expect(bench.training_max_kg).toBeNull();
  expect(bench.suggestion.suggested_kg).toBeNull();
});

test('sets a training max for this org only, and upserts rather than duplicates', async () => {
  pool.query.mockResolvedValueOnce({ rows: [clientRow()] });
  pool.query.mockResolvedValueOnce({ rows: [{ id: 'squat', name: 'Back Squat', movementPattern: 'Squat' }] });
  pool.query.mockResolvedValueOnce({
    rows: [{ exercise_id: 'squat', training_max_kg: '200', source: 'manual' }],
  });

  const res = await request(app)
    .put(`/api/pt-os/clients/${CLIENT}/training-maxes/squat`)
    .send({ training_max_kg: 200, source_e1rm_kg: 220 });
  expect(res.status).toBe(200);
  expect(res.body.data.training_max_kg).toBe('200');

  const insert = sqls().find((s) => /INSERT INTO workout_training_maxes/.test(s));
  expect(insert).toMatch(/ON CONFLICT \(client_id, exercise_id\) DO UPDATE/);
  const exerciseQuery = sqls().find((s) => /FROM exercises/.test(s));
  expect(exerciseQuery).toMatch(/organization_id IS NULL OR organization_id = \$2/);
});

test('rejects a training max that is not a load', async () => {
  const res = await request(app)
    .put(`/api/pt-os/clients/${CLIENT}/training-maxes/squat`)
    .send({ training_max_kg: 0 });
  expect(res.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

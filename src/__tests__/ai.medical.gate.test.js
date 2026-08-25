'use strict';
// POST /api/ai/workout/generate — Medical Safety Hard Gate (P0-2).
//
// The AI workout generator must enforce the SAME PAR-Q + Informed Consent
// gate as workout assignment and Workout Log session creation. It calls the
// shared src/lib/screeningGate.js — never a second copy of the rule — so this
// suite proves the ROUTE wiring: it invokes the shared gate after the
// org-scoped client check, answers a medical block as JSON 403 before any SSE
// header, surfaces missing-paperwork warnings on the done event, and fails
// closed (503) when the gate tables themselves cannot be read.
//
// The gate's own semantics (what counts as blocked vs warning) live in
// src/lib/screeningGate.js and are exercised by the workouts routes; they are
// not re-derived here.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  embedBatch: jest.fn().mockResolvedValue([new Array(384).fill(0.1)]),
  toVectorLiteral: jest.fn((v) => `[${v.join(',')}]`),
  EMBEDDING_DIM: 384,
}));

let mockUser = { id: 'u1', role: 'admin', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
}));

jest.mock('../lib/ai/router', () => ({ routedStream: jest.fn(), routedChat: jest.fn() }));
jest.mock('../lib/ai/models', () => ({ models: { primary: 'primary-model' } }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The route must call THIS shared gate — not reimplement the rule.
const { checkScreeningGate } = require('../lib/screeningGate');
jest.mock('../lib/screeningGate', () => ({ checkScreeningGate: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { routedStream } = require('../lib/ai/router');

process.env.OPENROUTER_API_KEY = 'test-key';

const app = express();
app.use(require('../middleware/requestId'));
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const CLIENT = {
  id: 'client-1', name: 'Priya Sharma', gender: 'female', dob: '1992-05-10',
  weight: 65, height: 160, goal: 'weight_loss', injuries: null,
  workout_experience_level: 'beginner', frequency: '4',
  health_conditions: 'None', previous_trainer_experience: false,
};
const ASSESSMENT = { weight: 71.3, body_fat_pct: 24, bmi: 27.8, created_at: '2026-07-01T00:00:00Z' };
const GOAL = { goal_type: 'weight_loss', target_weight: 68, target_body_fat: null, notes: null };
const WORKOUT_PLAN = {
  name: 'Strength Builder', description: '8-week block', goal: 'weight_loss',
  level: 'beginner', weeks: 8, days_per_week: 4, equipment: ['full gym'],
};
const DEFAULT_META = { model: 'primary-model', tier: 'primary', used_fallback: false };

function streamJson(obj, meta = DEFAULT_META) {
  let done = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (done) return Promise.resolve({ done: true, value: meta });
          done = true;
          return Promise.resolve({ done: false, value: JSON.stringify(obj) });
        },
      };
    },
  };
}

function mockQueries() {
  const rowsBySql = {
    'FROM pt_clients WHERE id=$1': [CLIENT],
    'client_fitness_profiles': [],
    'FROM pt_goals WHERE client_id=$1': [GOAL],
    'FROM pt_assessments WHERE client_id=$1': [ASSESSMENT],
    'FROM weekly_checkins WHERE client_id=$1': [],
    'FROM pt_lifestyle_assessments WHERE client_id=$1': [],
    'FROM pt_nutrition_assessments WHERE client_id=$1': [],
    'FROM workout_assignments wa': [],
    'FROM diet_assignments da': [],
    'ai_document_chunks': [],
    'FROM exercises e': [],
  };
  pool.query.mockImplementation((sql) => {
    for (const [needle, rows] of Object.entries(rowsBySql)) {
      if (sql.includes(needle)) return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
}

const donePayloadOf = (text) =>
  JSON.parse(text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"done"')).slice('data: '.length));

const BLOCK = { status: 403, body: { error: 'This client\'s PAR-Q screening flags them as medically blocked — clearance is required before training.', code: 'PARQ_BLOCKED' } };

beforeEach(() => {
  pool.query.mockReset();
  routedStream.mockReset();
  checkScreeningGate.mockReset();
  mockUser = { id: 'u1', role: 'admin', organization_id: 'org-1' };
});

describe('POST /api/ai/workout/generate — Medical Safety Hard Gate (P0-2)', () => {
  test('a medically blocked client is refused with JSON 403 before any SSE or model call', async () => {
    mockQueries();
    checkScreeningGate.mockResolvedValue({ blocked: BLOCK, warnings: [] });
    routedStream.mockReturnValue(streamJson(WORKOUT_PLAN));

    const res = await request(app).post('/api/ai/workout/generate').send({ client_id: 'client-1' });

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: BLOCK.body.error, code: 'PARQ_BLOCKED' });
    // The gate is the shared one, called for this client.
    expect(checkScreeningGate).toHaveBeenCalledTimes(1);
    expect(checkScreeningGate.mock.calls[0][1]).toBe('client-1');
    // No SSE stream, no keep-alives, no model call, no usage log.
    expect(res.text).not.toContain('data:');
    expect(routedStream).not.toHaveBeenCalled();
  });

  test('missing paperwork proceeds but surfaces screening_warnings on the done event', async () => {
    mockQueries();
    checkScreeningGate.mockResolvedValue({
      blocked: null,
      warnings: ['No PAR-Q health screening on file for this client.', 'Informed Consent is not completed for this client.'],
    });
    routedStream.mockReturnValue(streamJson(WORKOUT_PLAN));

    const res = await request(app).post('/api/ai/workout/generate').send({ client_id: 'client-1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(checkScreeningGate).toHaveBeenCalledTimes(1);
    const done = donePayloadOf(res.text);
    expect(done.type).toBe('done');
    expect(done.data.name).toBe('Strength Builder');
    expect(done.screening_warnings).toEqual([
      'No PAR-Q health screening on file for this client.',
      'Informed Consent is not completed for this client.',
    ]);
  });

  test('the gate runs strictly AFTER the org-scoped client check — a foreign client never reaches it', async () => {
    mockQueries();
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM pt_clients WHERE id=$1')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    checkScreeningGate.mockResolvedValue({ blocked: null, warnings: [] });

    const res = await request(app).post('/api/ai/workout/generate').send({ client_id: 'other-org-client' });

    expect(res.status).toBe(404);
    expect(checkScreeningGate).not.toHaveBeenCalled();
    // Only the parent lookup ran — no gate tables, no child data, no model.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(routedStream).not.toHaveBeenCalled();
  });

  test('a gate-table failure fails closed with JSON 503 — generation never proceeds unchecked', async () => {
    mockQueries();
    checkScreeningGate.mockRejectedValue(new Error('relation "pt_parq_forms" does not exist'));
    routedStream.mockReturnValue(streamJson(WORKOUT_PLAN));

    const res = await request(app).post('/api/ai/workout/generate').send({ client_id: 'client-1' });

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(routedStream).not.toHaveBeenCalled();
    expect(res.text).not.toContain('data:');
  });
});

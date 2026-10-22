// The authoritative screening gate, as the workout generator applies it.
//
// ── What these tests close ─────────────────────────────────────────────────
//
// The workout generator used to gate on the stored `workout_gate_status` from
// the digital twin, which:
//   • does NOT exclude PAR-Q drafts (a blank draft could hide a submitted high-risk form);
//   • does NOT re-check clearance expiry at read time (a lapsed clearance kept a client cleared);
//   • does NOT check revoked consent;
//   • does NOT check physician-advised-against without a clearance.
//
// src/lib/screeningGate.checkScreeningGate implements all of those live.
// This test ensures the generator calls it BEFORE any model call and respects
// its blocked/warnings contract, while keeping the existing stored-status gate
// (which refuses explicit non-cleared statuses like pending/referred/refused).
'use strict';

const request = require('supertest');
const express = require('express');

process.env.OPENROUTER_API_KEY = 'test-key';

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  embedBatch: jest.fn().mockResolvedValue([new Array(384).fill(0.1)]),
  toVectorLiteral: jest.fn((v) => `[${v.join(',')}]`),
  EMBEDDING_DIM: 384,
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'trainer', organization_id: 'org-1' }; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../lib/ai/router', () => ({ routedStream: jest.fn(), routedChat: jest.fn() }));
jest.mock('../lib/ai/models', () => ({ models: { primary: 'primary-model' } }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(), getModelStats: jest.fn(),
}));

// Mock the digital twin to return a cleared stored gate so the existing
// gateStatus block (lines 1071-1080) does not interfere with our screening
// gate tests. The screening gate must run FIRST and block before we reach
// that stored-status check.
const MOCK_TWIN = {
  rules: {
    may_program: true,
    gate: { status: 'cleared' },
    coverage: { screened: true, sources_present: true },
    constraints: [],
    library: {
      counts: { blocked: 0 },
      allowed: [],
      caution: [],
      blocked: [],
    },
    deload: { evaluated: false },
  },
  program: { active: false },
  history: { has_history: false },
  brief: { missing: [], stale: [] },
};

jest.mock('../modules/pt-os/client-context', () => ({
  loadDigitalTwin: jest.fn().mockResolvedValue(MOCK_TWIN),
  describeTwin: jest.fn(() => ''),
  limitationsLine: jest.fn(() => ''),
  screenPlanExercises: jest.fn().mockResolvedValue([]),
  MOCK_TWIN,
}));

// Mock the screening gate to control its blocked/warnings return value.
jest.mock('../lib/screeningGate', () => ({
  checkScreeningGate: jest.fn(),
}));

const pool = require('../db/pool');
const { routedStream } = require('../lib/ai/router');
const { checkScreeningGate } = require('../lib/screeningGate');
const { loadDigitalTwin } = require('../modules/pt-os/client-context');

const app = express();
app.use(require('../middleware/requestId'));
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

// Minimal DB rows so loadAuthoritativeClient passes its checks.
const CLIENT = {
  id: 'client-1', name: 'Test Client', gender: 'female', dob: '1992-05-10',
  weight: 65, height: 160, goal: 'muscle_gain', injuries: null,
  workout_experience_level: 'intermediate', frequency: '4',
  health_conditions: null, previous_trainer_experience: false,
};
const ASSESSMENT = { weight: 65, body_fat_pct: 24, bmi: 25, created_at: '2026-07-01T00:00:00Z' };
const GOAL = { goal_type: 'muscle_gain', target_weight: 68 };

const PLAN = {
  name: 'Block', description: 'x', goal: 'muscle_gain', level: 'intermediate',
  weeks: 8, days_per_week: 4, equipment: ['full gym'], warm_up: '', cool_down: '',
  progression_notes: '', weekly_schedule: {}, nutrition_notes: '',
};

function streamOnce(text) {
  const meta = { model: 'primary-model', tier: 'primary', used_fallback: false };
  let sent = false; let done = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (done) return Promise.resolve({ done: true, value: meta });
        if (!sent) { sent = true; return Promise.resolve({ done: false, value: text }); }
        done = true;
        return Promise.resolve({ done: true, value: meta });
      },
    }),
  };
}

function mockDb({ knowledge = null } = {}) {
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => {
    const rows =
      /FROM pt_clients/.test(sql) ? [CLIENT]
        : /FROM pt_goals/.test(sql) ? [GOAL]
          : /FROM pt_assessments/.test(sql) ? [ASSESSMENT]
            : /ai_document_chunks/.test(sql) ? (knowledge ?? [{
                content: 'a 48-hour window between sessions loading the same movement pattern is the floor for intermediate lifters.',
                chunk_index: 0, title: 'MPTS Programming SOP', category: 'methodology',
                document_id: 'doc-mpts-1', similarity: 0.9,
              }])
              : /MAX\(approved_at\)/.test(sql) ? [{ n: 2, last_approved: '2026-10-20T09:30:00.000Z' }]
                : [];
    return Promise.resolve({ rows });
  });
}

const BODY = { client_id: 'client-1', training_days: 4, duration_weeks: 8 };

function doneOf(text) {
  return JSON.parse(
    text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"done"')).slice(6),
  );
}

beforeEach(() => {
  routedStream.mockReset();
  routedStream.mockReturnValue(streamOnce(JSON.stringify(PLAN)));
  loadDigitalTwin.mockClear();
  checkScreeningGate.mockClear();
  loadDigitalTwin.mockResolvedValue(MOCK_TWIN);
});

describe('authoritative screening gate in workout/generate', () => {
  it('blocks a client with PARQ_BLOCKED and never calls the model', async () => {
    mockDb();
    checkScreeningGate.mockResolvedValue({
      blocked: { status: 403, body: { error: 'PAR-Q blocked', code: 'PARQ_BLOCKED' } },
      warnings: [],
    });

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PARQ_BLOCKED');
    expect(routedStream).not.toHaveBeenCalled();
    expect(loadDigitalTwin).toHaveBeenCalled(); // twin still loads for context before gate
    expect(checkScreeningGate).toHaveBeenCalledWith(expect.any(Object), 'client-1');
  });

  it('fails closed when the screening gate cannot be evaluated', async () => {
    mockDb();
    checkScreeningGate.mockRejectedValue(new Error('screening db unavailable'));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCREENING_UNAVAILABLE');
    expect(routedStream).not.toHaveBeenCalled();
  });

  it('allows a client with warnings, reaches the model, and returns screening_warnings', async () => {
    mockDb();
    checkScreeningGate.mockResolvedValue({
      blocked: null,
      warnings: ['Incomplete PAR-Q', 'Informed Consent is not completed for this client.'],
    });

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    expect(res.status).toBe(200);
    expect(routedStream).toHaveBeenCalled();
    const done = doneOf(res.text);
    expect(done.screening_warnings).toEqual([
      'Incomplete PAR-Q',
      'Informed Consent is not completed for this client.',
    ]);
  });

  it('still runs the stored-status gate after screening passes (NOT_CLEARED for referred)', async () => {
    mockDb();
    checkScreeningGate.mockResolvedValue({ blocked: null, warnings: [] });
    // Override the twin to return a referred stored status
    loadDigitalTwin.mockResolvedValueOnce({
      ...MOCK_TWIN,
      rules: { ...MOCK_TWIN.rules, may_program: false, gate: { status: 'referred' } },
    });

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    // The stored-status gate should still catch explicit non-cleared statuses
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_CLEARED');
    expect(res.body.gate).toBe('referred');
    // Model should not be called because stored gate blocks
    expect(routedStream).not.toHaveBeenCalled();
  });
});
'use strict';
// The MPTS grounding gate and the deterministic citation validator, as the
// routes apply them (workout · diet · chat).
//
// Fail-closed acceptance: an insufficient-evidence corpus (empty / outage /
// stale index) refuses the generation outright — 422/503 INSUFFICIENT_EVIDENCE,
// no model call — and a fabricated or out-of-range citation never reaches the
// client: the validator strips it, freezes the report into the done event and
// into the workout ledger. The fallback chain (retry marker → fallback model)
// is covered too: validation runs on the FINAL assembled plan, after the
// provider chain has settled, so no fallback can route around it.

jest.mock('../db/pool', () => ({ query: jest.fn() }));

// retrieveContext embeds its query with @xenova/transformers — never load
// the real 384-dim model in tests.
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
jest.mock('../lib/ai/models', () => ({ models: { primary: 'primary-model' }, resolveModel: () => ({ model: 'primary-model' }) }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(), getModelStats: jest.fn(),
}));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn().mockResolvedValue({ toolNames: [], contextText: '' }) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { routedStream, routedChat } = require('../lib/ai/router');

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
const META = { model: 'primary-model', tier: 'primary', used_fallback: false };

const CORPUS_CHUNK = {
  content: 'Progressive overload adds 2-5% load per week for intermediate clients.',
  chunk_index: 0, title: 'MPTS Programming SOP', category: 'methodology',
  document_id: 'doc-mpts-1', similarity: 0.91,
};
const CORPUS_VERSION_ROW = { n: 3, last_approved: '2026-10-20T09:30:00.000Z' };

const WORKOUT_PLAN = {
  name: 'Strength Builder', description: '8-week progressive block', goal: 'weight_loss',
  level: 'beginner', weeks: 8, days_per_week: 4, equipment: ['full gym'],
  warm_up: '5 min dynamic', cool_down: 'stretch', progression_notes: 'add weight weekly',
  weekly_schedule: { Monday: { name: 'Push', focus: 'Chest', exercises: [] } },
  nutrition_notes: 'protein at 1.6g/kg',
};
const DIET_PLAN = {
  name: 'Lean Fuel', description: 'deficit plan', goal: 'weight_loss',
  total_calories: 1800, macros: { protein_g: 115, carbs_g: 200, fat_g: 50 },
  meal_frequency: 5, meals: [{ name: 'Breakfast', time: '08:00', calories: 500 }],
  grocery_list: [], supplements: [], hydration_ml: 3000, notes: '',
};
const BODY = { client_id: 'client-1', mode: 'new' };

function streamChunks(chunks, meta = META) {
  let i = 0;
  let finished = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (finished) return Promise.resolve({ done: true, value: meta });
          if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
          finished = true;
          return Promise.resolve({ done: true, value: meta });
        },
      };
    },
  };
}

function mockQueries(overrides = {}) {
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
    // The approved corpus: a passage hit by default (the gate refuses an
    // empty corpus, so these happy-path tests must ground), and the
    // corpus-version read answers the approved count.
    'ai_document_chunks': [CORPUS_CHUNK],
    'MAX(approved_at)': [CORPUS_VERSION_ROW],
    'FROM exercises e': [],
    'FROM pt_clients': overrides['FROM pt_clients WHERE id=$1'] ?? [CLIENT],
    'FROM pt_parq_forms': [],
    'FROM pt_posture_assessments': [],
    'FROM pt_mobility_performance_assessments': [],
    'FROM workout_sessions': [],
    'FROM workout_sets s': [],
    ...overrides,
  };
  pool.query.mockImplementation((sql) => {
    for (const [needle, rows] of Object.entries(rowsBySql)) {
      if (sql.includes(needle)) return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
}

const ssePayloads = (text) => text.split('\n')
  .filter((l) => l.startsWith('data: '))
  .map((l) => JSON.parse(l.slice('data: '.length)));
const doneOf = (text) => ssePayloads(text).find((p) => p.type === 'done');

beforeEach(() => {
  pool.query.mockReset();
  routedStream.mockReset();
  routedChat.mockReset();
});

describe('deterministic citation enforcement (workout)', () => {
  test('a fabricated citation is stripped and reported in the done event', async () => {
    mockQueries();
    routedStream.mockReturnValue(streamChunks([
      JSON.stringify({ ...WORKOUT_PLAN, knowledge_citations: [1, 9] }),
    ]));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);
    expect(res.status).toBe(200);

    const done = doneOf(res.text);
    // The plan the client receives cites ONLY passage 1 — passage 9 never
    // existed in the 1-passage corpus this request was grounded with.
    expect(done.data.knowledge_citations).toEqual([1]);
    expect(done.grounding.validation_status).toBe('invalid_citations');
    expect(done.grounding.citations_accepted).toEqual([1]);
    expect(done.grounding.citations_rejected).toEqual([9]);
    // And the citation resolves to a REAL passage, with enough of it to verify
    // without exposing anything beyond what the prompt already sent this user.
    expect(done.grounding.sources).toEqual([
      expect.objectContaining({
        n: 1, title: 'MPTS Programming SOP', document_id: 'doc-mpts-1',
        excerpt: 'Progressive overload adds 2-5% load per week for intermediate clients.',
      }),
    ]);
  });

  test('in-range citations pass through with validation_status ok', async () => {
    mockQueries();
    routedStream.mockReturnValue(streamChunks([
      JSON.stringify({ ...WORKOUT_PLAN, knowledge_citations: [1] }),
    ]));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    expect(res.status).toBe(200);
    const done = doneOf(res.text);
    expect(done.data.knowledge_citations).toEqual([1]);
    expect(done.grounding.validation_status).toBe('ok');
    expect(done.grounding.citations_rejected).toEqual([]);
    expect(done.grounding.corpus_version).toMatch(/^mpts-v\d{14}-n\d+$/);
  });

  test('the provider fallback chain cannot route around the validator', async () => {
    mockQueries();
    // Primary model broke mid-stream; the fallback model's answer — the one
    // actually returned — cites passage 7, which does not exist. Validation
    // runs after the chain completes, so this output is still checked.
    routedStream.mockReturnValue(streamChunks(
      ['{"name":"Brok', '\n\n[Retrying primary model...]', JSON.stringify({ ...WORKOUT_PLAN, knowledge_citations: [1, 7] })],
      { model: 'fallback-model', tier: 'fallback', used_fallback: true },
    ));

    const res = await request(app).post('/api/ai/workout/generate').send(BODY);

    expect(res.status).toBe(200);
    const done = doneOf(res.text);
    expect(done.used_fallback).toBe(true);
    expect(done.data.knowledge_citations).toEqual([1]);
    expect(done.grounding.validation_status).toBe('invalid_citations');
    expect(done.grounding.citations_rejected).toEqual([7]);
  });

  test('the grounding report freezes into the generation ledger (audit JSONB)', async () => {
    mockQueries();
    routedStream.mockReturnValue(streamChunks([
      JSON.stringify({ ...WORKOUT_PLAN, knowledge_citations: [1, 2] }),
    ]));

    await request(app).post('/api/ai/workout/generate').send(BODY);

    // ai_workout_generations INSERT: the audit column is parameter 11 (JSONB).
    const insert = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO ai_workout_generations'));
    expect(insert).toBeDefined();
    const audit = JSON.parse(insert[1][10]);
    expect(audit.grounding.validation_status).toBe('invalid_citations');
    expect(audit.grounding.corpus_version).toMatch(/^mpts-v\d{14}-n\d+$/);
    expect(audit.grounding.citations_rejected).toEqual([2]);
    expect(audit.grounding.status).toBe('ok');
  });
});

describe('diet gate + deterministic validator + one bounded revision', () => {
  test('an empty approved corpus refuses (422, no model call)', async () => {
    mockQueries({ 'ai_document_chunks': [] });
    routedStream.mockReturnValue(streamChunks([JSON.stringify(DIET_PLAN)]));

    const res = await request(app).post('/api/ai/diet/generate').send({
      client_id: 'client-1', activity_level: 'moderate',
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_EVIDENCE');
    expect(res.body.detail).toBe('empty');
    expect(routedStream).not.toHaveBeenCalled();
    expect(routedChat).not.toHaveBeenCalled();
  });

  test('a broken plan gets ONE bounded revision; the fixed plan ships clean', async () => {
    mockQueries();
    const broken = { ...DIET_PLAN, total_calories: null, knowledge_citations: [1, 7] };
    const fixed = { ...DIET_PLAN, knowledge_citations: [1] };
    routedStream.mockReturnValue(streamChunks([JSON.stringify(broken)]));
    routedChat.mockResolvedValue({ content: JSON.stringify(fixed), usage: {}, model: 'primary-model' });

    const res = await request(app).post('/api/ai/diet/generate').send({
      client_id: 'client-1', activity_level: 'moderate',
    });

    expect(res.status).toBe(200);
    expect(routedChat).toHaveBeenCalledTimes(1);
    const done = doneOf(res.text);
    expect(done.data.total_calories).toBe(1800);
    expect(done.data.knowledge_citations).toEqual([1]);
    expect(done.grounding.validation_status).toBe('ok');
    expect(done.grounding.structure_ok).toBe(true);

    // The revision instruction says exactly what is deterministic: structure
    // fix and citation policy.
    const revisionInstruction = routedChat.mock.calls[0][0].messages
      .find((m) => m.role === 'user' && m.content.includes('knowledge_citations')).content;
    expect(revisionInstruction).toContain('"total_calories"');
    expect(revisionInstruction).toContain('AUTHORIZED KNOWLEDGE BASE');
    expect(revisionInstruction).toContain('[]');
  });

  test('a plan outside the save route ranges is revised, not shipped as saveable', async () => {
    // 100 kcal is finite and the meals array is non-empty, so the old
    // three-field gate called this saveable. normalisePlan caps the range at
    // 500–10000, and structure_ok must predict what Save & assign accepts.
    mockQueries();
    const broken = { ...DIET_PLAN, total_calories: 100, knowledge_citations: [1] };
    routedStream.mockReturnValue(streamChunks([JSON.stringify(broken)]));
    routedChat.mockResolvedValue({
      content: JSON.stringify({ ...DIET_PLAN, knowledge_citations: [1] }),
      usage: {}, model: 'primary-model',
    });

    const res = await request(app).post('/api/ai/diet/generate').send({
      client_id: 'client-1', activity_level: 'moderate',
    });

    expect(res.status).toBe(200);
    expect(routedChat).toHaveBeenCalledTimes(1);
    const done = doneOf(res.text);
    expect(done.grounding.structure_ok).toBe(true);
    expect(done.data.total_calories).toBe(1800);
  });

  test('an unfixable plan still ships — flagged, after exactly one attempt', async () => {
    mockQueries();
    routedStream.mockReturnValue(streamChunks([JSON.stringify({ ...DIET_PLAN, meals: [] })]));
    routedChat.mockResolvedValue({ content: JSON.stringify({ ...DIET_PLAN, meals: [] }) });

    const res = await request(app).post('/api/ai/diet/generate').send({
      client_id: 'client-1', activity_level: 'moderate',
    });

    expect(res.status).toBe(200);
    expect(routedChat).toHaveBeenCalledTimes(1);
    const done = doneOf(res.text);
    expect(done.grounding.structure_ok).toBe(false);
    expect(done.type).toBe('done');
  });

  test('a compliant plan skips the revision entirely', async () => {
    mockQueries();
    routedStream.mockReturnValue(streamChunks([
      JSON.stringify({ ...DIET_PLAN, knowledge_citations: [1] }),
    ]));

    const res = await request(app).post('/api/ai/diet/generate').send({
      client_id: 'client-1', activity_level: 'moderate',
    });

    expect(res.status).toBe(200);
    expect(routedChat).not.toHaveBeenCalled();
    const done = doneOf(res.text);
    expect(done.grounding.structure_ok).toBe(true);
    expect(done.grounding.validation_status).toBe('ok');
  });
});

describe('chat done-payload grounding truth', () => {
  function mockChat({ retrieval } = {}) {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [{ id: 'conv-1' }] });
      if (sql.includes('LIMIT $2')) return Promise.resolve({ rows: [] });
      if (sql.includes("VALUES ($1,'user',$2)")) return Promise.resolve({ rows: [] });
      if (sql.includes("'assistant'")) return Promise.resolve({ rows: [] });
      if (sql.includes('pt_clients WHERE')) return Promise.resolve({ rows: [] });
      if (sql.includes('ai_document_chunks')) {
        return retrieval === 'throw'
          ? Promise.reject(new Error('embeddings down'))
          : Promise.resolve({ rows: [CORPUS_CHUNK] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  test('grounded conversation tells the truth in the terminal event too', async () => {
    mockChat();
    routedStream.mockReturnValue(streamChunks(['Answer text.']));

    const res = await request(app).post('/api/ai/chat').send({ message: 'how should I progress squats?', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    const done = doneOf(res.text);
    expect(done.conversation_id).toBe('conv-1');
    expect(done.grounding).toBe('ok');
    expect(done.sources).toEqual(['MPTS Programming SOP']);
  });

  test('a grounding outage is carried in the done event, not just mid-stream', async () => {
    mockChat({ retrieval: 'throw' });
    routedStream.mockReturnValue(streamChunks(['Fallback answer.']));

    const res = await request(app).post('/api/ai/chat').send({ message: 'how should I progress squats?', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    const payloads = ssePayloads(res.text);
    const done = payloads.find((p) => p.type === 'done');
    expect(done.grounding).toBe('unavailable');
    expect(done.sources).toBeUndefined();
    // The mid-stream event still fires as before (no downgrade).
    expect(payloads.some((p) => p.type === 'grounding' && p.grounding === 'unavailable')).toBe(true);
  });
});

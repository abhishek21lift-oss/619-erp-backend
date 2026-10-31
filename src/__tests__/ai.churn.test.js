// POST /api/ai/business/churn — one roster-level briefing.
//
// The scores are deterministic and already computed; the model only narrates
// them. An empty roster must not cost a call, an unparseable answer must not
// reach the browser, and the payload must stay inside the studio's top ten.
'use strict';

process.env.OPENROUTER_API_KEY = 'test-key';

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  embedBatch: jest.fn().mockResolvedValue([new Array(384).fill(0.1)]),
  toVectorLiteral: jest.fn((v) => `[${v.join(',')}]`),
  EMBEDDING_DIM: 384,
}));
let mockUser = { id: 'u1', role: 'trainer', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../lib/ai/router', () => ({ routedChat: jest.fn(), routedStream: jest.fn() }));
jest.mock('../lib/ai/models', () => ({ models: { primary: 'primary-model' }, INTENT_ROUTES: {} }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../modules/pt-os/churn.service', () => ({ buildChurnList: jest.fn(), markFollowup: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { routedChat } = require('../lib/ai/router');
const { logUsage } = require('../lib/ai/usage');
const { buildChurnList } = require('../modules/pt-os/churn.service');

const app = express();
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const row = (i) => ({
  client_id: `cl-${i}`,
  client_name: `Client ${i}`,
  score: 75,
  band: 'critical',
  reasons: [{ code: 'silent_21', label: 'Last trained 31 days ago', points: 60 }],
  next_action: 'Call this week.',
  last_session: '2026-09-29',
  days_quiet: 31,
  term: { state: 'current', end: '2026-11-14', days_left: 15 },
  balance_amount: 8000,
  risk_increased: false,
});

const list = (overrides = {}) => ({
  as_of: '2026-10-30',
  assessed: 34,
  flagged: 12,
  bands: { critical: 2, high: 3, medium: 3, low: 4 },
  rows: Array.from({ length: 12 }, (_, i) => row(i + 1)),
  handled: [],
  ...overrides,
});

const post = () => request(app).post('/api/ai/business/churn').send({});

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'u1', role: 'trainer', organization_id: 'org-1' };
});

it('answers an empty roster without calling a model', async () => {
  buildChurnList.mockResolvedValue(list({ flagged: 0, rows: [] }));

  const res = await post();

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ model: 'deterministic', tier: 'none', used_fallback: false, empty: true });
  expect(res.body.data.themes).toEqual([]);
  expect(res.body.data.this_week).toEqual([]);
  expect(routedChat).not.toHaveBeenCalled();
  expect(logUsage).not.toHaveBeenCalled();
});

it('returns the model briefing and logs one business call', async () => {
  buildChurnList.mockResolvedValue(list());
  routedChat.mockResolvedValue({
    content: '{"summary":"Two clients are critical. Three need a renewal call.","themes":["silence","dues"],"this_week":["Call Asha"]}',
    model: 'model-x', tier: 'standard', used_fallback: false, usage: {}, latency_ms: 5,
  });

  const res = await post();

  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({
    summary: 'Two clients are critical. Three need a renewal call.',
    themes: ['silence', 'dues'],
    this_week: ['Call Asha'],
  });
  expect(res.body).toMatchObject({ model: 'model-x', tier: 'standard', used_fallback: false });
  expect(logUsage).toHaveBeenCalledTimes(1);
  expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({ intent_type: 'business' }));
});

it('refuses prose instead of JSON and never echoes it', async () => {
  buildChurnList.mockResolvedValue(list());
  routedChat.mockResolvedValue({
    content: 'Sure! Here is a friendly churn briefing for you...',
    model: 'model-x', tier: 'standard', used_fallback: false, usage: {}, latency_ms: 5,
  });

  const res = await post();

  expect(res.status).toBe(422);
  expect(res.body.code).toBe('AI_UNPARSEABLE');
  expect(res.body.data).toBeUndefined();
  expect(logUsage).not.toHaveBeenCalled();
});

it('answers 503 when the list cannot be built', async () => {
  buildChurnList.mockRejectedValue(new Error('db down'));

  const res = await post();

  expect(res.status).toBe(503);
  expect(res.body.code).toBe('AI_FAILED');
  expect(routedChat).not.toHaveBeenCalled();
});

it('sends the scored summary and at most ten clients', async () => {
  buildChurnList.mockResolvedValue(list());
  routedChat.mockResolvedValue({
    content: '{"summary":"x","themes":[],"this_week":[]}',
    model: 'model-x', tier: 'standard', used_fallback: false, usage: {}, latency_ms: 5,
  });

  await post();

  const { messages } = routedChat.mock.calls[0][0];
  const sent = messages.find((m) => m.role === 'user').content;
  expect(sent).toContain('"assessed"');
  expect(sent).toContain('Client 10');
  expect(sent).not.toContain('Client 11');
});

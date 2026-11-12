'use strict';
// POST /api/ai/chat — durable provenance on the stored assistant message.
//
// The answer stores references only: the tool run ids, source titles and
// grounding/model/intent. Prompt text, message bodies and tool payloads are
// never copied into ai_messages.meta.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'trainer', organization_id: 'org-1' };
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../lib/ai/router', () => ({ routedChat: jest.fn(), routedStream: jest.fn() }));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn() }));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn() }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/sse-heartbeat', () => ({ startSseHeartbeat: jest.fn(() => () => {}) }));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db/pool');
const { routedStream } = require('../lib/ai/router');
const { retrieveContext } = require('../lib/ai/knowledgeBase');
const { runTools } = require('../lib/ai/tools');

process.env.OPENROUTER_API_KEY = 'test-key';
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  pool.query.mockReset();
  retrieveContext.mockReset().mockResolvedValue([{ title: 'Studio SOP', content: 'warm up' }]);
  runTools.mockReset();
  routedStream.mockReset().mockImplementation(async function* () {
    yield 'Answer';
  });
});

function dispatch() {
  return jest.fn((sql) => {
    if (/SELECT id FROM ai_conversations WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'conv-1' }] });
    }
    if (sql.includes("VALUES ($1,'user',$2)")) return Promise.resolve({ rows: [{ id: 'msg-1' }] });
    if (sql.includes('LIMIT $2')) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

test('the chat turn passes correlation, conversation and message ids to the tools', async () => {
  pool.query.mockImplementation(dispatch());
  runTools.mockResolvedValue({
    toolNames: ['Revenue'],
    contextText: 'Revenue: 5,000',
    runs: [{ tool: 'revenue_summary', run_id: 'run-1', ok: true, code: null }],
  });

  const res = await request(app)
    .post('/api/ai/chat')
    .send({ message: 'What was our revenue?', conversation_id: 'conv-1' });

  expect(res.status).toBe(200);
  const [, , opts] = runTools.mock.calls[0];
  expect(opts).toMatchObject({ conversationId: 'conv-1', messageId: 'msg-1', clientId: null });
  expect(opts.correlationId).toMatch(UUID);
});

test('the assistant message stores tool run references and sources, not the answer or prompt', async () => {
  pool.query.mockImplementation(dispatch());
  runTools.mockResolvedValue({
    toolNames: ['Revenue'],
    contextText: 'Revenue: 5,000',
    runs: [{ tool: 'revenue_summary', run_id: 'run-1', ok: true, code: null }],
  });

  const res = await request(app)
    .post('/api/ai/chat')
    .send({ message: 'SECRET PROMPT what was our revenue?', conversation_id: 'conv-1' });

  expect(res.status).toBe(200);

  const assistantCall = pool.query.mock.calls.find(([sql]) => sql.includes("'assistant'"));
  expect(assistantCall).toBeDefined();
  const [sql, params] = assistantCall;
  expect(sql).toContain('meta');
  expect(sql).toContain('$4::jsonb');

  const meta = JSON.parse(params[3]);
  const toolOpts = runTools.mock.calls[0][2];
  expect(meta).toEqual({
    correlation_id: toolOpts.correlationId,
    intent: 'chat',
    model: expect.any(String),
    grounding: 'ok',
    tools: [{ tool: 'revenue_summary', run_id: 'run-1', ok: true, code: null }],
    sources: ['Studio SOP'],
    client_id: null,
  });
  expect(params[3]).not.toMatch(/SECRET PROMPT|Revenue: 5,000|warm up/);
});

test('a legacy failure still stores its failed run reference', async () => {
  pool.query.mockImplementation(dispatch());
  runTools.mockResolvedValue({
    toolNames: ['Revenue'],
    contextText: 'lookup failed',
    runs: [{ tool: 'revenue_summary', run_id: 'run-2', ok: false, code: 'TOOL_FAILED' }],
  });

  await request(app)
    .post('/api/ai/chat')
    .send({ message: 'What was our revenue?', conversation_id: 'conv-1' });

  const [, params] = pool.query.mock.calls.find(([sql]) => sql.includes("'assistant'"));
  expect(JSON.parse(params[3]).tools).toEqual([
    { tool: 'revenue_summary', run_id: 'run-2', ok: false, code: 'TOOL_FAILED' },
  ]);
});

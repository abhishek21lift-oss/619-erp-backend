'use strict';
// POST /api/ai/chat — a client disconnect aborts the generation, bills nothing
// and writes no half answer. The streaming layer already supports AbortSignal;
// the route must hand it one and treat AI_ABORTED as a normal disconnect.

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

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { routedStream } = require('../lib/ai/router');
const { retrieveContext } = require('../lib/ai/knowledgeBase');
const { runTools } = require('../lib/ai/tools');
const { logUsage } = require('../lib/ai/usage');

process.env.OPENROUTER_API_KEY = 'test-key';
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

function dispatch() {
  return jest.fn((sql) => {
    if (sql.includes('ai_conversations WHERE id')) return Promise.resolve({ rows: [{ id: 'conv-1' }] });
    if (sql.includes('LIMIT $2')) return Promise.resolve({ rows: [{ role: 'user', content: 'hi' }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  pool.query.mockReset().mockImplementation(dispatch());
  retrieveContext.mockReset().mockResolvedValue([]);
  runTools.mockReset().mockResolvedValue({ toolNames: [], contextText: '' });
  routedStream.mockReset();
  logUsage.mockClear();
});

describe('POST /api/ai/chat — client disconnect', () => {
  it('passes an AbortSignal to the model stream', async () => {
    routedStream.mockImplementation(async function* () { yield 'Answer'; });

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    expect(routedStream.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('treats AI_ABORTED as a disconnect: no error event, no persistence, no usage', async () => {
    // Fails on the first next() — the stream never produces a token.
    routedStream.mockImplementation(() => ({
      [Symbol.asyncIterator]() { return this; },
      next: () => Promise.reject(Object.assign(new Error('cancelled'), { code: 'AI_ABORTED' })),
    }));

    const res = await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.text).not.toContain('"type":"error"');
    expect(pool.query.mock.calls.some(([sql]) => sql.includes("'assistant'"))).toBe(false);
    expect(logUsage).not.toHaveBeenCalled();
  });
});

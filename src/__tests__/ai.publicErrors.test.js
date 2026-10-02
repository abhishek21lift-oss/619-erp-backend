'use strict';
// AI routes never hand an internal error message to the browser (Phase 3).
//
// Thirteen catch blocks in routes/ai.js answered
//
//     res.status(503).json({ error: '…failed', message: err.message })
//
// in production too. The AI layer's own failures are written for users
// ("AI service temporarily unavailable — all models failed"), but these
// catches also receive everything else on the way: a Postgres error naming a
// table, a JSON parser's internals, a provider's raw response body. Those went
// to the client verbatim. The global error handler already masks 500s in
// production; these 503s bypassed it.

process.env.NODE_ENV = 'production';
process.env.OPENROUTER_API_KEY = 'test-key';

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'usr-1', role: 'trainer', organization_id: 'org-1' }; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../lib/ai/router', () => ({ routedChat: jest.fn(), routedStream: jest.fn() }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined), getUserUsage: jest.fn(), getModelStats: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { routedChat } = require('../lib/ai/router');

const app = express();
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const INTERNAL = 'relation "ai_conversations" does not exist';

beforeEach(() => {
  pool.query.mockReset().mockResolvedValue({ rows: [] });
  routedChat.mockReset();
});

describe('AI errors that reach the client', () => {
  it('a database error in the chat ownership check is not echoed', async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error(INTERNAL), { code: '42P01' }));
    const res = await request(app).post('/api/ai/chat')
      .send({ conversation_id: '11111111-1111-4111-8111-111111111111', message: 'hi' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('ai_conversations');
  });

  it('an unexpected error from the model call is not echoed', async () => {
    routedChat.mockRejectedValueOnce(new Error('OpenRouter 402: {"error":{"message":"insufficient credits on account acct_123"}}'));
    const res = await request(app).post('/api/ai/test').send({});
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/acct_123|OpenRouter 402/);
  });

  it('the AI layer\'s own all-models-failed message still reaches the user', async () => {
    routedChat.mockRejectedValueOnce(Object.assign(
      new Error('AI service temporarily unavailable — all models failed'), { code: 'ALL_MODELS_FAILED' }));
    const res = await request(app).post('/api/ai/test').send({});
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('AI service temporarily unavailable — all models failed');
  });
});

describe('the chat stream', () => {
  const { routedStream } = require('../lib/ai/router');

  it('a stream failure is reported without its internal message', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
    routedStream.mockImplementation(async function* () {
      yield 'Partial';
      throw new Error('OpenRouter stream 500: upstream_secret_detail');
    });
    const res = await request(app).post('/api/ai/chat')
      .send({ conversation_id: '11111111-1111-4111-8111-111111111111', message: 'hi' });
    expect(res.text).toContain('"type":"error"');
    expect(res.text).not.toContain('upstream_secret_detail');
  });
});

'use strict';
// POST /api/ai/chat — conversation tenancy.
//
// The conversation's organization comes from the authenticated user, never
// from the request. These tests pin the write path that Phase 4.3D found
// leaving organization_id NULL: new conversations, reuse, regeneration and the
// conversation/message ids handed to the tool layer.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'trainer', organization_id: 'org-1' };
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));
jest.mock('../lib/ai/router', () => ({
  routedChat: jest.fn(),
  routedStream: jest.fn(),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn() }));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn() }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/sse-heartbeat', () => ({ startSseHeartbeat: jest.fn(() => () => {}) }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { routedStream } = require('../lib/ai/router');
const { retrieveContext } = require('../lib/ai/knowledgeBase');
const { runTools } = require('../lib/ai/tools');

process.env.OPENROUTER_API_KEY = 'test-key';
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

const streamChunks = (chunks) => jest.fn().mockImplementation(async function* () {
  for (const c of chunks) yield c;
});

const answers = (rowsBySql = {}) => pool.query.mockImplementation(async (sql) => {
  for (const [pattern, rows] of Object.entries(rowsBySql)) {
    if (sql.includes(pattern)) return { rows };
  }
  return { rows: [] };
});

beforeEach(() => {
  pool.query.mockReset();
  retrieveContext.mockReset().mockResolvedValue([]);
  runTools.mockReset().mockResolvedValue({ toolNames: [], contextText: '', runs: [] });
  routedStream.mockReset().mockImplementation(streamChunks(['ok']));
});

describe('new conversation tenancy', () => {
  test('stores the authenticated organization on the conversation', async () => {
    answers({ 'INSERT INTO ai_conversations': [{ id: 'conv-new' }], 'INSERT INTO ai_messages': [{ id: 'msg-1' }] });

    await request(app).post('/api/ai/chat').send({ message: 'Plan my week' });

    const insert = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO ai_conversations'));
    expect(insert).toBeDefined();
    expect(insert[0]).toMatch(/INSERT INTO ai_conversations \([^)]*organization_id[^)]*\)/);
    expect(insert[1]).toEqual(['usr-1', null, 'Plan my week', 'org-1']);
  });

  test('ignores organization_id supplied in the body', async () => {
    answers({ 'INSERT INTO ai_conversations': [{ id: 'conv-new' }], 'INSERT INTO ai_messages': [{ id: 'msg-1' }] });

    await request(app)
      .post('/api/ai/chat')
      .set('x-org-id', 'org-header-evil')
      .send({ message: 'hi', organization_id: 'org-body-evil' });

    const insert = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO ai_conversations'));
    expect(insert[1][3]).toBe('org-1');
    expect(JSON.stringify(insert[1])).not.toMatch(/org-body-evil|org-header-evil/);
  });
});

describe('reusing an existing conversation', () => {
  test('ownership is checked against the authenticated organization', async () => {
    answers({
      'SELECT id FROM ai_conversations': [{ id: 'conv-1' }],
      'INSERT INTO ai_messages': [{ id: 'msg-1' }],
    });

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/id = \$1 AND user_id = \$2 AND organization_id = \$3/);
    expect(params).toEqual(['conv-1', 'usr-1', 'org-1']);
  });

  test('regeneration keeps the conversation organization unchanged', async () => {
    answers({
      'SELECT id FROM ai_conversations': [{ id: 'conv-1' }],
      'INSERT INTO ai_messages': [{ id: 'msg-2' }],
    });

    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'answer again', conversation_id: 'conv-1', regenerate: true });

    expect(pool.query.mock.calls.some(([sql]) => /UPDATE ai_conversations[\s\S]*organization_id/i.test(sql)))
      .toBe(false);
    const ownership = pool.query.mock.calls[0];
    expect(ownership[1]).toEqual(['conv-1', 'usr-1', 'org-1']);
  });
});

describe('tool provenance is tied to the conversation', () => {
  test('the tool layer receives the new conversation and user message ids', async () => {
    answers({ 'INSERT INTO ai_conversations': [{ id: 'conv-new' }], 'INSERT INTO ai_messages': [{ id: 'msg-1' }] });

    await request(app).post('/api/ai/chat').send({ message: 'hi' });

    expect(runTools).toHaveBeenCalledTimes(1);
    expect(runTools.mock.calls[0][2]).toMatchObject({
      conversationId: 'conv-new',
      messageId: 'msg-1',
    });
  });
});

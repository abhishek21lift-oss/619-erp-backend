'use strict';
// POST /api/ai/chat — conversation ownership authorization.
//
// A caller-supplied conversation_id must belong to the authenticated user.
// The route answers 404 for unknown AND foreign conversation UUIDs alike,
// before any SSE header is flushed, so a foreign thread can never reach the
// prompt, RAG, tools, or the model. This file proves:
//   * owned conversations behave exactly as before (stream + persist)
//   * foreign/unknown UUIDs are rejected with zero downstream calls
//   * regenerate only ever runs against an owned conversation
//   * new conversations are created owned by req.user.id
//   * the ownership check uses bound parameters, never interpolation
//   * the check happens before history is read and before streaming

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'admin', organization_id: 'org-1' };
    next();
  },
  adminOnly: (_req, _res, next) => next(),
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
const { logUsage } = require('../lib/ai/usage');

process.env.OPENROUTER_API_KEY = 'test-key';
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

// The single ownership SELECT the route must issue first.
const OWNERSHIP_SQL = /SELECT id FROM ai_conversations WHERE id = \$1 AND user_id = \$2/;

// Streams the same way the real routedStream does: async generator of chunks.
const streamChunks = (chunks) => jest.fn().mockImplementation(async function* () {
  for (const c of chunks) yield c;
});

beforeEach(() => {
  pool.query.mockReset().mockResolvedValue({ rows: [] });
  retrieveContext.mockReset().mockResolvedValue([]);
  runTools.mockReset().mockResolvedValue({ toolNames: [], contextText: '' });
  logUsage.mockClear();
  routedStream.mockReset();
});

describe('POST /api/ai/chat — owned conversation', () => {
  it('streams and persists exactly as before', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
    routedStream.mockImplementation(streamChunks(['Hello', ' world']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'Plan my week', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"start"');
    expect(res.text).toContain('"conversation_id":"conv-1"');
    expect(res.text).toContain('"content":"Hello"');
    expect(res.text).toContain('"content":" world"');
    expect(res.text).toContain('"type":"done"');

    // RAG and tools still run for an owned thread; the model is called.
    expect(retrieveContext).toHaveBeenCalledTimes(1);
    expect(runTools).toHaveBeenCalledTimes(1);
    expect(routedStream).toHaveBeenCalledTimes(1);
    expect(routedStream.mock.calls[0][0]).toMatchObject({ intent: 'chat' });

    // The ownership SELECT ran first, and the thread was then written to.
    const [firstSql, firstParams] = pool.query.mock.calls[0];
    expect(firstSql).toMatch(OWNERSHIP_SQL);
    expect(firstParams).toEqual(['conv-1', 'usr-1']);
    expect(pool.query.mock.calls.some(([s]) => s.includes('INSERT INTO ai_messages'))).toBe(true);
    expect(logUsage).toHaveBeenCalledTimes(1);
  });

  it('runs the ownership check before reading conversation history', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
    routedStream.mockImplementation(streamChunks(['ok']));

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const calls = pool.query.mock.calls;
    expect(calls[0][0]).toMatch(OWNERSHIP_SQL);
    expect(calls[1][0]).toContain('INSERT INTO ai_messages');      // user message
    expect(calls[2][0]).toMatch(/SELECT role, content\s+FROM ai_messages/); // history
  });

  it('runs the ownership check before the model is streamed', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
    routedStream.mockImplementation(streamChunks(['ok']));

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const ownershipCall = pool.query.mock.calls[0];
    expect(ownershipCall[0]).toMatch(OWNERSHIP_SQL);
    expect(ownershipCall[1]).toEqual(['conv-1', 'usr-1']);
    expect(routedStream).toHaveBeenCalledTimes(1); // only reached after ownership passed
  });

  it('uses bound parameters — the UUID never appears inside the SQL string', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
    routedStream.mockImplementation(streamChunks(['ok']));

    await request(app).post('/api/ai/chat').send({ message: 'hi', conversation_id: 'conv-1' });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).not.toContain('conv-1');       // no interpolation of the value
    expect(params).toEqual(['conv-1', 'usr-1']); // bound, in order
  });
});

describe('POST /api/ai/chat — foreign conversation', () => {
  it('rejects with the same 404 as an unknown UUID and touches nothing else', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'Plan my week', conversation_id: 'foreign-conv' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
    expect(res.headers['content-type']).toMatch(/json/); // JSON, not SSE

    // The ownership SELECT is the ONLY query that ran — nothing was read,
    // written, deleted, or resolved for a foreign thread.
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(OWNERSHIP_SQL);
    expect(params).toEqual(['foreign-conv', 'usr-1']);
    expect(sql).not.toMatch(/ai_messages/);
    expect(sql).not.toMatch(/INSERT|DELETE/);

    // The model, RAG, tools, and usage logging never ran.
    expect(routedStream).not.toHaveBeenCalled();
    expect(retrieveContext).not.toHaveBeenCalled();
    expect(runTools).not.toHaveBeenCalled();
    expect(logUsage).not.toHaveBeenCalled();
  });

  it('answers byte-identically for a foreign UUID and an unknown UUID', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const foreign = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'another-users-conv' });
    const unknown = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: '00000000-0000-0000-0000-000000000000' });

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
    // No wording anywhere that confirms the foreign UUID exists.
    expect(JSON.stringify(foreign.body)).not.toMatch(/another|owner|exists|belongs/i);
  });

  it('rejects a conversation owned by a user in a different tenant', async () => {
    // The check is user-scoped: it must NOT rely on organization_id at all,
    // so a conversation from another tenant (or same tenant, another user)
    // is rejected by the same single bound query.
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'other-tenant-conv' });

    expect(res.status).toBe(404);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(OWNERSHIP_SQL);
    expect(sql).not.toMatch(/organization_id/);
    expect(params).toEqual(['other-tenant-conv', 'usr-1']);
  });
});

describe('POST /api/ai/chat — regenerate', () => {
  it('regenerate on a foreign conversation deletes nothing', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'try again', conversation_id: 'foreign-conv', regenerate: true });

    expect(res.status).toBe(404);
    expect(pool.query).toHaveBeenCalledTimes(1); // ownership only
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(OWNERSHIP_SQL);
    expect(sql).not.toMatch(/DELETE/);
    expect(routedStream).not.toHaveBeenCalled();
  });

  it('regenerate on an owned conversation still drops the last answer and regenerates', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] }); // ownership
    pool.query.mockResolvedValueOnce({ rows: [] });                 // DELETE
    routedStream.mockImplementation(streamChunks(['fresh answer']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'try again', conversation_id: 'conv-1', regenerate: true });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"content":"fresh answer"');

    const calls = pool.query.mock.calls;
    expect(calls[0][0]).toMatch(OWNERSHIP_SQL);
    expect(calls[1][0]).toMatch(/DELETE FROM ai_messages/);
    expect(calls[1][1]).toEqual(['conv-1']);
    // Regenerate must not re-insert the user's question.
    expect(calls.some(([s]) => s.includes("'user'"))).toBe(false);
    expect(routedStream).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/ai/chat — new conversation', () => {
  it('creates a conversation owned by the authenticated user', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'new-conv-1' }] }); // INSERT conversation
    routedStream.mockImplementation(streamChunks(['hi there']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'Hello coach' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"conversation_id":"new-conv-1"');
    expect(res.text).toContain('"type":"done"');

    const [createSql, createParams] = pool.query.mock.calls[0];
    expect(createSql).toMatch(/INSERT INTO ai_conversations \(user_id, client_id, title\)/);
    expect(createParams[0]).toBe('usr-1');      // owner = authenticated user
    expect(createParams[1]).toBeNull();         // no client_id sent
    expect(createParams[2]).toBe('Hello coach');

    // No ownership SELECT is issued for a brand-new conversation.
    expect(pool.query.mock.calls.some(([s]) => s.match(OWNERSHIP_SQL))).toBe(false);

    // The user's message is inserted into the new thread.
    const [msgSql, msgParams] = pool.query.mock.calls[1];
    expect(msgSql).toMatch(/INSERT INTO ai_messages \(conversation_id, role, content\)/);
    expect(msgParams).toEqual(['new-conv-1', 'Hello coach']);
  });

  it('preserves client_id handling on a new conversation', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'new-conv-2' }] });
    routedStream.mockImplementation(streamChunks(['ok']));

    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'Coach me', client_id: 'cli-9' });

    expect(pool.query.mock.calls[0][1]).toEqual(['usr-1', 'cli-9', 'Coach me']);
  });
});

describe('POST /api/ai/chat — ownership check failure handling', () => {
  it('answers JSON 503 without SSE when the ownership query itself fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('AI chat unavailable');
    expect(res.headers['content-type']).toMatch(/json/);
    expect(pool.query).toHaveBeenCalledTimes(1); // nothing ran after the failure
    expect(routedStream).not.toHaveBeenCalled();
  });
});
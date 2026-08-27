'use strict';
// POST /api/ai/chat — SSE heartbeat lifecycle (audit F-4 / A-4).
//
// The AI Coach must keep the connection alive through the silent pre-first-
// token window exactly like Workout/Diet: the canonical startSseHeartbeat()
// helper runs from just after the SSE headers are flushed until the stream
// ends, and its stop() is always invoked in the finally. This suite proves the
// ROUTE wires the helper correctly — the helper's own ': ping' emission and
// self-clearing behaviour are covered by src/__tests__/sse-heartbeat.test.js
// and are not duplicated here.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'trainer', organization_id: 'org-1' };
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
jest.mock('../lib/sse-heartbeat', () => ({ startSseHeartbeat: jest.fn() }));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { startSseHeartbeat } = require('../lib/sse-heartbeat');
const { routedStream } = require('../lib/ai/router');
const { retrieveContext } = require('../lib/ai/knowledgeBase');
const { runTools } = require('../lib/ai/tools');

process.env.OPENROUTER_API_KEY = 'test-key';
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

const RETRY_MARKER = '\n\n[Retrying with backup model…]\n\n';

function defaultDispatch() {
  return jest.fn((sql, _params) => {
    if (sql.includes('ai_conversations WHERE id')) return Promise.resolve({ rows: [{ id: 'conv-1' }] });
    return Promise.resolve({ rows: [] });
  });
}

const streamChunks = (chunks) => jest.fn().mockImplementation(async function* () {
  for (const c of chunks) yield c;
});

const persistedAnswer = () => {
  const call = pool.query.mock.calls.find(([sql]) => sql.includes("'assistant'"));
  return call ? call[1][1] : null;
};

let stopHeartbeat;
beforeEach(() => {
  stopHeartbeat = jest.fn();
  startSseHeartbeat.mockReset().mockImplementation(() => stopHeartbeat);
  pool.query.mockReset();
  retrieveContext.mockReset().mockResolvedValue([]);
  runTools.mockReset().mockResolvedValue({ toolNames: [], contextText: '' });
  routedStream.mockReset();
});

describe('POST /api/ai/chat — heartbeat lifecycle', () => {
  it('starts the canonical heartbeat after the ownership gate, before the model stream', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks(['Hello']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);

    // Started exactly once, with the SSE response object, for the silent
    // pre-first-token window.
    expect(startSseHeartbeat).toHaveBeenCalledTimes(1);
    expect(typeof startSseHeartbeat.mock.calls[0][0].flushHeaders).toBe('function');

    // Started AFTER the ownership check (ownership SELECT is call #1) and
    // BEFORE the model stream.
    const ownershipIdx = pool.query.mock.calls.findIndex(([s]) => s.includes('ai_conversations WHERE id'));
    const streamIdx = routedStream.mock.invocationCallOrder[0];
    const heartbeatIdx = startSseHeartbeat.mock.invocationCallOrder[0];
    expect(ownershipIdx).toBeLessThan(heartbeatIdx);
    expect(heartbeatIdx).toBeLessThan(streamIdx);
  });

  it('stops the heartbeat in the finally on normal completion', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks(['Hello']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(persistedAnswer()).toBe('Hello');
  });

  it('stops the heartbeat after a model error', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(async function* () {
      yield 'partial';
      throw new Error('ALL_MODELS_FAILED');
    });

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.text).toContain('"type":"error"');
    expect(res.text).not.toContain('"type":"done"');
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(persistedAnswer()).toBeNull();
  });

  it('a foreign conversation never starts the heartbeat or SSE at all', async () => {
    pool.query.mockResolvedValue({ rows: [] }); // ownership gate fails

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'foreign-conv' });

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(startSseHeartbeat).not.toHaveBeenCalled();
    expect(routedStream).not.toHaveBeenCalled();
    expect(retrieveContext).not.toHaveBeenCalled();
    expect(runTools).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1); // ownership only
  });

  it('normal stream unchanged: start, chunk, done, and a clean persisted answer', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks(['Hello', ' world']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"start"');
    expect(res.text).toContain('"content":"Hello"');
    expect(res.text).toContain('"type":"done"');
    expect(persistedAnswer()).toBe('Hello world');
  });

  it('heartbeat comments can never become answer text (route events and persisted row are ping-free)', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks([RETRY_MARKER, 'Real answer']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    // Every data event the route emits is JSON with a type; the ONLY way a
    // ': ping' comment reaches the wire is the helper (covered by its own
    // suite) — it is never part of a chunk event or the persisted message.
    for (const line of res.text.split('\n')) {
      if (line.startsWith('data: ')) {
        expect(line).not.toContain(': ping');
      }
    }
    expect(persistedAnswer()).toBe('Real answer');
    expect(persistedAnswer()).not.toContain(': ping');
    expect(persistedAnswer()).not.toContain('Retrying'); // F-3 behaviour intact
  });
});
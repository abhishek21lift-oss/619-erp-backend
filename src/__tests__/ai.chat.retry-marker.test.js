'use strict';
// POST /api/ai/chat — fallback retry marker must never be persisted.
//
// routedStream() yields '\n\n[Retrying with backup model…]\n\n' as a chunk
// when the primary model fails and a backup model takes over. The user may
// still see that status while streaming (existing UX, and the chunk event is
// preserved), but the assistant message persisted to ai_messages must contain
// only the actual answer — never the internal routing marker — and never the
// failed primary model's partial output. This mirrors the rule the workout /
// diet / progress / fitness-testing routes already use.

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

beforeEach(() => {
  pool.query.mockReset();
  retrieveContext.mockReset().mockResolvedValue([]);
  runTools.mockReset().mockResolvedValue({ toolNames: [], contextText: '' });
  logUsage.mockClear();
  routedStream.mockReset();
});

describe('POST /api/ai/chat — retry marker persistence', () => {
  it('primary model succeeds: final answer unchanged, no marker anywhere', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks(['Hello', ' world']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    expect(persistedAnswer()).toBe('Hello world');
    expect(persistedAnswer()).not.toContain('Retrying');
    expect(res.text).not.toContain('Retrying');
  });

  it('primary fails, fallback succeeds: marker still shown while streaming, but never persisted', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks([
      'partial primary', RETRY_MARKER, 'Real answer',
    ]));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    // Persisted assistant content holds only the fallback answer — no marker,
    // no partial primary output, no concatenated halves.
    expect(persistedAnswer()).toBe('Real answer');
    expect(persistedAnswer()).not.toContain('Retrying');
    expect(persistedAnswer()).not.toContain('partial primary');

    // The UI still receives the marker as a chunk event during streaming
    // (existing UX), followed by the real answer.
    expect(res.text).toContain('[Retrying with backup model…]');
    expect(res.text).toContain('"content":"Real answer"');
  });

  it('multiple retry/fallback events: final persisted answer contains no markers and no duplication', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks([
      'p1', RETRY_MARKER, 'f1', 'f2', RETRY_MARKER, 'final answer',
    ]));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(persistedAnswer()).toBe('final answer');
    expect(persistedAnswer()).not.toContain('Retrying');
    expect((persistedAnswer().match(/final answer/g) || []).length).toBe(1); // no duplicate text
    // Both markers still surfaced in the stream (existing UX).
    expect((res.text.match(/Retrying/g) || []).length).toBe(2);
  });

  it('history later loaded from the persisted row never contains the marker', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks([RETRY_MARKER, 'Clean reply']));

    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    // The exact string written to ai_messages is what history SELECT returns
    // on the next request — it is marker-free.
    expect(persistedAnswer()).toBe('Clean reply');
    expect(persistedAnswer()).not.toMatch(/Retrying|\[/);
  });

  it('SSE contract unchanged: start, chunks (incl. marker), done still emitted', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(streamChunks([RETRY_MARKER, 'answer']));

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"start"');
    expect(res.text).toContain('"type":"chunk","content":"\\n\\n[Retrying'); // marker is still a chunk event
    expect(res.text).toContain('"content":"answer"');
    expect(res.text).toContain('"type":"done"');
    expect(routedStream).toHaveBeenCalledTimes(1);
    expect(routedStream.mock.calls[0][0]).toMatchObject({ intent: 'chat' });
  });

  it('error path unchanged: error event, no assistant row persisted, no done', async () => {
    pool.query.mockImplementation(defaultDispatch());
    routedStream.mockImplementation(async function* () {
      yield 'partial chunk';
      throw new Error('ALL_MODELS_FAILED');
    });

    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hi', conversation_id: 'conv-1' });

    expect(res.text).toContain('"type":"error"');
    expect(res.text).not.toContain('"type":"done"');
    expect(persistedAnswer()).toBeNull(); // nothing saved for a failed stream
  });
});
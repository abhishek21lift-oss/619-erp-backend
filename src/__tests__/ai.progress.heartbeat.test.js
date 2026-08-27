'use strict';
// POST /api/ai/progress/analyze + POST /api/ai/fitness-testing/analyze —
// SSE heartbeat lifecycle (audit P2-2).
//
// Both streams previously relied only on per-chunk ': ping' comments, which
// leave the silent pre-first-token window unprotected against a proxy idle
// timeout. This suite proves the ROUTES start the canonical startSseHeartbeat()
// right after the SSE headers flush — which itself happens only after the
// client/assessment authorization gate — and always stop it in the finally.
// The helper's own ping emission and self-clearing are covered by
// src/__tests__/sse-heartbeat.test.js and are not duplicated here.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  embedBatch: jest.fn().mockResolvedValue([new Array(384).fill(0.1)]),
  toVectorLiteral: jest.fn((v) => `[${v.join(',')}]`),
  EMBEDDING_DIM: 384,
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'u1', role: 'admin', organization_id: 'org-1' }; next(); },
  adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../lib/ai/router', () => ({ routedStream: jest.fn(), routedChat: jest.fn() }));
jest.mock('../lib/ai/models', () => ({ models: { primary: 'primary-model' } }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue(undefined),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn() }));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn() }));
jest.mock('../lib/sse-heartbeat', () => ({ startSseHeartbeat: jest.fn() }));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { startSseHeartbeat } = require('../lib/sse-heartbeat');
const { routedStream } = require('../lib/ai/router');

process.env.OPENROUTER_API_KEY = 'test-key';
const app = express();
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const CLIENT = { id: 'client-1', name: 'Priya Sharma', gender: 'female', dob: '1992-05-10', pt_start_date: '2025-01-10' };
const ASSESSMENT = { id: 'assess-1', client_id: 'client-1', assessment_date: '2026-07-01', organization_id: 'org-1', weight: 71 };
const REPORT = { summary: 'steady improvement', recommendation: 'add volume' };
const DEFAULT_META = { model: 'primary-model', tier: 'primary', used_fallback: false };

/** An async iterator that yields `obj` as JSON then returns `meta`. */
function streamJson(obj, meta = DEFAULT_META) {
  let done = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (done) return Promise.resolve({ done: true, value: meta });
          done = true;
          return Promise.resolve({ done: false, value: JSON.stringify(obj) });
        },
      };
    },
  };
}

function mockProgressDB({ client = CLIENT } = {}) {
  pool.query.mockImplementation((sql) => {
    if (sql.includes('FROM pt_clients WHERE id=$1')) return Promise.resolve({ rows: client ? [client] : [] });
    if (sql.includes('FROM pt_assessments WHERE client_id=$1')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM pt_goals WHERE client_id=$1')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM weekly_checkins WHERE client_id=$1')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM strength_logs WHERE client_id=$1')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM pt_sessions WHERE client_id=$1')) return Promise.resolve({ rows: [{ total_sessions: 4, sessions_30d: 2 }] });
    if (sql.includes('FROM progress_photos WHERE client_id=$1')) return Promise.resolve({ rows: [{ total_photos: 0 }] });
    return Promise.resolve({ rows: [] });
  });
}

function mockFitnessDB({ assessment = ASSESSMENT, client = CLIENT } = {}) {
  pool.query.mockImplementation((sql) => {
    if (sql.includes('FROM pt_assessments WHERE id = $1')) return Promise.resolve({ rows: assessment ? [assessment] : [] });
    if (sql.includes('FROM pt_clients WHERE id=$1')) return Promise.resolve({ rows: client ? [client] : [] });
    if (sql.includes('FROM pt_assessments WHERE client_id=$1')) return Promise.resolve({ rows: [] }); // previous
    return Promise.resolve({ rows: [] });
  });
}

const donePayloadOf = (text) =>
  JSON.parse(text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"done"')).slice('data: '.length));
const eventTypesOf = (text) =>
  text.split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)).type);

let stopHeartbeat;
beforeEach(() => {
  stopHeartbeat = jest.fn();
  startSseHeartbeat.mockReset().mockImplementation(() => stopHeartbeat);
  pool.query.mockReset();
  routedStream.mockReset();
});

describe('POST /api/ai/progress/analyze — heartbeat lifecycle (P2-2)', () => {
  test('heartbeat starts after the client-authorization gate, before the model stream', async () => {
    mockProgressDB();
    routedStream.mockReturnValue(streamJson(REPORT));
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });
    expect(res.status).toBe(200);

    expect(startSseHeartbeat).toHaveBeenCalledTimes(1);
    expect(typeof startSseHeartbeat.mock.calls[0][0].flushHeaders).toBe('function');
    const gateOrder = pool.query.mock.invocationCallOrder[0];
    const heartbeatOrder = startSseHeartbeat.mock.invocationCallOrder[0];
    const streamOrder = routedStream.mock.invocationCallOrder[0];
    expect(gateOrder).toBeLessThan(heartbeatOrder);
    expect(heartbeatOrder).toBeLessThan(streamOrder);
  });

  test('the heartbeat is armed before the model produces its first token', async () => {
    mockProgressDB();
    routedStream.mockReturnValue(streamJson(REPORT));
    await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });

    // startSseHeartbeat ran before routedStream() was even called, so the
    // silent pre-first-token window is covered end to end.
    expect(startSseHeartbeat.mock.invocationCallOrder[0]).toBeLessThan(routedStream.mock.invocationCallOrder[0]);
  });

  test('normal stream unchanged: done event + per-chunk pings, no extra events', async () => {
    mockProgressDB();
    routedStream.mockReturnValue(streamJson(REPORT));
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain(': ping');
    const done = donePayloadOf(res.text);
    expect(done.type).toBe('done');
    expect(done.data).toEqual(REPORT);
    expect(done.model).toBe('primary-model');
    expect(done.tier).toBe('primary');
    expect(done.used_fallback).toBe(false);
    expect(eventTypesOf(res.text)).toEqual(['done']);
  });

  test('heartbeat stops on normal completion', async () => {
    mockProgressDB();
    routedStream.mockReturnValue(streamJson(REPORT));
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });
    expect(res.status).toBe(200);
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
  });

  test('heartbeat stops after a model-stream error', async () => {
    mockProgressDB();
    routedStream.mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('ALL_MODELS_FAILED')) };
      },
    });
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'client-1' });

    expect(res.text).toContain('"type":"error"');
    expect(res.text).not.toContain('"type":"done"');
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
  });

  test('a cross-tenant client never starts the heartbeat or SSE', async () => {
    mockProgressDB({ client: null });
    const res = await request(app).post('/api/ai/progress/analyze').send({ client_id: 'other-org-client' });

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(startSseHeartbeat).not.toHaveBeenCalled();
    expect(routedStream).not.toHaveBeenCalled();
    expect(res.text).not.toContain('data:');
  });
});

describe('POST /api/ai/fitness-testing/analyze — heartbeat lifecycle (P2-2)', () => {
  test('heartbeat starts after the org-scoped assessment gate, before the model stream', async () => {
    mockFitnessDB();
    routedStream.mockReturnValue(streamJson(REPORT));
    const res = await request(app).post('/api/ai/fitness-testing/analyze').send({ assessment_id: 'assess-1' });
    expect(res.status).toBe(200);

    expect(startSseHeartbeat).toHaveBeenCalledTimes(1);
    expect(typeof startSseHeartbeat.mock.calls[0][0].flushHeaders).toBe('function');
    const gateOrder = pool.query.mock.invocationCallOrder[0];
    const heartbeatOrder = startSseHeartbeat.mock.invocationCallOrder[0];
    const streamOrder = routedStream.mock.invocationCallOrder[0];
    expect(gateOrder).toBeLessThan(heartbeatOrder);
    expect(heartbeatOrder).toBeLessThan(streamOrder);
  });

  test('normal stream unchanged: done event + per-chunk pings', async () => {
    mockFitnessDB();
    routedStream.mockReturnValue(streamJson(REPORT));
    const res = await request(app).post('/api/ai/fitness-testing/analyze').send({ assessment_id: 'assess-1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain(': ping');
    const done = donePayloadOf(res.text);
    expect(done.type).toBe('done');
    expect(done.data).toEqual(REPORT);
    expect(eventTypesOf(res.text)).toEqual(['done']);
  });

  test('heartbeat stops on normal completion', async () => {
    mockFitnessDB();
    routedStream.mockReturnValue(streamJson(REPORT));
    const res = await request(app).post('/api/ai/fitness-testing/analyze').send({ assessment_id: 'assess-1' });
    expect(res.status).toBe(200);
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
  });

  test('heartbeat stops after a model-stream error', async () => {
    mockFitnessDB();
    routedStream.mockReturnValue({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('ALL_MODELS_FAILED')) };
      },
    });
    const res = await request(app).post('/api/ai/fitness-testing/analyze').send({ assessment_id: 'assess-1' });

    expect(res.text).toContain('"type":"error"');
    expect(res.text).not.toContain('"type":"done"');
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
  });

  test('a foreign assessment never starts the heartbeat or SSE', async () => {
    mockFitnessDB({ assessment: null });
    const res = await request(app).post('/api/ai/fitness-testing/analyze').send({ assessment_id: 'foreign-assess' });

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(startSseHeartbeat).not.toHaveBeenCalled();
    expect(routedStream).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1); // assessment gate only
  });
});
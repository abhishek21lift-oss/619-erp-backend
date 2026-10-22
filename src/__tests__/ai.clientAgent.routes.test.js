'use strict';
// POST /api/ai/client-agent/chat/stream — the wire contract ClientAiPanel reads.
//
// The route's job is narrow and security-relevant:
//   - refuse an unauthenticated or foreign client BEFORE the 200 SSE line,
//   - emit start → chunk* → done with the same field names as the old service,
//   - turn a terminal failure into an `error` event, and
//   - stay silent when the caller has already disconnected (499).
//
// The agent's own tenancy/fencing/billing behaviour is covered by
// ai.clientAgent.agent.test.js; this suite proves the transport.

jest.mock('../modules/pt-os/client-read.service', () => ({
  findVisibleClient: jest.fn(),
}));
jest.mock('../modules/client-agent/agent', () => ({
  ask: jest.fn(),
}));
jest.mock('../lib/sse-heartbeat', () => ({
  startSseHeartbeat: jest.fn(() => jest.fn()),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const request = require('supertest');
const express = require('express');
const read = require('../modules/pt-os/client-read.service');
const { ask } = require('../modules/client-agent/agent');
const { startSseHeartbeat } = require('../lib/sse-heartbeat');
const router = require('../routes/aiClientAgent');

const ORG = '11111111-1111-4111-8111-111111111111';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.headers.authorization === 'Bearer trainer') {
    req.user = { id: 'usr-1', role: 'trainer', organization_id: ORG };
    req.id = 'req-route-1';
  }
  next();
});
app.use('/api/ai/client-agent', router);

function events(res) {
  // Blocks carry `event: <type>` then `data: <json>`; the body's type is the
  // contract the browser parser keys on.
  return String(res.text || '')
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

beforeEach(() => {
  jest.clearAllMocks();
  read.findVisibleClient.mockResolvedValue({ id: 'c-1', name: 'Asha Rao' });
});

describe('POST /api/ai/client-agent/chat/stream — refusals before the stream', () => {
  it('returns 401 JSON without a user', async () => {
    const res = await request(app)
      .post('/api/ai/client-agent/chat/stream')
      .send({ clientId: 'c-1', message: 'hi' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NO_TOKEN');
    expect(ask).not.toHaveBeenCalled();
  });

  it('returns 404 for a client outside the caller studio, and calls no agent', async () => {
    read.findVisibleClient.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/ai/client-agent/chat/stream')
      .set('Authorization', 'Bearer trainer')
      .send({ clientId: 'foreign', message: 'summarise' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_FOUND');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(ask).not.toHaveBeenCalled();

    // The browser body never becomes the tenancy source.
    expect(read.findVisibleClient).toHaveBeenCalledWith(ORG, 'foreign');
    expect(startSseHeartbeat).not.toHaveBeenCalled();
  });

  it('rejects a malformed body before touching any client row', async () => {
    const res = await request(app)
      .post('/api/ai/client-agent/chat/stream')
      .set('Authorization', 'Bearer trainer')
      .send({ clientId: '', message: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(read.findVisibleClient).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/client-agent/chat/stream — SSE contract', () => {
  it('emits start, incremental chunks and done with the panel field names', async () => {
    ask.mockImplementation(async ({ onDelta, requestId }) => {
      const provenance = {
        clientName: 'Asha Rao',
        toolsUsed: ['getClientProfile', 'getClientSummary'],
        toolsUnavailable: [{ tool: 'getClientAttendance', reason: 'Not found, or not visible to you.' }],
      };
      onDelta('Hello', provenance);
      onDelta('Hello world', provenance);
      return {
        ok: true,
        status: 200,
        message: 'Hello world',
        clientId: 'c-1',
        clientName: 'Asha Rao',
        toolsUsed: provenance.toolsUsed,
        toolsUnavailable: provenance.toolsUnavailable,
        proposedAction: null,
        requiresConfirmation: false,
        meta: { requestId, intent: 'analysis', model: 'test/model', used_fallback: false, latency_ms: 12 },
      };
    });

    const res = await request(app)
      .post('/api/ai/client-agent/chat/stream')
      .set('Authorization', 'Bearer trainer')
      .send({ clientId: 'c-1', message: 'summarise this client' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    // The old service named each event as well as typing the JSON body.
    expect(res.text).toContain('event: start');
    expect(res.text).toContain('event: done');

    const evts = events(res);
    expect(evts.map((e) => e.type)).toEqual(['start', 'chunk', 'chunk', 'done']);
    expect(evts[0]).toMatchObject({
      clientId: 'c-1',
      clientName: 'Asha Rao',
      toolsUsed: ['getClientProfile', 'getClientSummary'],
      requestId: 'req-route-1',
    });
    expect(evts[1].content).toBe('Hello');
    expect(evts[2].content).toBe(' world');
    expect(evts[3]).toMatchObject({
      message: 'Hello world',
      clientId: 'c-1',
      proposedAction: null,
      requiresConfirmation: false,
      requestId: 'req-route-1',
    });

    // The agent receives the already-authorised client, the caller's org and
    // an abort signal — it must not re-derive identity from the body.
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      req: expect.objectContaining({ user: expect.objectContaining({ organization_id: ORG }) }),
      clientId: 'c-1',
      message: 'summarise this client',
      authorised: { id: 'c-1', name: 'Asha Rao' },
      requestId: 'req-route-1',
      signal: expect.any(AbortSignal),
    }));
    expect(startSseHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('delivers the whole answer as one chunk if the agent never streamed deltas', async () => {
    ask.mockResolvedValue({
      ok: true,
      status: 200,
      message: 'Single-shot answer',
      clientId: 'c-1',
      clientName: 'Asha Rao',
      toolsUsed: ['getClientProfile'],
      toolsUnavailable: [],
      proposedAction: null,
      requiresConfirmation: false,
      meta: {},
    });

    const res = await request(app)
      .post('/api/ai/client-agent/chat/stream')
      .set('Authorization', 'Bearer trainer')
      .send({ clientId: 'c-1', message: 'hi' });

    const evts = events(res);
    expect(evts.map((e) => e.type)).toEqual(['start', 'chunk', 'done']);
    expect(evts[1].content).toBe('Single-shot answer');
  });

  it('emits a terminal error event with partial=true after a model failure', async () => {
    ask.mockImplementation(async ({ onDelta }) => {
      onDelta('partial answer', { clientName: 'Asha Rao', toolsUsed: ['getClientProfile'], toolsUnavailable: [] });
      return {
        ok: false,
        status: 503,
        code: 'ALL_MODELS_FAILED',
        message: 'The assistant is temporarily unavailable. Please try again.',
        toolsUsed: ['getClientProfile'],
      };
    });

    const res = await request(app)
      .post('/api/ai/client-agent/chat/stream')
      .set('Authorization', 'Bearer trainer')
      .send({ clientId: 'c-1', message: 'hi' });

    const evts = events(res);
    expect(evts.map((e) => e.type)).toEqual(['start', 'chunk', 'error']);
    expect(evts[2]).toMatchObject({
      code: 'ALL_MODELS_FAILED',
      partial: true,
      status: 503,
    });
    expect(evts[2].message).not.toContain('ALL_MODELS_FAILED');
  });

  it('stays silent when the caller disconnected (499)', async () => {
    ask.mockResolvedValue({
      ok: false,
      status: 499,
      code: 'CLIENT_DISCONNECTED',
      message: 'The request was cancelled.',
      toolsUsed: [],
    });

    const res = await request(app)
      .post('/api/ai/client-agent/chat/stream')
      .set('Authorization', 'Bearer trainer')
      .send({ clientId: 'c-1', message: 'hi' });

    expect(events(res)).toEqual([]);
  });
});

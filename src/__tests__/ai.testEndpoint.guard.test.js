'use strict';
// S-3 (Phase 4A): POST /api/ai/test was the one AI surface that spent the
// provider without the meter. This file pins the guard around it:
//
//   * the intent must be one the model registry actually routes (INTENT_ROUTES)
//     — an unknown name used to fall through to 'primary' silently;
//   * the prompt is bounded in characters and the whole payload in bytes,
//     rejected BEFORE any model call;
//   * a valid request is metered exactly once (the same meteredChat path as
//     every other AI route) and keeps its response shape and 503 semantics;
//   * authentication, trainer-only admission and rate limiting stay as they
//     are at the mount (aiLimiter + requireAiQuota in server.js) — unchanged
//     and asserted in ai.privacyAndMetering.test.js.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.OPENROUTER_API_KEY = 'test-key-not-used-because-the-gate-refuses-first';

const ORG_A = '11111111-1111-4111-8111-111111111111';

jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
}));

jest.mock('../lib/ai/router', () => ({
  routedChat: jest.fn(),
  routedStream: jest.fn(async function* stream() { yield 'ok'; }),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn(async () => []) }));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn(async () => ({ contextText: '', toolNames: [] })) }));
jest.mock('../lib/ai/usage', () => ({
  logUsage: jest.fn().mockResolvedValue({ inserted: true }),
  getUserUsage: jest.fn(),
  getModelStats: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'trainer', organization_id: ORG_A };
    next();
  },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const { routedChat } = require('../lib/ai/router');
const { logUsage } = require('../lib/ai/usage');

let app;
beforeAll(async () => {
  const makeRouter = require('../routes/ai');
  const express = require('express');
  const a = express();
  a.use(express.json({ limit: '100kb' }));
  a.use('/api/ai', makeRouter);
  app = a;
});

const post = (body, headers = {}) =>
  require('supertest')(app).post('/api/ai/test').send(body).set(headers);

afterEach(() => {
  routedChat.mockReset();
  logUsage.mockClear();
});

describe('S-3: /api/ai/test refuses what it should, before any model call', () => {
  test('an intent outside the registry is a 400 and reaches no model', async () => {
    const res = await post({ intent: '这不是一个intent', prompt: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_INTENT');
    expect(routedChat).not.toHaveBeenCalled();
    expect(logUsage).not.toHaveBeenCalled();
  });

  test('an intent meant to probe must still be a registry name (e.g. "business")', async () => {
    routedChat.mockResolvedValue({ content: 'ok', model: 'm', tier: 'fallback', usage: {}, latency_ms: 4, used_fallback: false });
    const res = await post({ intent: 'business', prompt: 'hi' });
    expect(res.status).toBe(200);
  });

  test('an oversized prompt is a 413 and reaches no model', async () => {
    const res = await post({ intent: 'chat', prompt: 'x'.repeat(4001) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PROMPT_TOO_LONG');
    expect(routedChat).not.toHaveBeenCalled();
    expect(logUsage).not.toHaveBeenCalled();
  });

  test('a payload above the byte cap is a 413 even with a short prompt', async () => {
    const res = await post({ intent: 'chat', prompt: 'hi', filler: 'y'.repeat(40 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(routedChat).not.toHaveBeenCalled();
  });

  test('a non-string prompt is a 400, not a model crash', async () => {
    const res = await post({ intent: 'chat', prompt: { nested: true } });
    expect(res.status).toBe(400);
    expect(routedChat).not.toHaveBeenCalled();
  });

  test('the bare boot-check POST keeps its default prompt and is metered', async () => {
    routedChat.mockResolvedValue({
      content: 'ready', model: 'm', tier: 'primary',
      usage: {}, latency_ms: 5, used_fallback: false,
    });
    const res = await post({});
    expect(res.status).toBe(200);
    expect(routedChat).toHaveBeenCalledTimes(1);
    expect(logUsage).toHaveBeenCalledTimes(1);
  });
});

describe('S-3: a valid test call is metered exactly once', () => {
  test('one routedChat, one ledger row, response shape preserved', async () => {
    routedChat.mockResolvedValue({
      content: 'MY PT STUDIO AI is ready', model: 'm-1', tier: 'primary',
      usage: { prompt_tokens: 12, completion_tokens: 7 },
      latency_ms: 88, used_fallback: false, routed_via: null,
    });
    const res = await post({ intent: 'chat', prompt: 'Say ready' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('MY PT STUDIO AI is ready');
    expect(res.body.model).toBe('m-1');
    expect(res.body.tier).toBe('primary');
    expect(res.body.used_fallback).toBe(false);

    expect(routedChat).toHaveBeenCalledTimes(1);
    expect(routedChat.mock.calls[0][0]).toEqual(expect.objectContaining({
      intent: 'chat', max_tokens: 50, temperature: 0,
    }));

    expect(logUsage).toHaveBeenCalledTimes(1);
    const row = logUsage.mock.calls[0][0];
    expect(row).toEqual(expect.objectContaining({
      user_id: 'usr-1',
      intent_type: 'chat',
      organization_id: ORG_A,
      tokens_prompt: 12,
      tokens_completion: 7,
      usage_source: 'provider',
    }));
  });

  test('the model failing keeps the 503 gateway error and logs nothing', async () => {
    routedChat.mockRejectedValue(Object.assign(new Error('all failed'), { code: 'ALL_MODELS_FAILED' }));
    const res = await post({ intent: 'chat', prompt: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(logUsage).not.toHaveBeenCalled();
  });
});

// AI audit 2026-09-28, AI-1 and AI-3.
//
//   AI-1  every request to OpenRouter refuses providers that may store or
//         train on prompts (unless an operator explicitly allows it), and the
//         client lookup tool no longer hands a phone number to the model;
//   AI-3  the provider's exact usage and cost are requested and recorded,
//         the streaming path returns them, AI calls are rate limited per
//         user after authentication, and migration 218 turns the quota on
//         without overriding an operator's choice.
'use strict';

const fs = require('fs');
const path = require('path');

const REAL_FETCH = global.fetch;
const ENV = { ...process.env };

function okJson(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}

afterEach(() => {
  global.fetch = REAL_FETCH;
  process.env = { ...ENV };
  jest.resetModules();
});

function loadClient(env = {}) {
  process.env.AI_API_KEY = 'test-key';
  delete process.env.AI_BASE_URL;
  delete process.env.AI_ALLOW_DATA_COLLECTION;
  Object.assign(process.env, env);
  jest.resetModules();
  return require('../lib/ai/openrouter');
}

describe('AI-1: data collection is denied on every request', () => {
  test('chat completions carry provider.data_collection = deny and ask for usage', async () => {
    const { chatCompletion } = loadClient();
    let sent;
    global.fetch = jest.fn(async (_url, init) => { sent = JSON.parse(init.body); return okJson({ choices: [{ message: { content: 'hi' } }] }); });
    await chatCompletion({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
    expect(sent.provider).toEqual({ data_collection: 'deny' });
    expect(sent.usage).toEqual({ include: true });
  });

  test('streams carry it too, and return exact usage and latency', async () => {
    const { streamCompletion } = loadClient();
    let sent;
    const chunks = [
      'data: {"model":"m-1","choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}],"usage":{"prompt_tokens":1500,"completion_tokens":20,"cost":0.001}}\n\n',
      'data: [DONE]\n\n',
    ].map((c) => new TextEncoder().encode(c));
    global.fetch = jest.fn(async (_url, init) => {
      sent = JSON.parse(init.body);
      let i = 0;
      return { ok: true, body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), releaseLock() {} }) } };
    });
    const gen = streamCompletion({ model: 'auto', messages: [] });
    let step; let text = '';
    while (!(step = await gen.next()).done) text += step.value;
    expect(text).toBe('hello');
    expect(sent.provider).toEqual({ data_collection: 'deny' });
    expect(step.value.usage).toEqual({ prompt_tokens: 1500, completion_tokens: 20, cost: 0.001 });
    expect(step.value.model).toBe('m-1');
    expect(typeof step.value.latency_ms).toBe('number');
  });

  test('only an explicit operator setting allows collection', async () => {
    const { requestExtras } = loadClient({ AI_ALLOW_DATA_COLLECTION: 'true' });
    expect(requestExtras().provider).toEqual({ data_collection: 'allow' });
    const again = loadClient({ AI_ALLOW_DATA_COLLECTION: 'yes please' });
    expect(again.requestExtras().provider).toEqual({ data_collection: 'deny' });
  });

  test('a non-OpenRouter endpoint is sent no OpenRouter-only fields', () => {
    const { requestExtras } = loadClient({ AI_BASE_URL: 'https://api.example.test/v1' });
    expect(requestExtras()).toEqual({});
  });

  test('the client lookup tool does not put a phone number in the prompt', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai', 'tools.js'), 'utf8');
    expect(src).not.toMatch(/`mobile: \$\{c\.mobile\}`/);
    expect(src).not.toMatch(/SELECT name, status, mobile,/);
  });
});

describe('AI-3: metering', () => {
  test('provider usage is recorded exactly, with cost in rupees', () => {
    process.env.AI_USD_TO_INR = '85';
    const { usageFields } = require('../lib/ai/metering');
    expect(usageFields({ prompt_tokens: 3000, completion_tokens: 500, cost: 0.01 }, 'x')).toEqual({
      tokens_prompt: 3000, tokens_completion: 500, cost_inr: 0.85, usage_source: 'provider',
    });
  });

  test('without provider usage it estimates, and says so', () => {
    const { usageFields } = require('../lib/ai/metering');
    expect(usageFields(undefined, 'abcdefgh')).toEqual({
      tokens_prompt: 0, tokens_completion: 2, cost_inr: null, usage_source: 'estimated',
    });
  });

  test('meteredChat logs each call it makes', async () => {
    jest.doMock('../lib/ai/usage', () => ({ logUsage: jest.fn(async () => {}) }));
    const { meteredChat } = require('../lib/ai/metering');
    const { logUsage } = require('../lib/ai/usage');
    const chat = jest.fn(async () => ({ content: 'ok', model: 'm', usage: { prompt_tokens: 10, completion_tokens: 2 }, latency_ms: 42 }));
    const out = await meteredChat({ user: { id: 'u1' } }, 'coach', chat)({ intent: 'x' });
    expect(out.content).toBe('ok');
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u1', intent_type: 'coach', tokens_prompt: 10, tokens_completion: 2, latency_ms: 42, usage_source: 'provider',
    }));
  });
});

describe('AI-3: per-user AI rate limit', () => {
  test('the 21st model call in a minute is refused; reads are free', async () => {
    jest.doMock('../lib/rateLimitStore', () => ({ makeStore: () => undefined }));
    const { aiLimiter, AI_REQUESTS_PER_MINUTE } = require('../middleware/aiRateLimit');
    const express = require('express');
    const request = require('supertest');
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'u-limit' }; next(); });
    app.use(aiLimiter);
    app.all('/x', (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < AI_REQUESTS_PER_MINUTE; i++) {
      expect((await request(app).post('/x')).status).toBe(200);
    }
    const refused = await request(app).post('/x');
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('AI_RATE_LIMITED');
    expect((await request(app).get('/x')).status).toBe(200);
  });

  test('knowledge search is the one GET that counts', async () => {
    const { aiLimiter, AI_REQUESTS_PER_MINUTE } = require('../middleware/aiRateLimit');
    const express = require('express');
    const request = require('supertest');
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'u-search' }; next(); });
    app.use('/api/ai/knowledge', aiLimiter);
    app.get('/api/ai/knowledge/search', (_req, res) => res.json({ ok: true }));
    app.get('/api/ai/knowledge', (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < AI_REQUESTS_PER_MINUTE; i++) {
      expect((await request(app).get('/api/ai/knowledge/search')).status).toBe(200);
    }
    expect((await request(app).get('/api/ai/knowledge/search')).status).toBe(429);
    // The plain list GET on the same mount stays free.
    expect((await request(app).get('/api/ai/knowledge')).status).toBe(200);
  });

  test('it is mounted after authentication on every AI surface', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(server).toMatch(/app\.use\('\/api\/ai',\s+\.\.\.studioGate\('ai_suite'\), aiLimiter, requireAiQuota\(\)/);
    expect(server).toMatch(/\.\.\.gate\('ai_knowledge_base'\), aiLimiter, requireAiQuota\(\)/);
    const ptos = fs.readFileSync(path.join(__dirname, '..', 'modules', 'pt-os', 'pt-os.routes.js'), 'utf8');
    expect(ptos).toMatch(/'\/clients\/:id\/coach', auth, aiLimiter, requireAiQuota\(\)/);
    expect(ptos).toMatch(/'\/clients\/:id\/checkin-insight', auth, aiLimiter, requireAiQuota\(\)/);
  });
});

describe('AI-3: migration 218', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '218_ai_usage_accounting_and_quota.sql'), 'utf8');

  test('declares the usage columns without touching an existing table', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS cost_inr\s+NUMERIC\(12,6\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS usage_source TEXT/);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_source_check'\)/);
  });

  test('turns the quota on only where nobody has chosen otherwise', () => {
    expect(sql).toMatch(/SET enforcement_enabled\s+= TRUE,\s+default_monthly_tokens = 3000000/);
    expect(sql).toMatch(/WHERE default_monthly_tokens IS NULL\s+AND enforcement_enabled = FALSE/);
  });
});

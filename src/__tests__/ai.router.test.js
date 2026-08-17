// AI model router — deterministic fallback order and duplicate-model safety.
//
// Production currently configures AI_PRIMARY_MODEL == AI_SECONDARY_MODEL.
// The router must not answer that by asking the same model twice — the
// duplicate step is skipped and the chain falls through to AI_FALLBACK_MODEL.
// Order is fixed: primary → secondary → fallback (→ caller fallback).

'use strict';

jest.mock('../lib/ai/openrouter', () => ({
  chatCompletion: jest.fn(),
  streamCompletion: jest.fn(),
}));
jest.mock('../db/pool', () => ({ query: jest.fn() }));

const { chatCompletion, streamCompletion } = require('../lib/ai/openrouter');
const { routedChat, routedStream } = require('../lib/ai/router');
const { getFallbackChain } = require('../lib/ai/models');
const settings = require('../lib/ai/settings');
const logger = require('../lib/logger');

const ENV_KEYS = ['AI_PRIMARY_MODEL', 'AI_SECONDARY_MODEL', 'AI_FALLBACK_MODEL'];
const saved = {};

beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  settings.stop();
});

beforeEach(() => {
  chatCompletion.mockReset();
  streamCompletion.mockReset();
  settings._setCache(null);
  process.env.AI_PRIMARY_MODEL   = 'vendor/p';
  process.env.AI_SECONDARY_MODEL = 'vendor/s';
  process.env.AI_FALLBACK_MODEL  = 'vendor/f';
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  jest.restoreAllMocks();
});

function okResult(overrides = {}) {
  return { content: 'ok', usage: { total_tokens: 5 }, model: 'vendor/x', latency_ms: 10, ...overrides };
}

async function drain(gen) {
  const chunks = [];
  let meta;
  for (;;) {
    const r = await gen.next();
    if (r.done) { meta = r.value; break; }
    chunks.push(r.value);
  }
  return { chunks, meta };
}

async function* genOf(...chunks) {
  for (const c of chunks) yield c;
}

async function* rejectGen(err) {
  if (err) throw err;
  yield undefined; // unreachable in practice; present so require-yield is satisfied
}

describe('getFallbackChain', () => {
  it('primary falls back to secondary then fallback, in that order', () => {
    const chain = getFallbackChain('primary', 'vendor/p');
    expect(chain).toEqual([
      { model: 'vendor/s', tier: 'secondary' },
      { model: 'vendor/f', tier: 'fallback' },
    ]);
  });

  it('secondary falls back to fallback only', () => {
    expect(getFallbackChain('secondary', 'vendor/s')).toEqual([
      { model: 'vendor/f', tier: 'fallback' },
    ]);
  });

  it('fallback has no chain', () => {
    expect(getFallbackChain('fallback', 'vendor/f')).toEqual([]);
  });

  it('drops the secondary step when primary == secondary', () => {
    process.env.AI_SECONDARY_MODEL = 'vendor/p';
    expect(getFallbackChain('primary', 'vendor/p')).toEqual([
      { model: 'vendor/f', tier: 'fallback' },
    ]);
  });

  it('never returns a model already attempted', () => {
    expect(getFallbackChain('primary', 'vendor/f')).toEqual([
      { model: 'vendor/s', tier: 'secondary' },
    ]);
  });
});

describe('routedChat fallback order', () => {
  it('uses only the primary on success', async () => {
    chatCompletion.mockResolvedValue(okResult({ model: 'vendor/p' }));
    const res = await routedChat({ intent: 'chat', messages: [], timeout: 5000 });

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(chatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      model: 'vendor/p',
      timeout: 5000,
    }));
    expect(res).toMatchObject({ tier: 'primary', used_fallback: false, model: 'vendor/p' });
  });

  it('primary failure → secondary success', async () => {
    chatCompletion
      .mockRejectedValueOnce(new Error('primary boom'))
      .mockResolvedValueOnce(okResult({ model: 'vendor/s' }));

    const res = await routedChat({ intent: 'chat', messages: [] });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(chatCompletion.mock.calls.map((c) => c[0].model)).toEqual(['vendor/p', 'vendor/s']);
    expect(res).toMatchObject({ tier: 'secondary', used_fallback: true, original_error: 'primary boom' });
  });

  it('primary + secondary failure → fallback success', async () => {
    chatCompletion
      .mockRejectedValueOnce(new Error('primary boom'))
      .mockRejectedValueOnce(new Error('secondary boom'))
      .mockResolvedValueOnce(okResult({ model: 'vendor/f' }));

    const res = await routedChat({ intent: 'chat', messages: [] });

    expect(chatCompletion).toHaveBeenCalledTimes(3);
    expect(chatCompletion.mock.calls.map((c) => c[0].model)).toEqual(['vendor/p', 'vendor/s', 'vendor/f']);
    expect(res).toMatchObject({ tier: 'fallback', used_fallback: true });
  });

  it('skips the duplicate secondary and goes primary → fallback', async () => {
    process.env.AI_SECONDARY_MODEL = 'vendor/p';
    chatCompletion
      .mockRejectedValueOnce(new Error('primary boom'))
      .mockResolvedValueOnce(okResult({ model: 'vendor/f' }));

    const res = await routedChat({ intent: 'chat', messages: [] });

    // Exactly two provider calls — the same model is never asked twice.
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(chatCompletion.mock.calls.map((c) => c[0].model)).toEqual(['vendor/p', 'vendor/f']);
    expect(res).toMatchObject({ tier: 'fallback', used_fallback: true, original_error: 'primary boom' });
  });

  it('all models fail → ALL_MODELS_FAILED with per-attempt errors', async () => {
    chatCompletion
      .mockRejectedValueOnce(new Error('primary boom'))
      .mockRejectedValueOnce(new Error('secondary boom'))
      .mockRejectedValueOnce(new Error('fallback boom'));

    await expect(routedChat({ intent: 'chat', messages: [] })).rejects.toMatchObject({
      code: 'ALL_MODELS_FAILED',
      primary_error: 'primary boom',
      fallback_error: 'fallback boom',
      errors: [
        { model: 'vendor/p', error: 'primary boom' },
        { model: 'vendor/s', error: 'secondary boom' },
        { model: 'vendor/f', error: 'fallback boom' },
      ],
    });
  });

  it('duplicate config all-fail reports only the models actually called', async () => {
    process.env.AI_SECONDARY_MODEL = 'vendor/p';
    chatCompletion
      .mockRejectedValueOnce(new Error('primary boom'))
      .mockRejectedValueOnce(new Error('fallback boom'));

    await expect(routedChat({ intent: 'chat', messages: [] })).rejects.toMatchObject({
      code: 'ALL_MODELS_FAILED',
      errors: [
        { model: 'vendor/p', error: 'primary boom' },
        { model: 'vendor/f', error: 'fallback boom' },
      ],
    });
  });
});

describe('routedStream fallback order', () => {
  it('primary failure → fallback success, with the retry marker', async () => {
    process.env.AI_SECONDARY_MODEL = 'vendor/p';
    streamCompletion
      .mockImplementationOnce(() => rejectGen(new Error('stream boom')))
      .mockImplementationOnce(() => genOf('fallback-chunk'));

    const { chunks, meta } = await drain(routedStream({ intent: 'chat', messages: [] }));

    expect(streamCompletion.mock.calls.map((c) => c[0].model)).toEqual(['vendor/p', 'vendor/f']);
    expect(chunks).toEqual(['\n\n[Retrying with backup model…]\n\n', 'fallback-chunk']);
    expect(meta).toMatchObject({ tier: 'fallback', used_fallback: true });
  });

  it('primary + secondary + fallback failure → ALL_MODELS_FAILED', async () => {
    streamCompletion
      .mockImplementationOnce(() => rejectGen(new Error('p')))
      .mockImplementationOnce(() => rejectGen(new Error('s')))
      .mockImplementationOnce(() => rejectGen(new Error('f')));

    await expect(drain(routedStream({ intent: 'chat', messages: [] }))).rejects.toMatchObject({
      code: 'ALL_MODELS_FAILED',
      errors: [
        { model: 'vendor/p' },
        { model: 'vendor/s' },
        { model: 'vendor/f' },
      ],
    });
  });
});

describe('no secrets in logs', () => {
  it('fallback logs never carry the API key or authorization header', async () => {
    chatCompletion
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(okResult({ model: 'vendor/f' }));

    const info = jest.spyOn(logger, 'info');
    const warn = jest.spyOn(logger, 'warn');
    await routedChat({ intent: 'chat', messages: [] });

    const serialized = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).toContain('ai_fallback_success');
  });

  it('duplicate config is logged as ai_model_duplicate_skipped', async () => {
    process.env.AI_SECONDARY_MODEL = 'vendor/p';
    chatCompletion
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(okResult({ model: 'vendor/f' }));

    const warn = jest.spyOn(logger, 'warn');
    await routedChat({ intent: 'chat', messages: [] });

    const messages = warn.mock.calls.map((c) => c[1]);
    expect(messages).toContain('ai_model_duplicate_skipped');
  });
});
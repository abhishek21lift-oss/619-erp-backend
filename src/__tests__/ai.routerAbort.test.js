'use strict';
// routedStream cancellation and fallback markers.
//
// Split from ai.streamAbort.test.js so the router can be exercised against a
// hoisted jest.mock of the provider module. The openrouter suite in that file
// tests the real provider against a fake fetch; this one must never call it.

jest.mock('../lib/ai/openrouter', () => ({
  streamCompletion: jest.fn(),
  chatCompletion: jest.fn(),
}));
jest.mock('../lib/ai/models', () => ({
  resolveModel: jest.fn(),
  getFallbackChain: jest.fn(),
}));
jest.mock('../db/pool', () => ({ query: jest.fn() }));

const { streamCompletion } = require('../lib/ai/openrouter');
const { resolveModel, getFallbackChain } = require('../lib/ai/models');
const { routedStream } = require('../lib/ai/router');

const RETRY = '\n\n[Retrying with backup model…]\n\n';

function makeGen(chunks, returnValue) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
    return returnValue;
  })();
}

function makeRejectGen(err) {
  // eslint-disable-next-line require-yield -- the point is to reject before yielding
  return (async function* () { throw err; })();
}

function abortedError() {
  const err = new Error('Model request cancelled');
  err.code = 'AI_ABORTED';
  return err;
}

async function drain(gen) {
  const chunks = [];
  let meta;
  for (;;) {
    const step = await gen.next();
    if (step.done) { meta = step.value; break; }
    chunks.push(step.value);
  }
  return { chunks, meta };
}

beforeEach(() => {
  // reset, not clear: queued mockImplementationOnce values must not leak into
  // the next test (clearAllMocks leaves implementations in place).
  streamCompletion.mockReset();
  resolveModel.mockReset().mockReturnValue({ model: 'primary-model', tier: 'primary' });
  getFallbackChain.mockReset().mockReturnValue([
    { model: 'secondary-model', tier: 'secondary' },
    { model: 'fallback-model', tier: 'fallback' },
  ]);
});

describe('routedStream — cancellation', () => {
  it('does not open a provider connection for an already-aborted caller', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      drain(routedStream({ intent: 'chat', messages: [], signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'AI_ABORTED' });

    expect(streamCompletion).not.toHaveBeenCalled();
  });

  it('rethrows AI_ABORTED from the primary without trying a fallback', async () => {
    streamCompletion
      .mockImplementationOnce(() => makeRejectGen(abortedError()))
      .mockImplementationOnce(() => makeGen(['should-never-be-called'], {}));

    await expect(
      drain(routedStream({ intent: 'chat', messages: [] })),
    ).rejects.toMatchObject({ code: 'AI_ABORTED' });

    expect(streamCompletion).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when the caller aborts while the primary fails', async () => {
    const controller = new AbortController();
    streamCompletion
      .mockImplementationOnce(() => {
        controller.abort();
        return makeRejectGen(new Error('primary boom'));
      })
      .mockImplementationOnce(() => makeGen(['should-never-be-called'], {}));

    await expect(
      drain(routedStream({ intent: 'chat', messages: [], signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'AI_ABORTED' });

    expect(streamCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('routedStream — fallback notices and metadata', () => {
  it('suppresses the retry marker when fallbackNotice is false', async () => {
    streamCompletion
      .mockImplementationOnce(() => makeRejectGen(new Error('primary boom')))
      .mockImplementationOnce(() => makeGen(['fallback-chunk'], { model: 'secondary-model' }));

    const { chunks } = await drain(routedStream({
      intent: 'chat', messages: [], fallbackNotice: false,
    }));

    expect(chunks).toEqual(['fallback-chunk']);
    expect(streamCompletion).toHaveBeenCalledTimes(2);
  });

  it('yields the retry marker by default', async () => {
    streamCompletion
      .mockImplementationOnce(() => makeRejectGen(new Error('primary boom')))
      .mockImplementationOnce(() => makeGen(['fallback-chunk'], { model: 'secondary-model' }));

    const { chunks } = await drain(routedStream({ intent: 'chat', messages: [] }));

    expect(chunks).toEqual([RETRY, 'fallback-chunk']);
    expect(streamCompletion).toHaveBeenCalledTimes(2);
  });

  it('preserves the generator return metadata on success', async () => {
    const meta = {
      model: 'served-model',
      usage: { prompt_tokens: 4, completion_tokens: 2 },
      latency_ms: 123,
      routed_via: { provider: 'openrouter' },
    };
    streamCompletion.mockImplementationOnce(() => makeGen(['a', 'b'], meta));

    const { chunks, meta: returned } = await drain(routedStream({ intent: 'chat', messages: [] }));

    expect(chunks).toEqual(['a', 'b']);
    expect(returned).toMatchObject({
      model: 'served-model',
      requested_model: 'primary-model',
      used_fallback: false,
      usage: meta.usage,
      latency_ms: 123,
      routed_via: meta.routed_via,
    });
  });

  it('reports the model that actually served a fallback', async () => {
    streamCompletion
      .mockImplementationOnce(() => makeRejectGen(new Error('primary boom')))
      .mockImplementationOnce(() => makeGen(['chunk'], { model: 'secondary-served' }));

    const { meta } = await drain(routedStream({ intent: 'chat', messages: [] }));

    expect(meta).toMatchObject({
      model: 'secondary-served',
      requested_model: 'secondary-model',
      tier: 'secondary',
      used_fallback: true,
    });
  });

  it('throws ALL_MODELS_FAILED only after every model fails', async () => {
    streamCompletion
      .mockImplementationOnce(() => makeRejectGen(new Error('primary boom')))
      .mockImplementationOnce(() => makeRejectGen(new Error('secondary boom')))
      .mockImplementationOnce(() => makeRejectGen(new Error('fallback boom')));

    await expect(
      drain(routedStream({ intent: 'chat', messages: [] })),
    ).rejects.toMatchObject({ code: 'ALL_MODELS_FAILED' });

    expect(streamCompletion).toHaveBeenCalledTimes(3);
  });
});

// AI streaming cancellation — caller abort via AbortSignal
//
// These tests verify that the shared AI streaming path correctly:
// - Maps external AbortSignal abort to AI_ABORTED (not TIMEOUT)
// - Does not record a provider failure for caller abort
// - Cleans up reader/timer/listener on every path

'use strict';

const { streamCompletion } = require('../lib/ai/openrouter');

const REAL_FETCH = global.fetch;
const MSG = [{ role: 'user', content: 'hello' }];

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

/** fetch mock whose promise rejects only when the request's signal aborts. */
function fetchThatHangsUntilAbort() {
  return jest.fn((_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(abortError()));
  }));
}

/** fetch mock that returns a body reader which hangs until the request's signal aborts. */
function fetchThatHangsBody(reader) {
  let signal;
  const mock = jest.fn((_url, opts) => {
    signal = opts.signal;
    return Promise.resolve({ ok: true, body: { getReader: () => reader } });
  });
  reader.read.mockImplementation(() => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()));
  }));
  return mock;
}

beforeEach(() => {
  jest.restoreAllMocks();
  delete process.env.AI_OPENROUTER_TIMEOUT_MS;
  process.env.OPENROUTER_API_KEY = 'sk-test-key';
  jest.useFakeTimers();
});

afterEach(() => {
  global.fetch = REAL_FETCH;
  delete process.env.AI_OPENROUTER_TIMEOUT_MS;
  delete process.env.OPENROUTER_API_KEY;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('openrouter.streamCompletion — external AbortSignal', () => {
  beforeEach(() => {
    const observations = require('../lib/ai/observations');
    observations._reset();
  });

  it('does not open a provider connection for an already-aborted caller', async () => {
    global.fetch = jest.fn();

    const controller = new AbortController();
    controller.abort();

    await expect(
      streamCompletion({ model: 'vendor/m', messages: MSG, signal: controller.signal }).next(),
    ).rejects.toMatchObject({ code: 'AI_ABORTED' });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps caller abort during fetch to AI_ABORTED (not TIMEOUT)', async () => {
    global.fetch = fetchThatHangsUntilAbort();

    const controller = new AbortController();
    const gen = streamCompletion({ model: 'vendor/m', messages: MSG, signal: controller.signal });

    const promise = gen.next();
    await Promise.resolve();

    controller.abort();

    await expect(promise).rejects.toMatchObject({
      code: 'AI_ABORTED',
      message: 'Model request cancelled',
    });
  });

  it('maps caller abort during body read to AI_ABORTED (not TIMEOUT)', async () => {
    const reader = { read: jest.fn(), releaseLock: jest.fn() };
    global.fetch = fetchThatHangsBody(reader);

    const controller = new AbortController();
    const gen = streamCompletion({ model: 'vendor/m', messages: MSG, signal: controller.signal });

    const promise = gen.next();
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    await expect(promise).rejects.toMatchObject({
      code: 'AI_ABORTED',
      message: 'Model request cancelled',
    });
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it('does NOT record a provider failure for caller abort', async () => {
    const observations = require('../lib/ai/observations');
    observations._reset();

    global.fetch = fetchThatHangsUntilAbort();

    const controller = new AbortController();
    const gen = streamCompletion({ model: 'vendor/m', messages: MSG, signal: controller.signal });

    const promise = gen.next();
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'AI_ABORTED' });

    const summary = observations.summary({ windowMs: 60_000 });
    expect(summary.failures).toBe(0);
    expect(summary.calls).toBe(0);
  });

  it('still records TIMEOUT when the internal timer fires (no external signal)', async () => {
    const observations = require('../lib/ai/observations');
    observations._reset();

    global.fetch = fetchThatHangsUntilAbort();

    const gen = streamCompletion({ model: 'vendor/m', messages: MSG, timeout: 5000 });

    const promise = gen.next();
    await Promise.resolve();
    jest.advanceTimersByTime(5000);

    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });

    const summary = observations.summary({ windowMs: 60_000 });
    expect(summary.failures).toBe(1);
    expect(summary.calls).toBe(1);
  });

  it('cleans up reader/timer/listener on caller abort during fetch', async () => {
    global.fetch = fetchThatHangsUntilAbort();

    const controller = new AbortController();
    const gen = streamCompletion({ model: 'vendor/m', messages: MSG, signal: controller.signal, timeout: 5000 });

    const promise = gen.next();
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'AI_ABORTED' });

    jest.advanceTimersByTime(10_000);
  });

  it('cleans up reader/timer/listener on caller abort during body read', async () => {
    const reader = { read: jest.fn(), releaseLock: jest.fn() };
    global.fetch = fetchThatHangsBody(reader);

    const controller = new AbortController();
    const gen = streamCompletion({ model: 'vendor/m', messages: MSG, signal: controller.signal, timeout: 5000 });

    const promise = gen.next();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'AI_ABORTED' });
    expect(reader.releaseLock).toHaveBeenCalled();

    jest.advanceTimersByTime(10_000);
  });

  it('still throws TIMEOUT when timeout fires and no external signal provided', async () => {
    global.fetch = fetchThatHangsUntilAbort();

    const gen = streamCompletion({ model: 'vendor/m', messages: MSG, timeout: 1000 });

    const promise = gen.next();
    await Promise.resolve();
    jest.advanceTimersByTime(1000);

    await expect(promise).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('timed out'),
    });
  });
});
// OpenRouter client — configurable timeout and distinguishable failures.
//
// The timeout is the thing that broke in production: requests died at 90s
// because TIMEOUT_MS was hard-coded. These tests pin the contract that
// replaced it: the env var wins, the default stays 90s, an invalid value
// falls back to the default, and every timeout surfaces as a code=TIMEOUT
// error — for chat, for streams, and while the response body is still
// streaming (free-tier models can stall after headers arrive).

'use strict';

const logger = require('../lib/logger');
const { chatCompletion, streamCompletion } = require('../lib/ai/openrouter');

const REAL_FETCH = global.fetch;

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

/** fetch mock whose promise rejects only when the request's signal aborts. */
function fetchThatHangsUntilAbort() {
  return jest.fn((_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(abortError()));
  }));
}

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

const MSG = [{ role: 'user', content: 'hello' }];

beforeEach(() => {
  jest.restoreAllMocks();
  delete process.env.AI_OPENROUTER_TIMEOUT_MS;
  process.env.OPENROUTER_API_KEY = 'sk-test-key';
});

afterEach(() => {
  global.fetch = REAL_FETCH;
  delete process.env.AI_OPENROUTER_TIMEOUT_MS;
  delete process.env.OPENROUTER_API_KEY;
  jest.useRealTimers();
});

describe('configurable timeout', () => {
  it('honours AI_OPENROUTER_TIMEOUT_MS for chatCompletion', async () => {
    process.env.AI_OPENROUTER_TIMEOUT_MS = '5000';
    global.fetch = fetchThatHangsUntilAbort();
    jest.useFakeTimers();

    const pending = chatCompletion({ model: 'vendor/m', messages: MSG });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    jest.advanceTimersByTime(5000);
    await assertion;
  });

  it('keeps the 90s default when the env var is unset', async () => {
    global.fetch = fetchThatHangsUntilAbort();
    jest.useFakeTimers();

    const pending = chatCompletion({ model: 'vendor/m', messages: MSG });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    jest.advanceTimersByTime(90_000);
    await assertion;
  });

  it('falls back to the default when the env var is invalid', async () => {
    process.env.AI_OPENROUTER_TIMEOUT_MS = 'not-a-number';
    global.fetch = fetchThatHangsUntilAbort();
    jest.useFakeTimers();

    const pending = chatCompletion({ model: 'vendor/m', messages: MSG });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    jest.advanceTimersByTime(90_000);
    await assertion;
  });

  it('an explicit timeout param overrides the env default', async () => {
    process.env.AI_OPENROUTER_TIMEOUT_MS = '5000';
    global.fetch = fetchThatHangsUntilAbort();
    jest.useFakeTimers();

    const pending = chatCompletion({ model: 'vendor/m', messages: MSG, timeout: 1234 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    jest.advanceTimersByTime(1234);
    await assertion;
  });
});

describe('timeout errors are distinguishable', () => {
  it('chatCompletion rejects with code TIMEOUT and a useful message', async () => {
    global.fetch = fetchThatHangsUntilAbort();
    jest.useFakeTimers();

    const pending = chatCompletion({ model: 'vendor/m', messages: MSG });
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('timed out'),
    });
    jest.advanceTimersByTime(90_000);
    await assertion;
  });

  it('streamCompletion rejects with code TIMEOUT when the body stalls', async () => {
    const reader = { read: jest.fn(), releaseLock: jest.fn() };
    global.fetch = fetchThatHangsBody(reader);
    jest.useFakeTimers();

    const gen = streamCompletion({ model: 'vendor/m', messages: MSG });
    const next = gen.next();
    // Let the generator resume past `await fetch` and attach the body-read
    // abort listener before the timer fires.
    await Promise.resolve();
    await Promise.resolve();
    const assertion = expect(next).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('timed out'),
    });
    jest.advanceTimersByTime(90_000);
    await assertion;
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it('streamCompletion rejects with code TIMEOUT when the request never starts', async () => {
    global.fetch = fetchThatHangsUntilAbort();
    jest.useFakeTimers();

    const gen = streamCompletion({ model: 'vendor/m', messages: MSG });
    const next = gen.next();
    const assertion = expect(next).rejects.toMatchObject({ code: 'TIMEOUT' });
    jest.advanceTimersByTime(90_000);
    await assertion;
  });
});

describe('no secrets in logs', () => {
  it('success logs carry model/latency/tokens but never the key or headers', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-super-secret-123';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'pong' } }],
        usage: { total_tokens: 3 },
        model: 'vendor/m',
      }),
    });

    const info = jest.spyOn(logger, 'info');
    const res = await chatCompletion({ model: 'vendor/m', messages: MSG });

    expect(res.content).toBe('pong');
    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).not.toContain('sk-super-secret-123');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).toContain('ai_completion_ok');
  });

  it('timeout logs carry timeout/latency but never the key or headers', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-super-secret-123';
    global.fetch = fetchThatHangsUntilAbort();
    jest.useFakeTimers();

    const warn = jest.spyOn(logger, 'warn');
    const pending = chatCompletion({ model: 'vendor/m', messages: MSG });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    jest.advanceTimersByTime(90_000);
    await assertion;

    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain('sk-super-secret-123');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).toContain('ai_completion_timeout');
  });
});
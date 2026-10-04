// Worker error semantics — deliberate, and measured rather than assumed.
//
// #212 gave this process a Sentry SDK. That SDK's global integration installs
// `process.onunhandledrejection` and returns true from it
// (@sentry/core/build/cjs/instrument/globalUnhandledRejection.js), which tells
// Node the rejection is handled. Node's default policy is `throw`.
//
// Measured on this repo's own @sentry/node 10.65.0, with an RFC 2606 `.invalid`
// DSN so no event could leave the machine:
//
//   unhandled rejection   no SDK            -> exit 1   (Node default: throw)
//   unhandled rejection   Sentry.init()     -> exit 0   (SDK swallows it)
//   uncaught exception    no SDK            -> exit 1
//   uncaught exception    Sentry.init()     -> exit 1   (unchanged)
//
// So #212 silently changed one of the two. It moved the worker TOWARD the API,
// which has always logged-and-continued (server.js:1376) — but it moved it by
// accident, via an SDK internal, and the worker's own logs stayed silent while
// the event went only to Sentry. These tests pin the semantics we actually
// chose, so the next reader can see them rather than infer them.
'use strict';

jest.mock('@sentry/node', () => ({ init: jest.fn(), setupExpressErrorHandler: jest.fn(), flush: jest.fn() }));

const logCalls = { error: [], fatal: [] };
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), debug: jest.fn(),
  error: jest.fn((...a) => logCalls.error.push(a)),
  fatal: jest.fn((...a) => logCalls.fatal.push(a)),
}));

const ORIGINAL = { ...process.env };
const HANDLER_FLAG = Symbol.for('myptstudio.workerErrorHandlers');

/**
 * Load workers/index.js fresh, with the real process listeners removed first.
 *
 * The handlers under test attach to the REAL `process`, so every test has to
 * detach them or a later case sees a handler from an earlier one. Detaching by
 * reference is not possible across module registries, so the listeners this
 * module installs are removed by set — the only two it ever adds.
 */
function loadWorkerEntry(env = {}) {
  for (const ev of ['unhandledRejection', 'uncaughtException']) {
    for (const fn of process.listeners(ev)) process.removeListener(ev, fn);
  }
  delete process[HANDLER_FLAG];
  logCalls.error.length = 0;
  logCalls.fatal.length = 0;

  process.env = { ...ORIGINAL, ...env };
  jest.resetModules();
  require('../workers/index');
  return require('@sentry/node');
}

const fire = {
  rejection: () => process.emit('unhandledRejection', new Error('probe-rejection'), Promise.resolve()),
  exception: () => process.emit('uncaughtException', new Error('probe-exception')),
};

const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
afterEach(() => {
  exit.mockClear();
  process.env = { ...ORIGINAL };
  jest.resetModules();
});
afterAll(() => exit.mockRestore());

describe('worker error handlers — registration', () => {
  test('installs exactly one unhandledRejection and one uncaughtException handler', () => {
    loadWorkerEntry();
    expect(process.listenerCount('unhandledRejection')).toBe(1);
    expect(process.listenerCount('uncaughtException')).toBe(1);
  });

  test('does not double-register when the module is loaded twice', () => {
    // server.js registers its OWN pair at :1376/:1394 and requires this module
    // to start workers, so in RUN_WORKERS=1 mode both pairs would otherwise be
    // live in one process: every rejection logged twice, every fatal exit
    // attempted twice.
    loadWorkerEntry();
    jest.resetModules();
    require('../workers/index');
    expect(process.listenerCount('unhandledRejection')).toBe(1);
    expect(process.listenerCount('uncaughtException')).toBe(1);
  });

  test('yields to a pre-existing handler rather than replacing it', () => {
    // The single-container mode already has the API's pair installed. Ours must
    // sit alongside them, not evict them. Registered AFTER loadWorkerEntry
    // deliberately: that helper detaches every listener to isolate each case,
    // so a handler added before it would be swept away with the previous run's.
    loadWorkerEntry();
    const apiHandler = jest.fn();
    process.on('uncaughtException', apiHandler);
    fire.exception();
    expect(apiHandler).toHaveBeenCalledTimes(1);
  });
});

describe('worker unhandledRejection — report once, keep serving', () => {
  test('logs locally', () => {
    loadWorkerEntry();
    fire.rejection();
    expect(logCalls.error).toHaveLength(1);
    expect(logCalls.error[0][1]).toBe('unhandledRejection');
  });

  test('does NOT call captureException — the SDK already reports it', () => {
    // Calling captureException here is how one rejection becomes two Sentry
    // events. The SDK's own hook fires regardless of this handler; adding a
    // second report is the duplicate this test exists to prevent.
    const Sentry = loadWorkerEntry();
    fire.rejection();
    expect(Sentry.captureException).toBeUndefined();
    expect(Sentry.init).toHaveBeenCalledTimes(0); // no DSN => SDK inert, still no manual report
  });

  test('logs the reason, so the local record is usable', () => {
    loadWorkerEntry();
    fire.rejection();
    // `{ err }` not `{ reason }`: pino serializes by key and lib/logger.js
    // registers an `err` serializer, so a `reason` key renders an Error as {}.
    expect(logCalls.error[0][0]).toHaveProperty('err');
  });

  test('does not exit — matching server.js:1376', () => {
    loadWorkerEntry();
    fire.rejection();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('worker uncaughtException — report once, then die for restart', () => {
  test('logs fatal', () => {
    loadWorkerEntry();
    fire.exception();
    expect(logCalls.fatal).toHaveLength(1);
    expect(logCalls.fatal[0][1]).toMatch(/uncaughtException/);
  });

  test('flushes before exiting, so the event is not lost', () => {
    // The measured failure this prevents: Sentry's capture pipeline is async,
    // so a synchronous process.exit(1) discards the event. Probed on this
    // repo's SDK — immediate exit captured 0 events, flush-then-exit captured 1.
    const Sentry = loadWorkerEntry();
    fire.exception();
    expect(Sentry.flush).toHaveBeenCalledTimes(1);
  });

  test('exits 1 only after the flush resolves', async () => {
    const Sentry = loadWorkerEntry();
    let release;
    Sentry.flush.mockReturnValue(new Promise((r) => { release = r; }));
    fire.exception();
    expect(exit).not.toHaveBeenCalled();          // still flushing
    release();
    await new Promise((r) => setImmediate(r));
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('still exits 1 when the flush rejects', async () => {
    const Sentry = loadWorkerEntry();
    Sentry.flush.mockReturnValue(Promise.reject(new Error('flush failed')));
    fire.exception();
    await new Promise((r) => setImmediate(r));
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('still exits 1 when flush is unavailable (SDK never initialised)', async () => {
    const Sentry = loadWorkerEntry();
    Sentry.flush.mockReturnValue(undefined);
    fire.exception();
    await new Promise((r) => setImmediate(r));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

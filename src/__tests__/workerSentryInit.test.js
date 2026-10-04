// The standalone worker process initialises Sentry — or the DSN it is handed does nothing.
//
// docker-compose.yml passes SENTRY_DSN to BOTH the api and the worker service:
//   line 119  api     SENTRY_DSN: ${SENTRY_DSN:-}
//   line 189  worker  SENTRY_DSN: ${SENTRY_DSN:-}
//
// So the worker container has always received the variable. But nothing in
// src/workers/ required src/instrument.js, and that file is the only thing in
// the backend that calls Sentry.init(). The worker therefore had a DSN in its
// environment and no SDK: the var was read by nobody.
//
// That matters because of the topology. The API runs with RUN_WORKERS=0 and
// the workers run as their own container (`node src/workers/index.js`), so this
// is not the single-process case where loading instrument.js in server.js would
// have covered them incidentally. In this deployment the two are separate
// processes, and the workers own the AI queue, email delivery, WhatsApp,
// notifications and renewal billing.
//
// Requiring it at module scope (not inside startWorkers) is what makes the
// in-process case safe too: server.js already required ./instrument, and Node's
// module cache hands workers/index.js that same instance, so init() runs once
// rather than twice.
'use strict';

jest.mock('@sentry/node', () => ({ init: jest.fn(), setupExpressErrorHandler: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ORIGINAL = { ...process.env };

/**
 * Load the worker entrypoint with `env` applied, and return the Sentry mock
 * from the SAME module registry the entrypoint used.
 *
 * resetModules() re-runs the jest.mock factories, so a mock captured at file
 * scope is a different object by the time workers/index.js requires its own —
 * and every assertion here would pass vacuously.
 */
function loadWorkerEntry(env) {
  process.env = { ...ORIGINAL, ...env };
  jest.resetModules();
  require('../workers/index');
  return require('@sentry/node');
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  jest.resetModules();
});

describe('worker entrypoint and Sentry', () => {
  test('initialises the SDK when a DSN is present', () => {
    const Sentry = loadWorkerEntry({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2' });
    expect(Sentry.init).toHaveBeenCalledTimes(1);
  });

  test('passes the DSN and keeps PII out of events', () => {
    const Sentry = loadWorkerEntry({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2', NODE_ENV: 'production' });
    const arg = Sentry.init.mock.calls[0][0];
    expect(arg.dsn).toBe('https://key@o1.ingest.sentry.io/2');
    // Client health data flows through this process; default PII must stay off.
    expect(arg.sendDefaultPii).toBe(false);
    expect(arg.environment).toBe('production');
  });

  test('stays a no-op without a DSN — the pre-existing contract', () => {
    const Sentry = loadWorkerEntry({ SENTRY_DSN: '' });
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  test('initialises exactly once, so in-process mode does not double-init', () => {
    const Sentry = loadWorkerEntry({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2' });
    // server.js requires ./instrument first in that mode; the module cache must
    // make the second require a no-op rather than a second init().
    require('../instrument');
    expect(Sentry.init).toHaveBeenCalledTimes(1);
  });

  test('does not install an Express error handler — the worker serves no HTTP', () => {
    const Sentry = loadWorkerEntry({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2' });
    expect(Sentry.setupExpressErrorHandler).not.toHaveBeenCalled();
  });

  test('still exports the same surface', () => {
    process.env = { ...ORIGINAL, SENTRY_DSN: '' };
    jest.resetModules();
    const mod = require('../workers/index');
    expect(typeof mod.startWorkers).toBe('function');
    expect(typeof mod.stopWorkers).toBe('function');
  });
});

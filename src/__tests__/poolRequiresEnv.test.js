'use strict';

/**
 * pool.js must throw, not exit.
 *
 * It is a library module — every route, service and worker requires it — so a
 * process.exit() at import time takes down whatever pulled it in. In practice
 * that was the Jest worker: `npm test` on a clean checkout (no DATABASE_URL in
 * the environment) died inside an unrelated test that only wanted to mock the
 * pool, and the whole run reported a single confusing failure.
 *
 * server.js still fails fast with its own friendly message: its REQUIRED_ENV
 * block runs before anything reaches this module, which is asserted below so
 * the guarantee cannot quietly regress if the require order is reshuffled.
 */

const fs = require('fs');
const path = require('path');

describe('pool.js env guard', () => {
  const saved = process.env.DATABASE_URL;

  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    jest.resetModules();
  });

  it('throws — rather than exiting — when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit called with ${code}`);
    });

    jest.resetModules();
    expect(() => require('../db/pool')).toThrow(/DATABASE_URL is not set/);
    expect(exit).not.toHaveBeenCalled();

    exit.mockRestore();
  });

  it('loads normally when DATABASE_URL is present', () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    jest.resetModules();
    expect(() => require('../db/pool')).not.toThrow();
  });

  it('server.js validates DATABASE_URL before it requires any database-touching module', () => {
    // The friendly startup message depends on this ordering: if a require of a
    // route, service, module or the pool itself is hoisted above the
    // REQUIRED_ENV block, an operator with no DATABASE_URL gets a stack trace
    // instead of "Set them in your .env file".
    //
    // Deliberately a direct check on server.js's own requires rather than a
    // transitive walk: logger.js defers its logCapture require precisely to
    // avoid a pool cycle, and distinguishing a deferred require from a
    // top-level one needs an AST. A guard that reports false positives gets
    // deleted by the next person, so this asserts only what it can prove.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const guardAt = src.indexOf('REQUIRED_ENV');
    expect(guardAt).toBeGreaterThan(-1);

    const before = src.slice(0, guardAt);
    const risky = [...before.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)]
      .map((m) => m[1])
      .filter((r) => /^\.\/(db|routes|services|modules|middleware)\//.test(r));

    expect(risky).toEqual([]);
  });
});

'use strict';

/**
 * Migrations must be able to talk.
 *
 * Migration 174 reports the rows it could not attribute with RAISE WARNING.
 * node-postgres drops server NOTICE/WARNING on the floor unless something
 * subscribes to the 'notice' event, so that report went nowhere: the deploy
 * that ran 174 in production printed a clean "✓ applied" while four tables
 * were left nullable, and the only channel that would have said so was mute.
 *
 * These tests pin the listener, not the wording — the assertion is that a
 * WARNING raised by a migration reaches the deploy log at all.
 */

jest.mock('../db/pool', () => {
  const { EventEmitter: EE } = require('events');
  const client = new EE();
  client.release = jest.fn();
  client.query = jest.fn();
  return { connect: jest.fn(async () => client), query: jest.fn() };
});

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, readdirSync: jest.fn(), readFileSync: jest.fn() };
});

const fs = require('fs');
const pool = require('../db/pool');

describe('migrate.js surfaces what migrations report', () => {
  let client;
  let warn;
  let log;

  beforeEach(async () => {
    jest.clearAllMocks();
    client = await pool.connect();
    client.removeAllListeners('notice');

    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    log = jest.spyOn(console, 'log').mockImplementation(() => {});

    fs.readdirSync.mockReturnValue(['174_tenant_columns_for_untenanted_tables.sql']);
    fs.readFileSync.mockReturnValue('SELECT 1');

    // Advisory lock acquired, migration not yet applied, and the migration
    // body raises a WARNING the way 174 does.
    client.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ ok: true }] };
      }
      if (typeof sql === 'string' && sql.includes('FROM _migrations')) {
        return { rows: [] };
      }
      if (sql === 'SELECT 1') {
        client.emit('notice', {
          severity: 'WARNING',
          message: 'plans: 4 row(s) left nullable — no attribution signal',
        });
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it('prints a WARNING raised inside a migration', async () => {
    const { runMigrations } = require('../db/migrate');
    await runMigrations();

    const printed = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toMatch(/plans: 4 row\(s\) left nullable/);
    expect(printed).toMatch(/WARNING/);
  });

  it('does not leave the listener attached to the released client', async () => {
    const { runMigrations } = require('../db/migrate');
    await runMigrations();

    // The client goes back to the pool for ordinary request traffic; a
    // listener left behind would narrate every later NOTICE into the log.
    expect(client.listenerCount('notice')).toBe(0);
  });
});

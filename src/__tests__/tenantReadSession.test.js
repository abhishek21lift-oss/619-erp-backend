'use strict';
// pool.withTenantSession — one connection and ONE transaction for a group of
// reads, instead of BEGIN/set_config/COMMIT per statement.
//
// The dashboard loads a dozen reads. Each went through pool.query, and each of
// those paid four round trips for the transaction that puts app.org_id where
// RLS can see it. Pinning the client collapses that to one BEGIN, one
// set_config, N statements, one COMMIT — the scoping rule is unchanged, and
// the statements still run on a connection that was scoped by scopeClient.
//
// These tests use a fake client, like tenantScopedClient.test.js next door:
// the thing being checked is the order and scope of the statements, which a
// real database would hide behind a green result.

const { EventEmitter } = require('node:events');

process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://u:p@localhost:5432/db?sslmode=disable';

const pool = require('../db/pool');
const { runWithTenantContext } = require('../lib/tenant-context');

const ORG = '0a000000-0000-4000-8000-000000000001';

function fakeClient() {
  const c = new EventEmitter();
  c.log = [];
  c.released = 0;
  c.query = jest.fn((sql, params) => {
    c.log.push([String(sql), params]);
    return Promise.resolve({ rows: [] });
  });
  c.release = jest.fn(() => { c.released += 1; });
  return c;
}

/** pool.connect() as production returns it: already wrapped by scopeClient. */
function connectReturning(client, orgId = ORG) {
  return jest.fn(async () => pool.scopeClient(client, orgId, { warn: jest.fn() }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('pool.withTenantSession', () => {
  it('borrows one connection and wraps every read in a single transaction', async () => {
    const c = fakeClient();
    const origConnect = pool.connect;
    pool.connect = connectReturning(c);
    try {
      const out = await runWithTenantContext(ORG, () => pool.withTenantSession(async () => {
        await pool.query('SELECT 1');
        await pool.query('SELECT 2');
        return 'done';
      }));

      expect(out).toBe('done');
      // BEGIN → set_config (emitted by scopeClient) → the caller's reads →
      // COMMIT. No second BEGIN, no second set_config.
      expect(c.log.map(([sql]) => sql)).toEqual([
        'BEGIN',
        'SELECT set_config($1, $2, true)',
        'SELECT 1',
        'SELECT 2',
        'COMMIT',
      ]);
      expect(c.log[1][1]).toEqual(['app.org_id', ORG]);
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(c.released).toBe(1);
    } finally {
      pool.connect = origConnect;
    }
  });

  it('rolls back and releases when a read throws', async () => {
    const c = fakeClient();
    const origConnect = pool.connect;
    pool.connect = connectReturning(c);
    try {
      const boom = new Error('read failed');
      await expect(runWithTenantContext(ORG, () => pool.withTenantSession(async () => {
        await pool.query('SELECT 1');
        throw boom;
      }))).rejects.toBe(boom);

      expect(c.log.map(([sql]) => sql)).toEqual([
        'BEGIN',
        'SELECT set_config($1, $2, true)',
        'SELECT 1',
        'ROLLBACK',
      ]);
      expect(c.released).toBe(1);
    } finally {
      pool.connect = origConnect;
    }
  });

  it('falls back to the plain callback when there is no request org', async () => {
    const origConnect = pool.connect;
    pool.connect = jest.fn(() => { throw new Error('must not borrow'); });
    try {
      const fn = jest.fn(async () => 'ok');
      // Outside runWithTenantContext there is no org to scope to; pool.query
      // would not have opened a scoped transaction either.
      await expect(pool.withTenantSession(fn)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledWith(null);
      expect(pool.connect).not.toHaveBeenCalled();
    } finally {
      pool.connect = origConnect;
    }
  });

  it('joins the outer session instead of borrowing a second connection', async () => {
    const c = fakeClient();
    const origConnect = pool.connect;
    pool.connect = connectReturning(c);
    try {
      await runWithTenantContext(ORG, () => pool.withTenantSession(() =>
        pool.withTenantSession(async () => {
          await pool.query('SELECT 1');
        })));

      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(c.log.map(([sql]) => sql)).toEqual([
        'BEGIN',
        'SELECT set_config($1, $2, true)',
        'SELECT 1',
        'COMMIT',
      ]);
      expect(c.released).toBe(1);
    } finally {
      pool.connect = origConnect;
    }
  });
});

'use strict';
// pool.withTenantSession against a real database and the real app_tenant role.
//
// tenantReadSession.test.js checks statement order on a fake client. That cannot
// show two concurrent studios are kept apart, that every statement really lands
// on the pinned connection, or that a thrown read leaves the connection usable.
// This does, and skips unless RLS_TEST_DATABASE_URL points at a throwaway DB
// (scripts/rls-proof-setup.sh).

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

const ORG_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

if (DB_URL) {
  const tenantUrl = new URL(DB_URL);
  tenantUrl.username = 'app_tenant';
  tenantUrl.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
  process.env.DATABASE_URL = tenantUrl.toString();
  process.env.TENANT_RLS_ENFORCE = 'on';
  process.env.DATABASE_POOL_SIZE = '4';
}

describeIf('pool.withTenantSession, against a real database', () => {
  let owner;
  let pool;
  let runWithTenantContext;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 2 });
    await owner.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Session A','session-a'), ($2,'Session B','session-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await owner.query(
      `INSERT INTO pt_clients (id, name, organization_id)
       VALUES ('session-a','A Member',$1), ('session-b','B Member',$2)
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

    // Required after the env above is set: pool.js captures the flag and URL.
    jest.resetModules();
    pool = require('../db/pool');
    ({ runWithTenantContext } = require('../lib/tenant-context'));
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM pt_clients WHERE id IN ('session-a','session-b')`);
    await owner.query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await pool?.end();
    await owner?.end();
  });

  it('keeps two concurrent studios on their own connection and org', async () => {
    const read = (org) => runWithTenantContext(org, () => pool.withTenantSession(async () => {
      const pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // Yield so the other session starts before this one finishes.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const setting = (await pool.query("SELECT current_setting('app.org_id', true) AS org")).rows[0].org;
      const clients = (await pool.query(
        `SELECT id FROM pt_clients WHERE id IN ('session-a','session-b') ORDER BY id`)).rows.map((r) => r.id);
      return { pid, setting, clients };
    }));

    const [a, b] = await Promise.all([read(ORG_A), read(ORG_B)]);

    expect(a.setting).toBe(ORG_A);
    expect(b.setting).toBe(ORG_B);
    expect(a.clients).toEqual(['session-a']);
    expect(b.clients).toEqual(['session-b']);
    expect(a.pid).not.toBe(b.pid);
    // Both connections went back to the pool rather than leaking a checkout.
    expect(pool.idleCount).toBeGreaterThanOrEqual(2);
  });

  it('rolls back a thrown read and returns the connection to the pool', async () => {
    let pid;
    await expect(runWithTenantContext(ORG_A, () => pool.withTenantSession(async () => {
      pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await pool.query(`UPDATE pt_clients SET name = 'changed' WHERE id = 'session-a'`);
      throw new Error('read failed');
    }))).rejects.toThrow('read failed');

    const { rows } = await owner.query(`SELECT name FROM pt_clients WHERE id = 'session-a'`);
    expect(rows[0].name).toBe('A Member');

    const state = await owner.query(`SELECT state FROM pg_stat_activity WHERE pid = $1`, [pid]);
    expect(state.rows[0].state).toBe('idle');

    // A subsequent session gets a working connection instead of waiting 10s
    // on one the failed session never released.
    const value = await runWithTenantContext(ORG_A, () => pool.withTenantSession(async () =>
      (await pool.query('SELECT 1 AS ok')).rows[0].ok));
    expect(value).toBe(1);
  });
});

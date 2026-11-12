'use strict';
// Migration 272 creates the two tables push needs. Both hold credentials or
// delivery state that must never be reachable through Supabase's generated
// API, and `device_tokens` is the first new tenant table since 267.
//
// The static block catches a missing RLS statement on the branch, without a
// database. The real-database block proves the behaviour: `app_tenant` can
// only touch its own studio's tokens, and `anon` / `authenticated` cannot
// touch either table at all.
//
// The real block is skipped unless RLS_TEST_DATABASE_URL points at a
// throwaway database. `scripts/rls-proof-setup.sh` builds one.

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '272_device_tokens_push.sql'),
  'utf8'
);

const TABLES = ['device_tokens', 'push_deliveries'];

describe('migration 272 — direct-API lockout (static)', () => {
  it.each(TABLES)('enables RLS on %s', (table) => {
    expect(MIGRATION).toMatch(
      new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i')
    );
  });

  it.each(TABLES)('revokes anon and authenticated on %s', (table) => {
    expect(MIGRATION).toMatch(
      new RegExp(`REVOKE ALL ON ${table} FROM anon, authenticated`, 'i')
    );
  });

  it.each(TABLES)('adds an explicit deny-all policy on %s', (table) => {
    // Named roles and both halves: USING blocks reads, WITH CHECK blocks
    // writes. A policy that only names one half denies by accident today and
    // opens the other half the moment someone adds a permissive policy.
    expect(MIGRATION).toMatch(
      new RegExp(
        `CREATE POLICY deny_all_direct_access ON ${table}\\s+`
        + 'FOR ALL TO anon, authenticated USING \\(false\\) WITH CHECK \\(false\\)',
        'i'
      )
    );
  });

  it('scopes device_tokens to the connection tenant for app_tenant', () => {
    expect(MIGRATION).toMatch(
      /CREATE POLICY tenant_isolation ON device_tokens FOR ALL TO app_tenant\s+USING \(organization_id::text = current_setting\('app\.org_id', true\)\)\s+WITH CHECK \(organization_id::text = current_setting\('app\.org_id', true\)\)/i
    );
    expect(MIGRATION).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON device_tokens TO app_tenant/i
    );
  });

  it('does not invent a tenant policy for push_deliveries', () => {
    // The ledger has no organization_id. A policy pretending to scope it would
    // be a guess; deny-all is the honest boundary.
    expect(MIGRATION).not.toMatch(/CREATE POLICY tenant_isolation ON push_deliveries/i);
    expect(MIGRATION).toMatch(/REVOKE ALL ON push_deliveries FROM app_tenant/i);
  });

  it('grants nothing to anon or authenticated', () => {
    expect(MIGRATION).not.toMatch(/GRANT[^;]*TO\s+(anon|authenticated)/i);
  });

  it('stays idempotent', () => {
    // migrate.js applies each file once, but a manual re-run on a restored
    // branch must not fail.
    for (const t of TABLES) {
      expect(MIGRATION).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`, 'i'));
      expect(MIGRATION).toMatch(
        new RegExp(`DROP POLICY IF EXISTS deny_all_direct_access ON ${t}`, 'i')
      );
    }
    expect(MIGRATION).toMatch(/DROP POLICY IF EXISTS tenant_isolation ON device_tokens/i);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS push_opt_out/i);
  });
});

describe('application path — stays on the backend pool', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('device queries use the backend pool and filter by tenant', () => {
    const svc = read('modules/devices/devices.service.js');
    expect(svc).toMatch(/require\('\.\.\/\.\.\/db\/pool'\)/);
    // The sender's device lookup is the query that could cross a tenant if the
    // organization clause were dropped.
    expect(svc).toMatch(
      /SELECT token, app[\s\S]*FROM device_tokens[\s\S]*WHERE user_id = \$1[\s\S]*AND organization_id = \$2/i
    );
  });

  it('the push ledger uses the backend pool, not a client SDK', () => {
    const svc = read('modules/notifications/push.service.js');
    expect(svc).toMatch(/require\('\.\.\/\.\.\/db\/pool'\)/);
    expect(svc).not.toMatch(/supabase/i);
  });
});

// ── Real database ────────────────────────────────────────────────────────────

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

// Same guard as rls.isolation.integration.test.js: a missing URL is a broken
// CI wiring, not a developer running one suite without a database.
if (process.env.CI && !DB_URL) {
  describe('device token isolation, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the device isolation proof '
        + 'would silently skip. Restore the "Stand up the RLS isolation database" '
        + 'step and the env var in .github/workflows/ci.yml.'
      );
    });
  });
}

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = 'rls-device-user-a';
const USER_B = 'rls-device-user-b';
const TOKEN_A = 'rls-device-token-a';
const TOKEN_B = 'rls-device-token-b';
const DEDUPE_KEY = 'rls-device-dedupe';

describeIf('device token isolation, against a real database', () => {
  let owner;
  let tenant;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 2 });
    const tenantUrl = new URL(DB_URL);
    tenantUrl.username = 'app_tenant';
    tenantUrl.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
    tenant = new Pool({ connectionString: tenantUrl.toString(), max: 2 });

    await owner.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Device Studio A', 'rls-device-a'),
              ($2, 'Device Studio B', 'rls-device-b')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    );
    await owner.query(
      `INSERT INTO users (id, name, email, password, role, organization_id)
       VALUES ($1, 'Device A', 'rls-device-a@example.test', 'x', 'trainer', $3),
              ($2, 'Device B', 'rls-device-b@example.test', 'x', 'trainer', $4)
       ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id`,
      [USER_A, USER_B, ORG_A, ORG_B]
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM device_tokens WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(`DELETE FROM push_deliveries WHERE dedupe_key = $1`, [DEDUPE_KEY]);
    await owner.query(`DELETE FROM users WHERE id IN ($1,$2)`, [USER_A, USER_B]);
    await owner.query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner?.end();
    await tenant?.end();
  });

  beforeEach(async () => {
    await owner.query(`DELETE FROM device_tokens WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await owner.query(
      `INSERT INTO device_tokens (user_id, organization_id, token, app)
       VALUES ($1, $3, $5, 'studio'), ($2, $4, $6, 'studio')`,
      [USER_A, USER_B, ORG_A, ORG_B, TOKEN_A, TOKEN_B]
    );
    await owner.query(`DELETE FROM push_deliveries WHERE dedupe_key = $1`, [DEDUPE_KEY]);
    await owner.query(
      `INSERT INTO push_deliveries (dedupe_key, token_hash) VALUES ($1, 'rls-hash')`,
      [DEDUPE_KEY]
    );
  });

  /** Run `fn` as app_tenant with the same per-transaction GUC db/pool.js sets. */
  async function asOrg(orgId, fn) {
    const client = await tenant.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1,$2,true)', ['app.org_id', orgId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Run `fn` as anon/authenticated inside a rolled-back owner transaction. */
  async function asDirectRole(role, fn) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  it('connects as a role that cannot bypass RLS', async () => {
    const { rows } = await tenant.query(
      `SELECT current_user AS who, rolbypassrls, rolsuper
         FROM pg_roles WHERE rolname = current_user`
    );
    expect(rows[0].who).toBe('app_tenant');
    expect(rows[0].rolbypassrls).toBe(false);
    expect(rows[0].rolsuper).toBe(false);
  });

  it('the owner sees both rows, so the fixture is real', async () => {
    const { rows } = await owner.query(
      `SELECT token FROM device_tokens WHERE token IN ($1,$2) ORDER BY token`,
      [TOKEN_A, TOKEN_B]
    );
    expect(rows.map((r) => r.token)).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('SELECT returns only the scoped studio\'s tokens', async () => {
    const a = await asOrg(ORG_A, (c) =>
      c.query(`SELECT token FROM device_tokens ORDER BY token`));
    expect(a.rows.map((r) => r.token)).toEqual([TOKEN_A]);

    const b = await asOrg(ORG_B, (c) =>
      c.query(`SELECT token FROM device_tokens ORDER BY token`));
    expect(b.rows.map((r) => r.token)).toEqual([TOKEN_B]);
  });

  it('SELECT cannot reach the other studio by exact token', async () => {
    const { rows } = await asOrg(ORG_A, (c) =>
      c.query(`SELECT token FROM device_tokens WHERE token = $1`, [TOKEN_B]));
    expect(rows).toEqual([]);
  });

  it('INSERT of a token for another studio is refused', async () => {
    await expect(asOrg(ORG_A, (c) =>
      c.query(
        `INSERT INTO device_tokens (user_id, organization_id, token, app)
         VALUES ($1, $2, 'rls-smuggled', 'studio')`,
        [USER_B, ORG_B]
      ))).rejects.toThrow(/row-level security/i);

    const { rows } = await owner.query(
      `SELECT token FROM device_tokens WHERE token = 'rls-smuggled'`);
    expect(rows).toEqual([]);
  });

  it('INSERT into the scoped studio still works', async () => {
    // The other failure mode: a policy that denies everything would pass the
    // isolation assertions and break registration.
    await asOrg(ORG_A, (c) =>
      c.query(
        `INSERT INTO device_tokens (user_id, organization_id, token, app)
         VALUES ($1, $2, 'rls-own-new', 'studio')`,
        [USER_A, ORG_A]
      ));

    const { rows } = await owner.query(
      `SELECT organization_id FROM device_tokens WHERE token = 'rls-own-new'`);
    expect(rows[0].organization_id).toBe(ORG_A);
  });

  it('UPDATE of another studio\'s token changes nothing', async () => {
    const res = await asOrg(ORG_A, (c) =>
      c.query(`UPDATE device_tokens SET revoked_reason = 'HACKED' WHERE token = $1`, [TOKEN_B]));
    expect(res.rowCount).toBe(0);

    const { rows } = await owner.query(
      `SELECT revoked_reason FROM device_tokens WHERE token = $1`, [TOKEN_B]);
    expect(rows[0].revoked_reason).toBeNull();
  });

  it('DELETE of another studio\'s token removes nothing', async () => {
    const res = await asOrg(ORG_A, (c) =>
      c.query(`DELETE FROM device_tokens WHERE token = $1`, [TOKEN_B]));
    expect(res.rowCount).toBe(0);

    const { rows } = await owner.query(
      `SELECT token FROM device_tokens WHERE token = $1`, [TOKEN_B]);
    expect(rows.map((r) => r.token)).toEqual([TOKEN_B]);
  });

  it('sees nothing when app.org_id is not set', async () => {
    const client = await tenant.connect();
    try {
      const { rows } = await client.query(`SELECT token FROM device_tokens`);
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it.each(['anon', 'authenticated'])(
    '%s cannot read either table through PostgREST',
    async (role) => {
      await expect(asDirectRole(role, (c) =>
        c.query(`SELECT token FROM device_tokens`))).rejects.toThrow(/permission denied/i);
      await expect(asDirectRole(role, (c) =>
        c.query(`SELECT token_hash FROM push_deliveries`))).rejects.toThrow(/permission denied/i);
    }
  );

  it('authenticated cannot register or revoke a token directly', async () => {
    await expect(asDirectRole('authenticated', (c) =>
      c.query(
        `INSERT INTO device_tokens (user_id, organization_id, token, app)
         VALUES ($1, $2, 'rls-direct-write', 'studio')`,
        [USER_A, ORG_A]
      ))).rejects.toThrow(/permission denied/i);

    await expect(asDirectRole('authenticated', (c) =>
      c.query(`DELETE FROM device_tokens`))).rejects.toThrow(/permission denied/i);
  });

  it('app_tenant cannot read or write the push ledger', async () => {
    // push_deliveries has no tenant column; the only correct grant is none.
    const { rows } = await tenant.query(
      `SELECT has_table_privilege('app_tenant','push_deliveries','SELECT') AS can_select,
              has_table_privilege('app_tenant','push_deliveries','INSERT') AS can_insert`
    );
    expect(rows[0]).toEqual({ can_select: false, can_insert: false });
  });
});

'use strict';
// 277_ai_retrieval_log_append_only.sql — the retrieval ledger must be
// append-only for the tenant role.
//
// 232 granted SELECT and INSERT explicitly, but 157's default privileges
// granted all four to every later table. GRANT is additive, so the ledger
// inherited UPDATE and DELETE and its tenant policy was FOR ALL. This suite
// pins both halves of the fix:
//
//   * the SQL keeps the revoke and the split policies (always runs);
//   * a real PostgreSQL, connected as `app_tenant`, allows SELECT/INSERT,
//     denies UPDATE/DELETE, and still refuses cross-tenant and org-less
//     access (runs when RLS_TEST_DATABASE_URL is set).
//
// The real-database half is skipped without a throwaway database, matching
// copilot.ledger.realDb.integration.test.js. It creates its own organizations
// and removes only its own rows.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATION = path.join(
  __dirname, '..', 'db', 'migrations', '277_ai_retrieval_log_append_only.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');
const body = sql.replace(/--[^\n]*/g, ' ');

describe('277_ai_retrieval_log_append_only.sql', () => {
  it('is read, so nothing below can pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(400);
  });

  it('revokes all tenant privileges and grants back only SELECT and INSERT', () => {
    expect(body).toMatch(/REVOKE ALL ON public\.ai_retrieval_log FROM app_tenant/i);
    expect(body).toMatch(/GRANT SELECT, INSERT ON public\.ai_retrieval_log TO app_tenant/i);
    expect(body).not.toMatch(/GRANT ALL/i);
    expect(body).not.toMatch(/GRANT[^;]*UPDATE[^;]*ai_retrieval_log/i);
    expect(body).not.toMatch(/GRANT[^;]*DELETE[^;]*ai_retrieval_log/i);
  });

  it('replaces the FOR ALL tenant policy with SELECT and INSERT policies', () => {
    expect(body).toMatch(/DROP POLICY IF EXISTS ai_retrieval_log_tenant ON public\.ai_retrieval_log/i);
    expect(body).toMatch(/CREATE POLICY ai_retrieval_log_tenant_select[\s\S]*?FOR SELECT TO app_tenant/i);
    expect(body).toMatch(/CREATE POLICY ai_retrieval_log_tenant_insert[\s\S]*?FOR INSERT TO app_tenant/i);
    expect(body).not.toMatch(/FOR ALL TO app_tenant/i);
  });

  it('keeps the deny-all policy and touches only this table', () => {
    expect(body).not.toMatch(/DROP POLICY[^;]*deny_all_direct_access/i);
    expect(body).not.toMatch(/UPDATE\s+public\.ai_retrieval_log/i);
    expect(body).not.toMatch(/DELETE\s+FROM\s+public\.ai_retrieval_log/i);
    expect(body).not.toMatch(/TRUNCATE/i);
  });

  it('has no transaction control — migrate.js owns the transaction', () => {
    expect(body).not.toMatch(/\bBEGIN\b/i);
    expect(body).not.toMatch(/\bCOMMIT\b/i);
    expect(body).not.toMatch(/\bROLLBACK\b/i);
  });
});

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('277 retrieval-log append-only proof', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the 277 append-only proof '
        + 'would silently skip. Restore the "Stand up the RLS isolation database" '
        + 'step and the env var in .github/workflows/ci.yml.'
      );
    });
  });
}

// Distinct from the fixtures owned by rls.isolation and the M3 ledger suite.
const ORG_A = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';
const ORG_B = 'f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6';

const TENANT_URL = DB_URL
  ? (() => {
      const url = new URL(DB_URL);
      url.username = 'app_tenant';
      url.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
      return url.toString();
    })()
  : null;

jest.setTimeout(30000);

describeIf('277 retrieval-log append-only proof, against a real database', () => {
  let owner;
  let tenant;

  const countAll = async () => {
    const { rows } = await owner.query('SELECT count(*)::int AS n FROM ai_retrieval_log');
    return rows[0].n;
  };

  const asOrg = async (orgId, fn) => {
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
  };

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 2 });
    tenant = new Pool({ connectionString: TENANT_URL, max: 2 });
    await owner.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1,'277 Studio A','277-studio-a'), ($2,'277 Studio B','277-studio-b')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B],
    );
  });

  afterAll(async () => {
    await owner.query(
      'DELETE FROM ai_retrieval_log WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B],
    );
    await owner.query('DELETE FROM organizations WHERE id IN ($1,$2)', [ORG_A, ORG_B]);
    await owner?.end();
    await tenant?.end();
  });

  beforeEach(async () => {
    await owner.query(
      'DELETE FROM ai_retrieval_log WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B],
    );
  });

  it('grants SELECT and INSERT only, and no role membership widens it', async () => {
    const { rows: priv } = await owner.query(
      `SELECT has_table_privilege('app_tenant','public.ai_retrieval_log','SELECT') AS sel,
              has_table_privilege('app_tenant','public.ai_retrieval_log','INSERT') AS ins,
              has_table_privilege('app_tenant','public.ai_retrieval_log','UPDATE') AS upd,
              has_table_privilege('app_tenant','public.ai_retrieval_log','DELETE') AS del`,
    );
    expect(priv[0]).toEqual({ sel: true, ins: true, upd: false, del: false });

    const { rows: memberships } = await owner.query(
      `SELECT count(*)::int AS n
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = 'app_tenant'`,
    );
    expect(memberships[0].n).toBe(0);
  });

  it('has SELECT and INSERT policies for app_tenant, never FOR ALL', async () => {
    const { rows } = await owner.query(
      `SELECT policyname, cmd, roles::text
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'ai_retrieval_log'
        ORDER BY policyname`,
    );
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyname: 'ai_retrieval_log_tenant_select', cmd: 'SELECT' }),
      expect.objectContaining({ policyname: 'ai_retrieval_log_tenant_insert', cmd: 'INSERT' }),
      expect.objectContaining({ policyname: 'deny_all_direct_access', cmd: 'ALL' }),
    ]));
    expect(rows.filter((r) => r.cmd === 'ALL' && r.roles.includes('app_tenant'))).toEqual([]);
  });

  it('allows a same-tenant insert and read, and preserves every existing row', async () => {
    const before = await countAll();

    const inserted = await asOrg(ORG_A, (c) =>
      c.query(
        `INSERT INTO ai_retrieval_log (organization_id, route, result, top_k)
         VALUES ($1,'277-proof','ok',3) RETURNING id`,
        [ORG_A],
      ));
    expect(inserted.rows).toHaveLength(1);

    const read = await asOrg(ORG_A, (c) =>
      c.query('SELECT id FROM ai_retrieval_log WHERE id = $1', [inserted.rows[0].id]));
    expect(read.rows).toHaveLength(1);

    expect(await countAll()).toBe(before + 1);
    await owner.query('DELETE FROM ai_retrieval_log WHERE id = $1', [inserted.rows[0].id]);
    expect(await countAll()).toBe(before);
  });

  it('denies UPDATE and DELETE of the tenant\'s own row', async () => {
    const { rows } = await owner.query(
      `INSERT INTO ai_retrieval_log (organization_id, route, result, top_k)
       VALUES ($1,'277-proof','ok',3) RETURNING id`, [ORG_A],
    );
    const id = rows[0].id;

    await expect(asOrg(ORG_A, (c) =>
      c.query(`UPDATE ai_retrieval_log SET route = 'changed' WHERE id = $1`, [id])))
      .rejects.toThrow(/permission denied/i);

    await expect(asOrg(ORG_A, (c) =>
      c.query('DELETE FROM ai_retrieval_log WHERE id = $1', [id])))
      .rejects.toThrow(/permission denied/i);

    const { rows: after } = await owner.query(
      'SELECT route FROM ai_retrieval_log WHERE id = $1', [id],
    );
    expect(after).toEqual([{ route: '277-proof' }]);
  });

  it('refuses cross-tenant reads and writes', async () => {
    const { rows } = await owner.query(
      `INSERT INTO ai_retrieval_log (organization_id, route, result, top_k)
       VALUES ($1,'277-other','ok',3) RETURNING id`, [ORG_B],
    );
    const otherId = rows[0].id;

    const read = await asOrg(ORG_A, (c) =>
      c.query('SELECT id FROM ai_retrieval_log WHERE id = $1', [otherId]));
    expect(read.rows).toEqual([]);

    await expect(asOrg(ORG_A, (c) =>
      c.query(
        `INSERT INTO ai_retrieval_log (organization_id, route, result, top_k)
         VALUES ($1,'277-smuggled','ok',3)`, [ORG_B])))
      .rejects.toThrow(/row-level security/i);
  });

  it('denies reads and writes when no organization is set', async () => {
    const client = await tenant.connect();
    try {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM ai_retrieval_log');
      expect(rows[0].n).toBe(0);
      await expect(client.query(
        `INSERT INTO ai_retrieval_log (organization_id, route, result, top_k)
         VALUES ($1,'277-no-org','ok',3)`, [ORG_A]))
        .rejects.toThrow(/row-level security/i);
    } finally {
      client.release();
    }
  });
});

'use strict';
// M3 — the append-only tool ledger, proven against a real PostgreSQL as the
// real `app_tenant` role.
//
// Phase 4.1 found two defects that the mock/static suites could not see:
//
//   1. migration 157's default privileges gave `app_tenant` UPDATE and DELETE
//      on every new table, so 275's `GRANT SELECT, INSERT` did not make the
//      ledger append-only;
//   2. the ledger's `ON CONFLICT DO UPDATE` needs the UPDATE privilege that
//      append-only is supposed to deny, so retries silently became audit gaps.
//
// This suite is the regression test for both. It inspects effective
// privileges with `has_table_privilege`, attempts the four table operations as
// `app_tenant`, and runs the actual `recordToolRun` through db/pool.js with a
// tenant context — no mocked pool.
//
// Skipped unless RLS_TEST_DATABASE_URL points at a throwaway database. Stand
// one up with `scripts/rls-proof-setup.sh`.

const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('M3 ledger append-only proof', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the M3 append-only proof '
        + 'would silently skip. Restore the "Stand up the RLS isolation database" '
        + 'step and the env var in .github/workflows/ci.yml.'
      );
    });
  });
}

// Distinct from rls.isolation.integration.test.js, which runs in another Jest
// worker against the same database and owns the aaaa…/bbbb… fixtures.
const ORG_A = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const ORG_B = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const USER_A = 'm3-ledger-owner';
const USER_B = 'm3-ledger-other';

// db/pool.js reads DATABASE_URL at module load. Point it at app_tenant for this
// file only, so recordToolRun runs under the same role the cutover will use.
const TENANT_URL = DB_URL
  ? (() => {
      const url = new URL(DB_URL);
      url.username = 'app_tenant';
      url.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
      return url.toString();
    })()
  : null;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalEnforce = process.env.TENANT_RLS_ENFORCE;

if (TENANT_URL) {
  process.env.DATABASE_URL = TENANT_URL;
  process.env.TENANT_RLS_ENFORCE = 'on';
}

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../lib/logger');
const { runWithTenantContext } = require('../lib/tenant-context');
const ledger = TENANT_URL ? require('../modules/copilot/tools/ledger') : null;
const appPool = TENANT_URL ? require('../db/pool') : null;

jest.setTimeout(30000);

describeIf('M3 ledger append-only proof, against a real database', () => {
  let owner;
  let tenant;

  const entry = (overrides = {}) => ({
    organizationId: ORG_A,
    userId: USER_A,
    conversationId: null,
    messageId: null,
    correlationId: randomUUID(),
    toolName: 'get_client_profile',
    level: 'READ',
    sensitivity: 'personal',
    argsDigest: 'digest-1',
    argsMeta: { limit: 10 },
    ok: true,
    code: null,
    durationMs: 5,
    ordinal: 0,
    selectionReason: 'profile_intent',
    ...overrides,
  });

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
    owner = new Pool({ connectionString: DB_URL, max: 4 });
    tenant = new Pool({ connectionString: TENANT_URL, max: 4 });

    await owner.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1,'M3 Studio A','m3-studio-a'), ($2,'M3 Studio B','m3-studio-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await owner.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, is_active)
       VALUES ($1,'M3 Owner','m3-owner@test.invalid','!x','trainer',$3,TRUE),
              ($2,'M3 Other','m3-other@test.invalid','!x','trainer',$4,TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [USER_A, USER_B, ORG_A, ORG_B]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM ai_tool_runs WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
      await owner.query('DELETE FROM users WHERE id IN ($1,$2)', [USER_A, USER_B]);
      await owner.query('DELETE FROM organizations WHERE id IN ($1,$2)', [ORG_A, ORG_B]);
    }
    await appPool?.end();
    await tenant?.end();
    await owner?.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalEnforce === undefined) delete process.env.TENANT_RLS_ENFORCE;
    else process.env.TENANT_RLS_ENFORCE = originalEnforce;
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM ai_tool_runs WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    logger.warn.mockClear();
  });

  describe('effective privileges', () => {
    it('app_tenant can SELECT and INSERT but not UPDATE or DELETE', async () => {
      const { rows } = await owner.query(
        `SELECT has_table_privilege('app_tenant','public.ai_tool_runs','SELECT') AS sel,
                has_table_privilege('app_tenant','public.ai_tool_runs','INSERT') AS ins,
                has_table_privilege('app_tenant','public.ai_tool_runs','UPDATE') AS upd,
                has_table_privilege('app_tenant','public.ai_tool_runs','DELETE') AS del`);
      expect(rows[0]).toEqual({ sel: true, ins: true, upd: false, del: false });
    });

    it('app_tenant is not a member of a role that re-grants write access', async () => {
      const { rows } = await owner.query(
        `SELECT g.rolname
           FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.member
           JOIN pg_roles g ON g.oid = m.roleid
          WHERE r.rolname = 'app_tenant'`);
      expect(rows).toEqual([]);
    });

    it('SELECT on its own tenant works', async () => {
      await owner.query(
        `INSERT INTO ai_tool_runs (organization_id, user_id, correlation_id, run_key, tool_name, args_digest, status)
         VALUES ($1,$2,'corr-read','key-read','get_client_profile','digest','ok')`,
        [ORG_A, USER_A]);

      const { rows } = await asOrg(ORG_A, (c) =>
        c.query(`SELECT run_key FROM ai_tool_runs WHERE run_key = 'key-read'`));
      expect(rows.map((r) => r.run_key)).toEqual(['key-read']);
    });

    it('INSERT into its own tenant works', async () => {
      await asOrg(ORG_A, (c) => c.query(
        `INSERT INTO ai_tool_runs (organization_id, user_id, correlation_id, run_key, tool_name, args_digest, status)
         VALUES ($1,$2,'corr-insert','key-insert','get_client_profile','digest','ok')`,
        [ORG_A, USER_A]));

      const { rows } = await owner.query(`SELECT count(*)::int AS n FROM ai_tool_runs WHERE run_key = 'key-insert'`);
      expect(rows[0].n).toBe(1);
    });

    it('UPDATE is refused by the table privilege, not the policy', async () => {
      await owner.query(
        `INSERT INTO ai_tool_runs (organization_id, user_id, correlation_id, run_key, tool_name, args_digest, status)
         VALUES ($1,$2,'corr-upd','key-upd','get_client_profile','digest','ok')`,
        [ORG_A, USER_A]);

      await expect(asOrg(ORG_A, (c) =>
        c.query(`UPDATE ai_tool_runs SET duration_ms = 9 WHERE run_key = 'key-upd'`)))
        .rejects.toThrow(/permission denied for table ai_tool_runs/i);
    });

    it('DELETE is refused by the table privilege, not the policy', async () => {
      await owner.query(
        `INSERT INTO ai_tool_runs (organization_id, user_id, correlation_id, run_key, tool_name, args_digest, status)
         VALUES ($1,$2,'corr-del','key-del','get_client_profile','digest','ok')`,
        [ORG_A, USER_A]);

      await expect(asOrg(ORG_A, (c) =>
        c.query(`DELETE FROM ai_tool_runs WHERE run_key = 'key-del'`)))
        .rejects.toThrow(/permission denied for table ai_tool_runs/i);
    });
  });

  describe('RLS', () => {
    beforeEach(async () => {
      await owner.query(
        `INSERT INTO ai_tool_runs (organization_id, user_id, correlation_id, run_key, tool_name, args_digest, status)
         VALUES ($1,$2,'corr-a','key-a','get_client_profile','digest','ok'),
                ($3,$4,'corr-b','key-b','get_client_profile','digest','ok')`,
        [ORG_A, USER_A, ORG_B, USER_B]);
    });

    it('does not read another tenant row', async () => {
      const { rows } = await asOrg(ORG_A, (c) =>
        c.query(`SELECT run_key FROM ai_tool_runs WHERE run_key IN ('key-a','key-b') ORDER BY run_key`));
      expect(rows.map((r) => r.run_key)).toEqual(['key-a']);

      const { rows: all } = await owner.query(
        `SELECT run_key FROM ai_tool_runs WHERE run_key IN ('key-a','key-b') ORDER BY run_key`);
      expect(all.map((r) => r.run_key)).toEqual(['key-a', 'key-b']);
    });

    it('refuses an INSERT stamped with another tenant', async () => {
      await expect(asOrg(ORG_A, (c) => c.query(
        `INSERT INTO ai_tool_runs (organization_id, user_id, correlation_id, run_key, tool_name, args_digest, status)
         VALUES ($1,$2,'corr-smuggle','key-smuggle','get_client_profile','digest','ok')`,
        [ORG_B, USER_B]))).rejects.toThrow(/row-level security/i);

      const { rows } = await owner.query(`SELECT 1 FROM ai_tool_runs WHERE run_key = 'key-smuggle'`);
      expect(rows).toEqual([]);
    });

    it('the ledger itself refuses a cross-tenant write and reports no record', async () => {
      const e = entry({ organizationId: ORG_B, userId: USER_B });
      const result = await runWithTenantContext(ORG_A, () => ledger.recordToolRun(e));

      expect(result).toEqual({ recorded: false, run_id: null, duplicate: false });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'get_client_profile' }),
        'copilot_tool_ledger_write_failed',
      );

      const { rows } = await owner.query(
        'SELECT 1 FROM ai_tool_runs WHERE correlation_id = $1', [e.correlationId]);
      expect(rows).toEqual([]);
    });
  });

  describe('idempotency through the real ledger code', () => {
    it('records one row and returns its id', async () => {
      const e = entry();
      const result = await runWithTenantContext(ORG_A, () => ledger.recordToolRun(e));

      expect(result.recorded).toBe(true);
      expect(result.duplicate).toBe(false);
      expect(result.run_id).toEqual(expect.any(String));

      const { rows } = await owner.query(
        'SELECT id, run_key FROM ai_tool_runs WHERE organization_id = $1', [ORG_A]);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(result.run_id);
    });

    it('a retry returns the original id and does not mutate the row', async () => {
      const e = entry();
      const first = await runWithTenantContext(ORG_A, () => ledger.recordToolRun(e));

      const second = await runWithTenantContext(ORG_A, () =>
        ledger.recordToolRun({ ...e, ok: false, code: 'TOOL_FAILED', durationMs: 999 }));

      expect(second).toEqual({ recorded: true, run_id: first.run_id, duplicate: true });

      const { rows } = await owner.query(
        'SELECT id, status, error_code, duration_ms FROM ai_tool_runs WHERE organization_id = $1', [ORG_A]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first.run_id, status: 'ok', error_code: null, duration_ms: 5 });
    });

    it('concurrent callers all get the same id and only one row exists', async () => {
      const e = entry();
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        runWithTenantContext(ORG_A, () => ledger.recordToolRun(e))));

      expect(results.every((r) => r.recorded)).toBe(true);
      expect(new Set(results.map((r) => r.run_id)).size).toBe(1);

      const { rows } = await owner.query(
        'SELECT count(*)::int AS n FROM ai_tool_runs WHERE organization_id = $1', [ORG_A]);
      expect(rows[0].n).toBe(1);
    });
  });
});

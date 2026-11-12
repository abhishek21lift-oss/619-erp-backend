'use strict';
// F2 — the boot preflight must measure the connection the application really
// uses, against a real PostgreSQL with two real roles.
//
// Phase 4.3D ran the check through the routed `db/pool` export. At boot there
// is no request context, `isPlatformWide()` is true, and the routed query
// lands on the owner pool — so a correctly cut-over box reported
// `tenant_role=postgres` and could never claim enforcement it actually had.
// These tests use the diagnostic handles server.js now passes and assert the
// roles the database hands back, not the ones a connection string asked for.
//
// Skipped unless RLS_TEST_DATABASE_URL points at a disposable/staging database
// with an `app_tenant` login. RLS_TEST_TENANT_PASSWORD supplies its password.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('RLS preflight real-database proof', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI');
    });
  });
}

const TENANT_URL = DB_URL
  ? (() => {
      const url = new URL(DB_URL);
      url.username = 'app_tenant';
      url.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
      return url.toString();
    })()
  : null;

const original = {
  DATABASE_URL: process.env.DATABASE_URL,
  ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
  TENANT_RLS_ENFORCE: process.env.TENANT_RLS_ENFORCE,
};

if (TENANT_URL) {
  process.env.DATABASE_URL = TENANT_URL;
  process.env.ADMIN_DATABASE_URL = DB_URL;
  process.env.TENANT_RLS_ENFORCE = 'on';
}

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

const appPool = TENANT_URL ? require('../db/pool') : null;
const { verifyRlsPosture, inspectConnection } = TENANT_URL
  ? require('../db/rlsPreflight')
  : {};
const { setRlsPosture, rlsHealthField } = TENANT_URL ? require('../lib/health') : {};

jest.setTimeout(60000);

describeIf('RLS preflight against a real database', () => {
  let owner;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 4 });
  });

  afterAll(async () => {
    await appPool?.end();
    const ownerDiag = appPool?.ownerPoolForDiagnostics?.();
    if (ownerDiag && ownerDiag !== appPool) await ownerDiag.end().catch(() => {});
    await owner?.end();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('the tenant diagnostic handle reports app_tenant, the owner handle postgres', async () => {
    const tenantDiag = appPool.tenantPoolForDiagnostics();
    const ownerDiag = appPool.ownerPoolForDiagnostics();

    expect(await inspectConnection(tenantDiag)).toMatchObject({
      role: 'app_tenant', bypasses_rls: false, is_superuser: false,
    });
    expect(await inspectConnection(ownerDiag)).toMatchObject({
      role: 'postgres', bypasses_rls: true,
    });
  });

  test('a correctly cut-over pair verifies clean and says which pools were checked', async () => {
    const result = await verifyRlsPosture({
      tenantPool: appPool.tenantPoolForDiagnostics(),
      ownerPool: appPool.ownerPoolForDiagnostics(),
      env: { TENANT_RLS_ENFORCE: 'on' },
    });
    setRlsPosture(result);

    expect(result.findings).toEqual([]);
    expect(result.enforced).toBe(true);
    expect(result.tenant).toMatchObject({ role: 'app_tenant', bypasses_rls: false });
    expect(result.owner).toMatchObject({ role: 'postgres', bypasses_rls: true });
    expect(result.probe.isolated).toBe(true);

    const field = rlsHealthField();
    expect(field).toMatchObject({
      posture: 'on',
      enforced: true,
      tenant_checked: true,
      owner_checked: true,
      tenant_bypasses_rls: false,
    });
    // The unauthenticated payload still names no role.
    expect(JSON.stringify(field)).not.toMatch(/postgres|app_tenant|password|@|rolbypassrls/);
  });

  test('measuring the owner connection as the tenant is reported, not hidden', async () => {
    const ownerAsTenant = { query: (...a) => owner.query(...a), connect: (...a) => owner.connect(...a) };

    const result = await verifyRlsPosture({
      tenantPool: ownerAsTenant,
      ownerPool: appPool.tenantPoolForDiagnostics(),
      env: { TENANT_RLS_ENFORCE: 'on' },
    });

    expect(result.findings.map((f) => f.code)).toContain('tenant_connection_bypasses_rls');
    expect(result.enforced).toBe(false);
  });

  test('the preflight changes no role attributes, policies or grants', async () => {
    const snapshot = async () => {
      const roles = await owner.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
           FROM pg_roles ORDER BY rolname`
      );
      const policies = await owner.query(
        `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`
      );
      const grants = await owner.query(
        `SELECT has_table_privilege('app_tenant','public.pt_clients','SELECT') AS sel,
                has_table_privilege('app_tenant','public.pt_clients','UPDATE') AS upd,
                has_table_privilege('app_tenant','public.pt_clients','DELETE') AS del,
                has_table_privilege('app_tenant','public.ai_conversations','INSERT') AS conv_ins,
                has_table_privilege('app_tenant','public.ai_tool_runs','INSERT') AS tool_ins`
      );
      return { roles: roles.rows, policies: policies.rows[0].n, grants: grants.rows[0] };
    };

    const before = await snapshot();
    await verifyRlsPosture({
      tenantPool: appPool.tenantPoolForDiagnostics(),
      ownerPool: appPool.ownerPoolForDiagnostics(),
      env: { TENANT_RLS_ENFORCE: 'on' },
    });
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  test('the existing database health path still answers through the routed pool', async () => {
    const { rows } = await appPool.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
    expect(rlsHealthField().tenant_checked).toBe(true);
  });
});

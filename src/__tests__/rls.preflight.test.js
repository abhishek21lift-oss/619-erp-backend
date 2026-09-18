// The check that asks the DATABASE whether tenant isolation is real.
//
// ── The production state these tests encode ────────────────────────────────
//
// Measured against the live `619-erp` project, not assumed:
//
//   · `app_tenant` exists — LOGIN, NOSUPERUSER, NOBYPASSRLS, password set
//   · RLS is enabled on all 153 public tables; 141 policies name app_tenant
//   · pg_stat_activity shows five `postgres` backends serving traffic through
//     Supavisor and zero app_tenant connections, ever
//   · `postgres` reports rolbypassrls = true
//   · scoping to an organization with 16 pt_clients returned all 38 rows in
//     the table — the whole point, demonstrated rather than argued
//
// So every policy is inert while the per-query BEGIN/set_config/COMMIT wrapper
// still runs. server.js's existing guard could not see it: it compares two
// connection STRINGS, and two different strings can authenticate as the same
// privileged role. Only the database knows which role it handed out.
//
// Each test below is one of those facts, run against a fake pool that answers
// the way production does.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const { verifyRlsPosture, enforceRlsPostureAtBoot } = require('../db/rlsPreflight');

/**
 * A pool that answers the preflight's four queries.
 *
 * Driven by role facts and row counts rather than by SQL matching, so a test
 * reads as the database state it describes.
 */
function fakePool({ role, bypasses = false, superuser = false, policies = 141, counts }) {
  const client = {
    query: async (sql, params) => {
      if (/^BEGIN|^ROLLBACK|^COMMIT/.test(sql)) return { rows: [] };
      if (/set_config/.test(sql)) {
        client._org = params[1];
        return { rows: [{ set_config: params[1] }] };
      }
      if (/count\(\*\)::int AS n FROM pt_clients/.test(sql)) {
        const n = client._org == null ? counts.total : (counts[client._org] ?? counts.total);
        return { rows: [{ n }] };
      }
      throw new Error(`fakePool client: unexpected SQL ${sql}`);
    },
    release: () => {},
  };
  return {
    query: async (sql) => {
      if (/current_database/.test(sql)) {
        return { rows: [{ role, bypasses_rls: bypasses, is_superuser: superuser, database: 'postgres' }] };
      }
      if (/pg_policy/.test(sql)) return { rows: [{ n: policies }] };
      if (/FROM organizations/.test(sql)) {
        return { rows: counts.orgs.map((id) => ({ id })) };
      }
      // The unscoped total, read on the owner pool. A pool answers it directly
      // rather than through a borrowed client, which is what the real
      // countTotal does — see the comment on probeIsolation for why this
      // measurement cannot come off the tenant connection.
      if (/count\(\*\)::int AS n FROM pt_clients/.test(sql)) {
        return { rows: [{ n: counts.total }] };
      }
      throw new Error(`fakePool: unexpected SQL ${sql}`);
    },
    connect: async () => { client._org = null; return client; },
  };
}

const ORG_A = '4a11e8ce-907b-4437-a3c8-27024f66531a';
const ORG_B = '634ca71a-c68a-44e3-ad99-7d0777f96be3';

/** Production as measured today: postgres, bypassing, scoping does nothing. */
const productionToday = () => fakePool({
  role: 'postgres', bypasses: true,
  counts: { orgs: [ORG_A, ORG_B], total: 38, [ORG_A]: 38, [ORG_B]: 38 },
});

/** The cut-over box: app_tenant, not bypassing, scoping actually filters. */
const afterCutover = () => fakePool({
  role: 'app_tenant', bypasses: false,
  counts: { orgs: [ORG_A, ORG_B], total: 38, [ORG_A]: 18, [ORG_B]: 16 },
});

const codes = (r) => r.findings.map((f) => f.code);

describe('the finding this module exists for', () => {
  test('a bypassing tenant connection is fatal, however the URLs are written', async () => {
    const tenant = productionToday();
    // Two DIFFERENT connection strings, both landing on `postgres` — the exact
    // shape server.js's string comparison passes and this check does not.
    const owner = fakePool({ role: 'postgres', bypasses: true, counts: { orgs: [], total: 0 } });

    const result = await verifyRlsPosture({
      tenantPool: tenant, ownerPool: owner, env: { TENANT_RLS_ENFORCE: 'on' },
    });

    expect(codes(result)).toContain('tenant_connection_bypasses_rls');
    expect(codes(result)).toContain('owner_and_tenant_are_one_role');
    expect(result.enforced).toBe(false);
  });

  test('the live probe reports scoping that does not scope', async () => {
    const pool = productionToday();
    const result = await verifyRlsPosture({
      tenantPool: pool, ownerPool: pool, env: { TENANT_RLS_ENFORCE: 'on' },
    });

    expect(codes(result)).toContain('isolation_probe_shows_no_scoping');
    // The measured production numbers, carried into the payload so an operator
    // reading a log sees the evidence and not just a verdict.
    expect(result.probe).toMatchObject({ total: 38, a: 38, b: 38, isolated: false });
  });

  test('a correctly cut-over connection verifies clean', async () => {
    const tenant = afterCutover();
    const owner = fakePool({ role: 'postgres', bypasses: true, counts: { orgs: [ORG_A, ORG_B], total: 38, [ORG_A]: 18, [ORG_B]: 16 } });

    const result = await verifyRlsPosture({
      tenantPool: tenant, ownerPool: owner, env: { TENANT_RLS_ENFORCE: 'strict' },
    });

    expect(result.findings).toEqual([]);
    expect(result.enforced).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.probe).toMatchObject({ total: 38, a: 18, b: 16, isolated: true });
  });
});

describe('failing closed is distinguishable from denying everything', () => {
  // Both leave a studio looking at an empty screen, and they need opposite
  // fixes — one is "you are not cut over", the other is "app.org_id is not
  // reaching the connection". A single code for both would send whoever is
  // paged in the wrong direction.
  test('a policy that denies every row has its own code', async () => {
    // The tenant sees nothing; the owner still counts 38. Before probeIsolation
    // took the total from the owner connection, this case produced total=0 and
    // was misreported as "not scoped at all" — the opposite diagnosis.
    const tenant = fakePool({
      role: 'app_tenant', bypasses: false,
      counts: { orgs: [ORG_A, ORG_B], total: 38, [ORG_A]: 0, [ORG_B]: 0 },
    });
    const owner = fakePool({
      role: 'postgres', bypasses: true,
      counts: { orgs: [ORG_A, ORG_B], total: 38, [ORG_A]: 38, [ORG_B]: 38 },
    });

    const result = await verifyRlsPosture({
      tenantPool: tenant, ownerPool: owner, env: { TENANT_RLS_ENFORCE: 'on' },
    });

    expect(codes(result)).toContain('isolation_probe_denies_everything');
    expect(codes(result)).not.toContain('isolation_probe_shows_no_scoping');
  });

  test('a non-bypassing role with no policies at all is fatal', async () => {
    const tenant = fakePool({
      role: 'app_tenant', bypasses: false, policies: 0,
      counts: { orgs: [ORG_A, ORG_B], total: 38, [ORG_A]: 0, [ORG_B]: 0 },
    });
    const owner = fakePool({
      role: 'postgres', bypasses: true,
      counts: { orgs: [ORG_A, ORG_B], total: 38, [ORG_A]: 38, [ORG_B]: 38 },
    });

    const result = await verifyRlsPosture({
      tenantPool: tenant, ownerPool: owner, env: { TENANT_RLS_ENFORCE: 'on' },
    });

    expect(codes(result)).toContain('no_policies_for_tenant_role');
  });
});

describe('the three postures', () => {
  test('off claims nothing and probes nothing', async () => {
    const pool = productionToday();
    const result = await verifyRlsPosture({
      tenantPool: pool, ownerPool: pool, env: { TENANT_RLS_ENFORCE: 'off' },
    });

    expect(result).toMatchObject({ posture: 'off', ok: true, enforced: false, findings: [] });
    expect(result.probe).toBeNull();
  });

  // The production-safety rule, pinned. A box already running the misconfigured
  // state must not be taken offline by a deploy that merely adds the check —
  // it reports, loudly, and keeps a gym's software up.
  test('on reports the misconfiguration without refusing to run', async () => {
    const pool = productionToday();
    const result = await verifyRlsPosture({
      tenantPool: pool, ownerPool: pool, env: { TENANT_RLS_ENFORCE: 'on' },
    });

    expect(result.ok).toBe(true);
    expect(result.enforced).toBe(false);
    expect(result.findings.some((f) => f.severity === 'fatal')).toBe(true);
  });

  test('strict refuses to run on exactly the same database', async () => {
    const pool = productionToday();
    const result = await verifyRlsPosture({
      tenantPool: pool, ownerPool: pool, env: { TENANT_RLS_ENFORCE: 'strict' },
    });

    expect(result.ok).toBe(false);
  });
});

describe('boot wiring', () => {
  const silentLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() });

  test('strict exits the process; on does not', async () => {
    const exitStrict = jest.fn();
    await enforceRlsPostureAtBoot({
      tenantPool: productionToday(), ownerPool: null,
      logger: silentLogger(), env: { TENANT_RLS_ENFORCE: 'strict' }, exit: exitStrict,
    });
    expect(exitStrict).toHaveBeenCalledWith(1);

    const exitOn = jest.fn();
    await enforceRlsPostureAtBoot({
      tenantPool: productionToday(), ownerPool: null,
      logger: silentLogger(), env: { TENANT_RLS_ENFORCE: 'on' }, exit: exitOn,
    });
    expect(exitOn).not.toHaveBeenCalled();
  });

  test('a degraded posture is logged at error, not swallowed', async () => {
    const logger = silentLogger();
    await enforceRlsPostureAtBoot({
      tenantPool: productionToday(), ownerPool: null,
      logger, env: { TENANT_RLS_ENFORCE: 'on' }, exit: jest.fn(),
    });

    const messages = logger.error.mock.calls.map(([, msg]) => msg);
    expect(messages).toContain('rls_posture_degraded');
  });

  // A liveness endpoint is reachable by anyone who can reach the container.
  // Which privileged role the app connects as is not something to publish on it.
  test('no connection string, password or role detail reaches the health field', async () => {
    const { setRlsPosture, rlsHealthField } = require('../lib/health');
    const result = await verifyRlsPosture({
      tenantPool: productionToday(), ownerPool: null, env: { TENANT_RLS_ENFORCE: 'on' },
    });
    setRlsPosture(result);

    const serialised = JSON.stringify(rlsHealthField());
    expect(serialised).not.toMatch(/postgres|password|@|rolbypassrls/);
    expect(rlsHealthField()).toMatchObject({ posture: 'on', enforced: false });
    expect(rlsHealthField().findings).toContain('tenant_connection_bypasses_rls');
  });
});

describe('an unreachable database is not a silent pass', () => {
  test('a pool that throws produces a finding rather than an ok posture', async () => {
    const broken = { query: async () => { throw new Error('ECONNREFUSED'); }, connect: async () => { throw new Error('ECONNREFUSED'); } };

    const result = await verifyRlsPosture({
      tenantPool: broken, ownerPool: broken, env: { TENANT_RLS_ENFORCE: 'strict' },
    });

    expect(codes(result)).toContain('rls_preflight_unavailable');
    expect(result.enforced).toBe(false);
  });
});

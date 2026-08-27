// Phase 5/6 — /api/platform/tenancy/*
//
// Three properties pinned:
//
//   1. /tenancy-health returns 5 sections (isolation, rls, orphans,
//      cross_tenant, known_gaps) and each section's status is decided
//      independently — one warning does not roll the whole card red. That
//      is the "honest state" rule the card is named for.
//   2. The drilldowns are read-only views of the same data the card
//      shows. /tenancy/orphans reads from the materialised view
//      tenancy_orphan_summary, not from the underlying business tables —
//      a direct COUNT would be wrong during an incident when those tables
//      are under load.
//   3. POST /tenancy/run-isolation-tests is the only mutation. It is
//      rate-limited to once per 5 minutes per user — the 5-minute cooldown
//      is per-user, not global, so two operators in the same session
//      each get their own.
//
// What we don't test here: the runner's actual SQL — it inserts a probe
// row, reads it back under the wrong org, etc. The e2e suite already
// covers that, and re-running the same scenario from a Jest test would
// need a real database. The contract under test is: the endpoint
// exists, the cooldown is enforced, and the response shape matches what
// the card's "Run isolation tests" button expects.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));
const pool = require('../db/pool');

// The cooldown is a private Map in tenancy.js. We re-require per test
// so the Map is fresh and one test's "burn the cooldown" cannot affect
// the next test. jest.isolateModules gives the require its own sandbox.
function freshTenancyRouter() {
  let captured;
  jest.isolateModules(() => {
    captured = require('../modules/platform/super-admin/tenancy');
  });
  return captured;
}

const PLATFORM_OWNER = {
  id: 'usr-platform', name: 'Platform Owner', email: 'p@x.com', role: 'super_admin',
  organization_id: null, is_platform_owner: true, is_active: true, deleted_at: null,
  token_version: 1,
};

function token(overrides = {}) {
  return jwt.sign(
    { id: overrides.id || PLATFORM_OWNER.id,
      token_version: overrides.token_version || PLATFORM_OWNER.token_version,
      role: PLATFORM_OWNER.role, is_platform_owner: true, audience: 'platform' },
    process.env.JWT_SECRET, { expiresIn: '5m' }
  );
}

function app(router = freshTenancyRouter()) {
  const a = express();
  // The cooldown is keyed off req.user.id. The mock middleware
  // decodes the bearer token (if present) and sets req.user to the
  // token's identity, so two requests with different user-ids in
  // their tokens get independent cooldown slots. When no token is
  // present, the default platform owner is used.
  a.use((req, _res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    if (m) {
      try {
        const claims = jwt.verify(m[1], process.env.JWT_SECRET);
        req.user = { ...PLATFORM_OWNER, id: claims.id };
        return next();
      } catch { /* fall through to default */ }
    }
    req.user = PLATFORM_OWNER;
    next();
  });
  a.use('/api/platform', router);
  return a;
}

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
});

/* ── /tenancy-health ───────────────────────────────────────────────────── */

describe('GET /api/platform/tenancy-health — 5 independent sections', () => {
  it('returns the 5 sections the card reads, in a stable order', async () => {
    // The first query is the RLS / pg_policies summary; subsequent
    // queries are best-effort reads against the orphan MV, the activity
    // log, the known-gaps table, and the last isolation run.
    pool.query
      .mockResolvedValueOnce({ rows: [{ policy_count: 247, mv_rls_enabled: false }] }) // rls
      .mockResolvedValueOnce({ rows: [] })  // orphans MV (no rows with null_org_count > 0)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })  // cross-tenant 24h
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })  // open gaps
      .mockResolvedValueOnce({ rows: [] }); // last run (none)

    const res = await request(app()).get('/api/platform/tenancy-health').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const sections = res.body.data;
    expect(Object.keys(sections).sort()).toEqual(
      ['cross_tenant', 'isolation', 'known_gaps', 'orphans', 'rls']
    );
  });

  it('orphans = HEALTHY when the MV reports zero rows with null org_id', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ policy_count: 247, mv_rls_enabled: false }] })
      .mockResolvedValueOnce({ rows: [] }) // MV is empty
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get('/api/platform/tenancy-health').set('Authorization', `Bearer ${token()}`);
    expect(res.body.data.orphans.status).toBe('HEALTHY');
    expect(res.body.data.orphans.total).toBe(0);
  });

  it('orphans = WARNING when the MV reports any null org rows', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ policy_count: 247, mv_rls_enabled: false }] })
      .mockResolvedValueOnce({ rows: [{ table_name: 'pt_clients', null_org_count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get('/api/platform/tenancy-health').set('Authorization', `Bearer ${token()}`);
    expect(res.body.data.orphans.status).toBe('WARNING');
    expect(res.body.data.orphans.total).toBe(3);
    expect(res.body.data.orphans.breakdown).toEqual([{ table: 'pt_clients', count: 3 }]);
  });

  it('cross_tenant: 0 = HEALTHY, 1–5 = WARNING, 6+ = CRITICAL', async () => {
    async function runOnce(n) {
      pool.query.mockReset();
      pool.query
        .mockResolvedValueOnce({ rows: [{ policy_count: 247, mv_rls_enabled: false }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ n }] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      const res = await request(app()).get('/api/platform/tenancy-health').set('Authorization', `Bearer ${token()}`);
      return res.body.data.cross_tenant.status;
    }
    expect(await runOnce(0)).toBe('HEALTHY');
    expect(await runOnce(5)).toBe('WARNING');
    expect(await runOnce(6)).toBe('CRITICAL');
  });

  it('known_gaps: 0 = HEALTHY, 1–5 = WARNING, 6+ = CRITICAL', async () => {
    async function runOnce(n) {
      pool.query.mockReset();
      pool.query
        .mockResolvedValueOnce({ rows: [{ policy_count: 247, mv_rls_enabled: false }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [{ n }] })
        .mockResolvedValueOnce({ rows: [] });
      const res = await request(app()).get('/api/platform/tenancy-health').set('Authorization', `Bearer ${token()}`);
      return res.body.data.known_gaps.status;
    }
    expect(await runOnce(0)).toBe('HEALTHY');
    expect(await runOnce(5)).toBe('WARNING');
    expect(await runOnce(6)).toBe('CRITICAL');
  });

  it('isolation = HEALTHY when last run passed; WARNING when it failed; UNKNOWN when no run exists', async () => {
    async function runOnce(lastRun) {
      pool.query.mockReset();
      pool.query
        .mockResolvedValueOnce({ rows: [{ policy_count: 247, mv_rls_enabled: false }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: lastRun ? [lastRun] : [] });
      const res = await request(app()).get('/api/platform/tenancy-health').set('Authorization', `Bearer ${token()}`);
      return res.body.data.isolation;
    }
    const passed = await runOnce({ id: 1, ran_at: new Date(), by_user_name: 'admin',
      passed: true, total_tests: 4, failed_tests: 0, duration_ms: 50 });
    expect(passed.status).toBe('HEALTHY');
    const failed = await runOnce({ id: 2, ran_at: new Date(), by_user_name: 'admin',
      passed: false, total_tests: 4, failed_tests: 2, duration_ms: 50 });
    expect(failed.status).toBe('WARNING');
    const none = await runOnce(null);
    expect(none.status).toBe('UNKNOWN');
  });

  it('rls: 0 policies = DOWN; >0 policies = WARNING (org-scoping is the platform role, not per-org)', async () => {
    // The 247-policy, 0-org-scoped shape is the codebase's reality —
    // the card surfaces that as WARNING rather than HEALTHY, because
    // "we have RLS" is true but "we have per-org RLS" is not.
    async function runOnce(policyCount) {
      pool.query.mockReset();
      pool.query
        .mockResolvedValueOnce({ rows: [{ policy_count: policyCount, mv_rls_enabled: false }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [{ n: 0 }] })
        .mockResolvedValueOnce({ rows: [] });
      const res = await request(app()).get('/api/platform/tenancy-health').set('Authorization', `Bearer ${token()}`);
      return res.body.data.rls.status;
    }
    expect(await runOnce(0)).toBe('DOWN');
    expect(await runOnce(247)).toBe('WARNING');
  });
});

/* ── /tenancy/orphans ──────────────────────────────────────────────────── */

describe('GET /api/platform/tenancy/orphans — drilldown reads the MV', () => {
  it('returns rows from tenancy_orphan_summary, not from underlying tables', async () => {
    // If a future change points this at pt_clients/etc., the SQL the
    // mock sees would change — pin the source.
    pool.query.mockResolvedValueOnce({
      rows: [
        { table_name: 'pt_clients', null_org_count: 3 },
        { table_name: 'trainers',    null_org_count: 1 },
      ],
    });
    const res = await request(app()).get('/api/platform/tenancy/orphans').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { table: 'pt_clients', count: 3 },
      { table: 'trainers',    count: 1 },
    ]);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/tenancy_orphan_summary/);
  });
});

/* ── /tenancy/cross-tenant-attempts ────────────────────────────────────── */

describe('GET /api/platform/tenancy/cross-tenant-attempts — paginated drilldown', () => {
  it('clamps limit between 1 and 200 and passes it as $1', async () => {
    // Two queries: the paged list, then the total. Both filters are
    // identical — pinned because the brief says "no union with a
    // different filter or the count lies".
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const res = await request(app())
      .get('/api/platform/tenancy/cross-tenant-attempts?limit=999&offset=-5')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    // limit=999 is clamped to 200, offset=-5 is clamped to 0.
    expect(pool.query.mock.calls[0][1]).toEqual([200, 0]);
    // The count query has no parameters.
    expect(pool.query.mock.calls[1][1]).toBeUndefined();
  });

  it('uses the same action filter for list and count', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, action: 'cross_tenant_attempt' }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    await request(app())
      .get('/api/platform/tenancy/cross-tenant-attempts?limit=50&offset=0')
      .set('Authorization', `Bearer ${token()}`);
    // Both queries must include the same three action names.
    const listSql = pool.query.mock.calls[0][0];
    const countSql = pool.query.mock.calls[1][0];
    for (const a of ['cross_tenant_attempt', 'isolation_violation', 'unauthorized_organization_access']) {
      expect(listSql).toMatch(new RegExp(a));
      expect(countSql).toMatch(new RegExp(a));
    }
  });
});

/* ── /tenancy/known-gaps ───────────────────────────────────────────────── */

describe('GET /api/platform/tenancy/known-gaps — open gaps', () => {
  it('returns rows with severity-ordered sort', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { table_name: 'audit_log', reason: 'cross-tenant writes not in audit', severity: 'high',
          added_at: new Date(), verified_at: new Date(), closed_at: null },
      ],
    });
    const res = await request(app()).get('/api/platform/tenancy/known-gaps').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].closed_at).toBeNull();
  });
});

/* ── POST /tenancy/run-isolation-tests — cooldown ─────────────────────── */

describe('POST /api/platform/tenancy/run-isolation-tests — 5-minute per-user cooldown', () => {
  // The runner needs a probe client (BEGIN / SAVEPOINT / COMMIT) and
  // several DB queries. We mock them all here. The point of these
  // tests is the cooldown contract, not the runner's SQL — the runner
  // is exercised by the e2e suite.

  function mockRunnerHappyPath() {
    // 1) probe two orgs
    pool.query.mockResolvedValueOnce({
      rows: [{ org_a: 'org-1', org_b: 'org-2' }],
    });
    // 2) probe client connect — the runner fires several queries in
    // sequence: INSERT, SELECT, UPDATE+SELECT, DELETE+SELECT, DELETE.
    // We model the contract for each: the probe row exists in org_A
    // only, so the org_B SELECTs return [] and the org_A SELECTs
    // return the row.
    //
    // Note: the runner's SQL is multi-line (newlines between fields
    // and the VALUES clause), so we use [\s\S] instead of `.` to
    // match across newlines. .test() with /s/ is also valid; both
    // approaches are pinned here for clarity.
    const client = {
      query: jest.fn().mockImplementation((sql, params) => {
        if (/INSERT INTO trainers[\s\S]*RETURNING id/i.test(sql)) {
          return Promise.resolve({ rows: [{ id: 99 }] });
        }
        // SELECT name (test 3 read-back) — runner verifies the row's
        // name is unchanged after the org_B UPDATE. Mock returns the
        // original probe name.
        if (/SELECT name FROM trainers WHERE id = \$1 AND organization_id = \$2/.test(sql)) {
          return Promise.resolve({ rows: [{ name: 'untouched' }] });
        }
        // SELECT id (tests 2 and 4) — same SQL, different organization
        // params. The org_B lookup (test 2) must return [] for the
        // "isolation holds" check; the org_A lookup (test 4) must
        // return the row to confirm the org_B DELETE didn't take it.
        if (/SELECT id FROM trainers WHERE id = \$1 AND organization_id = \$2/.test(sql)) {
          if (params && params[1] === 'org-2') return Promise.resolve({ rows: [] });
          if (params && params[1] === 'org-1') return Promise.resolve({ rows: [{ id: 99 }] });
        }
        // UPDATE / DELETE / COMMIT / SAVEPOINT etc. all return empty
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValueOnce(client);
    // 3) write tenancy_isolation_runs row
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, ran_at: new Date() }],
    });
    return client;
  }

  it('first call returns 200 and writes one row', async () => {
    mockRunnerHappyPath();
    const res = await request(app())
      .post('/api/platform/tenancy/run-isolation-tests')
      .set('Authorization', `Bearer ${token({ id: 'user-first' })}`);
    expect(res.status).toBe(200);
    expect(res.body.data.passed).toBe(true);
    expect(res.body.data.tests).toBeDefined();
  });

  it('a second call within 5 minutes returns 429 COOLDOWN', async () => {
    mockRunnerHappyPath();
    const a = app();
    const t = `Bearer ${token({ id: 'user-cooldown' })}`;
    const r1 = await request(a).post('/api/platform/tenancy/run-isolation-tests').set('Authorization', t);
    expect(r1.status).toBe(200);
    // The second call must short-circuit on the cooldown BEFORE the
    // runner fires. Reset the mock to be sure; the cooldown check
    // happens at the top of the handler.
    pool.query.mockReset();
    pool.connect.mockReset();
    const r2 = await request(a).post('/api/platform/tenancy/run-isolation-tests').set('Authorization', t);
    expect(r2.status).toBe(429);
    expect(r2.body.error.code).toBe('COOLDOWN');
    // No DB work — the cooldown check is purely in-process.
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('the cooldown is per-user, not global', async () => {
    // Operator A burns the cooldown; operator B starts fresh.
    mockRunnerHappyPath();
    const a = app();
    const rA1 = await request(a)
      .post('/api/platform/tenancy/run-isolation-tests')
      .set('Authorization', `Bearer ${token({ id: 'user-per-A' })}`);
    expect(rA1.status).toBe(200);
    // Operator B has their own cooldown slot, so they can run.
    mockRunnerHappyPath();
    const rB1 = await request(a)
      .post('/api/platform/tenancy/run-isolation-tests')
      .set('Authorization', `Bearer ${token({ id: 'user-per-B' })}`);
    expect(rB1.status).toBe(200);
  });

  it('returns 503 NO_TENANTS when there are fewer than 2 organizations', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // probeOrgs is empty
    const res = await request(app())
      .post('/api/platform/tenancy/run-isolation-tests')
      .set('Authorization', `Bearer ${token({ id: 'user-no-tenants' })}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NO_TENANTS');
  });
});

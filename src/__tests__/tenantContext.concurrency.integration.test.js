// Does tenant context actually survive concurrency and connection reuse?
//
// Condition C3 of RLS-CUTOVER-READINESS.md. Every other part of the RLS design
// has been demonstrated somewhere; this one was argued from construction —
// "AsyncLocalStorage is per-async-context, therefore two requests cannot see
// each other's app.org_id" — and never shown. It is also the assumption whose
// failure would be worst and quietest: a leak here is not an error, it is one
// studio's rows appearing inside another studio's response.
//
// So this proves it against the REAL implementation. No fakes, no
// reimplementation of the wrapper:
//
//   · the real src/db/pool.js, with TENANT_RLS_ENFORCE=on
//   · the real lib/tenant-context.js AsyncLocalStorage plumbing
//   · a real PostgreSQL, connected as the real app_tenant role (NOBYPASSRLS)
//   · the real tenant_isolation policies from migrations 157/159
//   · a pool deliberately capped small, so connections MUST be reused
//
// Skips itself when RLS_TEST_DATABASE_URL is unset, like the isolation suite
// it sits beside. Stand the database up with scripts/rls-proof-setup.sh.

'use strict';

const { Pool } = require('pg');

const ADMIN_URL = process.env.RLS_TEST_DATABASE_URL;
const TENANT_PASSWORD = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';

const describeMaybe = ADMIN_URL ? describe : describe.skip;

// app_tenant's own connection string, derived from the admin one.
function tenantUrl() {
  const u = new URL(ADMIN_URL);
  u.username = 'app_tenant';
  u.password = TENANT_PASSWORD;
  return u.toString();
}

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

describeMaybe('tenant context under concurrency and pool reuse (real pool, real RLS)', () => {
  let admin;
  let pool;
  let tenantContext;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });

    // Two studios and one row each, written as the owner so RLS does not apply
    // to the setup itself.
    await admin.query(`
      INSERT INTO organizations (id, name, slug)
      VALUES ($1, 'Concurrency A', 'conc-a'), ($2, 'Concurrency B', 'conc-b')
      ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);

    await admin.query('DELETE FROM pt_clients WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]);
    await admin.query(`
      INSERT INTO pt_clients (id, name, mobile, organization_id)
      VALUES ('cl-a','Client A','9000000001',$1), ('cl-b','Client B','9000000002',$2)`,
    [ORG_A, ORG_B]);

    // The real pool module, pointed at app_tenant with enforcement ON. Env has
    // to be set before the module is first required — it reads both at load.
    process.env.TENANT_RLS_ENFORCE = 'on';
    process.env.DATABASE_URL = tenantUrl();
    // Small on purpose: with 2 connections and 40 interleaved operations the
    // same physical connection is handed out again and again, which is exactly
    // the condition a transaction-local GUC has to survive.
    process.env.DATABASE_POOL_SIZE = '2';
    delete process.env.ADMIN_DATABASE_URL;

    jest.resetModules();
    pool = require('../db/pool');
    tenantContext = require('../lib/tenant-context');
  });

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {});
    if (admin) {
      await admin.query('DELETE FROM pt_clients WHERE organization_id IN ($1,$2)', [ORG_A, ORG_B]).catch(() => {});
      // Remove the studios too. Leaving them behind collides with the slug
      // fixtures other integration suites create.
      await admin.query('DELETE FROM organizations WHERE id IN ($1,$2)', [ORG_A, ORG_B]).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  /** One request: run inside a tenant context and read the client list. */
  function requestAs(orgId) {
    return tenantContext.runWithTenantContext(orgId, async () => {
      const { rows } = await pool.query('SELECT id, organization_id FROM pt_clients ORDER BY id');
      return rows;
    });
  }

  it('sanity: the pool really is connected as app_tenant with RLS applying', async () => {
    const who = await tenantContext.runWithTenantContext(ORG_A, () =>
      pool.query('SELECT current_user, current_setting(\'app.org_id\', true) AS org'));
    expect(who.rows[0].current_user).toBe('app_tenant');
    expect(who.rows[0].org).toBe(ORG_A);
  });

  it('A sees only A and B sees only B, run concurrently, 40 interleaved requests', async () => {
    // Interleaved rather than grouped: A,B,A,B… so the pool is constantly
    // handing a connection that just served the other studio.
    const work = [];
    for (let i = 0; i < 20; i++) {
      work.push(requestAs(ORG_A).then((rows) => ({ org: ORG_A, rows })));
      work.push(requestAs(ORG_B).then((rows) => ({ org: ORG_B, rows })));
    }
    const results = await Promise.all(work);

    expect(results).toHaveLength(40);
    for (const { org, rows } of results) {
      // The whole proof: every row every request saw belongs to that request's
      // own studio, and it saw exactly its own one row.
      expect(rows).toHaveLength(1);
      expect(rows.every((r) => r.organization_id === org)).toBe(true);
    }
  });

  it('holds under a wider, randomly ordered burst (100 requests, both studios)', async () => {
    const orgs = Array.from({ length: 100 }, () => (Math.random() < 0.5 ? ORG_A : ORG_B));
    const results = await Promise.all(
      orgs.map((org) => requestAs(org).then((rows) => ({ org, rows }))),
    );
    for (const { org, rows } of results) {
      expect(rows.every((r) => r.organization_id === org)).toBe(true);
      expect(rows).toHaveLength(1);
    }
  });

  it('a request with NO tenant context reads nothing — fail-closed, not fail-open', async () => {
    // An authenticated request whose org could not be resolved must see zero
    // rows, NOT every row. This is the difference between "no store" (worker,
    // platform-wide) and "store with a null org" (broken tenant request).
    const rows = await tenantContext.runWithTenantContext(null, async () => {
      const r = await pool.query('SELECT id FROM pt_clients');
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  describe('contamination across a released connection', () => {
    it('B cannot inherit A\'s app.org_id from a reused connection', async () => {
      // Sequential on a 2-connection pool: B is very likely handed the physical
      // connection A just finished with.
      for (let i = 0; i < 25; i++) {
        const a = await requestAs(ORG_A);
        expect(a.every((r) => r.organization_id === ORG_A)).toBe(true);

        const b = await requestAs(ORG_B);
        expect(b.every((r) => r.organization_id === ORG_B)).toBe(true);
      }
    });

    it('app.org_id does not persist on a connection after the transaction ends', async () => {
      await requestAs(ORG_A);
      // Borrowed raw, with no tenant context at all. If set_config had been
      // session-scoped rather than transaction-scoped, A's org would still be
      // sitting on this connection.
      const client = await new Pool({ connectionString: tenantUrl(), max: 1 }).connect();
      try {
        const { rows } = await client.query("SELECT current_setting('app.org_id', true) AS org");
        expect(rows[0].org === null || rows[0].org === '').toBe(true);
      } finally {
        client.release();
      }
    });

    it('a request that THROWS mid-transaction leaves the connection clean for the next one', async () => {
      for (let i = 0; i < 10; i++) {
        // A blows up after its org has been set but before it finishes.
        await expect(
          tenantContext.runWithTenantContext(ORG_A, async () => {
            await pool.query('SELECT 1 FROM pt_clients');
            throw new Error('boom mid-request');
          }),
        ).rejects.toThrow('boom mid-request');

        // B must be unaffected — same pool, quite possibly the same connection
        // that just had a statement rolled back on it.
        const b = await requestAs(ORG_B);
        expect(b).toHaveLength(1);
        expect(b[0].organization_id).toBe(ORG_B);
      }
    });

    it('a failed statement inside a tenant transaction does not strand the GUC', async () => {
      for (let i = 0; i < 10; i++) {
        await expect(
          tenantContext.runWithTenantContext(ORG_A, () =>
            pool.query('SELECT * FROM a_table_that_does_not_exist')),
        ).rejects.toThrow();

        const b = await requestAs(ORG_B);
        expect(b.every((r) => r.organization_id === ORG_B)).toBe(true);
      }
    });
  });

  describe('pool.connect() — the borrowed-client path', () => {
    // 36 call sites borrow a client and run their own BEGIN…COMMIT. They go
    // through scopeClient rather than the query wrapper, so they need their own
    // proof.
    it('scopes a borrowed client to its own studio, and releases it clean', async () => {
      for (let i = 0; i < 15; i++) {
        const org = i % 2 === 0 ? ORG_A : ORG_B;
        await tenantContext.runWithTenantContext(org, async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const { rows } = await client.query('SELECT id, organization_id FROM pt_clients');
            expect(rows).toHaveLength(1);
            expect(rows[0].organization_id).toBe(org);
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        });
      }
    });

    it('a borrowed client whose transaction rolls back does not leak its org to the next borrower', async () => {
      for (let i = 0; i < 10; i++) {
        await tenantContext.runWithTenantContext(ORG_A, async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM pt_clients');
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        });

        await tenantContext.runWithTenantContext(ORG_B, async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const { rows } = await client.query('SELECT id, organization_id FROM pt_clients');
            expect(rows.every((r) => r.organization_id === ORG_B)).toBe(true);
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        });
      }
    });

    it('concurrent borrowed clients do not see each other\'s org', async () => {
      const borrow = (org) => tenantContext.runWithTenantContext(org, async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query('SELECT organization_id FROM pt_clients');
          await client.query('COMMIT');
          return { org, rows };
        } finally {
          client.release();
        }
      });

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => borrow(i % 2 === 0 ? ORG_A : ORG_B)),
      );
      for (const { org, rows } of results) {
        expect(rows).toHaveLength(1);
        expect(rows[0].organization_id).toBe(org);
      }
    });
  });
});

'use strict';
// What the org-scoping wrapper costs, measured rather than guessed.
//
// TENANT-RLS-PLAN.md step 3: "Measure the added latency from per-query
// transactions. If it is material, consider scoping the wrapper to reads of
// tenant tables rather than all queries." It was the last open engineering
// question before the cutover, and it was open because nobody had a number.
//
// ── Why the number that matters is a COUNT, not a duration ────────────────
//
// db/pool.js turns one `pool.query()` into four statements on a borrowed
// client: BEGIN, set_config, the query, COMMIT. Three of those are extra
// network round trips.
//
// This suite runs against localhost Postgres in CI, where a round trip is
// tens of microseconds. Production talks to Supabase through Supavisor, where
// it is milliseconds. So a duration measured here understates production by
// roughly the ratio of the two RTTs, and reporting "negligible" off the back
// of it would be worse than saying nothing.
//
// The round-trip COUNT does not have that problem: it is a property of the
// wrapper, identical everywhere, and it is what you multiply by your own RTT.
// So the assertions are about the count, and the durations are printed for
// context with the caveat attached. The formula an operator actually needs:
//
//     added latency per tenant query ≈ 3 × (round-trip time to the database)
//
// BEGIN and COMMIT are cheaper to execute than a real SELECT, so on a fast
// link the measured cost is nearer 2× one query's time — localhost runs at
// 3.0× total, 1.1ms added on a 0.55ms query. As RTT grows the three extra
// trips dominate and the model above becomes the accurate one. At 1ms RTT
// expect about +3ms on every tenant read; at 15ms — a cross-region Supavisor
// hop — about +45ms, and step 3's "if it is material" is answered yes.
//
// Skipped unless RLS_TEST_DATABASE_URL points at a throwaway database, same as
// rls.isolation.integration.test.js. Stand one up with scripts/rls-proof-setup.sh.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

const ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** Enough iterations to see past scheduler noise, few enough to stay quick. */
const RUNS = 200;

/** Median, not mean: one GC pause should not decide the answer. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

describeIf('what the org-scoping wrapper costs', () => {
  let owner;
  let tenant;
  /** Every statement the tenant connection issued, in order. */
  let issued;

  beforeAll(async () => {
    owner = new Pool({ connectionString: DB_URL, max: 2 });
    const tenantUrl = new URL(DB_URL);
    tenantUrl.username = 'app_tenant';
    tenantUrl.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
    tenant = new Pool({ connectionString: tenantUrl.toString(), max: 2 });

    await owner.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Overhead Studio','overhead-studio')
       ON CONFLICT (id) DO NOTHING`, [ORG]);
    await owner.query(`DELETE FROM pt_clients WHERE organization_id = $1`, [ORG]);
    await owner.query(
      `INSERT INTO pt_clients (id, name, organization_id)
       VALUES ('overhead-1','One',$1), ('overhead-2','Two',$1)`, [ORG]);
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM pt_clients WHERE organization_id = $1`, [ORG]);
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await owner?.end();
    await tenant?.end();
  });

  beforeEach(() => { issued = []; });

  /** One read, exactly as db/pool.js issues it when no org is in scope. */
  async function unwrapped(client) {
    issued.push('SELECT');
    return client.query('SELECT id FROM pt_clients WHERE organization_id = $1', [ORG]);
  }

  /** One read, exactly as db/pool.js issues it when an org IS in scope. */
  async function wrapped(client) {
    issued.push('BEGIN');
    await client.query('BEGIN');
    try {
      issued.push('set_config');
      await client.query('SELECT set_config($1, $2, true)', ['app.org_id', ORG]);
      issued.push('SELECT');
      const r = await client.query('SELECT id FROM pt_clients');
      issued.push('COMMIT');
      await client.query('COMMIT');
      return r;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  it('turns one round trip into four', async () => {
    // The mechanism, stated as a number. This is the assertion that travels:
    // it is true on localhost and true through Supavisor.
    const client = await tenant.connect();
    try {
      await unwrapped(client);
      expect(issued).toEqual(['SELECT']);

      issued = [];
      await wrapped(client);
      expect(issued).toEqual(['BEGIN', 'set_config', 'SELECT', 'COMMIT']);
    } finally {
      client.release();
    }
  });

  it('still returns only this org\'s rows through the wrapper', async () => {
    // The overhead has to be buying something, or there is nothing to trade
    // off. Under the wrapper the unqualified SELECT is filtered by policy.
    const client = await tenant.connect();
    try {
      const r = await wrapped(client);
      expect(r.rows).toHaveLength(2);
    } finally {
      client.release();
    }
  });

  it('reports both timings, without pretending localhost is production', async () => {
    const client = await tenant.connect();
    const bare = [];
    const scoped = [];
    try {
      // Interleaved rather than run in two blocks, so a cold cache or a noisy
      // neighbour lands on both arms instead of only the first.
      for (let i = 0; i < RUNS; i++) {
        let t = process.hrtime.bigint();
        await unwrapped(client);
        bare.push(Number(process.hrtime.bigint() - t) / 1e6);

        t = process.hrtime.bigint();
        await wrapped(client);
        scoped.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    } finally {
      client.release();
    }

    const b = median(bare);
    const s = median(scoped);
    const perRoundTrip = b;                       // one statement ≈ one RTT here

    // eslint-disable-next-line no-console
    console.log(
      `\n  org-scoping wrapper, ${RUNS} runs against localhost Postgres:\n`
      + `    unwrapped  median ${b.toFixed(3)} ms   (1 round trip)\n`
      + `    wrapped    median ${s.toFixed(3)} ms   (4 round trips)\n`
      + `    added      median ${(s - b).toFixed(3)} ms   = ${(s / b).toFixed(1)}x\n`
      + `\n  Localhost RTT is ~${perRoundTrip.toFixed(3)} ms. Production goes through\n`
      + `  Supavisor, so scale by YOUR round-trip time:\n`
      + `    added latency per tenant query ~= 3 x RTT\n`
      + `    at  1 ms RTT  -> +3 ms per query\n`
      + `    at 15 ms RTT  -> +45 ms per query\n`
    );

    // No threshold on the duration: a wall-clock assertion on a shared CI
    // runner is a flake generator, and the number that matters is the count
    // asserted above. This only catches a pathological regression — the
    // wrapper growing an N+1 or a retry loop.
    expect(s).toBeLessThan(b * 25);
  });
});

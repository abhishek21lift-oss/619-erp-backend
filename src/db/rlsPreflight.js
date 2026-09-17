'use strict';
// src/db/rlsPreflight.js
//
// Ask the DATABASE whether tenant isolation is actually in force, instead of
// inferring it from environment variables.
//
// ── The production state this was written against ──────────────────────────
//
// Everything the database needed was already done and live: the `app_tenant`
// role exists with LOGIN, NOSUPERUSER and NOBYPASSRLS; a password is set; all
// 153 public tables have RLS enabled; 141 policies are granted to that role.
// TENANT-RLS-PLAN.md step 6 — pointing DATABASE_URL at it — was never taken.
//
// pg_stat_activity is where that shows. The only application connections on
// production are five `postgres` backends through Supavisor, opened at 04:16
// and still serving traffic; `app_tenant` has never connected. `postgres` owns
// the tables and carries rolbypassrls, so every one of those 141 policies is
// inert for the API, and every tenant query still pays the four round trips of
// the BEGIN/set_config/COMMIT wrapper that exists to feed them.
//
// ── Why the existing boot guard did not catch it ───────────────────────────
//
// server.js compares two STRINGS: it refuses to start when enforcement is on
// and ADMIN_DATABASE_URL equals DATABASE_URL. That is necessary and nowhere
// near sufficient. Two different connection strings — a different host, a
// different pooler port, a different database name — can authenticate as the
// same privileged role, and the guard passes while RLS is bypassed exactly as
// before. A string cannot answer "what role did I actually connect as, and
// does that role bypass RLS", and that is the only question that matters.
//
// The database can answer it in one query, and this module asks.
//
// ── Read-only, and safe to run on a live box ───────────────────────────────
//
// The isolation probe runs inside an explicit transaction that ALWAYS ends in
// ROLLBACK, issues only SELECTs, and reads counts — never rows. It names no
// client and returns no personal data. It exists to be run on production at
// boot and on demand from a readiness probe.

const { rlsEnforcementEnabled, rlsStrictModeEnabled } = require('../lib/tenantRlsFlag');

/** The table the isolation probe counts. Strict-tenant, always populated. */
const PROBE_TABLE = 'pt_clients';

/**
 * Which role is this pool really connected as, and what can it bypass?
 *
 * `current_user` rather than anything parsed out of the connection string:
 * the string says what we asked for, this says what we got. They differ
 * whenever a pooler, a `SET ROLE`, or a peer-auth mapping sits in between.
 */
async function inspectConnection(pool) {
  const { rows } = await pool.query(
    `SELECT current_user::text                AS role,
            r.rolbypassrls                    AS bypasses_rls,
            r.rolsuper                        AS is_superuser,
            current_database()::text          AS database
       FROM pg_roles r
      WHERE r.rolname = current_user`
  );
  const row = rows[0];
  if (!row) {
    // current_user with no pg_roles row should be impossible. Treated as the
    // worst case rather than ignored: an unknown role is not a safe one.
    return { role: 'unknown', bypasses_rls: true, is_superuser: true, database: null };
  }
  return row;
}

/**
 * How many policies apply to the role this pool connects as.
 *
 * Zero, with enforcement on, means the role is either privileged (and bypasses
 * them) or has none — and both render the wrapper pointless. Counted through
 * pg_policy rather than assumed from the migration list, because what matters
 * is what the live database holds, not what a migration file once said.
 */
async function countPoliciesForCurrentRole(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM pg_policy p
       JOIN pg_class c     ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND current_user::regrole = ANY (p.polroles)`
  );
  return rows[0] ? rows[0].n : 0;
}

/**
 * Prove isolation by doing it: scope to one organization, count; scope to
 * another, count; compare both against the unscoped total.
 *
 * ── Why counts from two different orgs and not one ─────────────────────────
 *
 * One org proves nothing on its own. A policy that denies everything returns 0
 * for every tenant and looks like isolation; a policy that is bypassed returns
 * the full table for every tenant and also looks self-consistent. Two orgs and
 * the unscoped total tell the three states apart:
 *
 *   a + b <= total, a != total, b != total   →  isolation is in force
 *   a == b == total                          →  the role bypasses RLS
 *   a == b == 0 (with total > 0)             →  denying everything; fail closed
 *
 * The transaction is opened and rolled back whatever happens — set_config with
 * `is_local = true` is scoped to it, so a rollback also puts app.org_id back.
 *
 * ── The total is read on the OWNER connection, and has to be ───────────────
 *
 * This was written reading all three counts off the tenant pool, and the
 * integration test against a real app_tenant role caught it immediately:
 * `total` came back 0. Of course it did. An unscoped query on a correctly
 * isolated role sets no app.org_id, matches no policy and sees nothing — so
 * "the total number of rows in the table" measured there is really "how much a
 * tenant sees when it names no tenant", which is zero by design.
 *
 * That made the denominator meaningless in exactly the configuration the check
 * exists to confirm, and worse, it collided the two failure modes: a policy
 * genuinely denying everything gives a=0, b=0, total=0, and `a === total` then
 * reported it as "not scoped at all" — the opposite diagnosis, sending whoever
 * is paged to look at the wrong thing.
 *
 * The owner connection bypasses RLS, so it is the only one that can say how
 * many rows exist. Before the cutover there is one pool and it is the owner,
 * which is why the caller may pass the same pool twice.
 */
async function probeIsolation(tenantPool, ownerPool, orgA, orgB) {
  const total = await countTotal(ownerPool || tenantPool);

  const client = await tenantPool.connect();
  try {
    await client.query('BEGIN');
    const a = await countScoped(client, orgA);
    const b = await countScoped(client, orgB);
    return { total, a, b };
  } finally {
    // ROLLBACK before release, always. This function never intends to write,
    // and a client returned to the pool mid-transaction poisons the next
    // borrower.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** Every row in the probe table, counted on a connection that can see them. */
async function countTotal(pool) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE}`);
  return rows[0] ? rows[0].n : 0;
}

async function countScoped(client, orgId) {
  // Bound, never interpolated: SET does not take a bind parameter, which is
  // exactly why db/pool.js uses set_config here too.
  await client.query('SELECT set_config($1, $2, true)', ['app.org_id', String(orgId)]);
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${PROBE_TABLE}`);
  return rows[0] ? rows[0].n : 0;
}

/**
 * Two organization ids to probe with, or null when the database has fewer
 * than two.
 *
 * Read on the OWNER pool: on a correctly cut-over box the tenant pool is
 * subject to the policies and would see at most its own row, which is the
 * thing being measured and cannot also be the measuring instrument.
 */
async function probeOrgIds(ownerPool) {
  const { rows } = await ownerPool.query(
    `SELECT o.id::text AS id
       FROM organizations o
       JOIN ${PROBE_TABLE} c ON c.organization_id = o.id
      GROUP BY o.id
      HAVING count(c.id) > 0
      ORDER BY count(c.id) DESC
      LIMIT 2`
  );
  return rows.length === 2 ? [rows[0].id, rows[1].id] : null;
}

/** A finding, in the shape the log line and the readiness payload both use. */
function finding(code, severity, detail) {
  return { code, severity, detail };
}

/**
 * The whole posture, as data.
 *
 * Returns rather than throws, so one caller can exit the process and another
 * can render a readiness payload from the same result. `ok` is the single
 * boolean a caller acts on; `findings` is why.
 *
 * ── The three postures, and why this is not a boolean ──────────────────────
 *
 * TENANT_RLS_ENFORCE was a boolean, and a boolean cannot express the state
 * production is actually in: the plumbing is on, the policies are live, and
 * the connection bypasses them. Reported as "enabled" that is a lie, and
 * reported as "disabled" it is also a lie.
 *
 *   off      — no enforcement. No wrapper, no probe, nothing claimed.
 *   on       — the plumbing runs and the posture is REPORTED. A connection
 *              that bypasses RLS is an error-level finding and marks
 *              readiness degraded; it does not stop the process.
 *   strict   — the same checks, and the process refuses to run unless the
 *              database confirms isolation is real. This is fail-closed, and
 *              it is what a box gets after the cutover.
 *
 * The middle setting is the one that matters for a live system: today's
 * production is in it, and it turns a silent false claim into a loud one
 * without taking a gym's software offline to make the point. `strict` is one
 * environment variable away once DATABASE_URL points at app_tenant.
 */
async function verifyRlsPosture({ tenantPool, ownerPool, env = process.env } = {}) {
  const enabled = rlsEnforcementEnabled(env);
  const strict = rlsStrictModeEnabled(env);
  const posture = !enabled ? 'off' : strict ? 'strict' : 'on';

  if (!enabled) {
    return {
      posture, ok: true, enforced: false, findings: [],
      tenant: null, owner: null, probe: null,
    };
  }

  const findings = [];
  let tenant = null;
  let owner = null;
  let probe = null;

  try {
    tenant = await inspectConnection(tenantPool);
    owner = ownerPool && ownerPool !== tenantPool ? await inspectConnection(ownerPool) : null;
  } catch (err) {
    // Cannot even ask. Unknown is not safe, so this is a finding rather than
    // a silent pass — but it is its own code, because "the database was
    // unreachable at boot" and "the database says you bypass RLS" need
    // different responses from whoever reads the log.
    findings.push(finding('rls_preflight_unavailable', 'error', err.message));
    return { posture, ok: false, enforced: false, findings, tenant, owner, probe };
  }

  // ── The finding this module exists for ───────────────────────────────────
  if (tenant.bypasses_rls || tenant.is_superuser) {
    findings.push(finding(
      'tenant_connection_bypasses_rls', 'fatal',
      `DATABASE_URL authenticates as "${tenant.role}", which bypasses row-level security `
      + `(rolbypassrls=${tenant.bypasses_rls}, rolsuper=${tenant.is_superuser}). `
      + 'Every tenant policy is inert for this connection and the per-query transaction '
      + 'wrapper is pure overhead. Point DATABASE_URL at the app_tenant role — see '
      + 'db/migrations/TENANT-RLS-PLAN.md step 5.'
    ));
  }

  if (owner && owner.role === tenant.role) {
    findings.push(finding(
      'owner_and_tenant_are_one_role', 'fatal',
      `ADMIN_DATABASE_URL and DATABASE_URL are different strings but both authenticate as `
      + `"${tenant.role}". Splitting the URLs without splitting the role leaves platform-wide `
      + 'work and tenant traffic on the same privileges.'
    ));
  }

  if (!owner) {
    findings.push(finding(
      'no_separate_owner_connection', 'error',
      'ADMIN_DATABASE_URL is not set to a distinct connection. Platform-wide work '
      + '(workers, migrations, the operator console, pre-auth routes) has no org id and '
      + 'matches no tenant policy, so after cutover it reads empty rather than erroring.'
    ));
  }

  if (!tenant.bypasses_rls) {
    const policies = await countPoliciesForCurrentRole(tenantPool);
    if (policies === 0) {
      findings.push(finding(
        'no_policies_for_tenant_role', 'fatal',
        `No row-level security policies in schema "public" are granted to "${tenant.role}". `
        + 'A non-bypassing role with no policies reads nothing at all.'
      ));
    }
  }

  // ── The live proof ───────────────────────────────────────────────────────
  try {
    const ids = await probeOrgIds(ownerPool || tenantPool);
    if (!ids) {
      findings.push(finding(
        'isolation_probe_skipped', 'info',
        `Fewer than two organizations have ${PROBE_TABLE} rows, so cross-tenant isolation `
        + 'cannot be demonstrated on this database.'
      ));
    } else {
      const [orgA, orgB] = ids;
      const counts = await probeIsolation(tenantPool, ownerPool, orgA, orgB);
      // Both studios have rows — probeOrgIds only returns organizations that
      // do — so under real filtering each must see FEWER than the table holds.
      const isolated = counts.total > 0 && counts.a < counts.total && counts.b < counts.total
        && (counts.a > 0 || counts.b > 0);
      const denyingEverything = counts.total > 0 && counts.a === 0 && counts.b === 0;
      probe = { ...counts, isolated, table: PROBE_TABLE };

      if (denyingEverything) {
        findings.push(finding(
          'isolation_probe_denies_everything', 'fatal',
          `Scoping to either organization returned 0 of ${counts.total} ${PROBE_TABLE} rows. `
          + 'RLS is denying rather than filtering — app.org_id is probably not reaching the '
          + 'connection that runs the query.'
        ));
      } else if (!isolated) {
        findings.push(finding(
          'isolation_probe_shows_no_scoping', 'fatal',
          `Scoping to either organization returned all ${counts.total} ${PROBE_TABLE} rows. `
          + 'The connection is not subject to tenant policies.'
        ));
      }
    }
  } catch (err) {
    findings.push(finding('isolation_probe_failed', 'error', err.message));
  }

  const fatal = findings.filter((f) => f.severity === 'fatal');
  const enforced = fatal.length === 0 && Boolean(probe && probe.isolated);

  return {
    posture,
    // In `strict`, any fatal finding makes this false and the caller exits.
    // In `on`, the findings are reported and the process lives — see the
    // posture comment above for why a live box is not taken down to make a
    // point it can make in a log line.
    ok: strict ? fatal.length === 0 : true,
    enforced,
    findings,
    tenant,
    owner,
    probe,
  };
}

/**
 * Boot-time wiring: run the check, log it, and stop the process when the
 * posture is `strict` and the database disagrees.
 *
 * Logging is structured and carries no connection string, no password and no
 * client data — role names, booleans and counts only.
 */
async function enforceRlsPostureAtBoot({ tenantPool, ownerPool, logger, env = process.env, exit }) {
  const result = await verifyRlsPosture({ tenantPool, ownerPool, env });

  const summary = {
    rls_posture: result.posture,
    rls_enforced: result.enforced,
    tenant_role: result.tenant ? result.tenant.role : null,
    tenant_bypasses_rls: result.tenant ? result.tenant.bypasses_rls : null,
    owner_role: result.owner ? result.owner.role : null,
    probe: result.probe,
    findings: result.findings.map((f) => f.code),
  };

  if (result.posture === 'off') {
    logger.warn(summary, 'rls_posture_disabled');
    return result;
  }

  for (const f of result.findings) {
    const line = { rls_posture: result.posture, code: f.code, detail: f.detail };
    if (f.severity === 'fatal') logger.error(line, 'rls_posture_finding');
    else if (f.severity === 'error') logger.error(line, 'rls_posture_finding');
    else logger.info(line, 'rls_posture_finding');
  }

  if (!result.ok) {
    logger.fatal(summary, 'rls_posture_refusing_to_start');
    (exit || process.exit)(1);
    return result;
  }

  if (result.enforced) logger.info(summary, 'rls_posture_verified');
  else logger.error(summary, 'rls_posture_degraded');

  return result;
}

module.exports = {
  verifyRlsPosture,
  countTotal,
  enforceRlsPostureAtBoot,
  inspectConnection,
  probeIsolation,
  probeOrgIds,
  countPoliciesForCurrentRole,
  PROBE_TABLE,
};

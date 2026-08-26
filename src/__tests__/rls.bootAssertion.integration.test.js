'use strict';
/**
 * The boot guard, run against a real database rather than read as source.
 *
 * tenantRoleAssertion.test.js proves the decision table and pins the shape of
 * inspectRoles by reading db/pool.js. Neither catches the failure this file was
 * written for.
 *
 * The first version of inspectRoles asked the database through _origQuery — the
 * pool's own query method, captured before the tenant wrapper replaced it. That
 * reads as correct and is not: pg's Pool.prototype.query calls this.connect()
 * internally, and pool.connect is ALSO patched, so at boot — no
 * AsyncLocalStorage store, isPlatformWide() true — the query arrived on the
 * OWNER pool. The guard inspected the privileged connection, found it
 * privileged, and would have passed while the tenant connection bypassed every
 * policy: the exact state it exists to detect, reported as healthy.
 *
 * Only running it found that. So this file runs it, in a child process, with
 * the environment a deploy would have.
 *
 * Skipped unless RLS_TEST_DATABASE_URL points at a throwaway database. Stand
 * one up with scripts/rls-proof-setup.sh.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('the boot role guard, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the boot-guard proof would '
        + 'silently skip. Restore the "Stand up the RLS isolation database" step '
        + 'and the env var in .github/workflows/ci.yml.'
      );
    });
  });
}

describeIf('the boot role guard, against a real database', () => {
  const ROOT = path.join(__dirname, '..', '..');

  /** The owner URL the proof database was built with. */
  const ownerUrl = DB_URL;
  /** The same database, reached as the role the app connects as after cutover. */
  const tenantUrl = (() => {
    const u = new URL(DB_URL);
    u.username = 'app_tenant';
    u.password = process.env.RLS_TEST_TENANT_PASSWORD || 'localproof';
    return u.toString();
  })();
  /**
   * A second, textually different string for the same tenant role. This is the
   * case the check that used to live in server.js could not see: two URLs that
   * differ as strings and authenticate as the same unprivileged role.
   */
  const tenantUrlAlias = tenantUrl.replace('localhost', '127.0.0.1');

  /** Run inspectRoles in a child process with the given DATABASE_URLs. */
  function inspect(env) {
    const out = execFileSync(process.execPath, ['-e',
      "require('./src/db/pool').inspectRoles()"
      + ".then(r => { process.stdout.write('RESULT' + JSON.stringify(r)); process.exit(0); })"
      + ".catch(e => { process.stdout.write('ERROR' + e.message); process.exit(1); })",
    ], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 });
    const marker = out.indexOf('RESULT');
    if (marker === -1) throw new Error(`inspectRoles produced no result: ${out}`);
    return JSON.parse(out.slice(marker + 'RESULT'.length));
  }

  it('reports the TENANT role, not whichever pool the wrappers would pick', () => {
    // The regression test for the bug in the header. With no ALS store — which
    // is exactly the state at boot — the wrappers route everything to the owner
    // pool. If this ever reports `postgres` again, the guard has gone blind.
    const roles = inspect({ DATABASE_URL: tenantUrl, ADMIN_DATABASE_URL: ownerUrl });
    expect(roles.tenant.role).toBe('app_tenant');
    expect(roles.tenant.bypassrls).toBe(false);
    expect(roles.tenant.superuser).toBe(false);
  });

  it('reports the owner role separately, and correctly', () => {
    const roles = inspect({ DATABASE_URL: tenantUrl, ADMIN_DATABASE_URL: ownerUrl });
    expect(roles.separateAdminConnection).toBe(true);
    expect(roles.owner.bypassrls || roles.owner.superuser).toBe(true);
  });

  it("sees through today's production shape: both URLs resolving to the owner", () => {
    const roles = inspect({ DATABASE_URL: ownerUrl, ADMIN_DATABASE_URL: ownerUrl });
    expect(roles.tenant.bypassrls || roles.tenant.superuser).toBe(true);
  });

  it('sees through two different strings that are the same role', () => {
    // The failure the old string comparison was structurally unable to catch.
    const roles = inspect({ DATABASE_URL: tenantUrl, ADMIN_DATABASE_URL: tenantUrlAlias });
    expect(roles.separateAdminConnection).toBe(true);
    expect(roles.owner.role).toBe('app_tenant');
    expect(roles.owner.bypassrls).toBe(false);

    const { evaluateTenantRole } = require('../lib/tenantRoleAssertion');
    expect(evaluateTenantRole(roles)).toMatchObject({ ok: false, code: 'OWNER_NOT_PRIVILEGED' });
  });

  it('opens no owner pool when no owner connection is configured', () => {
    const roles = inspect({ DATABASE_URL: tenantUrl, ADMIN_DATABASE_URL: '' });
    expect(roles.separateAdminConnection).toBe(false);
    expect(roles.owner).toBeNull();
  });

  describe('and the verdicts it produces', () => {
    const { evaluateTenantRole } = require('../lib/tenantRoleAssertion');

    it.each([
      ['the intended cutover shape', { DATABASE_URL: 'TENANT', ADMIN_DATABASE_URL: 'OWNER' }, null],
      ["today's shape — owner on both", { DATABASE_URL: 'OWNER', ADMIN_DATABASE_URL: 'OWNER' }, 'TENANT_BYPASSES_RLS'],
      ['tenant role, no owner connection', { DATABASE_URL: 'TENANT', ADMIN_DATABASE_URL: '' }, 'NO_PRIVILEGED_OWNER'],
      ['tenant role on both connections', { DATABASE_URL: 'TENANT', ADMIN_DATABASE_URL: 'ALIAS' }, 'OWNER_NOT_PRIVILEGED'],
    ])('%s', (_label, spec, expected) => {
      const resolve = (v) => ({ TENANT: tenantUrl, OWNER: ownerUrl, ALIAS: tenantUrlAlias, '': '' }[v]);
      const result = evaluateTenantRole(inspect({
        DATABASE_URL: resolve(spec.DATABASE_URL),
        ADMIN_DATABASE_URL: resolve(spec.ADMIN_DATABASE_URL),
      }));
      if (expected === null) {
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        expect(result.code).toBe(expected);
      }
    });
  });
});

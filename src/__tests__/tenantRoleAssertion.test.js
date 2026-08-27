'use strict';
/**
 * The boot assertion that replaced the DATABASE_URL string comparison.
 *
 * The old check was untestable in the way that mattered: it compared two
 * environment variables, so a test could only ever confirm that two strings
 * differ — never that the connection they describe is actually unprivileged.
 * The live database proved the gap on 26 Aug 2026, when both URLs resolved to
 * `postgres` (rolbypassrls = true) and the check passed.
 *
 * evaluateTenantRole is pure, so the whole decision table is testable here
 * without a database, and the one part that must touch a pool — asking which
 * pool answers — is pinned by source assertions below.
 */
const fs = require('fs');
const path = require('path');
const { evaluateTenantRole } = require('../lib/tenantRoleAssertion');

const role = (name, over = {}) => ({ role: name, bypassrls: false, superuser: false, ...over });
const APP = role('app_tenant');
const OWNER = role('postgres', { bypassrls: true });

describe('evaluateTenantRole — decision table', () => {
  it('passes when the tenant role cannot bypass RLS and a privileged owner exists', () => {
    const r = evaluateTenantRole({ tenant: APP, owner: OWNER, separateAdminConnection: true });
    expect(r.ok).toBe(true);
    expect(r.code).toBeUndefined();
  });

  it('fails when the tenant connection has BYPASSRLS — the August production state', () => {
    const r = evaluateTenantRole({
      tenant: role('postgres', { bypassrls: true }),
      owner: OWNER,
      separateAdminConnection: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TENANT_BYPASSES_RLS');
    expect(r.message).toContain('postgres');
  });

  it('fails when the tenant connection is a superuser even with rolbypassrls false', () => {
    // A superuser bypasses RLS regardless of the flag. Checking only
    // rolbypassrls would report this connection as safe.
    const r = evaluateTenantRole({
      tenant: role('supa_admin', { bypassrls: false, superuser: true }),
      owner: OWNER,
      separateAdminConnection: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TENANT_BYPASSES_RLS');
  });

  it('a bypassing tenant is reported as that, not as the missing-owner case', () => {
    // Order matters: with no ADMIN_DATABASE_URL and a `postgres` tenant, both
    // conditions hold. The one that leaks data must be the one named.
    const r = evaluateTenantRole({
      tenant: role('postgres', { bypassrls: true }),
      owner: null,
      separateAdminConnection: false,
    });
    expect(r.code).toBe('TENANT_BYPASSES_RLS');
  });

  it('fails when the tenant role is correct but no separate owner connection is configured', () => {
    // Not a leak — the opposite. Migrations, workers, the Command Center and
    // pre-auth login all legitimately cross studios and would read nothing,
    // silently, because RLS filters rather than errors.
    const r = evaluateTenantRole({ tenant: APP, owner: null, separateAdminConnection: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_PRIVILEGED_OWNER');
    expect(r.message).toContain('ADMIN_DATABASE_URL');
  });

  it('fails when ADMIN_DATABASE_URL is set but points at an unprivileged role', () => {
    // The half-finished cutover: both variables moved to app_tenant.
    const r = evaluateTenantRole({ tenant: APP, owner: APP, separateAdminConnection: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('OWNER_NOT_PRIVILEGED');
  });

  it('accepts an owner that is a superuser without rolbypassrls set', () => {
    const r = evaluateTenantRole({
      tenant: APP,
      owner: role('postgres', { bypassrls: false, superuser: true }),
      separateAdminConnection: true,
    });
    expect(r.ok).toBe(true);
  });

  it('reports the observed facts on every outcome, so the log shows evidence not a verdict', () => {
    for (const roles of [
      { tenant: APP, owner: OWNER, separateAdminConnection: true },
      { tenant: role('postgres', { bypassrls: true }), owner: OWNER, separateAdminConnection: true },
      { tenant: APP, owner: null, separateAdminConnection: false },
    ]) {
      const r = evaluateTenantRole(roles);
      expect(r.detail).toMatchObject({
        tenantRole: roles.tenant.role,
        tenantBypassRls: roles.tenant.bypassrls,
        separateAdminConnection: roles.separateAdminConnection,
      });
    }
  });

  it('never reports a connection string, only a role name', () => {
    // Connection strings carry passwords. The check exists to be logged loudly
    // at boot, so nothing it returns may contain one.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tenantRoleAssertion.js'), 'utf8');
    const code = src.slice(src.indexOf('function evaluateTenantRole'));
    expect(code).not.toContain('process.env.DATABASE_URL');
    expect(code).not.toContain('process.env.ADMIN_DATABASE_URL');
  });
});

describe('inspectRoles asks the TENANT pool, not whichever pool the wrapper picks', () => {
  const poolSrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'pool.js'), 'utf8');
  const fn = poolSrc.slice(poolSrc.indexOf('async function inspectRoles('), poolSrc.indexOf('pool.inspectRoles ='));

  it('borrows through _origConnect, the only method the patches cannot reach', () => {
    // At boot there is no AsyncLocalStorage store, so isPlatformWide() is true
    // and BOTH pool.query and pool.connect route to the OWNER pool. Written the
    // obvious way this function inspects the privileged connection, finds it
    // privileged, and passes while the tenant connection bypasses RLS —
    // reporting the exact state it exists to detect.
    //
    // _origQuery is NOT far enough back, and the first version of this used it.
    // pg's Pool.prototype.query calls this.connect() internally, and _origQuery
    // is bound to `pool`, whose connect has been replaced — so the query still
    // lands on the owner pool. Running it against a real database with
    // DATABASE_URL set to app_tenant reported `postgres`.
    expect(fn).toContain('_origConnect()');
    expect(fn).not.toContain('_origQuery');
    expect(fn).not.toMatch(/\bpool\.query\(/);
  });

  it('releases the client it borrowed even when the query throws', () => {
    // It borrows from the tenant pool at boot. A leak here holds a connection
    // for the life of the process, out of a Supabase budget the plan already
    // treats as scarce.
    expect(fn).toMatch(/finally \{\s*client\.release\(\);/);
  });

  it('asks the server who it authenticated, rather than parsing a URL', () => {
    expect(fn).toContain('current_user');
    expect(fn).toContain('rolbypassrls');
    expect(fn).toContain('rolsuper');
    expect(fn).not.toContain('DATABASE_URL');
  });

  it('only opens the owner pool when one is configured', () => {
    // Otherwise the check itself would create the second connection whose
    // absence it is reporting.
    expect(fn).toMatch(/SEPARATE_ADMIN_CONNECTION \? \(await ownerPool\(\)/);
  });
});

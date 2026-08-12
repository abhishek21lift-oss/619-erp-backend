'use strict';
// Two places where the tenant boundary's DEFAULT was the unsafe answer.
//
// Neither was a live leak. Both were defects in what happens when somebody
// forgets — which is the only failure mode that actually recurs, and the one a
// code review is worst at catching, because the reviewer sees the code that IS
// there rather than the category or the caller that is not yet.
//
// ── 1. Two org-resolution rules, quietly disagreeing ────────────────────
//
// resolveOrgId() accepted a super admin's target org from the `x-org-id`
// header OR `?organization_id=` OR a body field. tenantScope() accepted only
// the header. Both are super-admin-only, so neither was a tenant-user
// escalation — but auth.js sets the RLS GUC `app.org_id` from the first while
// every handler filters with the second. Once TENANT_RLS_ENFORCE is on and
// DATABASE_URL points at app_tenant, a super admin sending
// `?organization_id=X` would have had the DATABASE scoped to X while the
// APPLICATION still believed it was operating platform-wide: two layers
// disagreeing about the active tenant inside one request, which is precisely
// the confusion defence in depth exists to eliminate.
//
// ── 2. An unregistered upload category served itself ────────────────────
//
// routes/uploads.js resolved a storage key's category to the table that owns
// it, and any category it did not recognise fell through to "a valid session
// suffices". Every category written today is registered, so nothing leaked —
// but the twelfth one added would have been readable by any authenticated user
// in any studio holding the key, and this bucket holds PAR-Q health
// screenings, payment proofs and photographs of clients.

const { tenantScope, targetOrgId } = require('../lib/tenant-db');
const { resolveOrgId } = require('../middleware/tenant');

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

/** A request as the middleware sees it, with the pieces both helpers read. */
const reqOf = ({ role, orgId = null, headers = {}, query = {}, body = {} }) => ({
  user: { id: 'u1', role, organization_id: orgId },
  headers,
  query,
  body,
});

describe('org resolution — one rule, not two', () => {
  it('agrees with tenantScope for a super admin targeting an org by header', () => {
    const req = reqOf({ role: 'super_admin', headers: { 'x-org-id': ORG_B } });
    expect(resolveOrgId(req)).toBe(ORG_B);
    expect(tenantScope(req).orgId).toBe(ORG_B);
  });

  it('agrees for a super admin operating platform-wide', () => {
    const req = reqOf({ role: 'super_admin' });
    expect(resolveOrgId(req)).toBeNull();
    expect(tenantScope(req).orgId).toBeNull();
    expect(tenantScope(req).applyFilter).toBe(false);
  });

  it('ignores a target org smuggled through the query string', () => {
    // The divergence itself. resolveOrgId used to return ORG_B here while
    // tenantScope returned null — the GUC and the WHERE clause pointing at
    // different tenants.
    const req = reqOf({ role: 'super_admin', query: { organization_id: ORG_B } });
    expect(resolveOrgId(req)).toBeNull();
    expect(resolveOrgId(req)).toBe(tenantScope(req).orgId);
  });

  it('ignores a target org smuggled through the request body', () => {
    const req = reqOf({ role: 'super_admin', body: { organization_id: ORG_B } });
    expect(resolveOrgId(req)).toBeNull();
    expect(resolveOrgId(req)).toBe(tenantScope(req).orgId);
  });

  it('never lets a tenant user name their own target, by any route in', () => {
    // The header is honoured for super admins only; for everyone else the org
    // comes off the database-loaded user row and nothing else.
    for (const attempt of [
      { headers: { 'x-org-id': ORG_B } },
      { query: { organization_id: ORG_B } },
      { body: { organization_id: ORG_B } },
    ]) {
      const req = reqOf({ role: 'admin', orgId: ORG_A, ...attempt });
      expect(resolveOrgId(req)).toBe(ORG_A);
      expect(tenantScope(req).orgId).toBe(ORG_A);
    }
  });

  it('throws NO_TENANT for an org-less tenant user rather than resolving null', () => {
    // resolveOrgId and tenantScope keep DIFFERENT contracts here on purpose —
    // one throws, the other returns null so the filter matches no rows — and
    // sharing the target rule must not have collapsed that distinction.
    const req = reqOf({ role: 'admin', orgId: null });
    expect(() => resolveOrgId(req)).toThrow(/No organization context/i);
    expect(tenantScope(req).orgId).toBeNull();
    expect(tenantScope(req).applyFilter).toBe(true);
  });

  it('reads the target from the header and nowhere else', () => {
    expect(targetOrgId({ headers: { 'x-org-id': ORG_B }, query: {}, body: {} })).toBe(ORG_B);
    expect(targetOrgId({ headers: {}, query: { organization_id: ORG_B }, body: {} })).toBeNull();
    expect(targetOrgId({ headers: {}, query: {}, body: { organization_id: ORG_B } })).toBeNull();
  });
});

describe('upload categories — unregistered means denied', () => {
  // The route resolves the owning table from the category, so the assertion
  // that matters is which categories are registered at all. Read from source:
  // requiring a live R2 bucket and a database to prove a default would make
  // this untestable in CI, which is how the default got there.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'uploads.js'), 'utf8');

  it('refuses an unknown category instead of serving it on the session alone', () => {
    // The one-word edit this whole file exists to prevent.
    expect(src).toMatch(/if \(!table\) return false;/);
    expect(src).not.toMatch(/if \(!table\) return true;/);
  });

  it('registers every category that saveFile() actually writes', () => {
    // The real regression: a new category added to a write path and never
    // registered here. Now that unknown means denied, that shows up as a 404
    // on first read rather than as a cross-tenant serve — but catching it on
    // the branch is cheaper than catching it in production either way.
    const SRC = path.join(__dirname, '..');
    const written = new Set();
    for (const dir of ['routes', 'modules', 'lib']) {
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.js')) {
            const body = fs.readFileSync(p, 'utf8');
            for (const m of body.matchAll(/saveFile\(\s*'([^']+)'/g)) {
              written.add(m[1].split('/')[0]);
            }
          }
        }
      })(path.join(SRC, dir));
    }

    // Sanity: if this stops finding call sites the assertion below is vacuous.
    expect(written.size).toBeGreaterThan(5);

    // Public tier — served without a session, deliberately, by their own routes.
    const PUBLIC_TIER = ['profile', 'org-logos'];
    const unregistered = [...written].filter(
      (c) => !PUBLIC_TIER.includes(c) && !src.includes(`'${c}'`)
    );
    expect(unregistered).toEqual([]);
  });

  it('states the super-admin bypass once, above the category checks', () => {
    // Hoisting it was what let the denial be added safely: with the bypass
    // still buried in each branch, `if (!table) return false` would have
    // locked the platform console out of any category it is the sole reader
    // for. If someone reintroduces a per-branch copy, the ordering guarantee
    // is gone and this says so.
    const fn = src.slice(src.indexOf('async function callerOwnsRecord'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.match(/scope\.applyFilter/g)).toHaveLength(1);
    expect(body.indexOf('scope.applyFilter')).toBeLessThan(body.indexOf('if (!table)'));
  });
});

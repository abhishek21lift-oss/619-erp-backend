'use strict';
// TENANT_RLS_ENFORCE gates two independent files — middleware/auth.js
// (resolves the org id, opens the AsyncLocalStorage context) and db/pool.js
// (reads it, decides whether to wrap a query in a transaction). If the two
// ever read different env vars, or default to different values, one half
// of the plumbing could be "on" while the other stays "off" — the org
// context gets set but nothing reads it, or a query gets wrapped with no
// context to set, neither of which TENANT-RLS-PLAN.md's staged rollout can
// tell apart from "working". Reading the source rather than exercising a
// live request, same reasoning as this repo's other tenant convention
// tests: no live database in CI, and a source check catches the drift on
// the branch instead of on a staging run.
//
// SECURITY FIX: The flag now defaults to ON in production for security.
// Explicitly set to 'off' to disable (staged rollout only). Both files
// must read the env var the exact same way.

const fs = require('fs');
const path = require('path');

const auth = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');
const poolSrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'pool.js'), 'utf8');

describe('TENANT_RLS_ENFORCE — the two halves of the flag agree', () => {
  it('both files gate on the exact same env var, read the exact same way (secure default: ON)', () => {
    const FLAG = "process.env.TENANT_RLS_ENFORCE !== 'off'";
    expect(auth).toContain(FLAG);
    expect(poolSrc).toContain(FLAG);
  });

  it('defaults ON in production — unset or any value other than the literal string "off" enables enforcement', () => {
    // !== 'off' rather than a truthy check: an operator setting
    // TENANT_RLS_ENFORCE=true or =1 by habit from other flags in this repo
    // must not silently turn off a security control.
    // Only explicit 'off' disables (for staged rollout).
    expect(auth).not.toMatch(/TENANT_RLS_ENFORCE\s*\?\?/);
    expect(auth).not.toMatch(/Boolean\(process\.env\.TENANT_RLS_ENFORCE\)/);
    // Ensure the strict comparison is used, not a loose truthy check
    expect(auth).toMatch(/!==\s*'off'/);
    expect(poolSrc).toMatch(/!==\s*'off'/);
  });

  it("auth.js never blocks a request when org-id resolution fails — it only feeds a query wrapper, it is not a new authorization gate", () => {
    const fn = auth.slice(auth.indexOf('async function auth('));
    // The TENANT_RLS_ENFORCE block ends with `return runWithTenantContext(...);`
    // then closes with `}` and `next();` before the outer catch.
    const blockStart = fn.indexOf('TENANT_RLS_ENFORCE) {');
    const blockEnd = fn.indexOf('return runWithTenantContext', blockStart);
    // Include up to the closing brace of the if block
    const afterReturn = fn.indexOf('}', blockEnd);
    const guard = fn.slice(blockStart, afterReturn + 1);
    expect(guard).toContain('try { orgId = resolveOrgId(req); } catch');
    // No res.status(...) inside the enforcement branch — a failure to
    // resolve an org id here must fall through to orgId = null, not reject
    // the request. NO_TENANT rejection is requireRole/requireClient's job
    // further down the chain, not this flag's.
    expect(guard).not.toMatch(/res\.status/);
  });

  it("pool.js's wrapper is a straight pass-through when there is no org id, on or off", () => {
    const patch = poolSrc.slice(poolSrc.indexOf('pool.query = function slowQueryInstrument'));
    // Whitespace-collapsed, because this guards the CONTROL FLOW and not the
    // layout. The original form pinned exact indentation and broke the day the
    // owner-connection branch nested this one a level deeper — while the
    // behaviour it exists to protect was completely unchanged. A guard that
    // fails on reformatting trains people to edit the guard.
    expect(patch.replace(/\s+/g, ' ')).toContain('orgId == null ? _origQuery(...args)');
  });

  it('sends platform-wide work to the owner connection BEFORE consulting the org id', () => {
    // Once DATABASE_URL points at app_tenant, a connection with no app.org_id
    // reads zero rows. Platform-wide work — the operator console, every
    // background worker, migrations, and the pre-auth routes — deliberately
    // has no org, so consulting the org id first would drop it into the
    // unscoped branch and it would silently read nothing.
    const patch = poolSrc.slice(poolSrc.indexOf('pool.query = function slowQueryInstrument'));
    const flat = patch.replace(/\s+/g, ' ');
    expect(flat).toContain('useOwnerConnection() ? ownerPool().query(...args)');
    expect(flat.indexOf('useOwnerConnection()')).toBeLessThan(flat.indexOf('currentOrgId()'));
  });

  it('borrowed clients route the same way, so a transaction cannot land on the wrong role', () => {
    const connect = poolSrc.slice(poolSrc.indexOf('pool.connect = function tenantScopedConnect'));
    const flat = connect.replace(/\s+/g, ' ');
    expect(flat).toContain('if (useOwnerConnection()) return ownerPool().connect(...args);');
    expect(flat.indexOf('useOwnerConnection()')).toBeLessThan(flat.indexOf('currentOrgId()'));
  });

  it('keeps one owner connection, defaulting to DATABASE_URL so it is inert before cutover', () => {
    // Before the cutover both URLs are the same `postgres` role, so
    // SEPARATE_ADMIN_CONNECTION is false and no second pool is ever created —
    // the same "lands inert" property that let migrations 157 and 159 ship.
    expect(poolSrc).toContain("process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL");
    expect(poolSrc).toMatch(/SEPARATE_ADMIN_CONNECTION\s*=\s*ADMIN_DATABASE_URL !== process\.env\.DATABASE_URL/);
    expect(poolSrc).toMatch(/TENANT_RLS_ENFORCE && SEPARATE_ADMIN_CONNECTION && isPlatformWide\(\)/);
  });
});

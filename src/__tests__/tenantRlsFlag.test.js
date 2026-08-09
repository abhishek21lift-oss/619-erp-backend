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

const fs = require('fs');
const path = require('path');

const auth = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');
const poolSrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'pool.js'), 'utf8');

describe('TENANT_RLS_ENFORCE — the two halves of the flag agree', () => {
  it('both files gate on the exact same env var, read the exact same way', () => {
    const FLAG = "process.env.TENANT_RLS_ENFORCE === 'on'";
    expect(auth).toContain(FLAG);
    expect(poolSrc).toContain(FLAG);
  });

  it('defaults off — unset or any value other than the literal string "on" stays off', () => {
    // === 'on' rather than a truthy check: an operator setting
    // TENANT_RLS_ENFORCE=true or =1 by habit from other flags in this repo
    // must not silently turn on a transaction wrapper nobody meant to flip.
    expect(auth).not.toMatch(/TENANT_RLS_ENFORCE\s*\?\?/);
    expect(auth).not.toMatch(/Boolean\(process\.env\.TENANT_RLS_ENFORCE\)/);
  });

  it("auth.js never blocks a request when org-id resolution fails — it only feeds a query wrapper, it is not a new authorization gate", () => {
    const fn = auth.slice(auth.indexOf('async function auth('));
    const guard = fn.slice(fn.indexOf('TENANT_RLS_ENFORCE) {'), fn.indexOf('next();\n  } catch'));
    expect(guard).toContain('try { orgId = resolveOrgId(req); } catch');
    // No res.status(...) inside the enforcement branch — a failure to
    // resolve an org id here must fall through to orgId = null, not reject
    // the request. NO_TENANT rejection is requireRole/requireClient's job
    // further down the chain, not this flag's.
    expect(guard).not.toMatch(/res\.status/);
  });

  it("pool.js's wrapper is a straight pass-through when there is no org id, on or off", () => {
    const patch = poolSrc.slice(poolSrc.indexOf('pool.query = function slowQueryInstrument'));
    expect(patch).toContain('orgId == null\n    ? _origQuery(...args)');
  });
});

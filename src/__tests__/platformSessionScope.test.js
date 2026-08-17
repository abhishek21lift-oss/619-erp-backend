'use strict';
// The mirror of platformBoundary.test.js: the tenant application refuses
// control-plane sessions.
//
// Without this half, the separation is one-directional — studios locked out of
// the platform, the platform free to roam the studios on its own credential.
// That matters for a reason beyond symmetry. The operator already HAS a
// sanctioned way into a studio: impersonation, which mints a studio-audience
// token and writes an audit row naming who acted. If a platform session can
// also just call /api/clients directly, then some crossings are recorded and
// some are not, and the audit trail is worth exactly as much as the least
// disciplined path through it.
//
// The rule is enforced at ONE place — inside the auth middleware, classifying
// by path — rather than mounted onto the ~45 tenant routes in server.js. These
// tests pin both halves of that: the classification, and the fact that the
// choke point actually runs.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const {
  isTenantPlanePath, platformSessionBlocked, denyPlatformSession,
  AUD_PLATFORM, AUD_TENANT,
} = require('../middleware/platformAuth');

const reqFor = (url, aud) => ({ originalUrl: url, url, session: { aud } });

beforeEach(() => { delete process.env.PLATFORM_SESSION_ENFORCE; });

describe('which plane a path belongs to', () => {
  it('puts both names of the control plane on the platform side', () => {
    expect(isTenantPlanePath('/api/platform/organizations')).toBe(false);
    expect(isTenantPlanePath('/api/super-admin/organizations')).toBe(false);
  });

  it('puts the platform-destructive admin tooling on the platform side', () => {
    // admin-reset.js: DELETE across every tenant, no organization_id filter.
    expect(isTenantPlanePath('/api/admin/reset-all-data')).toBe(false);
  });

  it('leaves sign-in, refresh and profile reachable from both planes', () => {
    // Plane-scoping these deadlocks the product: the operator must be able to
    // end a session, refresh is how a session proves it still exists, and
    // /api/profile carries the MFA enrolment that requireSuperAdminMfa
    // depends on — gate it and an operator who has not enrolled cannot.
    for (const p of ['/api/auth/logout', '/api/v1/auth/refresh', '/api/profile/mfa/setup', '/api/health']) {
      expect([p, isTenantPlanePath(p)]).toEqual([p, false]);
    }
  });

  it('treats the studio application as the tenant plane', () => {
    for (const p of ['/api/clients', '/api/payments', '/api/pt-os/clients', '/api/attendance']) {
      expect([p, isTenantPlanePath(p)]).toEqual([p, true]);
    }
  });

  it('treats a path it has never seen as tenant surface', () => {
    // The property that matters most here, and the reason the function is
    // written as "everything else" rather than as a list of tenant prefixes:
    // a route added next year is covered without anybody remembering to add
    // it, and forgetting fails toward the restrictive answer.
    expect(isTenantPlanePath('/api/some-feature-invented-in-2027')).toBe(true);
  });

  it('is not fooled by a query string', () => {
    expect(isTenantPlanePath('/api/platform/organizations?limit=10')).toBe(false);
  });
});

describe('a Command Center session inside the studio app', () => {
  it('is allowed while the flag is off, whatever the path', () => {
    // The flag fails CLOSED by default (absent means enforced), so the
    // permissive half of the rollout has to be named explicitly.
    process.env.PLATFORM_SESSION_ENFORCE = 'off';
    expect(platformSessionBlocked(reqFor('/api/clients', AUD_PLATFORM))).toBe(false);
  });

  it('is blocked on tenant paths once the flag is on', () => {
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    expect(platformSessionBlocked(reqFor('/api/clients', AUD_PLATFORM))).toBe(true);
  });

  it('is still allowed on the control plane it belongs to', () => {
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    expect(platformSessionBlocked(reqFor('/api/platform/overview', AUD_PLATFORM))).toBe(false);
  });

  it('is still allowed to sign itself out', () => {
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    expect(platformSessionBlocked(reqFor('/api/auth/logout', AUD_PLATFORM))).toBe(false);
  });
});

describe('a studio session is never blocked by this rule', () => {
  it.each([[AUD_TENANT], [null]])('audience %s passes on a tenant path with the flag on', (aud) => {
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    expect(platformSessionBlocked(reqFor('/api/clients', aud))).toBe(false);
  });
});

describe('the express form answers the same question', () => {
  const run = (req) => {
    let nexted = false;
    let status = null;
    let body = null;
    denyPlatformSession(req, {
      status(s) { status = s; return this; },
      json(b) { body = b; return this; },
    }, () => { nexted = true; });
    return { nexted, status, body };
  };

  it('calls next when the session belongs here', () => {
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    expect(run(reqFor('/api/clients', AUD_TENANT)).nexted).toBe(true);
  });

  it('answers 403 with a code the client can act on', () => {
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    const { nexted, status, body } = run(reqFor('/api/clients', AUD_PLATFORM));
    expect(nexted).toBe(false);
    expect(status).toBe(403);
    expect(body.error.code).toBe('TENANT_SESSION_REQUIRED');
  });
});

describe('the choke point is wired into auth, not left to route mounts', () => {
  // The rule is only as good as the number of places it is applied. Mounting
  // it per-route means ~45 chances to forget; this asserts it is called from
  // the one place every authenticated request already passes through.
  const fs = require('node:fs');
  const path = require('node:path');
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');

  it('auth.js consults platformSessionBlocked', () => {
    expect(authSrc).toMatch(/platformSessionBlocked\(req\)/);
  });

  it('and does so before the request reaches any handler', () => {
    // Specifically: before the impersonation branch and before the tenant
    // context is opened, so a blocked session never runs a query.
    //
    // Compared against the CALL rather than the import at the top of the file,
    // which the first version of this assertion matched instead and so was
    // measuring nothing.
    const at = authSrc.indexOf('platformSessionBlocked(req)');
    expect(at).toBeGreaterThan(-1);
    const impersonationBranch = authSrc.indexOf('if (decoded.imp)');
    const tenantContextCall = authSrc.indexOf('return runWithTenantContext(');
    expect(impersonationBranch).toBeGreaterThan(-1);
    expect(tenantContextCall).toBeGreaterThan(-1);
    expect(at).toBeLessThan(impersonationBranch);
    expect(at).toBeLessThan(tenantContextCall);
  });
});

'use strict';
// The control plane's boundary — the four facts that must hold together.
//
// Before this, "may act across every studio" was one string comparison:
// `req.user.role === 'super_admin'`. That is not a boundary, it is a field.
// Anything that could write users.role — a support fix applied with psql, a
// seed script, an update handler that forgets to exclude `role` from a patch
// body — was one statement away from handing an account every studio's data,
// with nothing recording that anybody intended it.
//
// middleware/platformAuth.js replaces the single check with four, chosen so
// they fail in different directions and an attacker needs all of them:
//
//   ROLE       users.role = 'super_admin'
//   GRANT      a live row in platform_owners (migration 161)
//   AUDIENCE   the session was opened at the Command Center door
//   NOT IMP.   no impersonation in flight
//
// These tests exercise the real middleware against a real Express app, so a
// future edit that drops one of the four — or that re-mounts the platform API
// on the old role-only chain — fails here rather than in production.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const platformAuth = require('../middleware/platformAuth');
const {
  requirePlatformOwner, hasPlatformGrant, invalidatePlatformGrant, AUD_PLATFORM, AUD_TENANT,
} = platformAuth;

const OPERATOR = { id: 'usr-operator', role: 'super_admin', organization_id: null };
const TENANT_ADMIN = { id: 'usr-owner', role: 'admin', organization_id: 'org-a' };
const TRAINER = { id: 'usr-trainer', role: 'trainer', organization_id: 'org-a' };

/**
 * An app mounted the way server.js mounts the platform API, minus the role and
 * MFA guards that sit in front of requirePlatformOwner there.
 *
 * Deliberately without them: this file is about what requirePlatformOwner
 * itself refuses. If the role check were also mounted here, the "refuses a
 * tenant admin" case would pass even if requirePlatformOwner had no role check
 * of its own — and the whole point of the four facts is that each one holds on
 * its own rather than by being covered by a neighbour.
 */
function appWith(session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = session.user;
    req.session = { aud: session.aud ?? null };
    if (session.impersonation) req.impersonation = session.impersonation;
    next();
  });
  app.use('/api/platform', requirePlatformOwner, (_req, res) => res.json({ ok: true }));
  return app;
}

/** platform_owners returns a row (granted) or none (not granted). */
function grantIs(granted) {
  pool.query.mockImplementation(async (sql) => {
    if (/platform_owners/.test(sql)) return { rows: granted ? [{ '?column?': 1 }] : [] };
    return { rows: [] };
  });
}

beforeEach(() => {
  pool.query.mockReset();
  // The grant is cached for 10s, and every test in this file uses the same
  // user id. Without this the second test would read the first one's answer.
  invalidatePlatformGrant();
  delete process.env.PLATFORM_SESSION_ENFORCE;
  grantIs(true);
});

describe('requirePlatformOwner — role', () => {
  it('refuses a tenant Studio Owner, whatever else is true', async () => {
    const res = await request(appWith({ user: TENANT_ADMIN, aud: AUD_PLATFORM })).get('/api/platform');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLATFORM_FORBIDDEN');
  });

  it('refuses a trainer', async () => {
    const res = await request(appWith({ user: TRAINER, aud: AUD_PLATFORM })).get('/api/platform');
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(appWith({ user: undefined })).get('/api/platform');
    expect(res.status).toBe(401);
  });

  it('admits the operator when every fact holds', async () => {
    const res = await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform');
    expect(res.status).toBe(200);
  });
});

describe('requirePlatformOwner — the explicit grant', () => {
  it('refuses role=super_admin with no row in platform_owners', async () => {
    // The case the grant exists for: somebody whose role says operator but
    // whom nobody deliberately authorized. Before 161 this request succeeded.
    grantIs(false);
    const res = await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLATFORM_GRANT_REQUIRED');
  });

  it('actually asks the database rather than trusting the role', async () => {
    await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform');
    const asked = pool.query.mock.calls.some(([sql]) => /platform_owners/.test(sql));
    expect(asked).toBe(true);
  });

  it('reads the grant as live only — a revoked row is not a grant', async () => {
    await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform');
    const [sql] = pool.query.mock.calls.find(([s]) => /platform_owners/.test(s));
    expect(sql).toMatch(/revoked_at IS NULL/);
  });

  it('fails CLOSED when platform_owners cannot be read', async () => {
    // A boundary that opens when a query throws is a boundary an attacker only
    // has to make throw. The console returning 403 until somebody fixes the
    // database is the recoverable failure; the other one is not.
    pool.query.mockImplementation(async () => { throw new Error('connection refused'); });
    const res = await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLATFORM_GRANT_REQUIRED');
  });

  it('fails closed when the table does not exist yet', async () => {
    // Migration 161 not applied. Distinguished in the log, not in the answer.
    const err = new Error('relation "platform_owners" does not exist');
    err.code = '42P01';
    pool.query.mockImplementation(async () => { throw err; });
    const res = await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform');
    expect(res.status).toBe(403);
  });

  it('does not cache a denial caused by a database error', async () => {
    // A transient outage must not pin the operator out for the cache TTL after
    // the database recovers.
    pool.query.mockImplementation(async () => { throw new Error('down'); });
    expect((await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform')).status).toBe(403);
    grantIs(true);
    expect((await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform')).status).toBe(200);
  });
});

describe('requirePlatformOwner — session audience', () => {
  it('accepts a legacy session (no audience) while the flag is off', async () => {
    // Every token issued before audiences existed. Enforcing on deploy would
    // sign the operator out of the console with a 403 they cannot clear.
    // The flag now fails CLOSED by default (absent means enforced), so the
    // permissive half of the rollout has to be named explicitly.
    process.env.PLATFORM_SESSION_ENFORCE = 'off';
    const res = await request(appWith({ user: OPERATOR, aud: null })).get('/api/platform');
    expect(res.status).toBe(200);
  });

  it('accepts a studio-door session while the flag is off', async () => {
    process.env.PLATFORM_SESSION_ENFORCE = 'off';
    const res = await request(appWith({ user: OPERATOR, aud: AUD_TENANT })).get('/api/platform');
    expect(res.status).toBe(200);
  });

  it('refuses a studio-door session once the flag is on', async () => {
    // The property that makes the separation real rather than nominal: an
    // operator's cookie from /login cannot drive the control plane.
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    const res = await request(appWith({ user: OPERATOR, aud: AUD_TENANT })).get('/api/platform');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLATFORM_SESSION_REQUIRED');
  });

  it('refuses a legacy session once the flag is on', async () => {
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    const res = await request(appWith({ user: OPERATOR, aud: null })).get('/api/platform');
    expect(res.status).toBe(403);
  });

  it('still admits a Command Center session with the flag on', async () => {
    process.env.PLATFORM_SESSION_ENFORCE = 'on';
    const res = await request(appWith({ user: OPERATOR, aud: AUD_PLATFORM })).get('/api/platform');
    expect(res.status).toBe(200);
  });
});

describe('requirePlatformOwner — impersonation', () => {
  it('refuses a request carrying an impersonation claim', async () => {
    // While impersonating, req.user IS the tenant admin. A request holding a
    // tenant identity AND an operator's provenance is one nothing downstream
    // is built to authorize, so it is refused before that question arises.
    const res = await request(appWith({
      user: OPERATOR,
      aud: AUD_PLATFORM,
      impersonation: { by: 'usr-operator', ro: true, org: 'org-a' },
    })).get('/api/platform');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLATFORM_FORBIDDEN_IMPERSONATING');
  });

  it('refuses it before consulting the grant', async () => {
    pool.query.mockClear();
    await request(appWith({
      user: OPERATOR, aud: AUD_PLATFORM, impersonation: { by: 'x', ro: true },
    })).get('/api/platform');
    expect(pool.query.mock.calls.some(([sql]) => /platform_owners/.test(sql))).toBe(false);
  });
});

describe('the grant is read on the owner connection, whatever org is named', () => {
  // The bug the CI-only RLS suite caught.
  //
  // "May this person operate the platform" is an authorization question, not a
  // tenant-data question. db/pool.js routes to the owner connection only when
  // isPlatformWide() is true, and auth.js computes that as
  // `role === 'super_admin' && orgId == null` — so an operator with the
  // org-switcher pinned sends x-org-id, orgId is non-null, and the lookup would
  // run as app_tenant. platform_owners has RLS on and no app_tenant policy by
  // design, so it would read zero rows and lock the operator out of their own
  // console.
  //
  // The frontend sends x-org-id from localStorage on every request, so a pin
  // set weeks earlier is enough. It stays latent until TENANT_RLS_ENFORCE is on
  // AND ADMIN_DATABASE_URL differs — the exact deployment this mechanism exists
  // for, and the worst possible moment to find out.
  const { runWithTenantContext, isPlatformWide } = require('../lib/tenant-context');

  it('runs the lookup platform-wide even inside a tenant-scoped context', async () => {
    let sawPlatformWide = null;
    pool.query.mockImplementation(async (sql) => {
      if (/platform_owners/.test(sql)) sawPlatformWide = isPlatformWide();
      return { rows: [{ ok: 1 }] };
    });

    // Exactly what auth.js opens for a super admin who named an org.
    await runWithTenantContext('org-a', async () => {
      expect(isPlatformWide()).toBe(false);   // the context really is scoped
      await hasPlatformGrant('usr-operator');
    }, { platformWide: false });

    expect(sawPlatformWide).toBe(true);
  });

  it('still answers correctly for the ordinary platform-wide request', async () => {
    invalidatePlatformGrant();
    grantIs(true);
    await runWithTenantContext(null, async () => {
      expect(await hasPlatformGrant('usr-operator')).toBe(true);
    }, { platformWide: true });
  });
});

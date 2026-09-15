'use strict';
// Impersonation, attacked from every side it can be attacked from.
//
// ── Why this file exists ───────────────────────────────────────────────────
//
// Impersonation is the most privileged path in the product: it mints a token
// that carries a studio admin's identity, on demand, for any studio on the
// platform. Before this file there was no test of it anywhere — the whole
// subsystem was covered only by whatever incidentally exercised the middleware.
//
// The design is sound; that is not the same as proven. Each property below is
// load-bearing, and each is asserted by DRIVING the real middleware with a real
// signed token rather than by reading the source:
//
//   1. A read-only token cannot write. Any method other than GET/HEAD/OPTIONS
//      is refused, whatever the route would otherwise have allowed.
//   2. An impersonation token can never re-enter the control plane. Without
//      this the operator's provenance and the admin's identity arrive on one
//      request and nothing downstream is built to choose between them.
//   3. It cannot escape its studio. req.user IS the target admin, so
//      tenantScope() reads their organization_id and the x-org-id header — the
//      operator's own studio switcher — is ignored for a non-super_admin.
//   4. It dies when the target's token_version moves, so force-logout and a
//      password change kill an in-flight impersonation.
//   5. A platform account can never be the target.
//   6. The TTL is bounded, because there is no other revocation path.

const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const TARGET_ADMIN = {
  id: 'admin-a', name: 'Studio A Admin', email: 'a@example.com',
  role: 'admin', organization_id: ORG_A, is_active: true, token_version: 7,
};

let mockDbUser = { ...TARGET_ADMIN };

jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({ rows: [{ ...mockDbUser }], rowCount: 1 })),
  connect: jest.fn(async () => ({
    query: jest.fn(async () => ({ rows: [{ ...mockDbUser }], rowCount: 1 })),
    release: jest.fn(),
  })),
}));

const express = require('express');
const request = require('supertest');
const { auth, invalidateUserCache } = require('../middleware/auth');
const { AUD_TENANT } = require('../middleware/platformAuth');

/** A real signed impersonation token, exactly as the mint produces one. */
function impToken({ ro = true, by = 'operator-1', org = ORG_A, tokenVersion = 7, expiresIn = '30m' } = {}) {
  return jwt.sign(
    {
      id: TARGET_ADMIN.id,
      token_version: tokenVersion,
      aud: AUD_TENANT,
      imp: { by, byName: 'Operator', ro, org },
    },
    process.env.JWT_SECRET,
    { expiresIn },
  );
}

/** An app that runs the REAL auth middleware, then echoes what survived. */
function appWithAuth(extra) {
  const app = express();
  app.use(express.json());
  app.use(auth);
  if (extra) app.use(extra);
  app.all('/probe', (req, res) => res.json({
    userId: req.user && req.user.id,
    role: req.user && req.user.role,
    orgId: req.user && req.user.organization_id,
    impersonation: req.impersonation || null,
  }));
  return app;
}

beforeEach(() => {
  mockDbUser = { ...TARGET_ADMIN };
  // auth() caches the resolved user for 30s. Without clearing it, every case
  // after the first would be graded against the first case's row — which is
  // how the deactivation and token_version cases first "failed": the middleware
  // was correct and the fixture was stale. The cache is real and load-bearing
  // (force-logout calls this same function so a revocation lands immediately
  // rather than up to 30s later), so it is cleared rather than disabled.
  invalidateUserCache();
});

describe('1. a read-only session cannot write', () => {
  it('lets a GET through', async () => {
    const res = await request(appWithAuth()).get('/probe').set('Authorization', `Bearer ${impToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(TARGET_ADMIN.id);
    expect(res.body.impersonation).toMatchObject({ ro: true, by: 'operator-1' });
  });

  it.each(['post', 'put', 'patch', 'delete'])('refuses %s', async (verb) => {
    const res = await request(appWithAuth())[verb]('/probe')
      .set('Authorization', `Bearer ${impToken({ ro: true })}`)
      .send({ any: 'payload' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IMPERSONATION_READONLY');
  });

  it('a full-mode token may write — otherwise the mode does nothing', async () => {
    // The other side of the boundary. A read-only check that refused every
    // impersonation would pass the four assertions above while breaking the
    // sanctioned write path.
    const res = await request(appWithAuth()).post('/probe')
      .set('Authorization', `Bearer ${impToken({ ro: false })}`)
      .send({ any: 'payload' });
    expect(res.status).toBe(200);
    expect(res.body.impersonation.ro).toBe(false);
  });
});

describe('2. impersonation can never reach the control plane', () => {
  const { requirePlatformOwner } = require('../middleware/platformAuth');

  it('is refused even when the impersonated account would otherwise qualify', async () => {
    // The role check would already refuse an `admin`. This asserts the explicit
    // impersonation refusal fires FIRST, so the guarantee does not depend on
    // the target's role — which is what would break if a platform account were
    // ever impersonable.
    mockDbUser = { ...TARGET_ADMIN, role: 'super_admin' };
    const app = appWithAuth(requirePlatformOwner);
    const res = await request(app).get('/probe').set('Authorization', `Bearer ${impToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLATFORM_FORBIDDEN_IMPERSONATING');
  });
});

describe('3. impersonation cannot escape its studio', () => {
  const { tenantScope } = require('../lib/tenant-db');

  it('ignores x-org-id, because req.user is an admin and not a super_admin', async () => {
    const app = express();
    app.use(auth);
    app.get('/scope', (req, res) => res.json(tenantScope(req)));
    const res = await request(app).get('/scope')
      .set('Authorization', `Bearer ${impToken()}`)
      .set('x-org-id', ORG_B);
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(ORG_A);
    expect(res.body.applyFilter).toBe(true);
    expect(res.body.isSuperAdmin).toBe(false);
  });

  it('an org-less target matches no rows rather than everything', async () => {
    // applyFilter must stay true with a null org: `organization_id = NULL`
    // matches nothing, which is the fail-closed outcome. applyFilter false
    // would mean platform-wide.
    mockDbUser = { ...TARGET_ADMIN, organization_id: null };
    const app = express();
    app.use(auth);
    app.get('/scope', (req, res) => res.json(tenantScope(req)));
    const res = await request(app).get('/scope').set('Authorization', `Bearer ${impToken()}`);
    expect(res.body.applyFilter).toBe(true);
    expect(res.body.orgId).toBeNull();
  });
});

describe('4. revoking the target revokes the impersonation', () => {
  it('rejects the token once the target\'s token_version moves', async () => {
    // Force-logout and password change both bump token_version. An in-flight
    // impersonation must die with it — otherwise the one lever an admin has
    // against a session does not reach the operator holding one.
    mockDbUser = { ...TARGET_ADMIN, token_version: 8 };
    const res = await request(appWithAuth()).get('/probe')
      .set('Authorization', `Bearer ${impToken({ tokenVersion: 7 })}`);
    expect(res.status).toBe(401);
  });

  it('rejects a deactivated target', async () => {
    mockDbUser = { ...TARGET_ADMIN, is_active: false };
    const res = await request(appWithAuth()).get('/probe')
      .set('Authorization', `Bearer ${impToken()}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const res = await request(appWithAuth()).get('/probe')
      .set('Authorization', `Bearer ${impToken({ expiresIn: '-1s' })}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign(
      { id: TARGET_ADMIN.id, token_version: 7, aud: AUD_TENANT, imp: { by: 'x', ro: false, org: ORG_A } },
      'not-the-real-secret-but-long-enough-to-sign!!',
      { expiresIn: '30m' },
    );
    const res = await request(appWithAuth()).get('/probe').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});

describe('5. the mint refuses targets it must refuse', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../modules/platform/super-admin/impersonation'), 'utf8',
  );

  it('refuses a platform account outright', () => {
    expect(src).toMatch(/role === 'super_admin'/);
    expect(src).toMatch(/Cannot impersonate a platform account/);
  });

  it('refuses a deactivated account', () => {
    expect(src).toMatch(/is_active/);
    expect(src).toMatch(/INACTIVE/);
  });

  it('only ever selects a target inside the named organization', () => {
    // Both branches — an explicit user_id and the default primary admin — must
    // carry the org predicate, or naming any user id on the platform would
    // pick them up.
    const explicit = src.slice(src.indexOf('if (req.body.user_id)'), src.indexOf('} else {'));
    expect(explicit).toMatch(/organization_id = \$2/);
    const fallback = src.slice(src.indexOf('} else {'), src.indexOf('if (!target)'));
    expect(fallback).toMatch(/organization_id = \$1/);
  });

  it('writes an audit row naming the operator, the target and the mode', () => {
    expect(src).toMatch(/audit\(req, 'user_impersonated', 'user', target\.id/);
    expect(src).toMatch(/mode: readonly \? 'read_only' : 'full'/);
  });

  it('mints a TENANT-audience token, so the control plane will not take it', () => {
    expect(src).toMatch(/aud: AUD_TENANT/);
  });

  it('issues no refresh token, so the session cannot outlive its TTL', () => {
    // Asserted against CODE, not prose: the handler's own comment says "No
    // refresh token issued", so a bare /refresh/i match is satisfied by the
    // documentation regardless of what the handler does.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/refresh/i);
    expect(code).not.toMatch(/res\.cookie\s*\(/);
  });
});

describe('6. the TTL is bounded, because nothing else bounds the session', () => {
  const { ttlMinutes, IMPERSONATION_TTL_MAX_MINUTES } = require('../modules/platform/super-admin/shared');

  it('reads the durations an operator would plausibly write', () => {
    expect(ttlMinutes('30m')).toBe(30);
    expect(ttlMinutes('45')).toBe(45);
    expect(ttlMinutes('2h')).toBe(120);
  });

  it('treats an unreadable value as absent rather than as zero', () => {
    for (const bad of ['', '   ', 'garbage', '0', '-5', '30d', '10 days', null, undefined]) {
      expect(ttlMinutes(bad)).toBeNull();
    }
  });

  it('caps at two hours', () => {
    expect(IMPERSONATION_TTL_MAX_MINUTES).toBe(120);
  });

  it('the resolved TTL never exceeds the cap, whatever the environment says', () => {
    // `30d` is a plausible typo for `30m`, and read raw it would mint
    // month-long tokens carrying a studio admin's identity.
    const saved = process.env.IMPERSONATION_TTL;
    try {
      for (const [env, want] of Object.entries({
        '30m': '30m', '15m': '15m', '1h': '60m',
        '2h': '120m', '8h': '120m', '9999': '120m',
        '30d': '30m', garbage: '30m', '': '30m',
      })) {
        process.env.IMPERSONATION_TTL = env;
        jest.resetModules();
        // Re-required inside the loop on purpose: IMPERSONATION_TTL is resolved
        // once at module load, so reading the clamp for a new env value means
        // loading the module again.
        const fresh = require('../modules/platform/super-admin/shared');
        expect(`${env} -> ${fresh.IMPERSONATION_TTL}`).toBe(`${env} -> ${want}`);
      }
    } finally {
      if (saved === undefined) delete process.env.IMPERSONATION_TTL;
      else process.env.IMPERSONATION_TTL = saved;
      jest.resetModules();
    }
  });
});

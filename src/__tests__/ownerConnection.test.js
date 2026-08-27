'use strict';
// Which connection a query runs on, once DATABASE_URL points at app_tenant.
//
// After the cutover a connection with no `app.org_id` matches no tenant policy
// and reads ZERO ROWS. That is the correct answer for an authenticated request
// whose organization could not be resolved, and a catastrophe for everything
// that legitimately works across studios — the platform console, every
// background worker, migrations, and the unauthenticated routes, because login
// cannot scope itself to a studio before it has found the user whose studio it
// is.
//
// None of those would have errored. They would have silently returned nothing:
// renewals stopping, the operator console rendering empty, login failing to
// find accounts that exist.
//
// So the routing has three outcomes, and the whole design rests on telling the
// third apart from the first:
//
//   no ALS store          → owner connection   (worker, migration, pre-auth)
//   store, platformWide   → owner connection   (operator acting across tenants)
//   store, tenant request → app_tenant         (scoped, or seeing nothing)
//
// The discriminator is the PRESENCE of the store, not the org id inside it —
// a worker and an org-less authenticated request both have a null org and must
// end up in opposite places.

const {
  runWithTenantContext, runAsPlatform, currentOrgId, isPlatformWide,
} = require('../lib/tenant-context');

const ORG = '11111111-1111-1111-1111-111111111111';

describe('tenant context — the three states', () => {
  it('treats "no context at all" as platform-wide', () => {
    // Workers, cron, migrations, the startup probe, and every unauthenticated
    // route: only auth.js ever opens a context, so none of these have one.
    expect(isPlatformWide()).toBe(true);
    expect(currentOrgId()).toBeNull();
  });

  it('treats an authenticated tenant request as NOT platform-wide', () => {
    runWithTenantContext(ORG, () => {
      expect(isPlatformWide()).toBe(false);
      expect(currentOrgId()).toBe(ORG);
    });
  });

  it('keeps an org-less authenticated request off the owner connection', () => {
    // The case the whole design turns on. This request has a null org, exactly
    // like a background worker — but it is a logged-in user whose tenant could
    // not be determined, and it must see NOTHING rather than everything.
    runWithTenantContext(null, () => {
      expect(currentOrgId()).toBeNull();
      expect(isPlatformWide()).toBe(false);
    });
  });

  it('grants platform-wide only when asked explicitly', () => {
    // Same null org, opposite outcomes — the option is the whole difference.
    runWithTenantContext(null, () => {
      expect(isPlatformWide()).toBe(false);
    });
    runWithTenantContext(null, () => {
      expect(isPlatformWide()).toBe(true);
    }, { platformWide: true });
  });

  it('never infers platform-wide from a null org id', () => {
    // Inferring it would collapse "operator across every studio" and "this
    // user has no studio, show them nothing" into the more dangerous one.
    runWithTenantContext(null, () => expect(isPlatformWide()).toBe(false));
  });

  it('scopes a super admin who named a target org, like anybody else', () => {
    runWithTenantContext(ORG, () => {
      expect(isPlatformWide()).toBe(false);
      expect(currentOrgId()).toBe(ORG);
    }, { platformWide: false });
  });

  it('runAsPlatform marks deliberate cross-tenant work', () => {
    runAsPlatform(() => {
      expect(isPlatformWide()).toBe(true);
      expect(currentOrgId()).toBeNull();
    });
  });

  it('does not leak platform-wide out of its callback', () => {
    runAsPlatform(() => expect(isPlatformWide()).toBe(true));
    // Back outside: no store, which is platform-wide for a different and
    // legitimate reason — but a tenant context opened next must not inherit it.
    runWithTenantContext(ORG, () => expect(isPlatformWide()).toBe(false));
  });

  it('survives an await, which is why this is AsyncLocalStorage', async () => {
    await runWithTenantContext(ORG, async () => {
      await new Promise((r) => setImmediate(r));
      expect(currentOrgId()).toBe(ORG);
      expect(isPlatformWide()).toBe(false);
    });
  });

  it('restores the outer context when a tenant request nests inside platform work', async () => {
    await runAsPlatform(async () => {
      expect(isPlatformWide()).toBe(true);
      await runWithTenantContext(ORG, async () => {
        expect(isPlatformWide()).toBe(false);
      });
      expect(isPlatformWide()).toBe(true);
    });
  });
});

describe('auth.js is the only grant of platform-wide status', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..');

  it('computes it from the database-loaded role, never from the request', () => {
    const auth = fs.readFileSync(path.join(SRC, 'middleware', 'auth.js'), 'utf8');
    // req.user.role is loaded from the users table by this middleware; a
    // header or body value would be caller-controlled and is the one thing
    // that must never reach this decision.
    expect(auth).toMatch(/const platformWide = req\.user\.role === 'super_admin' && orgId == null;/);
  });

  it('is granted nowhere else in the codebase', () => {
    // Everything downstream reads this as "bypass RLS". A second place that
    // could set it is a second place that could hand a tenant the platform.
    const offenders = [];
    for (const root of ['routes', 'modules', 'lib', 'services', 'workers', 'jobs', 'middleware']) {
      const dir = path.join(SRC, root);
      if (!fs.existsSync(dir)) continue;
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          if (!e.name.endsWith('.js')) continue;
          const src = fs.readFileSync(p, 'utf8');
          // runAsPlatform is the sanctioned, self-documenting entry point for
          // background work; the raw option object is what must stay confined.
          // Path comparison via path.join so it holds on Windows separators too.
          if (/platformWide\s*:\s*true/.test(src) && !p.endsWith(path.join('lib', 'tenant-context.js'))) {
            offenders.push(path.relative(SRC, p));
          }
        }
      })(dir);
    }
    expect(offenders).toEqual([]);
  });
});

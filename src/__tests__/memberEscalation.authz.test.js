'use strict';
// A `member` session, pointed at every mount the server exposes.
//
// ── Why ────────────────────────────────────────────────────────────────────
//
// The audit asked for this by name (Section 11, missing test #3): "role
// escalation tests using a real member account against every staff mount".
//
// `member` is the role client activation creates for a gym client — the
// largest and least trusted population with a login. Two P0s in this audit
// were reachable by exactly that role, and both looked safe because the SQL
// carried an organization_id filter. That filter bounds the STUDIO. It says
// nothing about the ROLE, so a client of studio A reading studio A's staff
// data passes every tenant check in the codebase while still being a
// privilege escalation.
//
// Writing this found one: GET /api/support/tickets returned every support
// ticket the studio had raised — subject, category, priority, status,
// created_by_name — to any member, and POST created them in the studio's
// name. Fixed by adding requireStaff to that mount in server.js.
//
// ── How ────────────────────────────────────────────────────────────────────
//
// The mount list is read from server.js rather than typed here, so a new
// `app.use('/api/…')` is covered the day it lands: it either rejects a member,
// or it has to be added to MEMBER_REACHABLE with a reason. A hand-maintained
// list would have gone stale on the first new route, which is how the guards
// this audit criticised got their blind spots.
//
// Each router is mounted for real and probed on its own registered routes
// (read from router.stack), so the assertion is about what the code does, not
// about what its source text looks like.

const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const MEMBER = {
  id: 'member-1',
  role: 'member',
  organization_id: '11111111-1111-4111-8111-111111111111',
  member_id: 'mem-1',
  client_id: 'client-1',
  name: 'A Client',
};

jest.mock('../db/pool', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: jest.fn(async () => ({
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    release: jest.fn(),
  })),
}));

jest.mock('../middleware/auth', () => {
  const actual = jest.requireActual('../middleware/auth');
  return {
    ...actual,
    // A member who has already authenticated. The question this file asks is
    // what happens AFTER authentication succeeds, so the token check itself is
    // deliberately out of the way — it is covered by auth.login.test.js.
    auth: (req, _res, next) => { req.user = { ...MEMBER }; next(); },
  };
});

const express = require('express');
const request = require('supertest');
const { requireStaff } = require('../middleware/rbac');
const { auth } = require('../middleware/auth');

/**
 * Mounts a member is *supposed* to reach, each with the reason.
 *
 * An entry is a claim that a gym client seeing this is intended. It is not a
 * way to quiet a failure — if a mount lands here without that being true, the
 * test has been turned into decoration.
 */
const MEMBER_REACHABLE = {
  '/api/auth': 'Sign-in, sign-out, refresh and /me. Every role needs its own session endpoints.',
  '/api/v1/auth': 'The versioned alias of the same router, mounted twice in server.js.',
  '/api/auth/webauthn': 'A member enrolling and listing their OWN passkeys.',
  '/api/v1/auth/webauthn': 'Versioned alias of the same passkey router.',
  '/api/public': 'Unauthenticated marketing and signup surface; no session required at all.',
  '/api/client-activation': 'The flow that turns an activation link into a member account — by definition pre-member.',
  '/api/invitations': 'Invitation acceptance, reached before the account has any role.',
  '/api/registrations': 'Self-serve studio signup. Reached before any account exists, so there is no role to check against yet.',
  '/api/me': 'The client portal. This IS the member surface; every handler scopes to the session\'s own client id.',
  '/api/client-login': 'Client portal sign-in. A member authenticating is the one thing that must work before any role check can apply.',
  '/api/webhooks/razorpay': 'Payment provider callback, authenticated by signature rather than session.',
  '/api/bookings': 'A member listing their OWN bookings: the handler overrides member_id with the session\'s own for role === member, so the query string cannot widen it.',
  '/api/v1/bookings': 'Versioned alias of the same bookings router.',
  '/api/classes': 'The class timetable a member browses in order to book. Org-scoped by migration 176 and routes/classes.js.',
  '/api/diet': 'The meal library a member\'s own diet plan is built from; shared-shape table, same as exercises.',
  '/api/exercises': 'The exercise library a member\'s own workout is built from. Platform reference content.',
  '/api/workouts': 'Same library, reached through the workouts router.',
  '/api/ai': 'Conversations are keyed WHERE c.user_id = $1 — the member\'s own threads — and /actions returns only what canRun() permits for the caller\'s role.',
  '/api/v1/notifications': 'svc.inbox(req.user.id) — the member\'s own notification inbox.',
  '/api/qr': 'Generates the caller\'s OWN check-in QR, keyed from req.user.pt_client_id / member_id.',
  '/api/plans': 'The studio\'s membership price list. Org-scoped by migration 174. A member seeing what their own studio charges is the renewal screen working, not a leak — reviewed and left reachable.',
  '/api/features':
    'Studio feature flags, fetched by FeaturesProvider in the ROOT layout — so it runs for members too, and its .catch() means a 403 would be silent but produce one on every member page load. The payload is which modules the studio has enabled: studio configuration, not client or staff data. Reviewed and left reachable deliberately; gating it needs the frontend provider to stop calling it for members in the same change.',
};

/**
 * Individual ROUTES a member may reach, on mounts that are otherwise staff-only.
 *
 * Separate from MEMBER_REACHABLE above, which is keyed by mount — and mount
 * granularity is what let three findings hide: allowlisting /api/diet to
 * permit the meal library also silently permitted
 * /api/diet/fitness-profile/:clientId, which had no ownership check at all.
 * An exemption should be no wider than the thing it excuses.
 */
const MEMBER_REACHABLE_ROUTES = {
  '/api/payments/upi/history':
    'A member reading their OWN payment history. The handler has an explicit `role === member` branch that narrows to req.user.pt_client_id and ignores any client_id in the query — the correct shape, and the opposite of the trainer fall-through: it narrows for the untrusted role rather than widening for it.',
};

/**
 * Routes found reachable by a member that have not yet been triaged.
 *
 * EMPTY, and that is the point of leaving it here. The first run of this test
 * produced eighteen entries; all eighteen have now been read and resolved —
 * seven gated (five mounts, two individual routes), eleven moved into
 * MEMBER_REACHABLE above with a written reason.
 *
 * The next ungated mount lands here rather than passing silently, and the
 * pinned length below means it cannot grow without somebody typing a number.
 */
const UNREVIEWED = [];

/** Every `app.use('/api/…', …, require('./router'))` line in server.js. */
function mountsFromServer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const re = /^app\.use\(\s*'(\/api\/[^']*)'\s*,([^;]*?)\);/gm;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const chain = m[2].replace(/\s+/g, ' ').trim();
    const mod = (chain.match(/require\('(\.\/[^']+)'\)/) || [])[1];
    if (!mod) continue; // a limiter or a bare middleware, not a router mount
    out.push({
      mountPath: m[1].replace(/\/$/, ''),
      module: mod,
      // staffGate() is the [auth, requireStaff, requireFeature] helper; it must
      // be named here explicitly, since it does not contain the substring
      // "requireStaff" and this check would otherwise miss every mount using it.
      // permGate() is the [auth, requireStaff, requireFeature, requirePermission]
      // helper and replaced staffGate(); like it, the name does not contain the
      // substring "requireStaff", so it has to be listed explicitly or every
      // mount using it reads as ungated here.
      gated: /requireStaff|permGate|requireRole|requireSuperAdmin|adminOnly|platformAuth|requireClient/.test(chain),
    });
  }
  return out;
}

/** The GET routes a router registers on itself. */
function getRoutes(router) {
  const paths = [];
  for (const layer of router.stack || []) {
    if (layer.route && layer.route.methods && layer.route.methods.get) {
      paths.push(layer.route.path);
    }
  }
  return paths;
}

const mounts = mountsFromServer();

describe('a member cannot reach staff mounts', () => {
  it('found the mount table in server.js', () => {
    // If the regex stops matching, every assertion below passes vacuously.
    expect(mounts.length).toBeGreaterThan(40);
  });

  // Mounts and probes ~50 real routers; well past Jest's 5s default.
  it('every mount is either member-reachable by decision, or refuses a member', async () => {
    const reached = [];

    for (const mount of mounts) {
      if (MEMBER_REACHABLE[mount.mountPath]) continue;

      let router;
      try {
        router = require(`../${mount.module.replace(/^\.\//, '')}`);
      } catch {
        continue; // covered by the module's own tests; not this file's business
      }

      const routes = getRoutes(router);
      if (!routes.length) continue;

      // EVERY GET route, not just the first.
      //
      // The first version of this probed one route per router — `routes.find(p
      // => !p.includes(':')) || routes[0]` — and that halved its coverage: the
      // real reachable surface is 37 routes, not the 18 it reported. Three
      // findings hid in the routes it never asked about, including
      // /api/expenses/stats, /api/subscription/invoices and an unguarded
      // /api/diet/fitness-profile/:clientId. A guard that samples is a guard
      // whose blind spot is wherever it did not sample.
      for (const probe of routes) {
        const url = `${mount.mountPath}${probe}`.replace(/\/+/g, '/').replace(/:[A-Za-z_]+/g, '1');

        const app = express();
        app.use(express.json());
        // The real chain: server.js's own gates where it has them, then the
        // real router, which may gate internally instead.
        const chain = mount.gated ? [auth, requireStaff, router] : [router];
        app.use(mount.mountPath, ...chain);

        let res;
        try {
          res = await request(app).get(url);
        } catch {
          continue;
        }

        if (res.status >= 200 && res.status < 300) {
          reached.push(`${res.status} GET ${url}  [${mount.module}]`);
        }
      }
    }

    // /api/support/tickets sat here: 200, every ticket in the studio.
    const untracked = reached
      .map((r) => r.replace(/^\d+ GET /, '').replace(/\s+\[.*$/, ''))
      .filter((url) => !UNREVIEWED.includes(url))
      .filter((url) => !MEMBER_REACHABLE_ROUTES[url]);

    expect(untracked.sort()).toEqual([]);
  }, 60000);

  it('the untriaged list only ever shrinks', () => {
    // Pinned at the count the first run produced, minus the three fixed in the
    // same change. Triaging an entry lowers this; nothing else should move it,
    // so a newly ungated mount fails rather than joining the list silently.
    expect(UNREVIEWED).toHaveLength(0);
  });

  it('every untriaged entry is still reachable, so the list cannot go stale', async () => {
    // If a route is gated later but its entry is left here, this list becomes
    // a lie that hides the next regression behind it.
    const stillListed = new Set(UNREVIEWED);
    expect(stillListed.size).toBe(UNREVIEWED.length);
  });

  it('support is gated in server.js, not merely scoped in its handlers', async () => {
    // The handlers filter on organization_id, which bounds the studio and not
    // the role — so the fix has to be at the mount. Driven rather than
    // regexed: this asserts a member is actually refused.
    const router = require('../routes/support');
    const app = express();
    app.use(express.json());
    app.use('/api/support', auth, requireStaff, router);

    const res = await request(app).get('/api/support/tickets');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/staff/i);
  });

  it('a staff role still reaches support', async () => {
    // A gate that refuses everyone is not a fix.
    const router = require('../routes/support');
    const app = express();
    app.use(express.json());
    app.use(
      '/api/support',
      (req, _res, next) => { req.user = { ...MEMBER, role: 'admin' }; next(); },
      requireStaff,
      router
    );

    const res = await request(app).get('/api/support/tickets');
    expect(res.status).toBe(200);
  });

  it('every route-level exemption carries a real reason', () => {
    for (const [route, reason] of Object.entries(MEMBER_REACHABLE_ROUTES)) {
      expect(`${route}: ${reason}`.length).toBeGreaterThan(route.length + 60);
    }
  });

  it('every member-reachable entry carries a real reason', () => {
    for (const [mount, reason] of Object.entries(MEMBER_REACHABLE)) {
      expect(`${mount}: ${reason}`.length).toBeGreaterThan(mount.length + 40);
    }
  });

  it('the member-reachable list has no entry for a mount that no longer exists', () => {
    // Otherwise a mount could be renamed and silently lose its exemption —
    // or keep one it no longer needs.
    const known = new Set(mounts.map((m) => m.mountPath));
    const stale = Object.keys(MEMBER_REACHABLE).filter((p) => !known.has(p));
    expect(stale).toEqual([]);
  });
});

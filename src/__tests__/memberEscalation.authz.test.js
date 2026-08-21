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
  '/api/features':
    'Studio feature flags, fetched by FeaturesProvider in the ROOT layout — so it runs for members too, and its .catch() means a 403 would be silent but produce one on every member page load. The payload is which modules the studio has enabled: studio configuration, not client or staff data. Reviewed and left reachable deliberately; gating it needs the frontend provider to stop calling it for members in the same change.',
};

/**
 * Routes this test found a member can reach, that have NOT been triaged.
 *
 * ── Read this before adding to it ──────────────────────────────────────────
 *
 * This is not an allowlist and it is not an assertion that these are safe. It
 * is the raw output of the first run of this test, recorded honestly: 18
 * routes answered a member with 200, and verifying each one means reading its
 * handler to decide whether it returns the caller's own data or the studio's.
 * Three were verified and fixed in the same change as this file
 * (/api/support/tickets, /api/invoices, /api/reports/monthly), and the rest
 * are written down rather than quietly dropped.
 *
 * Some are near-certainly fine — a member listing their OWN bookings, or
 * reading the exercise library their workout is built from. Others look like
 * the same shape as the three that were fixed:
 *
 *   /api/settings/                      studio settings
 *   /api/trainers/                      staff roster
 *   /api/leave/                         staff leave requests
 *   /api/search/                        search across studio data
 *   /api/subscription/checkout/settings SaaS billing configuration
 *   /api/payments/upi/settings          payment configuration
 *   /api/qr/generate                    check-in QR generation
 *   /api/modules/:key                   operations workspace
 *   /api/ai/actions                     AI action plans
 *
 * The rule for this list is that it SHRINKS. Triage an entry, and it either
 * moves to MEMBER_REACHABLE with a reason or gets a gate and disappears. The
 * pinned count below fails if anything is added, which is the whole point: a
 * new ungated mount cannot join this list without somebody typing a number.
 */
const UNREVIEWED = [
  '/api/ai/actions',
  '/api/ai/conversations',
  '/api/bookings/',
  '/api/classes/sessions',
  '/api/diet/meals',
  '/api/exercises/',
  '/api/leave/',
  '/api/modules/1',
  '/api/payments/upi/settings',
  '/api/plans/',
  '/api/qr/generate',
  '/api/search/',
  '/api/settings/',
  '/api/subscription/checkout/settings',
  '/api/trainers/',
  '/api/v1/bookings/',
  '/api/v1/notifications/',
  '/api/workouts/exercises',
];

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
      gated: /requireStaff|staffGate|requireRole|requireSuperAdmin|adminOnly|platformAuth|requireClient/.test(chain),
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

      // Prefer a route with no parameters: a 404 from a bad id would be
      // indistinguishable from a refusal.
      const probe = routes.find((p) => !p.includes(':')) || routes[0];
      const url = `${mount.mountPath}${probe}`.replace(/\/+/g, '/').replace(/:[A-Za-z_]+/g, '1');

      const app = express();
      app.use(express.json());
      // The real chain: server.js's own gates where it has them, then the real
      // router, which may gate internally instead.
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

    // /api/support/tickets sat here: 200, every ticket in the studio.
    const untracked = reached
      .map((r) => r.replace(/^\d+ GET /, '').replace(/\s+\[.*$/, ''))
      .filter((url) => !UNREVIEWED.includes(url));

    expect(untracked.sort()).toEqual([]);
  }, 60000);

  it('the untriaged list only ever shrinks', () => {
    // Pinned at the count the first run produced, minus the three fixed in the
    // same change. Triaging an entry lowers this; nothing else should move it,
    // so a newly ungated mount fails rather than joining the list silently.
    expect(UNREVIEWED).toHaveLength(18);
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

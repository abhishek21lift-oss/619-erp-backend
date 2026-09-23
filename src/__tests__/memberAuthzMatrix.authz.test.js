'use strict';
// The member authorization matrix: EVERY method, EVERY route, route-granular.
//
// ── Why this exists beside memberEscalation.authz.test.js ──────────────────
//
// That file is the mount-level guard and it is good, but it has two structural
// blind spots that let four live findings through, and both are in its
// mechanics rather than its intent:
//
//   1. IT PROBES ONLY GET. `getRoutes()` collects `layer.route.methods.get`,
//      so every POST, PUT, PATCH and DELETE on a member-reachable mount was
//      never asked about. A read leak and a WRITE leak are not the same
//      severity, and it could only ever see the first.
//
//   2. ITS ALLOWLIST IS MOUNT-GRANULAR AND IT `continue`s PAST IT. An entry in
//      MEMBER_REACHABLE skips the whole mount, so a justification written
//      about one route silently excuses every other route on it. Its own
//      comment warns about this ("mount granularity is what let three findings
//      hide") and then the code does it anyway, one level up.
//
// Between them those two gaps hid:
//
//   PUT  /api/diet/fitness-profile/:clientId   member WRITES another client's
//        health conditions, injuries, emergency contact. The GET beside it had
//        been fixed; the PUT had not, and being a PUT it was never probed.
//   GET  /api/ai/workout/context/:client_id    member READS any client's facts,
//        digital twin, safety gate and training history. On an allowlisted
//        mount, excused by a reason written about /conversations.
//   GET  /api/workouts/assignments/:id         member READS any assignment.
//   PUT  /api/workouts/assignments/:id/progress member WRITES any client's
//        completion percentage.
//
// Every one is org-scoped and none is role-scoped: the filter bounds the
// STUDIO and says nothing about which client inside it. That is the single
// shape all four share, and it is the shape this file exists to catch.
//
// ── What it asserts ────────────────────────────────────────────────────────
//
// A real member session is driven at every registered route on every mount,
// with the mount's real gate chain from server.js. Any 2xx is a reach, and a
// reach must be named in MEMBER_MAY, keyed by `METHOD /path` — not by mount —
// with a reason that says why a gym client seeing this is intended.

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
  pt_client_id: 'client-1',
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
  return { ...actual, auth: (req, _res, next) => { req.user = { ...MEMBER }; next(); } };
});

const express = require('express');
const request = require('supertest');
const { requireTrainer } = require('../middleware/rbac');
const { auth } = require('../middleware/auth');

/**
 * Routes a member may reach, keyed by `METHOD /path` — never by mount.
 *
 * The key carries the method because a GET and a PUT on the same path are two
 * different authorization decisions, and it carries the full path because a
 * reason written about one route must not excuse its neighbours.
 */
const MEMBER_MAY = {
  // ── The client portal. No route here takes an id at all. ─────────────────
  'GET /api/me/profile': 'The client portal. Scoped to req.user.pt_client_id, and the route accepts no id of any kind.',
  'GET /api/me/membership': 'Client portal. Same self-scoping from the session; no id is accepted.',
  'GET /api/me/payments': "The member's own payment history, keyed from the session's client id only.",
  'GET /api/me/attendance': "The member's own check-in history, keyed from the session's client id only.",
  'GET /api/me/measurements': "The member's own recorded measurements, keyed from the session's client id only.",

  // ── The member's own credentials and inbox. ──────────────────────────────
  'GET /api/auth/webauthn/credentials': "Lists the caller's OWN passkeys, keyed WHERE user_id = req.user.id.",
  'POST /api/auth/webauthn/register/options': 'Begins enrolling a passkey for the caller themselves; the challenge is bound to their own user id.',
  'POST /api/auth/webauthn/login/options': 'Pre-session ceremony start. Reached before any role exists, so there is no role to check against.',
  'GET /api/v1/auth/webauthn/credentials': 'Versioned alias of the same self-scoped passkey list.',
  'POST /api/v1/auth/webauthn/register/options': 'Versioned alias of the same self-scoped enrolment start.',
  'POST /api/v1/auth/webauthn/login/options': 'Versioned alias of the same pre-session ceremony start.',
  'GET /api/v1/notifications/': 'svc.inbox(req.user.id) — the caller\'s own notification inbox, keyed by their user id.',
  'PATCH /api/v1/notifications/1/read': "Marks one of the caller's OWN notifications read; the update is keyed by user id as well as notification id.",
  'PATCH /api/v1/notifications/read-all': "Marks the caller's OWN inbox read; scoped to req.user.id.",

  // ── The member's own bookings and check-ins. ─────────────────────────────
  'GET /api/bookings/': "A member listing their OWN bookings: the handler overrides member_id with the session's own when role === member, so the query string cannot widen it.",
  'GET /api/v1/bookings/': 'Versioned alias of the same self-narrowing bookings list.',
  'GET /api/qr/generate': "Generates the caller's OWN check-in QR, keyed from req.user.pt_client_id / member_id.",
  'GET /api/qr/my-history': "The caller's OWN check-in history; the route name is literal and it takes no id.",
  'POST /api/qr/checkout': 'Closes the caller\'s OWN open check-in, keyed from the session rather than from a body field.',

  // ── Studio reference content every member legitimately browses. ──────────
  'GET /api/classes/sessions': 'The class timetable a member browses in order to book. Org-scoped, and identical for every member of the studio.',
  'GET /api/plans/': "The studio's own membership price list, which the renewal screen shows the member. Org-scoped by migration 174.",
  'GET /api/diet/meals': 'The shared meal library a member\'s own diet plan is built from. Reference content, not client data.',
  'GET /api/diet/supplements': 'Shared supplement reference library, same shape as meals.',
  'GET /api/diet/templates': 'Shared diet templates. Studio and platform content, carrying no client rows.',
  'GET /api/exercises/': 'The exercise library a member\'s own workout is built from. Platform and studio reference content.',
  'GET /api/exercises/check-name': 'Name-availability probe against that same library; returns a boolean, no client data.',
  'GET /api/exercises/1/versions': 'Edit history of a library exercise. Library content, and canEdit() still governs every mutation.',
  'GET /api/exercises/favorites': "The caller's OWN favourited exercises, keyed by user id.",
  'GET /api/exercises/recent': "The caller's OWN recently-used exercises, keyed by user id.",
  'POST /api/exercises/1/favorite': "Favourites a library exercise FOR THE CALLER; the row is keyed by their own user id.",
  'POST /api/exercises/1/use': "Records that the caller used an exercise, keyed by their own user id. Drives /recent above.",
  'GET /api/workouts/plans': 'The plan LIST, which is org-scoped reference content. The single-plan read beside it now requires staff.',
  'GET /api/features/': 'Studio feature flags, read by FeaturesProvider in the root layout for every role. Studio configuration, not client or staff data.',

  // ── AI surfaces that self-scope by user id. ──────────────────────────────
  'GET /api/ai/conversations': "The caller's OWN AI threads, keyed WHERE c.user_id = $1.",
  'GET /api/ai/usage': "The caller's OWN AI usage counters, keyed by their user id.",
  'GET /api/ai/actions': 'Returns only the actions canRun() permits for the caller\'s role, so a member sees the member set.',

  // ── Deliberate non-answers that happen to use a 2xx status. ──────────────
  'GET /api/diet/fitness-profile/1': "Answers null — not the row — when a member asks for an id that is not their own. A 200 carrying null is the refusal; the sibling PUT is now requireTrainer outright.",
  'GET /api/invitations/track/1.gif': 'A tracking pixel. Always returns a 1x1 GIF regardless of the id, by design, and reads nothing back to the caller.',
  'GET /api/public/stats': 'The unauthenticated marketing surface. Public by definition and carries no studio or client rows.',
};

/** Every `app.use('/api/…', …, require('./router'))` line in server.js. */
function mountsFromServer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const re = /^app\.use\(\s*'(\/api\/[^']*)'\s*,([^;]*?)\);/gm;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const chain = m[2].replace(/\s+/g, ' ').trim();
    const mod = (chain.match(/require\('(\.\/[^']+)'\)/) || [])[1];
    if (!mod) continue;
    out.push({
      mountPath: m[1].replace(/\/$/, ''),
      module: mod,
      gated: /requireTrainer|studioGate|requireRole|requireSuperAdmin|adminOnly|platformAuth|requireClient/.test(chain),
    });
  }
  return out;
}

/** The literal prefix an express Layer mounts its sub-router at. */
function prefixOf(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return '';
  const src = layer.regexp && layer.regexp.source;
  if (!src) return '';
  // Express compiles '/x/y' to '^\/x\/y\/?(?=\/|$)'. Recover the literal part;
  // a parameterised segment becomes a placeholder we substitute below anyway.
  const m = src.match(/^\^((?:\\\/[^\\^$?(]+)+)/);
  if (!m) return '';
  return m[1].replace(/\\\//g, '/');
}

/** Every `{method, path}` a router registers, following nested routers. */
function routesOf(router, prefix = '', seen = new Set(), depth = 0) {
  const out = [];
  if (depth > 6 || !router || !router.stack) return out;
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods || {})) {
        if (method === '_all') continue;
        out.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` });
      }
    } else if (layer.handle && layer.handle.stack) {
      if (seen.has(layer.handle)) continue;
      seen.add(layer.handle);
      out.push(...routesOf(layer.handle, prefix + prefixOf(layer), seen, depth + 1));
    }
  }
  return out;
}

const mounts = mountsFromServer();

describe('the member authorization matrix', () => {
  it('found the mount table in server.js', () => {
    expect(mounts.length).toBeGreaterThan(40);
  });

  it('no member reaches any route that is not an explicit, reasoned exception', async () => {
    const reached = [];

    for (const mount of mounts) {
      let router;
      try {
        router = require(`../${mount.module.replace(/^\.\//, '')}`);
      } catch {
        continue;
      }

      for (const route of routesOf(router)) {
        const url = `${mount.mountPath}${route.path}`
          .replace(/\/+/g, '/')
          .replace(/:[A-Za-z_]+/g, '1');

        const app = express();
        app.use(express.json());
        app.use(mount.mountPath, ...(mount.gated ? [auth, requireTrainer, router] : [router]));

        const verb = route.method.toLowerCase();
        if (typeof request(app)[verb] !== 'function') continue;

        let res;
        try {
          res = await request(app)[verb](url).send({});
        } catch {
          continue; // a handler that throws returned the member no data
        }

        // A 2xx is the only outcome that hands a member anything. 4xx and 5xx
        // are all refusals of one kind or another.
        if (res.status >= 200 && res.status < 300) {
          reached.push(`${route.method} ${url}`);
        }
      }
    }

    const unreasoned = [...new Set(reached)]
      .filter((k) => !MEMBER_MAY[k])
      .sort();

    expect(unreasoned).toEqual([]);
  }, 180000);

  it('probes more than GET, which is the gap this file exists to close', () => {
    // If routesOf() ever regresses to GET-only, every write leak becomes
    // invisible again and the suite above would pass while proving nothing.
    const methods = new Set();
    for (const mount of mounts) {
      let router;
      try { router = require(`../${mount.module.replace(/^\.\//, '')}`); } catch { continue; }
      for (const r of routesOf(router)) methods.add(r.method);
    }
    expect(methods.has('GET')).toBe(true);
    expect(methods.has('POST')).toBe(true);
    expect(methods.has('PUT')).toBe(true);
    expect(methods.has('DELETE')).toBe(true);
  });

  it('sees enough routes to be meaningful', () => {
    // A traversal that silently stops finding routes would pass vacuously.
    // (391 when the staff-management surface — /api/trainers, /api/leave,
    // commissions and payouts — was removed with the staff roles.)
    let total = 0;
    for (const mount of mounts) {
      let router;
      try { router = require(`../${mount.module.replace(/^\.\//, '')}`); } catch { continue; }
      total += routesOf(router).length;
    }
    expect(total).toBeGreaterThan(350);
  });

  it('every exception is keyed by method and path, not by mount', () => {
    for (const key of Object.keys(MEMBER_MAY)) {
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\/\S+/);
    }
  });

  it('every exception carries a real reason', () => {
    for (const [key, reason] of Object.entries(MEMBER_MAY)) {
      expect(`${key}: ${reason}`.length).toBeGreaterThan(key.length + 50);
    }
  });
});

describe('the four routes this file was written to catch', () => {
  const cases = [
    ['put', '/api/diet/fitness-profile/client-2', '../routes/diet', '/api/diet'],
    ['get', '/api/ai/workout/context/client-2', '../routes/ai', '/api/ai'],
    ['get', '/api/workouts/assignments/asg-2', '../routes/workouts', '/api/workouts'],
    ['put', '/api/workouts/assignments/asg-2/progress', '../routes/workouts', '/api/workouts'],
  ];

  it.each(cases)('refuses a member: %s %s', async (verb, url, mod, mount) => {
    const router = require(mod);
    const app = express();
    app.use(express.json());
    app.use(mount, router);
    const res = await request(app)[verb](url).send({ progress_pct: 50 });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/trainer/i);
  });

  it.each(cases)('still admits a trainer: %s %s', async (verb, url, mod, mount) => {
    // A gate that refuses everyone is not a fix. Trainers are STAFF_ROLES, and
    // these are their tools.
    jest.resetModules();
    jest.doMock('../middleware/auth', () => {
      const actual = jest.requireActual('../middleware/auth');
      return {
        ...actual,
        auth: (req, _res, next) => { req.user = { ...MEMBER, role: 'trainer' }; next(); },
      };
    });
    const freshRouter = require(mod);
    const app = express();
    app.use(express.json());
    app.use(mount, freshRouter);
    const res = await request(app)[verb](url).send({ progress_pct: 50 });
    expect(res.status).not.toBe(403);
    jest.dontMock('../middleware/auth');
    jest.resetModules();
  });
});

'use strict';
// The Command Center must read as the PLATFORM, never as whichever studio the
// operator happens to have pinned.
//
// ── The bug this pins ──────────────────────────────────────────────────────
//
// db/pool.js routes a query to the owner connection only when isPlatformWide()
// is true, and middleware/auth.js computes that as
//
//     req.user.role === 'super_admin' && orgId == null
//
// The frontend forwards `x-org-id` from localStorage on every request
// (lib/http.ts), so an operator who has ever pinned a studio in the org
// switcher arrives with an org id. platformWide is then FALSE and every
// Command Center query runs as app_tenant, under RLS, on the one console whose
// entire job is to describe the whole platform.
//
// Measured against the live policies, that is not an error — it is a wrong
// answer delivered confidently:
//
//   system_alerts / system_logs / platform_ai_settings
//       no app_tenant policy exists -> ZERO ROWS. The Alert Center shows no
//       alerts and the log history shows nothing, on a healthy-looking screen.
//   ai_usage_log / login_events / refresh_tokens / admin_invitations
//       tenant_isolation applies -> ONE studio's numbers under a platform
//       heading. The security card grades one tenant's failed logins as the
//       platform's posture.
//
// middleware/platformAuth.js already hit exactly this for platform_owners and
// already fixed it with runAsPlatform. These tests are what stop the Command
// Center drifting back.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

// The REAL tenant-context module: the property under test is what db/pool.js
// would observe, so mocking it would test nothing.
const { runWithTenantContext, currentOrgId, isPlatformWide } = require('../lib/tenant-context');

/** What the pool saw, per query, at the moment it was called. */
const observed = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    // Required inside the factory: jest.mock is hoisted above the require above.
    const ctx = require('../lib/tenant-context');
    observed.push({
      sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 60),
      orgId: ctx.currentOrgId(),
      platformWide: ctx.isPlatformWide(),
    });
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    if (/AS in_window/i.test(flat)) return { rows: [{ in_window: 0, from_worker: 0, fatal: 0 }], rowCount: 1 };
    if (/^SELECT MIN\(logged_at\)/i.test(flat)) return { rows: [{ oldest: null }], rowCount: 1 };
    return { rows: [], rowCount: 0, params };
  }),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

// Collector registration is irrelevant here and pulls in Redis/BullMQ.
jest.mock('../modules/command-center/index', () => ({
  registerCollectors: jest.fn(),
  registry: { names: () => [], STATUS: {} },
  snapshot: { collect: jest.fn(async () => ({ cards: {}, status: 'healthy' })) },
}));

const request = require('supertest');
const express = require('express');

/** The org a careless operator has pinned. */
const PINNED_ORG = '4a11e8ce-907b-4437-a3c8-27024f66531a';

/**
 * The app, with auth simulated exactly as middleware/auth.js leaves it for a
 * super admin who is sending x-org-id: a tenant context with an org id and
 * platformWide FALSE. That is the state the bug needs.
 */
function app({ orgId = PINNED_ORG, platformWide = false } = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { id: 'sa1', role: 'super_admin', email: 'op@example.com' };
    runWithTenantContext(orgId, next, { platformWide });
  });
  a.use('/api/super-admin', require('../modules/command-center/command-center.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

beforeEach(() => { observed.length = 0; });

describe('the harness itself is honest', () => {
  it('leaves a pinned operator non-platform-wide OUTSIDE the router', async () => {
    // If this ever fails, every assertion below is vacuous — the simulated
    // operator would already be platform-wide before the router touched them.
    let seen;
    await new Promise((resolve) => {
      runWithTenantContext(PINNED_ORG, () => {
        seen = { orgId: currentOrgId(), platformWide: isPlatformWide() };
        resolve();
      }, { platformWide: false });
    });
    expect(seen).toEqual({ orgId: PINNED_ORG, platformWide: false });
  });
});

describe('every Command Center read runs platform-wide', () => {
  // Each of these hits a table that RLS would either scope to one tenant or
  // blank entirely.
  it.each([
    ['log history (system_logs — zero rows under app_tenant)',
      '/api/super-admin/command-center/logs/history'],
    ['alerts (system_alerts — zero rows under app_tenant)',
      '/api/super-admin/command-center/alerts'],
  ])('%s', async (_label, url) => {
    const res = await request(app()).get(url);
    expect(res.status).toBe(200);

    // Cannot pass vacuously: the route must actually have queried something.
    expect(observed.length).toBeGreaterThan(0);

    for (const q of observed) {
      expect(q.platformWide).toBe(true);
      // Null, not the pinned org: db/pool.js would otherwise still SET
      // app.org_id for the statement even on the owner connection.
      expect(q.orgId).toBeNull();
    }
  });

  it('holds across the await inside a handler, not just at its first line', async () => {
    // logs/history issues three sequential queries with awaits between them.
    // AsyncLocalStorage is what carries the context across those; a fix that
    // only set it synchronously would pass the first and fail the rest.
    await request(app()).get('/api/super-admin/command-center/logs/history?stats=1');
    expect(observed.length).toBeGreaterThanOrEqual(3);
    expect(observed.every((q) => q.platformWide === true)).toBe(true);
  });

  it('does not depend on the operator having no org pinned', async () => {
    // The same route, with nothing pinned, must behave identically — so the
    // fix is "the router decides", not "it happened to be platform-wide".
    await request(app({ orgId: null, platformWide: true }))
      .get('/api/super-admin/command-center/alerts');
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((q) => q.platformWide === true && q.orgId === null)).toBe(true);
  });
});

describe('the platform context is opened by the router, not inherited', () => {
  it('is declared in the router source with the reason attached', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'command-center', 'command-center.routes.js'),
      'utf8',
    );
    expect(src).toMatch(/runAsPlatform/);
    // The middleware must come before the first route, or the routes declared
    // above it would run outside the context.
    const guardAt = src.indexOf('router.use((req, res, next) => runAsPlatform');
    const firstRouteAt = src.search(/router\.(get|post)\(/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstRouteAt);
  });
});

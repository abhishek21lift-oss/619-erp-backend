'use strict';
// Every route on the control plane reads as the PLATFORM.
//
// ── The trap, and why it needed a structural answer ─────────────────────────
//
// db/pool.js routes to the owner connection only when isPlatformWide() is
// true, and middleware/auth.js computes that as
//
//     req.user.role === 'super_admin' && orgId == null
//
// The frontend forwards `x-org-id` from localStorage on EVERY request, so an
// operator who has ever pinned a studio in the org switcher arrives with an
// org id for the rest of their session. Every query on the platform API then
// runs as app_tenant under RLS.
//
// Nothing raises. Tables with a tenant_isolation policy return one studio's
// rows under a platform heading; tables with no app_tenant policy at all
// return nothing. A cross-tenant directory becomes a single-studio directory
// with no sign it was filtered.
//
// It had already been discovered twice and fixed twice locally:
// middleware/platformAuth.js for the grant lookup, super-admin/users.js for
// the directory — which documents the trap at length in its own header.
// Measured across the mount when this test was written: 221 queries in 20
// sub-routers, 3 of them protected. "Every future author remembers" is not a
// mechanism, so the guard moved to the mount.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const fs = require('fs');
const path = require('path');

const PLATFORM_DIR = path.join(__dirname, '..', 'modules', 'platform');
const ROUTES = path.join(PLATFORM_DIR, 'super-admin.routes.js');

describe('the guard is at the mount, ahead of every sub-router', () => {
  const src = fs.readFileSync(ROUTES, 'utf8');

  it('opens a platform context', () => {
    expect(src).toMatch(/runAsPlatform/);
    expect(src).toMatch(/router\.use\(\(req, res, next\) => runAsPlatform\(\(\) => next\(\)\)\);/);
  });

  it('opens it BEFORE the first sub-router is mounted', () => {
    // Mounted after, and the routers registered above it run outside the
    // context — which is the whole bug, reintroduced.
    const guardAt = src.indexOf('runAsPlatform(() => next())');
    const firstMount = src.search(/router\.use\(require\(/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstMount).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstMount);
  });

  it('covers every sub-router this mount has', () => {
    // Cannot pass vacuously: if the mount list is emptied, this fails.
    const mounts = src.match(/router\.use\(require\(/g) ?? [];
    expect(mounts.length).toBeGreaterThanOrEqual(20);
  });
});

describe('no platform route depends on the caller\'s ambient org', () => {
  /** Every .js under modules/platform. */
  function platformSources() {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (e.name.endsWith('.js')) out.push(p);
      }
    };
    walk(PLATFORM_DIR);
    return out;
  }

  const sources = platformSources();

  it('found the modules, so this cannot pass vacuously', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
  });

  it.each([
    ['currentOrgId', /\bcurrentOrgId\b/],
    ['tenantScope', /\btenantScope\b/],
    ['orgWhere', /\borgWhere\b/],
    ["req.user.organization_id", /req\.user\.organization_id/],
  ])('uses no %s — every route names its studio explicitly', (_label, re) => {
    // This is the premise the mount-level guard rests on. A route that DID
    // read the ambient org would change behaviour under it, so if one ever
    // appears, this fails and the author has to decide deliberately rather
    // than discover it in production.
    const offenders = sources
      .filter((f) => {
        const code = fs.readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        return re.test(code);
      })
      .map((f) => path.relative(PLATFORM_DIR, f));
    expect(offenders).toEqual([]);
  });
});

// ── The behaviour, not just the source ──────────────────────────────────────

describe('a pinned operator still reads platform-wide', () => {
  const { runWithTenantContext } = require('../lib/tenant-context');
  const request = require('supertest');
  const express = require('express');

  const observed = [];
  jest.mock('../db/pool', () => ({
    query: jest.fn(async () => {
      const ctx = require('../lib/tenant-context');
      observed.push({ orgId: ctx.currentOrgId(), platformWide: ctx.isPlatformWide() });
      return { rows: [], rowCount: 0 };
    }),
  }));

  const PINNED = '4a11e8ce-907b-4437-a3c8-27024f66531a';

  /**
   * The platform mount with auth simulated exactly as middleware/auth.js
   * leaves it for a super admin sending x-org-id, and ONE stub sub-router
   * standing in for the twenty real ones — so this tests the mount's
   * behaviour rather than any particular handler's.
   */
  function app() {
    const pool = require('../db/pool');
    const { runAsPlatform } = require('../lib/tenant-context');
    const platform = express.Router();
    platform.use((req, res, next) => runAsPlatform(() => next()));
    platform.use((() => {
      const r = express.Router();
      r.get('/anything', async (_req, res) => {
        await pool.query('SELECT 1');
        await pool.query('SELECT 2');   // across an await, too
        res.json({ ok: true });
      });
      return r;
    })());

    const a = express();
    a.use((req, _res, next) => {
      req.user = { id: 'sa1', role: 'super_admin' };
      runWithTenantContext(PINNED, next, { platformWide: false });
    });
    a.use('/api/platform', platform);
    return a;
  }

  beforeEach(() => { observed.length = 0; });

  it('runs every query on the platform context, across awaits', async () => {
    const res = await request(app()).get('/api/platform/anything');
    expect(res.status).toBe(200);
    expect(observed).toHaveLength(2);
    for (const q of observed) {
      expect(q.platformWide).toBe(true);
      expect(q.orgId).toBeNull();
    }
  });

  it('the harness is honest: without the mount the context IS the pinned org', async () => {
    // Otherwise the assertion above proves nothing.
    const pool = require('../db/pool');
    const a = express();
    a.use((req, _res, next) => {
      req.user = { id: 'sa1', role: 'super_admin' };
      runWithTenantContext(PINNED, next, { platformWide: false });
    });
    a.get('/bare', async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });

    await request(a).get('/bare');
    expect(observed).toEqual([{ orgId: PINNED, platformWide: false }]);
  });
});

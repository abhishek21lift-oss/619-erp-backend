// Regression test: platform-wide AI usage must not be reachable from the
// tenant AI surface.
//
// GET /api/ai/model-stats served an aggregate over the WHOLE of ai_usage_log —
// requests, tokens, latency, fallback counts, grouped by model — behind the
// check `req.user.role !== 'admin'`. That role is the TENANT studio owner,
// auto-granted to every self-serve trial signup, so any studio could read every
// studio's AI consumption.
//
// It could not be fixed by filtering: ai_usage_log has no organization_id
// column (126_ai_control_centre.sql). It was removed instead, and the platform
// console's properly-guarded equivalent under /api/super-admin/ai is the only
// way to that data.
//
// This test fails if the route is reintroduced on the tenant mount, or if the
// unscoped aggregate comes back into the tenant AI library.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const fs = require('fs');
const path = require('path');

let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  adminOnly: (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  },
}));

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [{}] })), connect: jest.fn() }));

// The AI plumbing is irrelevant here — this test is about routing and gating,
// and loading the real router would pull in the model clients.
jest.mock('../lib/ai/router', () => ({ routedChat: jest.fn(), routedStream: jest.fn() }));
jest.mock('../lib/ai/openrouter', () => ({ pingModel: jest.fn() }));
jest.mock('../lib/ai/knowledgeBase', () => ({ retrieveContext: jest.fn(async () => []) }));
jest.mock('../lib/ai/tools', () => ({ runTools: jest.fn() }));

const request = require('supertest');
const express = require('express');

const app = express();
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const TENANT_ADMIN = { id: 'usr-owner', role: 'admin', organization_id: 'org-a' };
const TRAINER = { id: 'usr-trainer', role: 'trainer', organization_id: 'org-a' };
const STAFF = { id: 'usr-staff', role: 'staff', organization_id: 'org-a' };
const MEMBER = { id: 'usr-member', role: 'member', organization_id: 'org-a' };
const SUPER_ADMIN = { id: 'usr-platform', role: 'super_admin', organization_id: null };

describe('GET /api/ai/model-stats — removed from the tenant surface', () => {
  // Every role, including the platform operator: the point is that this PATH is
  // gone, not that it is gated. A 403 for tenants and a 200 for super_admin
  // would mean the platform endpoint was still living on the tenant mount.
  it.each([
    ['tenant studio owner (admin)', () => TENANT_ADMIN],
    ['trainer', () => TRAINER],
    ['staff', () => STAFF],
    ['member', () => MEMBER],
    ['platform super_admin', () => SUPER_ADMIN],
  ])('is 404 for %s', async (_label, user) => {
    mockCurrentUser = user();
    const res = await request(app).get('/api/ai/model-stats');
    expect(res.status).toBe(404);
  });

  // Proves the 404 above is the removed route rather than a router that failed
  // to mount — a sibling route on the same mount still answers.
  it('leaves the rest of the tenant AI surface mounted (GET /usage still answers)', async () => {
    mockCurrentUser = TENANT_ADMIN;
    const res = await request(app).get('/api/ai/usage');
    expect(res.status).not.toBe(404);
  });
});

describe('the unscoped aggregate itself is gone', () => {
  it('lib/ai/usage.js no longer exports getModelStats', () => {
    const usage = require('../lib/ai/usage');
    expect(usage.getModelStats).toBeUndefined();
    // The tenant-safe, per-caller functions must still be there.
    expect(typeof usage.logUsage).toBe('function');
    expect(typeof usage.getUserUsage).toBe('function');
  });

  it('no live code in the tenant AI library queries ai_usage_log without a caller predicate', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/ai/usage.js'), 'utf8');
    // Strip comments — the removal note deliberately names the table.
    const live = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const statements = live.split(';');
    for (const stmt of statements) {
      if (!/FROM\s+ai_usage_log/i.test(stmt)) continue;
      // Every surviving read of this table must be scoped to one caller.
      expect(stmt).toMatch(/WHERE[\s\S]*user_id\s*=\s*\$\d/i);
    }
  });

  it('routes/ai.js does not register a model-stats route', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/ai.js'), 'utf8');
    const live = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(live).not.toMatch(/router\.(get|post|put|patch|delete)\(\s*['"`]\/model-stats/);
  });
});

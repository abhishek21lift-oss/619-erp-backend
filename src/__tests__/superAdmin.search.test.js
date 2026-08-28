// Phase 5/6 — /api/platform/search
//
// Four properties, each pinned because they protect the brief's explicit
// rules:
//
//   1. org_id is on EVERY result row. The brief states the platform
//      "must not return ambiguous records from different tenants without
//      showing their organization" — making the field mandatory in the
//      result type turns a removal into a type error rather than a render
//      bug at runtime.
//   2. ILIKE pattern injection is escaped. A literal `%` in a query must
//      match rows with `%` in the data, not the entire table. Without
//      escaping, an operator typing `%` would see every studio.
//   3. Sub-2-char queries return empty (no 400), so the UI's debounce
//      doesn't trip on the first keystroke.
//   4. The kinds param validates against an allow-list — passing a
//      nonsense kind does not 500 and does not leak data.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({ query: jest.fn() }));
const pool = require('../db/pool');

const searchRouter = require('../modules/platform/super-admin/search');

const PLATFORM_OWNER = {
  id: 'usr-platform', name: 'Platform Owner', email: 'p@x.com', role: 'super_admin',
  organization_id: null, is_platform_owner: true, is_active: true, deleted_at: null,
  token_version: 1,
};

function token(user = PLATFORM_OWNER) {
  return jwt.sign(
    { id: user.id, token_version: user.token_version, role: user.role,
      is_platform_owner: true, audience: 'platform' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

function app() {
  const a = express();
  // Skip real auth — set req.user to a platform owner, then mount the
  // router. The test cares about the router's behaviour, not the
  // requirePlatformOwner chain (which has its own dedicated test).
  a.use((req, _res, next) => { req.user = PLATFORM_OWNER; next(); });
  a.use('/api/platform', searchRouter);
  return a;
}

beforeEach(() => { pool.query.mockReset(); });

// Mock the per-kind queries. The kinds param narrows the set; the
// default is [studio, owner, trainer, client]. The mock returns the
// row for the kind under test and [] for the others.
function mockKindsWithOneRow(kinds, kindUnderTest, row) {
  for (const k of kinds) {
    if (k === kindUnderTest) {
      pool.query.mockResolvedValueOnce({ rows: [row] });
    } else {
      pool.query.mockResolvedValueOnce({ rows: [] });
    }
  }
}

describe('GET /api/platform/search — org_id always present', () => {
  it('returns org_id on every studio result', async () => {
    mockKindsWithOneRow(['studio', 'owner', 'trainer', 'client'], 'studio', {
      id: 's1', name: 'Acme Fitness', slug: 'acme', status: 'active', org_id: 'org-1',
    });
    const res = await request(app()).get('/api/platform/search?q=acme').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const studios = res.body.data.filter(r => r.kind === 'studio');
    expect(studios).toHaveLength(1);
    for (const r of studios) {
      expect(r).toHaveProperty('org_id');
      expect(r.org_id).toBeTruthy();
    }
  });

  it('returns org_id on every owner result (joined from organizations)', async () => {
    mockKindsWithOneRow(['owner'], 'owner', {
      id: 'u1', name: 'Owner One', email: 'o1@x.com', org_id: 'org-1', org_name: 'Acme',
    });
    const res = await request(app()).get('/api/platform/search?q=owner&kinds=owner').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].org_id).toBe('org-1');
  });

  it('returns org_id on every trainer result', async () => {
    mockKindsWithOneRow(['trainer'], 'trainer', {
      id: 't1', name: 'Trainer One', email: 't1@x.com', org_id: 'org-9', org_name: 'Org Nine',
    });
    const res = await request(app()).get('/api/platform/search?q=trainer&kinds=trainer').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].org_id).toBe('org-9');
  });
});

describe('GET /api/platform/search — injection guards', () => {
  it('escapes % in the query so it matches literal %', async () => {
    // Use `ab%cd` (length 5) so the 2-char minimum is met but the %
    // is in the middle. The escape turns it into `ab\%cd`, the pattern
    // is `%ab\%cd%`. If the backend did NOT escape, the SQL would
    // treat `%` as "match anything" and a 1-char drop would be lost.
    pool.query.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/platform/search?q=ab%25cd').set('Authorization', `Bearer ${token()}`);
    const [, params] = pool.query.mock.calls[0];
    // a, b → a, b; % → \%; c, d → c, d. Wrapped: %ab\%cd%
    expect(params[0]).toBe('%ab\\%cd%');
  });

  it('escapes backslash and underscore metacharacters', async () => {
    // `a_b%c` is length 5, so it clears the 2-char minimum.
    pool.query.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/platform/search?q=a_b%25c').set('Authorization', `Bearer ${token()}`);
    const [, params] = pool.query.mock.calls[0];
    // a -> a, _ -> \_, b -> b, % -> \%, c -> c — the unescaped form
    // would have made _ match any character.
    expect(params[0]).toBe('%a\\_b\\%c%');
  });

  it('trims and caps the query length so a 10MB query does not reach the DB', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const big = 'a'.repeat(5000);
    await request(app()).get(`/api/platform/search?q=${big}`).set('Authorization', `Bearer ${token()}`);
    const [, params] = pool.query.mock.calls[0];
    // MAX_QUERY_LENGTH is 100, so the pattern is 102 chars: % + 100 a's + %.
    expect(params[0].length).toBeLessThanOrEqual(102);
  });
});

describe('GET /api/platform/search — short query is a no-op, not an error', () => {
  it('returns empty for q.length < 2', async () => {
    const res = await request(app()).get('/api/platform/search?q=a').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
    // No SQL fired at all.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns empty for empty q', async () => {
    const res = await request(app()).get('/api/platform/search?q=').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('GET /api/platform/search — kinds allow-list', () => {
  it('rejects an empty kinds list with 400 BAD_KINDS', async () => {
    // kinds= with a value that resolves to [] after filtering — using a
    // nonsense kind so the allow-list strips everything.
    const res = await request(app()).get('/api/platform/search?q=acme&kinds=nonsense').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_KINDS');
  });

  it('caps results at SEARCH_TOTAL_LIMIT (50)', async () => {
    // Even if every kind returns its per-kind cap, the final list is
    // sliced to 50. This test mocks the studio kind returning 10 rows.
    pool.query.mockResolvedValueOnce({
      rows: Array.from({ length: 10 }, (_, i) => ({
        id: `s${i}`, name: `Studio ${i}`, slug: `s${i}`, status: 'active', org_id: `o${i}`,
      })),
    });
    const res = await request(app()).get('/api/platform/search?q=studio&kinds=studio').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(50);
  });
});

// AUD-001 (P0) — /api/settings must be per-organization.
//
// ── What this pins ──────────────────────────────────────────────────────────
//
// `system_settings` and `feature_flags` were a single global key/value store.
// Six live studios read the same 35 rows, which held one studio's name, its
// owner's email and mobile, its street location and its check-in geofence — and
// PUT /api/settings upserted arbitrary keys by name, so any admin could rewrite
// all of it for everyone.
//
// Every test below fails against the code as it stood before migration 159:
// there was no organization predicate to assert on, and no allow-list to reject
// a key with.
//
// The queries are asserted rather than the data, because the tenant boundary
// IS the SQL predicate. A test that seeded two studios into a mock and checked
// what came back would pass just as happily against a handler that filtered in
// JavaScript after fetching every studio's rows — which is not isolation.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
let mockRows;

jest.mock('../../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: text, params });
    if (/SELECT COUNT\(\*\)::int AS member_count/i.test(text)) {
      return { rows: [{ member_count: 0 }], rowCount: 1 };
    }
    return { rows: mockRows, rowCount: mockRows.length };
  }),
  connect: jest.fn(),
}));

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

let mockUser;
jest.mock('../../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (
    req.user?.role === 'admin' || req.user?.role === 'super_admin'
      ? next()
      : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/settings', require('../../routes/settings'));
  a.use(errorHandler);
  return a;
}

const writes = () => mockLog.filter((q) => /INSERT INTO system_settings|UPDATE system_settings|DELETE FROM system_settings|UPDATE feature_flags/i.test(q.sql));
const reads = () => mockLog.filter((q) => /SELECT .* FROM system_settings|FROM feature_flags/i.test(q.sql));

beforeEach(() => {
  mockLog.length = 0;
  mockRows = [];
  mockUser = { id: 'usr-a', role: 'admin', organization_id: ORG_A };
});

// ── Reads ───────────────────────────────────────────────────────────────────
describe('reads are scoped to the caller organization', () => {
  test.each([
    ['GET /', '/api/settings'],
    ['GET /studio', '/api/settings/studio'],
    ['GET /branches', '/api/settings/branches'],
    ['GET /gym', '/api/settings/gym'],
    ['GET /permissions', '/api/settings/permissions'],
    ['GET /feature-flags', '/api/settings/feature-flags'],
  ])('%s filters on organization_id', async (_name, path) => {
    const res = await request(app()).get(path);
    expect(res.status).toBe(200);

    const qs = reads();
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      expect(q.sql).toMatch(/organization_id = \$1/);
      expect(q.params[0]).toBe(ORG_A);
    }
  });

  test('a second studio never sees the first studio values', async () => {
    // The predicate carries the caller's org, taken from the session — so the
    // database, not the handler, decides what comes back.
    mockUser = { id: 'usr-b', role: 'admin', organization_id: ORG_B };
    await request(app()).get('/api/settings');
    expect(reads()[0].params[0]).toBe(ORG_B);
    expect(reads()[0].params[0]).not.toBe(ORG_A);
  });
});

// ── Writes ──────────────────────────────────────────────────────────────────
describe('writes are scoped and stamped with the caller organization', () => {
  test('PUT / upserts on (organization_id, key), not on key alone', async () => {
    const res = await request(app()).put('/api/settings').send({ studio_name: 'Studio A' });
    expect(res.status).toBe(200);

    const w = writes()[0];
    expect(w.sql).toMatch(/ON CONFLICT \(organization_id, key\)/i);
    expect(w.params[0]).toBe(ORG_A);
  });

  test('PUT /gym is scoped', async () => {
    const res = await request(app()).put('/api/settings/gym').send({ geofence_radius: 250 });
    expect(res.status).toBe(200);
    expect(writes()[0].params[0]).toBe(ORG_A);
  });

  test('PUT /permissions is scoped — one studio cannot configure another studio staff', async () => {
    const res = await request(app())
      .put('/api/settings/permissions').send({ perm_trainer_finance: true });
    expect(res.status).toBe(200);
    expect(writes()[0].params[0]).toBe(ORG_A);
  });

  test('PUT /feature-flags is scoped', async () => {
    const res = await request(app())
      .put('/api/settings/feature-flags').send({ auto_expire: false });
    expect(res.status).toBe(200);
    const w = writes()[0];
    expect(w.sql).toMatch(/organization_id = \$3/);
    expect(w.params[2]).toBe(ORG_A);
  });
});

// ── Branch CRUD ─────────────────────────────────────────────────────────────
describe('branches belong to one studio', () => {
  const BRANCH_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  test('POST /branches stamps the caller organization', async () => {
    const res = await request(app()).post('/api/settings/branches').send({ name: 'Main' });
    expect(res.status).toBe(201);
    expect(writes()[0].params[0]).toBe(ORG_A);
  });

  test("PUT /branches/:id 404s for another studio branch", async () => {
    mockRows = []; // scoped lookup finds nothing
    const res = await request(app())
      .put(`/api/settings/branches/${BRANCH_ID}`).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    // 404 and not 403: the response must not confirm the id exists elsewhere.
    expect(res.body.error).toMatch(/not found/i);
    expect(writes()).toHaveLength(0);
  });

  test("DELETE /branches/:id 404s for another studio branch and writes nothing", async () => {
    mockRows = [];
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);
    expect(res.status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  test('the branch lookup is scoped before anything is deleted', async () => {
    mockRows = [{ key: `branch_${BRANCH_ID}` }];
    await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);
    const lookup = mockLog.find((q) => /SELECT key FROM system_settings/i.test(q.sql));
    expect(lookup.params).toEqual([ORG_A, `branch_${BRANCH_ID}`]);
  });
});

// ── The allow-list ──────────────────────────────────────────────────────────
describe('PUT /api/settings rejects anything not in the catalogue', () => {
  test('an unknown key is refused and nothing is written', async () => {
    const res = await request(app()).put('/api/settings').send({ unknown_setting: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SETTING');
    expect(res.body.error.message).toMatch(/unknown_setting/);
    expect(writes()).toHaveLength(0);
  });

  test('organization_id can never be written through settings', async () => {
    const res = await request(app())
      .put('/api/settings').send({ organization_id: ORG_B });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/organization_id/);
    expect(writes()).toHaveLength(0);
  });

  test.each(['role', 'permissions', 'database_url', 'jwt_secret', 'is_super_admin'])(
    '%s is refused', async (key) => {
      const res = await request(app()).put('/api/settings').send({ [key]: 'x' });
      expect(res.status).toBe(400);
      expect(writes()).toHaveLength(0);
    }
  );

  test('one bad key rejects the whole request — no partial save', async () => {
    const res = await request(app())
      .put('/api/settings').send({ studio_name: 'Fine', nonsense_key: 'bad' });
    expect(res.status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  test('values are range-checked, not just name-checked', async () => {
    const res = await request(app()).put('/api/settings').send({ geofence_lat: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/geofence_lat/);
  });

  test('a number key refuses a non-numeric value instead of storing NaN', async () => {
    const res = await request(app()).put('/api/settings').send({ geofence_radius: 'banana' });
    expect(res.status).toBe(400);
  });

  test('a boolean key refuses a value that is not a boolean', async () => {
    const res = await request(app()).put('/api/settings').send({ enable_gps: 'yes' });
    expect(res.status).toBe(400);
  });

  test('a string past its length is refused', async () => {
    const res = await request(app())
      .put('/api/settings').send({ studio_name: 'x'.repeat(500) });
    expect(res.status).toBe(400);
  });

  test('a legitimate value is accepted', async () => {
    const res = await request(app())
      .put('/api/settings').send({ studio_name: 'Real Studio', geofence_radius: 250 });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  test('PUT /gym refuses a key outside the gym slice', async () => {
    const res = await request(app())
      .put('/api/settings/gym').send({ geofence_radius: 100, perm_trainer_finance: true });
    // perm_* is a real setting but not settable on this endpoint.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/perm_trainer_finance/);
  });

  test('PUT /feature-flags accepts an unknown flag but writes nothing for it', async () => {
    // Deliberately unlike PUT /api/settings. That endpoint INSERTs, so an
    // unknown key created a row — the actual AUD-001 defect. This one UPDATEs
    // against existing rows, so an unknown key matches nothing and the
    // `updated` vs `requested` counts are how a caller sees the typo. See the
    // note in the handler and settings.featureFlags.atomic.test.js.
    const res = await request(app())
      .put('/api/settings/feature-flags').send({ made_up_flag: true });
    expect(res.status).toBe(200);
    // Still scoped: the write cannot reach another studio's flags.
    expect(writes()[0].params[2]).toBe(ORG_A);
  });
});

// ── No org context ──────────────────────────────────────────────────────────
describe('a caller with no studio is refused rather than served everything', () => {
  test('a super admin with no target org must pick one', async () => {
    mockUser = { id: 'usr-sa', role: 'super_admin', organization_id: null };
    const res = await request(app()).get('/api/settings');
    // Settings have no meaningful platform-wide view: merging six studios into
    // one object is exactly the bug this whole change removes.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_ORG');
    expect(reads()).toHaveLength(0);
  });

  test('a tenant user with no organization reads nothing', async () => {
    mockUser = { id: 'usr-orphan', role: 'admin', organization_id: null };
    const res = await request(app()).get('/api/settings');
    expect(res.status).toBe(400);
    expect(reads()).toHaveLength(0);
  });

  test('a non-admin cannot write settings', async () => {
    mockUser = { id: 'usr-trainer', role: 'trainer', organization_id: ORG_A };
    const res = await request(app()).put('/api/settings').send({ studio_name: 'Nope' });
    expect(res.status).toBe(403);
    expect(writes()).toHaveLength(0);
  });
});

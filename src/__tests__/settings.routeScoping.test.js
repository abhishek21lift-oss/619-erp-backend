'use strict';
// Every /api/settings handler binds the caller's studio.
//
// The DB-backed proof lives in settings.tenancy.integration.test.js, but it
// runs COPIES of the route's SQL. That proves the predicates work; it cannot
// prove the handlers still use them. Strip `AND organization_id = $1` out of
// routes/settings.js and that suite stays green.
//
// So this drives the real handlers and asserts on the SQL they emit and the
// parameters they bind. Between the two: the predicate is right, and it is the
// one actually running.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];
let mockRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: mockRows, rowCount: mockRows.length };
  }),
}));

let mockCurrentUser = { id: 'usr-1', role: 'admin', organization_id: ORG_A };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/settings', require('../routes/settings'));

const settingsSql = () => mockQueries.filter((q) => /\bsystem_settings\b/i.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockRows = [];
  mockCurrentUser = { id: 'usr-1', role: 'admin', organization_id: ORG_A };
});

describe('every settings read is bounded by the caller studio', () => {
  it.each([
    ['GET /',            '/api/settings'],
    ['GET /studio',      '/api/settings/studio'],
    ['GET /branches',    '/api/settings/branches'],
    ['GET /gym',         '/api/settings/gym'],
    ['GET /permissions', '/api/settings/permissions'],
  ])('%s filters on organization_id and binds the caller org', async (_label, url) => {
    await request(app).get(url).expect(200);

    const touched = settingsSql();
    expect(touched.length).toBeGreaterThan(0);
    for (const q of touched) {
      expect(q.sql).toMatch(/organization_id\s*=\s*\$\d/i);
      expect(q.params).toContain(ORG_A);
    }
  });
});

describe('every settings write is bounded by the caller studio', () => {
  it('PUT / upserts on (organization_id, key), not key alone', async () => {
    // The conflict target IS the write half of the isolation. On `key` alone,
    // one studio saving a setting overwrote every other studio's.
    await request(app).put('/api/settings').send({ studio_name: 'Mine' }).expect(200);

    const [q] = settingsSql();
    expect(q.sql).toMatch(/INSERT INTO system_settings \(organization_id, key/i);
    expect(q.sql).toMatch(/ON CONFLICT \(organization_id, key\)/i);
    expect(q.params).toContain(ORG_A);
  });

  it('PUT /gym upserts on (organization_id, key)', async () => {
    await request(app).put('/api/settings/gym').send({ geofence_radius: 250 }).expect(200);
    const [q] = settingsSql();
    expect(q.sql).toMatch(/ON CONFLICT \(organization_id, key\)/i);
    expect(q.params).toContain(ORG_A);
  });

  it('PUT /permissions upserts on (organization_id, key)', async () => {
    // Role permissions: unscoped, one studio's admin changed what trainers in
    // every other studio could reach.
    await request(app).put('/api/settings/permissions')
      .send({ perm_trainer_finance: true }).expect(200);
    const [q] = settingsSql();
    expect(q.sql).toMatch(/ON CONFLICT \(organization_id, key\)/i);
    expect(q.params).toContain(ORG_A);
  });

  it('POST /branches stamps the creating studio', async () => {
    await request(app).post('/api/settings/branches').send({ name: 'North' }).expect(201);
    const [q] = settingsSql();
    expect(q.sql).toMatch(/INSERT INTO system_settings \(organization_id, key/i);
    expect(q.params).toContain(ORG_A);
  });

  it('PUT /branches/:id scopes both the lookup and the update', async () => {
    mockRows = [{ value: JSON.stringify({ name: 'Old' }) }];
    await request(app).put('/api/settings/branches/abc').send({ name: 'New' }).expect(200);
    for (const q of settingsSql()) {
      expect(q.sql).toMatch(/organization_id\s*=\s*\$\d/i);
      expect(q.params).toContain(ORG_A);
    }
  });

  it('DELETE /branches/:id scopes both the lookup and the delete', async () => {
    mockRows = [{ key: 'branch_abc', member_count: 0 }];
    await request(app).delete('/api/settings/branches/abc').expect(200);
    for (const q of settingsSql()) {
      expect(q.sql).toMatch(/organization_id\s*=\s*\$\d/i);
      expect(q.params).toContain(ORG_A);
    }
  });
});

describe('a caller with no studio cannot read or write anything', () => {
  it('a write is refused rather than landing nowhere', async () => {
    // A platform super admin who has not picked a studio. Settings are
    // per-studio business configuration, so "all studios at once" is not a
    // mode this router offers — the write is refused outright.
    mockCurrentUser = { id: 'usr-0', role: 'super_admin', organization_id: null };
    const res = await request(app).put('/api/settings').send({ studio_name: 'X' }).expect(400);
    expect(res.body.error.code).toBe('NO_ORG');
    expect(settingsSql()).toHaveLength(0);
  });

  it('a read binds null, which matches no row', async () => {
    // Fail-closed rather than fail-open: the query still runs, but
    // `organization_id = NULL` is never true, so it returns nothing instead of
    // every studio's settings.
    mockCurrentUser = { id: 'usr-0', role: 'super_admin', organization_id: null };
    await request(app).get('/api/settings').expect(200);

    const [q] = settingsSql();
    expect(q.sql).toMatch(/organization_id\s*=\s*\$\d/i);
    expect(q.params[0]).toBeNull();
  });

  it('an org-less tenant user is filtered too, not exempted', async () => {
    mockCurrentUser = { id: 'usr-2', role: 'admin', organization_id: null };
    await request(app).get('/api/settings/gym').expect(200);
    const [q] = settingsSql();
    expect(q.sql).toMatch(/organization_id\s*=\s*\$\d/i);
  });
});

describe('migration 194 is the other half of the isolation', () => {
  // The DB-backed suite asserts the END STATE of a database that has already
  // run this migration, so editing the migration cannot fail it — two
  // mutations (removing the shared-read drop, keeping the global primary key)
  // sailed through until these went in. These read the migration itself, so a
  // change is caught before it is applied anywhere.
  const fs = require('fs');
  const path = require('path');
  const mig = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '194_system_settings_organization_id.sql'),
    'utf8',
  );

  it('gives the table an owner and refuses to leave one unattributed', () => {
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS organization_id UUID/i);
    expect(mig).toMatch(/ALTER COLUMN organization_id SET NOT NULL/i);
    expect(mig).toMatch(/RAISE EXCEPTION\s+'194 refused/);
  });

  it('moves the primary key to (organization_id, key)', () => {
    // The write half. On PRIMARY KEY (key) the upserts in this router
    // conflicted globally, so one studio's save overwrote every other's.
    expect(mig).toMatch(/ADD PRIMARY KEY \(organization_id, key\)/i);
    expect(mig).not.toMatch(/ADD PRIMARY KEY \(key\)/i);
  });

  it('reclassifies the table at the RLS layer too', () => {
    // `tenant_shared_read USING (true)` is how the database said "platform
    // reference data". Leaving it means the application filters while RLS
    // does not — defence in depth with one layer switched off.
    expect(mig).toMatch(/DROP POLICY IF EXISTS tenant_shared_read ON system_settings/i);
    expect(mig).toMatch(/CREATE POLICY tenant_isolation ON system_settings/i);
    expect(mig).toMatch(/current_setting\('app\.org_id', true\)/);
  });

  it('attributes rows from evidence rather than a hardcoded studio id', () => {
    // A literal UUID here would be right on one database and wrong on every
    // other. Attribution goes through updated_by → users.organization_id.
    expect(mig).toMatch(/FROM users u\s+WHERE s\.updated_by = u\.id/i);
    expect(mig).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

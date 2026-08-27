'use strict';
// The platform user directory.
//
// A cross-tenant endpoint, so the things worth testing are not "does it return
// rows" but: does it stay cross-tenant, does it scope only when explicitly
// asked, and does it refuse to leak a credential.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { isPlatformWide, runWithTenantContext } = require('../lib/tenant-context');

const app = express();
app.use(express.json());
app.use('/api/platform', require('../modules/platform/super-admin/users'));

/** The SQL the directory ran, as one string. */
const sqlOf = () => pool.query.mock.calls.map(([s]) => (typeof s === 'string' ? s : s.text)).join('\n');
/** Bind parameters from the first call that looks like the list query. */
const listCall = () => pool.query.mock.calls.find(([s]) => /FROM users u/.test(String(s)));

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql) => {
    if (/count\(\*\)::int AS total/.test(String(sql))) return { rows: [{ total: 7 }] };
    return { rows: [] };
  });
});

describe('the directory stays cross-tenant', () => {
  it('reads platform-wide even inside a tenant-scoped context', async () => {
    // The trap that cost the platform grant a lockout bug. The frontend sends
    // x-org-id from localStorage on every request, so an operator who once
    // pinned the org-switcher makes auth.js compute platformWide=false — and a
    // directory that inherited that would quietly show one studio's users while
    // looking like the whole platform.
    let sawPlatformWide = null;
    pool.query.mockImplementation(async (sql) => {
      if (/FROM users u/.test(String(sql))) sawPlatformWide = isPlatformWide();
      if (/count\(\*\)::int AS total/.test(String(sql))) return { rows: [{ total: 0 }] };
      return { rows: [] };
    });

    await new Promise((resolve, reject) => {
      runWithTenantContext('org-a', () => {
        request(app).get('/api/platform/users').then(resolve, reject);
      }, { platformWide: false });
    });

    expect(sawPlatformWide).toBe(true);
  });

  it('scopes to one studio only when asked explicitly', async () => {
    await request(app).get('/api/platform/users?org=org-b');
    const [, params] = listCall();
    expect(params).toContain('org-b');
    expect(sqlOf()).toMatch(/u\.organization_id = \$\d/);
  });

  it('applies no organization filter by default', async () => {
    await request(app).get('/api/platform/users');
    expect(sqlOf()).not.toMatch(/u\.organization_id = \$/);
  });
});

describe('it never returns a credential', () => {
  it('selects no password column', async () => {
    await request(app).get('/api/platform/users');
    const sql = sqlOf();
    expect(sql).toMatch(/SELECT u\.id, u\.name, u\.email/);
    expect(sql).not.toMatch(/u\.password/);
    expect(sql).not.toMatch(/SELECT \*/);
  });

  it('reports platform access from the grant, not the role column', async () => {
    // role='super_admin' with no live grant cannot reach the console. A
    // directory that showed the role as though it were access would describe a
    // permission the account does not have.
    await request(app).get('/api/platform/users');
    const sql = sqlOf();
    expect(sql).toMatch(/platform_owners po/);
    expect(sql).toMatch(/po\.revoked_at IS NULL/);
    expect(sql).toMatch(/has_platform_grant/);
  });
});

describe('filters are bound, never concatenated', () => {
  it('binds the search term', async () => {
    await request(app).get('/api/platform/users?q=abhishek');
    const [sql, params] = listCall();
    expect(params).toContain('%abhishek%');
    expect(String(sql)).not.toContain('abhishek');
  });

  it('survives a search term full of SQL', async () => {
    const nasty = "'; DROP TABLE users; --";
    await request(app).get(`/api/platform/users?q=${encodeURIComponent(nasty)}`);
    const [sql, params] = listCall();
    expect(params.some((p) => String(p).includes('DROP TABLE'))).toBe(true);
    expect(String(sql)).not.toContain('DROP TABLE');
  });

  it('binds a role filter', async () => {
    await request(app).get('/api/platform/users?role=trainer');
    expect(listCall()[1]).toContain('trainer');
  });

  it("treats role=platform as the operators, not a literal role value", async () => {
    await request(app).get('/api/platform/users?role=platform');
    // 'platform' is not a value users.role can hold — binding it would return
    // nothing and look like "there are no platform users".
    expect(listCall()[1]).not.toContain('platform');
    expect(sqlOf()).toMatch(/u\.role = 'super_admin'/);
  });
});

describe('paging cannot be used to ask for the whole platform at once', () => {
  it('caps the page size', async () => {
    const res = await request(app).get('/api/platform/users?limit=100000');
    expect(res.body.limit).toBe(200);
    expect(sqlOf()).toMatch(/LIMIT 200/);
  });

  it('falls back to a default for nonsense', async () => {
    const res = await request(app).get('/api/platform/users?limit=abc&offset=-5');
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });

  it('never interpolates anything but an integer', async () => {
    await request(app).get('/api/platform/users?limit=10;DROP%20TABLE%20users&offset=0');
    const sql = sqlOf();
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).toMatch(/LIMIT \d+ OFFSET \d+/);
  });

  it('returns the unpaged total alongside the page', async () => {
    const res = await request(app).get('/api/platform/users?limit=1');
    expect(res.body.total).toBe(7);
  });
});

describe('status filters', () => {
  it.each([
    ['active', /u\.deleted_at IS NULL AND u\.is_active = true/],
    ['inactive', /u\.deleted_at IS NULL AND u\.is_active = false/],
    ['deleted', /u\.deleted_at IS NOT NULL/],
  ])('%s narrows the query', async (status, pattern) => {
    await request(app).get(`/api/platform/users?status=${status}`);
    expect(sqlOf()).toMatch(pattern);
  });

  it('shows soft-deleted accounts when asked, rather than hiding them always', async () => {
    // "What happened to this login" is the question a directory has to answer,
    // and an account that silently vanishes sends somebody to the database.
    await request(app).get('/api/platform/users?status=deleted');
    expect(sqlOf()).toMatch(/u\.deleted_at IS NOT NULL/);
  });
});

describe('the summary', () => {
  it('is reachable — a literal segment, not swallowed by a :param route', async () => {
    pool.query.mockResolvedValue({ rows: [{ total: 8, active: 7 }] });
    const res = await request(app).get('/api/platform/users/summary');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(8);
  });

  it('counts platform operators separately from studio roles', async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    await request(app).get('/api/platform/users/summary');
    const sql = sqlOf();
    expect(sql).toMatch(/AS owners/);
    expect(sql).toMatch(/AS trainers/);
    expect(sql).toMatch(/AS members/);
    expect(sql).toMatch(/AS platform/);
  });

  it('also reads platform-wide', async () => {
    let sawPlatformWide = null;
    pool.query.mockImplementation(async () => {
      sawPlatformWide = isPlatformWide();
      return { rows: [{}] };
    });
    await new Promise((resolve, reject) => {
      runWithTenantContext('org-a', () => {
        request(app).get('/api/platform/users/summary').then(resolve, reject);
      }, { platformWide: false });
    });
    expect(sawPlatformWide).toBe(true);
  });
});

'use strict';
// GET /api/diet/templates and POST /api/diet/assign carry their tenant filter.
//
// The DB-backed proof lives in diet.tenancy.integration.test.js, but it runs a
// COPY of the route's SQL. That proves the predicate works; it cannot prove
// the route still uses it. Strip the WHERE clause out of routes/diet.js and
// that suite stays green — which is exactly the shape of vacuous proof this
// repo has been bitten by before.
//
// So this drives the real handlers and asserts on the SQL they emit and the
// parameters they bind. Between the two files: the predicate is correct, and
// it is the one actually running.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];
let mockRows = [];

// The pool answers per-statement rather than uniformly. clientInOrg runs its
// own pt_clients lookup before the insert, so a mock that returned the same
// rows to everything would make "the template guard refused" and "the client
// guard refused" indistinguishable — and the assign tests below would pass on
// the wrong 404.
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    if (/FROM pt_clients/i.test(flat)) return { rows: [{ ok: 1 }], rowCount: 1 };
    return { rows: mockRows, rowCount: mockRows.length };
  }),
}));

let mockCurrentUser = { id: 'usr-1', role: 'admin', organization_id: ORG_A, trainer_id: null };
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
app.use((req, _res, next) => { req.branchScope = { appendTo: (p) => ({ sql: 'TRUE', params: p || [] }) }; next(); });
app.use('/api/diet', require('../routes/diet'));

/** Statements that touched a given table. */
const touching = (table) =>
  mockQueries.filter((q) => new RegExp(`\\b${table}\\b`, 'i').test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockRows = [];
  mockCurrentUser = { id: 'usr-1', role: 'admin', organization_id: ORG_A, trainer_id: null };
});

describe('GET /api/diet/templates is bounded by the caller studio', () => {
  it('carries the shared-shape org predicate and binds the caller org', async () => {
    await request(app).get('/api/diet/templates').expect(200);

    const [q] = touching('diet_templates');
    expect(q).toBeDefined();
    expect(q.sql).toMatch(/dt\.organization_id IS NULL OR dt\.organization_id = \$\d/i);
    expect(q.params).toContain(ORG_A);
  });

  it('is the SHARED shape, not the strict one', async () => {
    // A strict `organization_id = $n` would empty the picker for every studio,
    // since every diet template in production is product-seeded. This is the
    // half of the predicate that is easiest to "tidy up" into a bug.
    await request(app).get('/api/diet/templates').expect(200);

    const [q] = touching('diet_templates');
    expect(q.sql).toMatch(/IS NULL OR/i);
  });

  it('keeps the filter when a goal is also supplied', async () => {
    // The goal filter and the org filter share the parameter counter. A
    // numbering slip here binds the org id to the wrong placeholder, which
    // silently changes what the query means rather than erroring.
    await request(app).get('/api/diet/templates?goal=keto').expect(200);

    const [q] = touching('diet_templates');
    expect(q.sql).toMatch(/dt\.organization_id IS NULL OR dt\.organization_id = \$1/i);
    expect(q.sql).toMatch(/goal = \$2/i);
    expect(q.params[0]).toBe(ORG_A);
    expect(q.params[1]).toBe('keto');
  });

  it('binds limit and offset after the filters, not over them', async () => {
    await request(app).get('/api/diet/templates?goal=keto&limit=5&offset=10').expect(200);

    const [q] = touching('diet_templates');
    expect(q.params).toEqual([ORG_A, 'keto', 5, 10]);
    expect(q.sql).toMatch(/LIMIT \$3 OFFSET \$4/i);
  });

  it('a platform super admin with no target org reads unscoped', async () => {
    // The one caller for whom no predicate is correct. If this starts being
    // filtered, the operator console silently shows nothing.
    mockCurrentUser = { id: 'usr-0', role: 'super_admin', organization_id: null, trainer_id: null };
    await request(app).get('/api/diet/templates').expect(200);

    const [q] = touching('diet_templates');
    expect(q.sql).not.toMatch(/organization_id/i);
    expect(q.params).toEqual([200, 0]);
  });
});

describe('POST /api/diet/assign is bounded by the caller studio', () => {
  const body = { diet_template_id: 'tpl-1', client_id: 'cl-1' };

  it('gates the template id inside the insert', async () => {
    mockRows = [{ id: 'as-1' }];
    await request(app).post('/api/diet/assign').send(body).expect(201);

    const ins = touching('diet_assignments')[0];
    expect(ins.sql).toMatch(/WHERE EXISTS \(SELECT 1 FROM diet_templates dt WHERE dt\.id = \$2/i);
    expect(ins.sql).toMatch(/dt\.organization_id IS NULL OR dt\.organization_id = \$9/i);
    expect(ins.params[8]).toBe(ORG_A);
  });

  it('404s rather than 201s when the template is not visible', async () => {
    // The guard writes no row and returns nothing; without the rows[0] check
    // the handler would answer 201 with `assignment: undefined`, which reads
    // to the caller as success.
    mockRows = [];
    const res = await request(app).post('/api/diet/assign').send(body).expect(404);
    expect(res.body.error).toMatch(/template not found/i);
  });

  it('does not leak whether the template id exists', async () => {
    // Same 404 as the client guard above it. A 403 here would confirm the id
    // is real to a caller who may not use it.
    mockRows = [];
    const res = await request(app).post('/api/diet/assign').send(body).expect(404);
    expect(res.status).not.toBe(403);
  });

  it('a platform super admin with no target org assigns unguarded', async () => {
    mockCurrentUser = { id: 'usr-0', role: 'super_admin', organization_id: null, trainer_id: null };
    mockRows = [{ id: 'as-1' }];
    await request(app).post('/api/diet/assign').send(body).expect(201);

    const ins = touching('diet_assignments')[0];
    expect(ins.sql).toMatch(/WHERE EXISTS/i);
    expect(ins.sql).not.toMatch(/dt\.organization_id/i);
  });
});

describe('diet_templates is the only diet-template data source', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..');

  /** Runtime .js under src/, excluding tests and migrations. */
  function runtimeFiles(dir = SRC, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'migrations' || e.name === 'node_modules') continue;
        runtimeFiles(full, out);
      } else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  const files = runtimeFiles();

  it('scans a real set of runtime files', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(path.join('routes', 'diet.js')))).toBe(true);
  });

  it('no runtime file queries a diet_plans table', () => {
    // `diet_plans` exists in this codebase only as a search-provider group key
    // and a UI route name (/pt-os/diet-plans). It has never been a table, and
    // the search provider that carries the name already reads diet_templates.
    // This is what keeps the label from turning back into a data source.
    const SQL = /\b(?:FROM|UPDATE|INTO|JOIN)\s+(?:public\.)?diet_plans\b/i;
    const offenders = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (SQL.test(line)) offenders.push(`${path.relative(SRC, f)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern would catch one if it appeared, and spares diet_plan_meals', () => {
    // diet_plan_meals is a real, live table whose name contains the string.
    // Matching it would make the assertion above fail for the wrong reason;
    // loosening the regex to compensate would stop it detecting the real thing.
    const SQL = /\b(?:FROM|UPDATE|INTO|JOIN)\s+(?:public\.)?diet_plans\b/i;
    expect(SQL.test('FROM diet_plan_meals dpm')).toBe(false);
    expect(SQL.test('INTO diet_plan_meals (id)')).toBe(false);
    expect(SQL.test('FROM diet_plans')).toBe(true);
    expect(SQL.test('JOIN public.diet_plans p ON')).toBe(true);
  });

  it('the search provider named diet_plans reads diet_templates', () => {
    // The one place the name survives on the backend. It is a result-group
    // key in the global search payload, and the frontend keys its icon off
    // the item type `diet_plan` — so the name is an API contract, not a
    // leftover, and renaming it would break the search UI for no gain.
    const svc = fs.readFileSync(
      path.join(SRC, 'modules', 'search', 'search.service.js'), 'utf8');
    expect(svc).toMatch(/type: 'diet_plans'/);
    expect(svc).toMatch(/from: 'diet_templates x'/);
  });
});

// Phase 2 — "Hey Siri, find Rahul in MY PT STUDIO."
//
// Searching by name is a bigger step than Phase 1's count, and these tests are
// scoped to the two ways it can go wrong:
//
//   1. It returns PEOPLE, not a number. A leak here is a named individual and
//      their package, not an aggregate — so the cross-organization case is the
//      centre of this file rather than one test in it.
//   2. It takes CALLER INPUT for the first time on this surface. `q` reaches a
//      SQL LIKE pattern, so its bounds are a security property, not ergonomics.
//
// A trainer seeing only their own roster is the third boundary, and the
// fail-closed case (a trainer account with no trainer record) is the one that
// silently becomes "the whole studio" if the guard is ever dropped.
//
// The SQL is asserted by inspecting what reached the pool. "It returned the
// right rows" is exactly what a broken filter also does when the mock holds
// only one org's rows.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
let mockRows;

jest.mock('../../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: mockRows, rowCount: mockRows.length };
  }),
  connect: jest.fn(),
}));

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

let mockUser;
// Spread over the REAL module rather than replacing it. A bare object mock
// silently drops every export the router also imports — when the router later
// grew an `adminManagerOrTrainer` guard, that arrived here as `undefined`
// middleware and every test in the file failed at router construction, naming
// nothing useful. Only `auth` itself needs faking.
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  auth: (req, res, next) => {
    if (!mockUser) return res.status(401).json({ error: 'Unauthorized' });
    req.user = mockUser;
    next();
  },
  adminOnly: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../middleware/errorHandler');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/voice', require('../../routes/voice'));
  a.use(errorHandler);
  return a;
}

const URL = '/api/voice/clients/search';
const search = (q) => request(app()).get(URL).query({ q });

/** The SELECT the handler ran — the audit INSERT is fire-and-forget noise. */
const searchQuery = () => mockLog.find((x) => /FROM pt_clients/i.test(x.sql));
const dbTouched = () => mockLog.length;

const ADMIN_A    = { id: 'u-admin-a', name: 'Admin A', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B    = { id: 'u-admin-b', name: 'Admin B', role: 'admin', organization_id: ORG_B, trainer_id: null };
const MANAGER_A  = { id: 'u-mgr-a', name: 'Mgr A', role: 'manager', organization_id: ORG_A, trainer_id: null };
const TRAINER_A  = { id: 'u-trn-a', name: 'Trainer A', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a' };
const TRAINER_NO_RECORD = { id: 'u-trn-x', name: 'Trainer X', role: 'trainer', organization_id: ORG_A, trainer_id: null };
const MEMBER_A   = { id: 'u-member-a', name: 'Client A', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-a' };
const ORPHAN     = { id: 'u-orphan', name: 'Orphan', role: 'admin', organization_id: null, trainer_id: null };
const SUPER      = { id: 'u-super', name: 'Platform', role: 'super_admin', organization_id: null, trainer_id: null };

const RAHUL = {
  id: 'ptc-1', client_id: 'PT001', name: 'Rahul Sharma',
  status: 'active', package_type: 'PT 3 Month', pt_end_date: '2099-01-01',
};

beforeEach(() => {
  mockLog.length = 0;
  mockRows = [RAHUL];
  mockUser = ADMIN_A;
});

// ── A. Who may search ──────────────────────────────────────────────────────
describe('A. the search is staff-only', () => {
  test('a client (role=member) is refused before any query runs', async () => {
    mockUser = MEMBER_A;
    const res = await search('Rahul');

    expect(res.status).toBe(403);
    // A member must not be able to enumerate the roster by voice — least of
    // all from a locked phone.
    expect(dbTouched()).toBe(0);
  });

  test('an unauthenticated request is refused', async () => {
    mockUser = null;
    const res = await search('Rahul');

    expect(res.status).toBe(401);
    expect(dbTouched()).toBe(0);
  });
});

// ── B. Cross-organization isolation ────────────────────────────────────────
describe('B. one studio can never reach another studio\'s clients', () => {
  test('filters on the org id taken from the SESSION', async () => {
    mockUser = ADMIN_A;
    const res = await search('Rahul');

    expect(res.status).toBe(200);
    const q = searchQuery();
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.params).toContain(ORG_A);
    expect(q.params).not.toContain(ORG_B);
  });

  test('the SAME name from two studios is filtered to each caller\'s own org', async () => {
    // The cross-organization test. Both studios have a Rahul; nothing in the
    // REQUEST distinguishes them, so only the session may.
    mockUser = ADMIN_A;
    await search('Rahul');
    const paramsA = searchQuery().params;

    mockLog.length = 0;
    mockUser = ADMIN_B;
    await search('Rahul');
    const paramsB = searchQuery().params;

    expect(paramsA).toContain(ORG_A);
    expect(paramsA).not.toContain(ORG_B);
    expect(paramsB).toContain(ORG_B);
    expect(paramsB).not.toContain(ORG_A);
  });

  test('a tenant admin cannot widen scope with x-org-id or a query param', async () => {
    // x-org-id is the platform operator's targeting header. Honoured for a
    // super_admin only — otherwise any studio could read any other studio by
    // adding a header to a request its own phone makes.
    mockUser = ADMIN_A;
    const res = await request(app())
      .get(URL)
      .query({ q: 'Rahul', organization_id: ORG_B })
      .set('x-org-id', ORG_B);

    expect(res.status).toBe(200);
    expect(searchQuery().params).toContain(ORG_A);
    expect(searchQuery().params).not.toContain(ORG_B);
  });

  test('a tenant user with no organization matches nothing, not everything', async () => {
    mockUser = ORPHAN;
    const res = await search('Rahul');

    expect(res.status).toBe(200);
    const q = searchQuery();
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.params).toContain(null);
  });

  test('a platform super admin targeting one studio is filtered to it', async () => {
    mockUser = SUPER;
    await request(app()).get(URL).query({ q: 'Rahul' }).set('x-org-id', ORG_B);
    expect(searchQuery().params).toContain(ORG_B);
  });
});

// ── C. A trainer sees only their own roster ────────────────────────────────
describe('C. trainer scoping is narrower than the org', () => {
  test('a trainer is additionally filtered to their own clients', async () => {
    mockUser = TRAINER_A;
    await search('Rahul');

    const q = searchQuery();
    // In ADDITION to the org filter, never instead of it.
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.sql).toMatch(/trainer_id = \$3/);
    expect(q.params).toContain('trn-a');
    expect(q.params).toContain(ORG_A);
  });

  test('an admin is NOT narrowed to a trainer', async () => {
    mockUser = ADMIN_A;
    await search('Rahul');
    expect(searchQuery().sql).not.toMatch(/trainer_id/);
  });

  test('a manager is NOT narrowed to a trainer', async () => {
    mockUser = MANAGER_A;
    await search('Rahul');
    expect(searchQuery().sql).not.toMatch(/trainer_id/);
  });

  test('a trainer with no trainer record fails CLOSED, not open', async () => {
    // The silent one. Without the guard this role falls through with no
    // trainer filter and reads the entire studio.
    mockUser = TRAINER_NO_RECORD;
    const res = await search('Rahul');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.results).toEqual([]);
    expect(searchQuery()).toBeUndefined();
  });
});

// ── D. Input validation ────────────────────────────────────────────────────
describe('D. the search term is bounded', () => {
  test('rejects a single character', async () => {
    // One letter matches most of a roster and turns search into enumeration.
    const res = await search('R');
    expect(res.status).toBe(400);
    expect(dbTouched()).toBe(0);
  });

  test('rejects an empty or whitespace-only term', async () => {
    expect((await search('   ')).status).toBe(400);
    expect((await request(app()).get(URL)).status).toBe(400);
    expect(dbTouched()).toBe(0);
  });

  test('rejects an over-long term', async () => {
    const res = await search('x'.repeat(61));
    expect(res.status).toBe(400);
    expect(dbTouched()).toBe(0);
  });

  test('passes the term as a BOUND PARAMETER, never interpolated', async () => {
    // The injection guard. The term reaches SQL as $1 and nothing else.
    await search("Rahul'; DROP TABLE pt_clients;--");

    const q = searchQuery();
    expect(q.sql).not.toMatch(/DROP TABLE/i);
    expect(q.params[0]).toBe("%Rahul'; DROP TABLE pt_clients;--%");
  });

  test('caps how many rows can come back', async () => {
    // A bounded LIMIT is what stops a two-character term returning the roster.
    await search('Rahul');
    expect(searchQuery().sql).toMatch(/LIMIT \$\d+/);
    expect(searchQuery().params).toContain(5);
  });
});

// ── E. What comes back, and what is said ───────────────────────────────────
describe('E. the answer', () => {
  test('returns only the four facts a spoken answer needs', async () => {
    const res = await search('Rahul');
    // No mobile, no email, no address, no amounts. Whatever is here may be
    // read aloud with other people in the room.
    expect(Object.keys(res.body.results[0]).sort())
      .toEqual(['client_id', 'expired', 'expires_on', 'id', 'name', 'package_type', 'status']);
  });

  test('never selects contact details from the database at all', async () => {
    await search('Rahul');
    const { sql } = searchQuery();
    expect(sql).not.toMatch(/\bmobile\b/i);
    expect(sql).not.toMatch(/\bemail\b/i);
    expect(sql).not.toMatch(/\baddress\b/i);
  });

  test('no match is a real answer, not an error', async () => {
    mockRows = [];
    const res = await search('Nobody');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.spoken).toMatch(/could not find anyone/i);
  });

  test('one match is described with its expiry', async () => {
    mockRows = [RAHUL];
    const res = await search('Rahul');
    expect(res.body.spoken).toBe('Rahul Sharma is active until 2099-01-01.');
  });

  test('an expired package is volunteered, not buried', async () => {
    mockRows = [{ ...RAHUL, pt_end_date: '2020-01-01' }];
    const res = await search('Rahul');

    expect(res.body.results[0].expired).toBe(true);
    expect(res.body.spoken).toMatch(/expired package/i);
    expect(res.body.spoken).toMatch(/2020-01-01/);
  });

  test('an inactive client is described by status rather than expiry', async () => {
    mockRows = [{ ...RAHUL, status: 'frozen' }];
    const res = await search('Rahul');
    expect(res.body.spoken).toBe('Rahul Sharma is frozen.');
  });

  test('a client with no end date on file is unknown, not expired', async () => {
    // The honest-empty case: no date means we do not know, and announcing
    // "expired" would be a claim about the client rather than the record.
    mockRows = [{ ...RAHUL, pt_end_date: null }];
    const res = await search('Rahul');

    expect(res.body.results[0].expired).toBeNull();
    expect(res.body.spoken).toBe('Rahul Sharma is active.');
  });

  test('several matches are counted and named, never guessed between', async () => {
    mockRows = [
      { ...RAHUL, id: 'ptc-1', name: 'Rahul Sharma' },
      { ...RAHUL, id: 'ptc-2', name: 'Rahul Verma' },
    ];
    const res = await search('Rahul');

    expect(res.body.count).toBe(2);
    expect(res.body.spoken).toMatch(/found 2 people/i);
    expect(res.body.spoken).toContain('Rahul Sharma');
    expect(res.body.spoken).toContain('Rahul Verma');
    // Must not state one person's expiry as though it were the answer.
    expect(res.body.spoken).not.toMatch(/active until/i);
  });

  test('the search is written to the audit trail', async () => {
    await search('Rahul');
    const audit = mockLog.find((x) => /INSERT INTO activity_log/i.test(x.sql));

    expect(audit).toBeTruthy();
    expect(audit.params).toContain('voice.clients.search');
  });
});

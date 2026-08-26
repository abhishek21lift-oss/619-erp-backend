// DELETE /api/settings/branches/:id
//
// The Settings → Branches screen has always rendered a Delete button wired to
// api.branches.delete(), but settings.js only registered GET/POST/PUT for
// branches. The call 404'd, the catch showed "Failed to delete branch", and the
// row stayed. Deleting a branch was simply not possible from the UI.
//
// The interesting case is the refusal. Branches live in system_settings under a
// `branch_<uuid>` key and clients.branch_id stores that full key — there is no
// foreign key, so nothing cascades and nothing gets nulled. Deleting a branch
// that still has members would leave those rows pointing at a key that no
// longer resolves, and they would drop out of every per-branch view without a
// word. So a populated branch is a 409, not a delete.
'use strict';

const BRANCH_ID = '0b4d1f2e-1111-2222-3333-444455556666';
const BRANCH_KEY = `branch_${BRANCH_ID}`;

let mockBranchRows = [{ key: BRANCH_KEY }];
let mockMemberCount = 0;

const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: text, params });
    if (/^SELECT key FROM system_settings/i.test(text)) {
      return { rows: mockBranchRows, rowCount: mockBranchRows.length };
    }
    if (/COUNT\(\*\)::int AS member_count/i.test(text)) {
      return { rows: [{ member_count: mockMemberCount }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser = { id: 'admin-1', role: 'admin', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (req, res, next) => (
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })
  ),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/settings', require('../routes/settings'));
  return a;
}

const deleteQuery = () => mockQueries.find((q) => /^DELETE FROM system_settings/i.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockBranchRows = [{ key: BRANCH_KEY }];
  mockMemberCount = 0;
  mockUser = { id: 'admin-1', role: 'admin', organization_id: 'org-1' };
});

describe('DELETE /settings/branches/:id', () => {
  test('deletes an empty branch and reports it', async () => {
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(200);
    // The client types this as { message: string } and shows it on success.
    expect(res.body).toEqual({ message: 'Branch deleted' });
    // Both the key AND the caller's organisation. system_settings carries a
    // tenant column since migration 180; before it, this DELETE addressed the
    // key alone and one studio's owner could remove another studio's branch.
    expect(deleteQuery().params).toEqual([BRANCH_KEY, 'org-1']);
  });

  test('scopes every statement to the caller\'s organisation', async () => {
    // The guard against the whole class of bug, not just the DELETE: the
    // existence check, the member count and the delete must all be bounded, or
    // the route reports on one studio's data while acting on another's.
    await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    const touching = mockQueries.filter((q) =>
      /system_settings|pt_clients/i.test(q.sql));
    expect(touching.length).toBeGreaterThanOrEqual(3);
    for (const q of touching) {
      expect(q.sql).toMatch(/organization_id\s*=\s*\$\d/i);
      expect(q.params).toContain('org-1');
    }
  });

  test('refuses to delete when no organisation resolved', async () => {
    // An admin account carrying no organisation — a legacy or half-provisioned
    // row, which middleware/auth.js loads through a LEFT JOIN and will happily
    // hand over. orgIdOf() returns null for it, and an unbounded DELETE would
    // remove the branch from whichever studio owned it. So the write refuses.
    //
    // Deliberately an `admin`, not a `super_admin`: adminOnly gates these
    // routes on role === 'admin' exactly, so an operator never reaches the
    // handler at all and this backstop only ever fires for the case above.
    mockUser = { id: 'admin-2', role: 'admin', organization_id: null };
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_TARGET_ORG');
    expect(deleteQuery()).toBeUndefined();
  });

  test('addresses the row by its prefixed settings key, not the bare id', async () => {
    // clients.branch_id stores `branch_<uuid>`. Deleting on the bare uuid would
    // match no row, and the member-count guard would check the wrong key.
    await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    for (const q of mockQueries) {
      expect(q.params).not.toContain(BRANCH_ID);
      expect(q.params).toContain(BRANCH_KEY);
    }
  });

  test('refuses a branch that still has members, and does not delete', async () => {
    mockMemberCount = 3;
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/3 members/);
    expect(deleteQuery()).toBeUndefined();
  });

  test('the refusal reads naturally for a single member', async () => {
    mockMemberCount = 1;
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.body.error).toMatch(/1 member\b/);
    expect(res.body.error).not.toMatch(/1 members/);
  });

  test('counts only live members — a soft-deleted client must not block', async () => {
    await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    const countQ = mockQueries.find((q) => /member_count/i.test(q.sql));
    expect(countQ.sql).toMatch(/deleted_at IS NULL/i);
  });

  test('404s an unknown branch instead of reporting a successful delete', async () => {
    mockBranchRows = [];
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(404);
    expect(deleteQuery()).toBeUndefined();
  });

  test('a non-admin cannot delete a branch', async () => {
    // Matches POST/PUT on the same collection, which are both adminOnly.
    mockUser = { id: 'mgr-1', role: 'manager', organization_id: 'org-1' };
    const res = await request(app()).delete(`/api/settings/branches/${BRANCH_ID}`);

    expect(res.status).toBe(403);
    expect(deleteQuery()).toBeUndefined();
  });
});

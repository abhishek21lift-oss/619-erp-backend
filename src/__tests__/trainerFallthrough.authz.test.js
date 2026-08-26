'use strict';
// The `role === 'trainer' ? own_scope : null` fall-through, and its relatives.
//
// ── The shape ──────────────────────────────────────────────────────────────
//
// A handler narrows its query for a trainer, so that a trainer sees only their
// own roster:
//
//     const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
//     const where = tid ? 'AND p.trainer_id = $2' : '';
//
// For an admin or a manager the empty string is correct — they are supposed to
// see the whole studio. For everyone ELSE it is a silent grant. The code reads
// as "narrow for trainers", and what it does is "narrow for trainers, and
// widen for every role nobody thought about".
//
// It has now produced four instances:
//
//   GET /api/reports/monthly        studio revenue          (fixed in #84)
//   GET /api/search                 the studio's clients    (fixed in #85)
//   GET /api/expenses/stats         studio expense totals   (fixed here)
//   authz.trainerWhere / canAccessClient                    (fixed here)
//
// The last is the one worth the comment. It is a SHARED helper, so the hole
// was inherited by every caller rather than written four times; it was latent
// only because every current caller happens to sit behind
// requireRole('admin','manager','trainer'). "Safe because of something in
// another file" is exactly how the twelve untenanted tables happened.
//
// ── What this file pins ────────────────────────────────────────────────────
//
// Not the wording of any one query. The property: a member must not be handed
// the unconstrained branch of a trainer test.

const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

const mockQueries = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(async () => ({
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    release: jest.fn(),
  })),
}));

const authz = require('../modules/training/authz');

const MEMBER = {
  id: 'u-member', role: 'member',
  organization_id: '11111111-1111-4111-8111-111111111111',
  pt_client_id: 'client-own', member_id: 'mem-1',
};
const TRAINER = {
  id: 'u-trainer', role: 'trainer',
  organization_id: '11111111-1111-4111-8111-111111111111',
  trainer_id: 'tr-1',
};
const ADMIN = {
  id: 'u-admin', role: 'admin',
  organization_id: '11111111-1111-4111-8111-111111111111',
};

beforeEach(() => { mockQueries.length = 0; });

describe('canAccessClient constrains a member to their own client', () => {
  it('allows a member their own client id', async () => {
    await expect(authz.canAccessClient({ user: MEMBER }, 'client-own')).resolves.toBe(true);
    // Answered without a query: the ownership test is decidable from the
    // session, so it must not depend on what the database happens to return.
    expect(mockQueries).toHaveLength(0);
  });

  it('refuses a member another client in the SAME studio', async () => {
    // The org filter passes here — same studio — which is precisely why the
    // org filter was never enough on its own.
    await expect(authz.canAccessClient({ user: MEMBER }, 'client-someone-else'))
      .resolves.toBe(false);
    expect(mockQueries).toHaveLength(0);
  });

  it('refuses a member with no client id at all', async () => {
    const orphan = { ...MEMBER, pt_client_id: null, client_id: null };
    await expect(authz.canAccessClient({ user: orphan }, 'client-own')).resolves.toBe(false);
  });

  it('still queries for a trainer, rather than short-circuiting everyone', async () => {
    // A fix that refused every non-admin would also pass the tests above.
    await authz.canAccessClient({ user: TRAINER }, 'client-x');
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0].sql).toMatch(/FROM pt_clients/i);
    expect(mockQueries[0].params).toContain('tr-1');
  });

  it('still queries for an admin, unnarrowed by trainer', async () => {
    await authz.canAccessClient({ user: ADMIN }, 'client-x');
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0].params).not.toContain('tr-1');
  });
});

describe('trainerWhere does not hand a member the unconstrained branch', () => {
  it('matches nothing for a member', () => {
    const params = [];
    const clause = authz.trainerWhere({ user: MEMBER }, params);
    // The bug returned '' here — no clause at all — which widened the query.
    expect(clause).not.toBe('');
    expect(clause).toMatch(/FALSE/i);
  });

  it('narrows to the trainer for a trainer', () => {
    const params = [];
    const clause = authz.trainerWhere({ user: TRAINER }, params);
    expect(clause).toMatch(/c\.trainer_id = \$1/);
    expect(params).toEqual(['tr-1']);
  });

  it('stays empty for an admin, who is meant to see the studio', () => {
    const params = [];
    expect(authz.trainerWhere({ user: ADMIN }, params)).toBe('');
    expect(params).toEqual([]);
  });

  it('stays empty for a staff role with no trainer record', () => {
    // reception/staff legitimately see the whole studio and have no
    // trainer_id. Refusing them would be a different bug.
    const params = [];
    const reception = { ...ADMIN, role: 'reception' };
    expect(authz.trainerWhere({ user: reception }, params)).toBe('');
  });
});

describe('the routes that carried this pattern are gated', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Behavioural coverage for these lives in memberEscalation.authz.test.js,
  // which drives a real member session at every route. This asserts the
  // specific mounts stay gated, so a future edit that drops one is caught by
  // name rather than by a count changing somewhere.
  it.each([
    ['/api/expenses', 'permGate'],
    ['/api/search', 'requireStaff'],
    ['/api/reports', 'permGate'],
  ])('%s is mounted behind %s', (mount, guard) => {
    const line = server.split('\n').find((l) => l.includes(`app.use('${mount}'`));
    expect(line).toBeDefined();
    expect(line).toContain(guard);
  });
});

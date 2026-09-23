'use strict';
// The `role === 'trainer' ? own_scope : null` fall-through, and its relatives.
//
// ── The shape ──────────────────────────────────────────────────────────────
//
// Handlers used to narrow their query for a trainer (an assistant coach) and
// leave it wide for everyone else:
//
//     const tid = req.user.role === 'trainer' ? req.user.trainer_id : null;
//     const where = tid ? 'AND p.trainer_id = $2' : '';
//
// That produced four real holes — GET /api/reports/monthly, GET /api/search,
// GET /api/expenses/stats and the shared authz.trainerWhere/canAccessClient —
// because every role nobody thought about got the wide branch.
//
// In the Trainer → Members model there is nothing to narrow TO: the trainer
// owns the studio. So the whole shape is gone rather than patched, and this
// file pins what replaced it in the one shared helper:
//
//   · trainer — the studio's clients, and only the studio's: one query, bound
//     to the caller's organization, with no trainer_id narrowing.
//   · member — their own client record and nothing else, decided from the
//     session without asking the database.
//   · anything else — false, without a query. No role falls through to an
//     org-only check the way a member once did.
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

  it('queries for a trainer, bound to their organization and not to a roster', async () => {
    // A fix that refused everyone would also pass the member tests above.
    await authz.canAccessClient({ user: TRAINER }, 'client-x');
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0].sql).toMatch(/FROM pt_clients/i);
    expect(mockQueries[0].sql).toMatch(/organization_id = \$2/);
    expect(mockQueries[0].params).toEqual(['client-x', TRAINER.organization_id]);
    // The trainer owns the studio: no assistant-coach narrowing.
    expect(mockQueries[0].sql).not.toMatch(/trainer_id/);
  });
});

describe('canAccessClient refuses every other caller without asking the database', () => {
  it.each([
    ['the platform operator', { id: 'op', role: 'super_admin', organization_id: null }],
    ['a trainer with no studio', { id: 't', role: 'trainer', organization_id: null }],
    ['a removed staff role', { id: 'a', role: 'admin', organization_id: '11111111-1111-4111-8111-111111111111' }],
    ['a role nobody defined', { id: 'x', role: 'partner_api', organization_id: '11111111-1111-4111-8111-111111111111' }],
    ['no user at all', undefined],
  ])('%s', async (_label, user) => {
    await expect(authz.canAccessClient({ user }, 'client-x')).resolves.toBe(false);
    expect(mockQueries).toHaveLength(0);
  });

  it('exports no roster-narrowing helper for a caller to reach for', () => {
    expect(authz.trainerWhere).toBeUndefined();
    expect(authz.seesAllClients).toBeUndefined();
    expect(authz.ALL_CLIENT_ROLES).toBeUndefined();
  });
});

describe('the routes that carried this pattern are gated', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Behavioural coverage for these lives in memberEscalation.authz.test.js,
  // which drives a real member session at every route. This asserts the
  // specific mounts stay gated, so a future edit that drops one is caught by
  // name rather than by a count changing somewhere.
  it.each([
    ['/api/expenses', 'studioGate'],
    ['/api/search', 'requireTrainer'],
    ['/api/reports', 'studioGate'],
  ])('%s is mounted behind %s', (mount, guard) => {
    const line = server.split('\n').find((l) => l.includes(`app.use('${mount}'`));
    expect(line).toBeDefined();
    expect(line).toContain(guard);
  });
});

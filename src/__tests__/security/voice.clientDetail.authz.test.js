// Phase 3 — "Hey Siri, show me Rahul's details in MY PT STUDIO."
//
// This is the first voice endpoint that takes an ID FROM THE CALLER, which is
// the shape that already went wrong once in this codebase: the automation
// module shipped handlers that accepted a client_id and read rows for it
// without asking whose client it was, and returned every studio's client names
// and mobile numbers to any authenticated account (see that module's header).
//
// So the centre of this file is ownership:
//
//   · Another studio's id answers 404, NOT 403. A 403 confirms the id is real
//     somewhere, which is an enumeration oracle for a surface whose ids are
//     handed out by the Phase 2 search endpoint.
//   · The ownership check runs BEFORE any client data is read.
//   · A trainer cannot read a colleague's client by pasting an id search gave
//     to somebody else.
//
// The two joined reads (session balance, today's workout) are asserted to be
// keyed on the already-verified client rather than re-deriving the tenant.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
/** Queue of responses, matched in order against the queries the handler runs. */
let mockResponder;

jest.mock('../../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: flat, params });
    const rows = mockResponder(flat, params);
    return { rows, rowCount: rows.length };
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

const CLIENT_ID = 'ptc-rahul';
const url = (id = CLIENT_ID) => `/api/voice/clients/${id}`;
const get = (id) => request(app()).get(url(id));

/** Queries the handler ran, by role. */
const ownershipQuery = () => mockLog.find((q) => /SELECT 1 FROM pt_clients/i.test(q.sql));
const detailQuery = () => mockLog.find((q) => /SELECT id, name, status, package_type/i.test(q.sql));
const balanceQuery = () => mockLog.find((q) => /FROM session_balance/i.test(q.sql));
const todayQuery = () => mockLog.find((q) => /FROM workout_sessions/i.test(q.sql));

const ADMIN_A   = { id: 'u-a', name: 'Admin A', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B   = { id: 'u-b', name: 'Admin B', role: 'admin', organization_id: ORG_B, trainer_id: null };
const TRAINER_A = { id: 'u-t', name: 'Trainer A', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a' };
const TRAINER_NO_RECORD = { id: 'u-tx', name: 'Trainer X', role: 'trainer', organization_id: ORG_A, trainer_id: null };
const MEMBER_A  = { id: 'u-m', name: 'Client A', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-a' };
const ORPHAN    = { id: 'u-o', name: 'Orphan', role: 'admin', organization_id: null, trainer_id: null };

const RAHUL = {
  id: CLIENT_ID, name: 'Rahul Sharma', status: 'active',
  package_type: 'PT Gold', pt_end_date: '2099-09-14',
};

/**
 * The default world: the client belongs to the caller, has 8 sessions left and
 * an in-progress workout today.
 */
function defaultWorld(overrides = {}) {
  const {
    owned = true, client = RAHUL, balance = [{ remaining_sessions: 8 }],
    today = [{ status: 'in_progress', program_name: 'Push Day' }],
  } = overrides;

  return (sql) => {
    if (/SELECT 1 FROM pt_clients/i.test(sql)) return owned ? [{ '?column?': 1 }] : [];
    if (/SELECT id, name, status, package_type/i.test(sql)) return client ? [client] : [];
    if (/FROM session_balance/i.test(sql)) return balance;
    if (/FROM workout_sessions/i.test(sql)) return today;
    return [];
  };
}

beforeEach(() => {
  mockLog.length = 0;
  mockUser = ADMIN_A;
  mockResponder = defaultWorld();
});

// ── A. Authorized access ───────────────────────────────────────────────────
describe('A. authorized access', () => {
  test('an admin in the owning org gets the detail', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Rahul Sharma');
    expect(res.body.package_type).toBe('PT Gold');
    expect(res.body.active).toBe(true);
    expect(res.body.sessions_remaining).toBe(8);
    expect(res.body.today.status).toBe('in_progress');
  });

  test('speaks a concise natural sentence', async () => {
    const res = await get();
    // The shape the brief asked for.
    expect(res.body.spoken).toBe(
      "Rahul Sharma is on PT Gold. Their package expires on 14 September 2099, and they have 8 sessions left, and today's workout is pending."
    );
  });

  test('a trainer may read their OWN client', async () => {
    mockUser = TRAINER_A;
    const res = await get();

    expect(res.status).toBe(200);
    // Narrowed in addition to the org filter, never instead of it.
    expect(detailQuery().sql).toMatch(/trainer_id = \$3/);
    expect(detailQuery().params).toContain('trn-a');
  });
});

// ── B. Unauthorized access ─────────────────────────────────────────────────
describe('B. unauthorized access', () => {
  test('a client (role=member) is refused before anything is read', async () => {
    mockUser = MEMBER_A;
    const res = await get();

    expect(res.status).toBe(403);
    expect(mockLog).toHaveLength(0);
  });

  test('an unauthenticated request is refused', async () => {
    mockUser = null;
    const res = await get();

    expect(res.status).toBe(401);
    expect(mockLog).toHaveLength(0);
  });

  test('a trainer with no trainer record cannot read anyone', async () => {
    // Fail closed: without the guard this role reads any client in the org.
    mockUser = TRAINER_NO_RECORD;
    const res = await get();

    expect(res.status).toBe(404);
    expect(detailQuery()).toBeUndefined();
  });
});

// ── C. Cross-organization access ───────────────────────────────────────────
describe('C. cross-organization access', () => {
  test('another studio\'s client is 404, NOT 403', async () => {
    // The enumeration guard. 403 would confirm the id exists somewhere, and
    // these ids are handed out by the Phase 2 search endpoint.
    mockResponder = defaultWorld({ owned: false });
    mockUser = ADMIN_B;

    const res = await get();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('ownership is checked BEFORE any client data is read', async () => {
    mockResponder = defaultWorld({ owned: false });
    mockUser = ADMIN_B;
    await get();

    // The ownership probe ran; the detail read never did.
    expect(ownershipQuery()).toBeTruthy();
    expect(detailQuery()).toBeUndefined();
    expect(balanceQuery()).toBeUndefined();
    expect(todayQuery()).toBeUndefined();
  });

  test('the ownership check is scoped to the CALLER\'s org', async () => {
    mockUser = ADMIN_B;
    mockResponder = defaultWorld({ owned: false });
    await get();

    expect(ownershipQuery().params).toEqual([CLIENT_ID, ORG_B]);
  });

  test('a foreign id and a nonexistent id are indistinguishable', async () => {
    // Same status, same body — nothing separates "not yours" from "not there".
    mockResponder = defaultWorld({ owned: false });
    mockUser = ADMIN_B;
    const foreign = await get();

    mockLog.length = 0;
    mockResponder = defaultWorld({ owned: true, client: null });
    mockUser = ADMIN_A;
    const missing = await get('ptc-does-not-exist');

    expect(foreign.status).toBe(missing.status);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
  });

  test('the detail read is itself org-filtered, not just the ownership probe', async () => {
    // Defence in depth: if clientInOrg were ever bypassed, the read must still
    // be bounded.
    await get();
    expect(detailQuery().sql).toMatch(/organization_id = \$2/);
    expect(detailQuery().params).toContain(ORG_A);
  });

  test('an org-less tenant user reads nothing', async () => {
    mockUser = ORPHAN;
    mockResponder = defaultWorld({ owned: false });
    const res = await get();
    expect(res.status).toBe(404);
  });
});

// ── D. Nonexistent client ──────────────────────────────────────────────────
describe('D. nonexistent client', () => {
  test('a missing client is 404 with a sentence to speak', async () => {
    mockResponder = defaultWorld({ client: null });
    const res = await get();

    expect(res.status).toBe(404);
    expect(res.body.spoken).toMatch(/could not find that client/i);
  });

  test('a malformed id is rejected by validation, before any query', async () => {
    const res = await get('../../etc/passwd');
    expect([400, 404]).toContain(res.status);
    expect(detailQuery()).toBeUndefined();
  });
});

// ── E. Partial data — unknown is not zero ──────────────────────────────────
describe('E. missing sub-reads are unknown, never invented', () => {
  test('no session balance on file is omitted from the sentence, not spoken as 0', async () => {
    mockResponder = defaultWorld({ balance: [] });
    const res = await get();

    expect(res.body.sessions_remaining).toBeNull();
    expect(res.body.spoken).not.toMatch(/sessions left/i);
  });

  test('zero sessions left IS spoken — it is a real number', async () => {
    mockResponder = defaultWorld({ balance: [{ remaining_sessions: 0 }] });
    const res = await get();

    expect(res.body.sessions_remaining).toBe(0);
    expect(res.body.spoken).toMatch(/they have 0 sessions left/i);
  });

  test('no workout logged today says so, rather than inventing a plan', async () => {
    mockResponder = defaultWorld({ today: [] });
    const res = await get();

    expect(res.body.today.status).toBe('none');
    expect(res.body.spoken).toMatch(/nothing is logged for today/i);
  });

  test('a completed workout is spoken as done', async () => {
    mockResponder = defaultWorld({ today: [{ status: 'completed', program_name: 'Push Day' }] });
    const res = await get();
    expect(res.body.spoken).toMatch(/today's workout is done/i);
  });

  test('a failed sub-read is reported as unchecked, not as absent', async () => {
    // The API/network-failure case for a dependency: the answer still comes
    // back, and it does not claim a state it never saw.
    mockResponder = (sql) => {
      if (/SELECT 1 FROM pt_clients/i.test(sql)) return [{ ok: 1 }];
      if (/SELECT id, name, status, package_type/i.test(sql)) return [RAHUL];
      if (/FROM session_balance/i.test(sql)) throw new Error('db down');
      if (/FROM workout_sessions/i.test(sql)) throw new Error('db down');
      return [];
    };

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.sessions_remaining).toBeNull();
    expect(res.body.spoken).toMatch(/could not be checked/i);
  });

  test('an inactive client leads with their status', async () => {
    mockResponder = defaultWorld({ client: { ...RAHUL, status: 'frozen' } });
    const res = await get();

    expect(res.body.active).toBe(false);
    expect(res.body.spoken).toMatch(/their account is frozen/i);
  });

  test('an expired package is stated as expired', async () => {
    mockResponder = defaultWorld({ client: { ...RAHUL, pt_end_date: '2020-01-01' } });
    const res = await get();

    expect(res.body.expired).toBe(true);
    expect(res.body.spoken).toMatch(/their package expired on 1 January 2020/i);
  });
});

// ── F. What is never spoken or exposed ─────────────────────────────────────
describe('F. nothing private leaves the endpoint', () => {
  test('no contact details or amounts are selected from the database', async () => {
    await get();
    const { sql } = detailQuery();

    expect(sql).not.toMatch(/\bmobile\b/i);
    expect(sql).not.toMatch(/\bemail\b/i);
    expect(sql).not.toMatch(/\baddress\b/i);
    expect(sql).not.toMatch(/amount/i);
  });

  test('the response carries no internal ids beyond the client handle', async () => {
    const res = await get();
    // The pt_clients id is the handle the intent already holds from search.
    // No session_balance row id, no workout_sessions row id.
    expect(Object.keys(res.body).sort()).toEqual([
      'active', 'expired', 'expires_on', 'id', 'name', 'package_type',
      'sessions_remaining', 'spoken', 'status', 'today',
    ]);
    expect(Object.keys(res.body.today).sort()).toEqual(['program_name', 'status']);
  });

  test('the spoken sentence never contains an id', async () => {
    const res = await get();
    expect(res.body.spoken).not.toContain(CLIENT_ID);
  });

  test('the read is written to the audit trail against the client', async () => {
    await get();
    const audit = mockLog.find((q) => /INSERT INTO activity_log/i.test(q.sql));

    expect(audit).toBeTruthy();
    expect(audit.params).toContain('voice.clients.detail');
    expect(audit.params).toContain(CLIENT_ID);
  });
});

// Phase 6 — "Hey Siri, mark Rahul's workout as completed."
//
// A much smaller write than Phase 5's: it flips a status that already exists
// rather than creating anything, which is why it has no prepare/confirm step.
// Three properties carry it, and each fails silently:
//
//   1. IT DOES NOT INVENT A SESSION. A client with nothing logged has not
//      trained. Writing a completion for a workout that never happened
//      corrupts the record a trainer later relies on.
//   2. IT IS IDEMPOTENT. Siri repeats itself when it mishears. Completing
//      twice must write once, and must SAY something different the second
//      time — "done" when nothing changed teaches a trainer that the command
//      works when it may not have.
//   3. THE WRITE IS CONDITIONAL AND ORG-SCOPED. Both the read and the UPDATE
//      carry the org filter, so neither can be reached across a tenant
//      boundary.
//
// Asserted against what reached the pool: "it returned already_completed" is
// also what a handler that skipped the write for the wrong reason reports.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const CLIENT_ID = 'ptc-rahul';
const SESSION_ID = 'ws-today';

const mockLog = [];
let mockResponder;

jest.mock('../../db/pool', () => {
  const query = jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: flat, params });
    const rows = mockResponder(flat, params);
    return { rows, rowCount: rows.length };
  });
  return { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
});

jest.mock('../../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../lib/ai/router', () => ({
  routedChat: jest.fn(), routedStream: jest.fn(),
}));

let mockUser;
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
const { today: studioToday } = require('../../lib/appTime');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/voice', require('../../routes/voice'));
  a.use(errorHandler);
  return a;
}

const URL = '/api/voice/workouts/complete';
const complete = (body = { client_id: CLIENT_ID }) => request(app()).post(URL).send(body);

const q = (re) => mockLog.find((x) => re.test(x.sql));
const findQuery    = () => q(/^SELECT id, status, workout_assignment_id/i);
const updateQuery  = () => q(/^UPDATE workout_sessions SET status = 'completed'/i);
const progressRead = () => q(/FROM workout_assignments wa/i);
const progressWrite= () => q(/UPDATE workout_assignments SET progress_pct/i);

const ADMIN_A   = { id: 'u-a', name: 'Admin A', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B   = { id: 'u-b', name: 'Admin B', role: 'admin', organization_id: ORG_B, trainer_id: null };
const MANAGER_A = { id: 'u-mg', name: 'Manager A', role: 'manager', organization_id: ORG_A, trainer_id: null };
const TRAINER_A = { id: 'u-t', name: 'Trainer A', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a' };
const RECEPT_A  = { id: 'u-rc', name: 'Reception', role: 'reception', organization_id: ORG_A, trainer_id: null };
const MEMBER_A  = { id: 'u-m', name: 'Client', role: 'member', organization_id: ORG_A };
const ORPHAN    = { id: 'u-o', name: 'Orphan', role: 'admin', organization_id: null, trainer_id: null };

const SESSION = {
  id: SESSION_ID, status: 'in_progress',
  workout_assignment_id: 'wa-1', program_name: 'Push Day',
};

function world(o = {}) {
  const {
    owned = true, trainerOwns = true, session = SESSION,
    updated = [{ id: SESSION_ID, workout_assignment_id: 'wa-1' }],
    name = 'Rahul Sharma',
  } = o;

  return (sql) => {
    if (/^SELECT 1 FROM pt_clients WHERE id = \$1 AND trainer_id/i.test(sql)) return trainerOwns ? [{ '?column?': 1 }] : [];
    if (/^SELECT 1 FROM pt_clients/i.test(sql)) return owned ? [{ '?column?': 1 }] : [];
    if (/^SELECT name FROM pt_clients/i.test(sql)) return name ? [{ name }] : [];
    if (/^SELECT id, status, workout_assignment_id/i.test(sql)) return session ? [session] : [];
    if (/^UPDATE workout_sessions SET status = 'completed'/i.test(sql)) return updated;
    if (/FROM workout_assignments wa/i.test(sql)) return [{ sessions_per_week: 4, duration_weeks: 4, completed_count: 5 }];
    return [];
  };
}

beforeEach(() => {
  mockLog.length = 0;
  mockUser = ADMIN_A;
  mockResponder = world();
});

// ── A. The happy path ─────────────────────────────────────────────────────
describe('A. completing today\'s workout', () => {
  test('marks it completed and says so', async () => {
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.already_completed).toBe(false);
    expect(res.body.spoken).toBe("Done. Rahul's workout is marked completed.");
  });

  test('returns the session it changed', async () => {
    const res = await complete();
    expect(res.body.session_id).toBe(SESSION_ID);
    expect(res.body.client_name).toBe('Rahul Sharma');
    expect(res.body.date).toBe(studioToday());
  });

  test('defaults to the STUDIO\'s today, not UTC\'s', async () => {
    await complete();
    expect(findQuery().params[1]).toBe(studioToday());
  });

  test('an explicit date is honoured', async () => {
    await complete({ client_id: CLIENT_ID, date: '2026-08-01' });
    expect(findQuery().params[1]).toBe('2026-08-01');
  });

  test.each([['admin', ADMIN_A], ['manager', MANAGER_A], ['trainer', TRAINER_A]])(
    '%s may complete', async (_l, u) => {
      mockUser = u;
      expect((await complete()).status).toBe(200);
    });
});

// ── B. Authorization ──────────────────────────────────────────────────────
describe('B. authorization', () => {
  test('no session is 401', async () => {
    mockUser = null;
    expect((await complete()).status).toBe(401);
  });

  test('a gym member is refused', async () => {
    mockUser = MEMBER_A;
    const res = await complete();
    expect(res.status).toBe(403);
    expect(updateQuery()).toBeUndefined();
  });

  test('reception may read the voice surface but not complete a workout', async () => {
    mockUser = RECEPT_A;
    const res = await complete();
    expect(res.status).toBe(403);
    // The property that matters: nothing was written.
    expect(updateQuery()).toBeUndefined();
    expect(findQuery()).toBeUndefined();
  });

  test('a trainer cannot complete a colleague\'s client\'s workout', async () => {
    mockUser = TRAINER_A;
    mockResponder = world({ trainerOwns: false });
    const res = await complete();
    expect(res.status).toBe(404);
    expect(updateQuery()).toBeUndefined();
  });

  test('an admin is not narrowed by trainer', async () => {
    await complete();
    expect(q(/AND trainer_id = \$2/i)).toBeUndefined();
  });
});

// ── C. Cross-organization ─────────────────────────────────────────────────
describe('C. cross-organization access', () => {
  test('another studio\'s client is 404, NOT 403', async () => {
    mockResponder = world({ owned: false });
    mockUser = ADMIN_B;
    const res = await complete();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('a foreign client is refused before any session is read or written', async () => {
    mockResponder = world({ owned: false });
    await complete();
    expect(findQuery()).toBeUndefined();
    expect(updateQuery()).toBeUndefined();
  });

  test('the session lookup is org-filtered', async () => {
    await complete();
    expect(findQuery().sql).toMatch(/organization_id = \$\d/);
    expect(findQuery().params).toContain(ORG_A);
  });

  test('the UPDATE is org-filtered too, not just the lookup', async () => {
    await complete();
    expect(updateQuery().sql).toMatch(/organization_id = \$\d/);
    expect(updateQuery().params).toContain(ORG_A);
  });

  test('a caller in org B writes with org B\'s filter, never org A\'s', async () => {
    mockUser = ADMIN_B;
    await complete();
    expect(updateQuery().params).toContain(ORG_B);
    expect(updateQuery().params).not.toContain(ORG_A);
  });

  test('an org-less user filters on NULL, matching nothing', async () => {
    mockUser = ORPHAN;
    await complete();
    expect(updateQuery().params).toContain(null);
  });

  test('an x-org-id header from a tenant user is ignored', async () => {
    await request(app()).post(URL).set('x-org-id', ORG_B).send({ client_id: CLIENT_ID });
    expect(updateQuery().params).toContain(ORG_A);
    expect(updateQuery().params).not.toContain(ORG_B);
  });
});

// ── D. No session to complete ─────────────────────────────────────────────
describe('D. an invalid workout or session', () => {
  test('no session on that date is 404, and writes nothing', async () => {
    mockResponder = world({ session: null });
    const res = await complete();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_SESSION');
    expect(res.body.completed).toBe(false);
    expect(updateQuery()).toBeUndefined();
  });

  test('it says there was nothing to mark, rather than claiming success', async () => {
    mockResponder = world({ session: null });
    const res = await complete();
    expect(res.body.spoken).toMatch(/could not find a workout for Rahul/i);
    expect(res.body.spoken).not.toMatch(/^Done/);
  });

  test('a missing session never invents one', async () => {
    mockResponder = world({ session: null });
    await complete();
    expect(q(/INSERT INTO workout_sessions/i)).toBeUndefined();
  });

  test('a malformed client id is rejected before any query', async () => {
    const res = await complete({ client_id: 'ptc/../../etc' });
    expect(res.status).toBe(400);
    expect(mockLog).toHaveLength(0);
  });

  test('a malformed date is rejected', async () => {
    expect((await complete({ client_id: CLIENT_ID, date: 'yesterday' })).status).toBe(400);
  });

  test('unknown body fields are rejected, not ignored', async () => {
    const res = await complete({ client_id: CLIENT_ID, organization_id: ORG_B });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  test('a status cannot be smuggled in', async () => {
    expect((await complete({ client_id: CLIENT_ID, status: 'completed' })).status).toBe(400);
  });
});

// ── E. Duplicates ─────────────────────────────────────────────────────────
describe('E. duplicate completion', () => {
  test('an already-completed session writes nothing', async () => {
    mockResponder = world({ session: { ...SESSION, status: 'completed' } });
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.already_completed).toBe(true);
    expect(updateQuery()).toBeUndefined();
  });

  test('and says something DIFFERENT from a fresh completion', async () => {
    mockResponder = world({ session: { ...SESSION, status: 'completed' } });
    const res = await complete();
    expect(res.body.spoken).toBe("Rahul's workout was already marked completed.");
    expect(res.body.spoken).not.toMatch(/^Done/);
  });

  test('the UPDATE is guarded on the status it expects to find', async () => {
    await complete();
    expect(updateQuery().sql).toMatch(/AND status <> 'completed'/);
  });

  test('losing a race is reported as already-done, not as a failure', async () => {
    // The row was completed between our read and our write: the UPDATE
    // matches nothing.
    mockResponder = world({ updated: [] });
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.already_completed).toBe(true);
  });

  test('a lost race does not recompute progress a second time', async () => {
    mockResponder = world({ updated: [] });
    await complete();
    expect(progressWrite()).toBeUndefined();
  });
});

// ── F. Existing business logic ────────────────────────────────────────────
describe('F. it reuses the app\'s own completion logic', () => {
  test('assignment progress is recomputed, as the app does on PATCH', async () => {
    await complete();
    expect(progressRead()).toBeDefined();
    expect(progressWrite()).toBeDefined();
  });

  test('progress is recomputed AFTER the session is written', async () => {
    await complete();
    expect(mockLog.indexOf(updateQuery())).toBeLessThan(mockLog.indexOf(progressWrite()));
  });

  test('a session with no assignment completes without recomputing', async () => {
    mockResponder = world({ updated: [{ id: SESSION_ID, workout_assignment_id: null }] });
    const res = await complete();
    expect(res.status).toBe(200);
    expect(progressWrite()).toBeUndefined();
  });

  test('a progress failure does not fail the completion', async () => {
    mockResponder = (sql) => {
      if (/FROM workout_assignments wa/i.test(sql)) throw new Error('deadlock');
      return world()(sql);
    };
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
  });
});

// ── G. Audit ──────────────────────────────────────────────────────────────
describe('G. audit', () => {
  const auditActions = () => mockLog
    .filter((x) => /INSERT INTO activity_log/i.test(x.sql))
    .flatMap((x) => x.params.filter((p) => typeof p === 'string' && p.startsWith('voice.')));

  test('a completion is audited', async () => {
    await complete();
    expect(auditActions()).toContain('voice.workouts.complete');
  });

  test('a duplicate is audited distinctly', async () => {
    mockResponder = world({ session: { ...SESSION, status: 'completed' } });
    await complete();
    expect(auditActions()).toContain('voice.workouts.complete.duplicate');
    expect(auditActions()).not.toContain('voice.workouts.complete');
  });

  test('a missing session is audited too', async () => {
    mockResponder = world({ session: null });
    await complete();
    expect(auditActions()).toContain('voice.workouts.complete.missing');
  });

  test('the audit records the client, date and programme', async () => {
    await complete();
    const row = mockLog
      .filter((x) => /INSERT INTO activity_log/i.test(x.sql))
      .find((x) => x.params.includes('voice.workouts.complete'));
    const payload = row.params
      .filter((v) => typeof v === 'string' && v.startsWith('{'))
      .map((v) => JSON.parse(v))
      .find((o) => o.channel === 'voice');
    expect(payload).toMatchObject({
      client_id: CLIENT_ID, date: studioToday(), program_name: 'Push Day',
    });
  });
});

// ── H. Nothing private leaves ─────────────────────────────────────────────
describe('H. nothing private is returned', () => {
  test('no contact detail is selected', async () => {
    await complete();
    for (const x of mockLog) {
      expect(x.sql).not.toMatch(/\bmobile\b|\bemail\b|\baddress\b|balance_amount/i);
    }
  });

  test('only the first name is spoken', async () => {
    const res = await complete();
    expect(res.body.spoken).not.toContain('Sharma');
  });

  test('no identifier is spoken', async () => {
    const res = await complete();
    expect(res.body.spoken).not.toContain(SESSION_ID);
    expect(res.body.spoken).not.toContain(CLIENT_ID);
  });

  test('a client whose name has gone reads as English, not "They\'s"', async () => {
    mockResponder = world({ name: null });
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.spoken).toBe('Done. The workout is marked completed.');
  });

  test('the no-session sentence also survives a missing name', async () => {
    mockResponder = world({ name: null, session: null });
    const res = await complete();
    expect(res.body.spoken).toBe(
      'I could not find a workout on that day, so there was nothing to mark completed.'
    );
  });
});

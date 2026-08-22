// The voice surface answers from a LOCKED PHONE, out loud.
//
// That is what these tests are really about. Every other router in this app is
// reached through a UI that a human is looking at; this one is reached by
// saying a sentence near a device, and the answer is spoken to whoever is in
// the room. So the boundaries matter more, not less:
//
//   A. A client (role=member) must not be able to ask their phone how large
//      the studio's roster is. That is staff data, and `member` is the role
//      client activation hands to a gym client.
//   B. The count must be filtered to the caller's OWN organization, in SQL,
//      with the org id coming from the session and never from the request.
//   C. A tenant user with no organization must count NOTHING rather than
//      falling through to a platform-wide total.
//
// The SQL is asserted by inspecting what reached the pool, because "it
// returned the right number" is exactly what a broken filter also does when
// the mock only has one org's rows in it.

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

// No rate-limiter mock: the limiter is applied at the MOUNT in server.js, not
// inside this router, so nothing here imports it. The mount's posture is
// asserted separately in voice.mount.test.js.

let mockUser;
jest.mock('../../middleware/auth', () => ({
  auth: (req, res, next) => {
    // No token → 401 before anything else, the same shape the real middleware
    // produces. This is what an expired Keychain token looks like to the API.
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

const COUNT_URL = '/api/voice/dashboard/client-count';

/** The SELECT the handler ran — the audit INSERT is fire-and-forget noise. */
const countQuery = () => mockLog.find((q) => /FROM pt_clients/i.test(q.sql));
const dbTouched = () => mockLog.length;

const ADMIN_A   = { id: 'usr-admin-a', name: 'Admin A', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B   = { id: 'usr-admin-b', name: 'Admin B', role: 'admin', organization_id: ORG_B, trainer_id: null };
const TRAINER_A = { id: 'usr-trainer-a', name: 'Trainer A', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a' };
const MEMBER_A  = { id: 'usr-client-a', name: 'Client A', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-a' };
const ORPHAN    = { id: 'usr-orphan', name: 'Orphan', role: 'admin', organization_id: null, trainer_id: null };
const SUPER     = { id: 'usr-super', name: 'Platform', role: 'super_admin', organization_id: null, trainer_id: null };

beforeEach(() => {
  mockLog.length = 0;
  mockRows = [{ count: 7 }];
  mockUser = ADMIN_A;
});

// ── A. Who may ask at all ──────────────────────────────────────────────────
describe('A. the voice surface is staff-only', () => {
  test('a client (role=member) is refused, before any query runs', async () => {
    mockUser = MEMBER_A;
    const res = await request(app()).get(COUNT_URL);

    expect(res.status).toBe(403);
    // Refused at the gate, not after counting. A 403 that still ran the query
    // has already done the work it was supposed to refuse.
    expect(dbTouched()).toBe(0);
  });

  test('an unauthenticated request is refused', async () => {
    // What the intent sees when the Keychain token has expired or been revoked.
    mockUser = null;
    const res = await request(app()).get(COUNT_URL);

    expect(res.status).toBe(401);
    expect(dbTouched()).toBe(0);
  });

  test('a trainer may ask', async () => {
    mockUser = TRAINER_A;
    const res = await request(app()).get(COUNT_URL);
    expect(res.status).toBe(200);
  });
});

// ── B. Organization isolation ──────────────────────────────────────────────
describe('B. the count is bounded to the caller\'s own organization', () => {
  test('filters on the org id taken from the SESSION', async () => {
    mockUser = ADMIN_A;
    const res = await request(app()).get(COUNT_URL);

    expect(res.status).toBe(200);
    const q = countQuery();
    expect(q.sql).toMatch(/organization_id = \$1/);
    expect(q.params).toEqual([ORG_A]);
  });

  test('two studios asking the same question are filtered differently', async () => {
    // The whole point of the surface: same sentence, same endpoint, different
    // organizations, and nothing in the REQUEST distinguishes them.
    mockUser = ADMIN_A;
    await request(app()).get(COUNT_URL);
    const paramsA = countQuery().params;

    mockLog.length = 0;
    mockUser = ADMIN_B;
    await request(app()).get(COUNT_URL);
    const paramsB = countQuery().params;

    expect(paramsA).toEqual([ORG_A]);
    expect(paramsB).toEqual([ORG_B]);
  });

  test('a caller cannot widen the scope through the request', async () => {
    // x-org-id is the platform operator's targeting header. A tenant admin
    // sending it must be ignored — tenantScope only honours it for a
    // super_admin — or any studio could read any other studio by adding a
    // header to a request their own phone makes.
    mockUser = ADMIN_A;
    const res = await request(app())
      .get(COUNT_URL)
      .set('x-org-id', ORG_B)
      .query({ organization_id: ORG_B });

    expect(res.status).toBe(200);
    expect(countQuery().params).toEqual([ORG_A]);
  });

  test('a tenant user with no organization counts nothing, not everything', async () => {
    // Fail closed. `organization_id = NULL` matches no rows, which is the
    // correct answer; the dangerous failure is dropping the filter entirely.
    mockUser = ORPHAN;
    const res = await request(app()).get(COUNT_URL);

    expect(res.status).toBe(200);
    const q = countQuery();
    expect(q.sql).toMatch(/organization_id = \$1/);
    expect(q.params).toEqual([null]);
  });

  test('a platform super admin targeting one studio is filtered to it', async () => {
    mockUser = SUPER;
    await request(app()).get(COUNT_URL).set('x-org-id', ORG_B);

    expect(countQuery().params).toEqual([ORG_B]);
  });
});

// ── C. What it counts, and what it says ────────────────────────────────────
describe('C. the answer', () => {
  test('counts active, non-deleted clients only', async () => {
    await request(app()).get(COUNT_URL);
    const { sql } = countQuery();

    expect(sql).toMatch(/FROM pt_clients/i);
    expect(sql).toMatch(/deleted_at IS NULL/i);
    expect(sql).toMatch(/status = 'active'/i);
  });

  test('returns the count and a sentence to speak', async () => {
    mockRows = [{ count: 7 }];
    const res = await request(app()).get(COUNT_URL);

    expect(res.body.count).toBe(7);
    expect(res.body.scope).toBe('active');
    expect(res.body.spoken).toBe('You have 7 active clients.');
  });

  test('an empty roster is a real zero, spoken as one', async () => {
    // A studio with no clients yet must get a sentence, not a failure — this
    // is the empty-result path the intent has to read aloud.
    mockRows = [{ count: 0 }];
    const res = await request(app()).get(COUNT_URL);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.spoken).toBe('You have 0 active clients.');
  });

  test('one client is singular', async () => {
    mockRows = [{ count: 1 }];
    const res = await request(app()).get(COUNT_URL);
    expect(res.body.spoken).toBe('You have 1 active client.');
  });

  test('exposes no roster detail — a spoken answer cannot be redacted', async () => {
    const res = await request(app()).get(COUNT_URL);
    // Whoever is in the room hears this. It must be a number and nothing else:
    // no names, no ids, no list to read out.
    expect(Object.keys(res.body).sort()).toEqual(['count', 'scope', 'spoken']);
  });

  test('the request is written to the audit trail', async () => {
    // A voice request leaves no UI trace, so the audit row is the only record
    // that it happened at all.
    await request(app()).get(COUNT_URL);
    const audit = mockLog.find((q) => /INSERT INTO activity_log/i.test(q.sql));

    expect(audit).toBeTruthy();
    expect(audit.params).toContain('voice.dashboard.client_count');
  });
});

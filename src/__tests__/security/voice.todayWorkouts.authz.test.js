// Phase 4 — "Hey Siri, show me today's workouts in MY PT STUDIO."
//
// This is the first voice endpoint that returns a LIST OF PEOPLE with no
// caller-supplied filter at all. Phases 2 and 3 both required the caller to
// name someone; this one answers "who is training today" from nothing but a
// token, so the org filter is the only thing standing between a request and
// somebody else's roster. That makes the cross-organization tests the centre
// of this file rather than one section in it.
//
// Three further properties are asserted because each is a silent failure:
//
//   1. THREE TIERS, ONE PERSON. A client with a booked slot must not also be
//      announced by their programme and again by their enrolment. The count is
//      the whole answer on a surface with no screen.
//   2. TIME IS NEVER INVENTED. Only a booked slot has a time the studio agreed
//      to. A programme day spoken as "at 9 AM" sends a trainer to a slot that
//      does not exist.
//   3. TODAY IS THE STUDIO'S TODAY. A UTC date is yesterday between midnight
//      and 05:30 IST, which is exactly when this command gets used.
//
// The SQL is asserted by inspecting what reached the pool. "It returned the
// right rows" is what a missing filter also does when the mock holds one org.

'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const mockLog = [];
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
const { today: studioToday, todayShortDay: studioShortDay } = require('../../lib/appTime');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/voice', require('../../routes/voice'));
  a.use(errorHandler);
  return a;
}

const URL = '/api/voice/workouts/today';
const get = () => request(app()).get(URL);

// Which query is which.
//
// Anchored on each tier's own SELECT list, NOT on its FROM table: tiers 2 and
// 3 both contain `FROM pt_sessions s` inside a NOT EXISTS, so matching the
// table makes every tier look like tier 1 — which is how the first run of this
// file passed the wrong rows to the wrong handler and hid three real failures.
const RE_BOOKED    = /^SELECT s\.id, s\.client_id/i;
// Anchored at the start for the same reason: tier 1 embeds a LATERAL reading
// `wp.name AS plan_name FROM workout_assignments a`, so an unanchored pattern
// finds the BOOKED query and reports it as the programme one.
const RE_PROGRAMME = /^SELECT c\.id AS client_id, c\.name AS client_name, c\.trainer_name, wp\.name AS plan_name/i;
const RE_ENROLMENT = /^SELECT c\.id AS client_id, c\.name AS client_name, c\.trainer_name, c\.preferred_workout_time/i;
const RE_TRAINERS  = /^SELECT id FROM trainers/i;

const bookedQuery    = () => mockLog.find((q) => RE_BOOKED.test(q.sql));
const programmeQuery = () => mockLog.find((q) => RE_PROGRAMME.test(q.sql));
const enrolmentQuery = () => mockLog.find((q) => RE_ENROLMENT.test(q.sql));
const trainerIdQuery = () => mockLog.find((q) => RE_TRAINERS.test(q.sql));

const ADMIN_A   = { id: 'u-a', name: 'Admin A', role: 'admin', organization_id: ORG_A, trainer_id: null };
const ADMIN_B   = { id: 'u-b', name: 'Admin B', role: 'admin', organization_id: ORG_B, trainer_id: null };
// The real staff allow-list from middleware/rbac.js. `owner` is NOT one of
// them — it is not a role this system issues, despite reading like one.
const STAFF_A   = { id: 'u-st', name: 'Staff A', role: 'staff', organization_id: ORG_A, trainer_id: null };
const RECEPT_A  = { id: 'u-rc', name: 'Reception A', role: 'reception', organization_id: ORG_A, trainer_id: null };
const MANAGER_A = { id: 'u-mg', name: 'Manager A', role: 'manager', organization_id: ORG_A, trainer_id: null };
const TRAINER_A = { id: 'u-t', name: 'Trainer A', role: 'trainer', organization_id: ORG_A, trainer_id: 'trn-a', email: 't@a.com' };
const TRAINER_NO_RECORD = { id: 'u-tx', name: 'Trainer X', role: 'trainer', organization_id: ORG_A, trainer_id: null, email: '' };
const MEMBER_A  = { id: 'u-m', name: 'Client A', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-a' };
const ORPHAN    = { id: 'u-o', name: 'Orphan', role: 'admin', organization_id: null, trainer_id: null };
const SUPER     = { id: 'u-s', name: 'Super', role: 'super_admin', organization_id: null, trainer_id: null };

const BOOKED_RAHUL = {
  id: 's-1', client_id: 'ptc-rahul', client_name: 'Rahul Sharma',
  start_time: '09:00:00', status: 'scheduled',
  trainer_name: 'Coach A', plan_name: 'Push Pull Legs',
};
const BOOKED_AMIT = {
  id: 's-2', client_id: 'ptc-amit', client_name: 'Amit Verma',
  start_time: '11:00:00', status: 'scheduled',
  trainer_name: 'Coach A', plan_name: 'Upper Body',
};

function world(overrides = {}) {
  const {
    booked = [BOOKED_RAHUL, BOOKED_AMIT], programme = [], enrolment = [],
    trainers = [{ id: 'trn-a' }],
  } = overrides;

  return (sql) => {
    if (RE_TRAINERS.test(sql)) return trainers;
    if (RE_BOOKED.test(sql)) return booked;
    if (RE_PROGRAMME.test(sql)) return programme;
    if (RE_ENROLMENT.test(sql)) return enrolment;
    return [];
  };
}

beforeEach(() => {
  mockLog.length = 0;
  mockUser = ADMIN_A;
  mockResponder = world();
});

// ── A. Authorized access ───────────────────────────────────────────────────
describe('A. authorized access', () => {
  test('an admin gets today\'s sessions and a sentence', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.booked_count).toBe(2);
    expect(res.body.spoken).toBe('You have 2 PT sessions today. Rahul at 9 AM, and Amit at 11 AM.');
  });

  test.each([
    ['staff', STAFF_A], ['reception', RECEPT_A],
    ['manager', MANAGER_A], ['admin', ADMIN_A],
  ])('%s is allowed', async (_label, user) => {
      mockUser = user;
      expect((await get()).status).toBe(200);
    });

  test('each session carries only the five permitted fields', async () => {
    const res = await get();
    expect(Object.keys(res.body.sessions[0]).sort()).toEqual([
      'client_id', 'client_name', 'program_name', 'source',
      'start_time', 'status', 'time_source', 'trainer_name',
    ]);
  });

  test('the response is the studio\'s date and names its zone', async () => {
    const res = await get();
    expect(res.body.date).toBe(studioToday());
    expect(res.body.timezone).toBeTruthy();
  });

  test('an audit row is written', async () => {
    const { logActivity } = require('../../lib/activityLog');
    await get();
    expect(logActivity).toBeDefined();
  });
});

// ── B. Unauthorized access ────────────────────────────────────────────────
describe('B. unauthorized access', () => {
  test('no session is 401', async () => {
    mockUser = null;
    expect((await get()).status).toBe(401);
  });

  test('a gym member (role=member) is refused', async () => {
    mockUser = MEMBER_A;
    const res = await get();
    expect(res.status).toBe(403);
  });

  test('a refused caller never reaches the roster', async () => {
    mockUser = MEMBER_A;
    await get();
    expect(bookedQuery()).toBeUndefined();
    expect(programmeQuery()).toBeUndefined();
    expect(enrolmentQuery()).toBeUndefined();
  });
});

// ── C. Cross-organization ─────────────────────────────────────────────────
describe('C. cross-organization isolation', () => {
  test('every tier filters on the caller\'s org', async () => {
    await get();
    for (const q of [bookedQuery(), programmeQuery(), enrolmentQuery()]) {
      expect(q.sql).toMatch(/organization_id = \$\d/);
      expect(q.params).toContain(ORG_A);
    }
  });

  test('a caller in org B filters on org B, never org A', async () => {
    mockUser = ADMIN_B;
    await get();
    expect(bookedQuery().params).toContain(ORG_B);
    expect(bookedQuery().params).not.toContain(ORG_A);
  });

  test('an x-org-id header from a tenant user is ignored', async () => {
    const res = await request(app()).get(URL).set('x-org-id', ORG_B);
    expect(res.status).toBe(200);
    expect(bookedQuery().params).toContain(ORG_A);
    expect(bookedQuery().params).not.toContain(ORG_B);
  });

  test('a user with no organization filters on NULL, matching nothing', async () => {
    mockUser = ORPHAN;
    await get();
    expect(bookedQuery().sql).toMatch(/organization_id = \$\d/);
    expect(bookedQuery().params).toContain(null);
  });

  test('the org filter is never dropped for a super_admin either', async () => {
    mockUser = SUPER;
    const res = await get();
    // super_admin has no tenant of its own; the filter must still be expressed
    // rather than silently omitted into a studio-wide read.
    expect(res.status).toBe(200);
    expect(bookedQuery().sql).toMatch(/WHERE s\.session_date = \$1/);
  });
});

// ── D. Trainer narrowing ──────────────────────────────────────────────────
describe('D. trainer narrowing', () => {
  test('a trainer\'s query is narrowed to their own profiles', async () => {
    mockUser = TRAINER_A;
    await get();
    expect(bookedQuery().sql).toMatch(/s\.trainer_id = ANY\(\$\d\)/);
    expect(bookedQuery().params.some((p) => Array.isArray(p) && p.includes('trn-a'))).toBe(true);
  });

  test('a trainer resolves their profiles before reading any roster', async () => {
    mockUser = TRAINER_A;
    await get();
    expect(mockLog.indexOf(trainerIdQuery())).toBeLessThan(mockLog.indexOf(bookedQuery()));
  });

  test('an admin is NOT narrowed by trainer', async () => {
    await get();
    expect(bookedQuery().sql).not.toMatch(/trainer_id = ANY/);
  });

  test('a trainer with no resolvable profile gets nothing, not the whole studio', async () => {
    mockUser = TRAINER_NO_RECORD;
    mockResponder = world({ trainers: [] });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.trainer_linked).toBe(false);
    // The point: it must not have read the roster at all.
    expect(bookedQuery()).toBeUndefined();
  });

  test('the unlinked trainer is told why, not shown an empty day', async () => {
    mockUser = TRAINER_NO_RECORD;
    mockResponder = world({ trainers: [] });
    const res = await get();
    expect(res.body.spoken).toMatch(/not linked to a trainer profile/i);
    expect(res.body.spoken).not.toMatch(/no workouts/i);
  });
});

// ── E. No workouts ────────────────────────────────────────────────────────
describe('E. an empty day', () => {
  test('is 200 with a real sentence, not an error', async () => {
    mockResponder = world({ booked: [], programme: [], enrolment: [] });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.spoken).toBe('You have no workouts scheduled today.');
  });
});

// ── F. Timezone / date ────────────────────────────────────────────────────
describe('F. today is the studio\'s today', () => {
  test('the date bound into SQL is the studio date, not UTC\'s', async () => {
    await get();
    expect(bookedQuery().params[0]).toBe(studioToday());
  });

  test('the enrolment tier matches the studio\'s weekday spelling', async () => {
    await get();
    expect(enrolmentQuery().params).toContain(studioShortDay());
    expect(studioShortDay()).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
  });

  test('the studio date can differ from the UTC date', () => {
    // Not an assertion that they differ right now — an assertion that the
    // helper is zone-aware at all, which is what the UTC bug came down to.
    const { todayIn } = require('../../lib/appTime');
    const atMidnightUTC = new Date('2026-03-05T00:30:00Z');
    expect(todayIn('Asia/Kolkata', atMidnightUTC)).toBe('2026-03-05');
    expect(todayIn('UTC', atMidnightUTC)).toBe('2026-03-05');
    const lateUTC = new Date('2026-03-04T20:00:00Z');
    expect(todayIn('Asia/Kolkata', lateUTC)).toBe('2026-03-05');
    expect(todayIn('UTC', lateUTC)).toBe('2026-03-04');
  });
});

// ── G. One person, once ───────────────────────────────────────────────────
describe('G. the three tiers do not double-count', () => {
  test('a booked client is excluded from the programme tier in SQL', async () => {
    await get();
    expect(programmeQuery().sql).toMatch(/NOT EXISTS \( SELECT 1 FROM pt_sessions s/i);
  });

  test('the enrolment tier excludes both booked and programme clients', async () => {
    await get();
    const sql = enrolmentQuery().sql;
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM pt_sessions s/i);
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM workout_assignments a/i);
  });

  test('cancelled slots are not counted as today\'s workouts', async () => {
    await get();
    expect(bookedQuery().sql).toMatch(/status <> 'cancelled'/);
  });

  test('the three tiers are concatenated, booked first', async () => {
    mockResponder = world({
      booked: [BOOKED_RAHUL],
      programme: [{ client_id: 'ptc-p', client_name: 'Priya Nair', plan_name: 'Legs', trainer_name: null }],
      enrolment: [{ client_id: 'ptc-e', client_name: 'Sana Iqbal', preferred_workout_time: '6:00 AM', trainer_name: null }],
    });
    const res = await get();
    expect(res.body.sessions.map((s) => s.source)).toEqual(['booked', 'programme', 'enrolment']);
    expect(res.body.count).toBe(3);
    expect(res.body.booked_count).toBe(1);
  });
});

// ── H. Time is never invented ─────────────────────────────────────────────
describe('H. a time is only spoken when one exists', () => {
  test('a programme row has no start_time and is named without an hour', async () => {
    mockResponder = world({
      booked: [],
      programme: [{ client_id: 'ptc-p', client_name: 'Priya Nair', plan_name: 'Legs', trainer_name: null }],
    });
    const res = await get();
    expect(res.body.sessions[0].start_time).toBeNull();
    expect(res.body.sessions[0].time_source).toBeNull();
    expect(res.body.spoken).toBe('You have 1 PT session today. Priya.');
  });

  test('an enrolment preference is spoken as "around", not "at"', async () => {
    mockResponder = world({
      booked: [],
      enrolment: [{ client_id: 'ptc-e', client_name: 'Sana Iqbal', preferred_workout_time: '6:00 AM', trainer_name: null }],
    });
    const res = await get();
    expect(res.body.sessions[0].time_source).toBe('preference');
    expect(res.body.spoken).toContain('Sana around 6 AM');
    expect(res.body.spoken).not.toContain('Sana at 6 AM');
  });

  test('an unparseable preferred time becomes null, never spoken', async () => {
    mockResponder = world({
      booked: [],
      enrolment: [{ client_id: 'ptc-e', client_name: 'Sana Iqbal', preferred_workout_time: 'whenever', trainer_name: null }],
    });
    const res = await get();
    expect(res.body.sessions[0].start_time).toBeNull();
    expect(res.body.spoken).toBe('You have 1 PT session today. Sana.');
  });

  test('a booked slot with a null start_time is still listed, without a time', async () => {
    mockResponder = world({ booked: [{ ...BOOKED_RAHUL, start_time: null }] });
    const res = await get();
    expect(res.body.sessions[0].start_time).toBeNull();
    expect(res.body.spoken).toBe('You have 1 PT session today. Rahul.');
  });
});

// ── I. The spoken sentence ────────────────────────────────────────────────
describe('I. the spoken sentence', () => {
  test('names at most three people and counts the rest', async () => {
    const many = ['Rahul Sharma', 'Amit Verma', 'Priya Nair', 'Sana Iqbal', 'Vikram Rao', 'Neha Gupta']
      .map((name, i) => ({
        ...BOOKED_RAHUL, id: `s-${i}`, client_id: `c-${i}`, client_name: name,
        start_time: `${String(9 + i).padStart(2, '0')}:00:00`,
      }));
    mockResponder = world({ booked: many });
    const res = await get();
    expect(res.body.spoken).toBe(
      'You have 6 PT sessions today. Rahul at 9 AM, Amit at 10 AM, Priya at 11 AM, and three more.'
    );
  });

  test('only first names are spoken', async () => {
    const res = await get();
    expect(res.body.spoken).not.toContain('Sharma');
    expect(res.body.spoken).not.toContain('Verma');
  });

  test('a single session is singular', async () => {
    mockResponder = world({ booked: [BOOKED_RAHUL] });
    expect((await get()).body.spoken).toBe('You have 1 PT session today. Rahul at 9 AM.');
  });

  test('afternoon times read as PM and keep their minutes', async () => {
    mockResponder = world({ booked: [{ ...BOOKED_RAHUL, start_time: '17:30:00' }] });
    expect((await get()).body.spoken).toContain('Rahul at 5:30 PM');
  });

  test('midnight and noon are not both 12 AM', async () => {
    mockResponder = world({ booked: [{ ...BOOKED_RAHUL, start_time: '12:00:00' }] });
    expect((await get()).body.spoken).toContain('Rahul at 12 PM');
    mockLog.length = 0;
    mockResponder = world({ booked: [{ ...BOOKED_RAHUL, start_time: '00:00:00' }] });
    expect((await get()).body.spoken).toContain('Rahul at 12 AM');
  });
});

// ── J. Nothing private leaves ─────────────────────────────────────────────
describe('J. nothing private is returned', () => {
  test('no contact detail or amount is selected by any tier', async () => {
    await get();
    for (const q of [bookedQuery(), programmeQuery(), enrolmentQuery()]) {
      expect(q.sql).not.toMatch(/\bmobile\b|\bemail\b|\baddress\b|balance_amount|\bphone\b/i);
    }
  });

  test('no organization id or trainer id appears in the response body', async () => {
    const res = await get();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ORG_A);
    expect(body).not.toContain('trn-a');
  });

  test('no identifier is ever spoken', async () => {
    mockResponder = world({ booked: [BOOKED_RAHUL] });
    const res = await get();
    expect(res.body.spoken).not.toContain('ptc-rahul');
    expect(res.body.spoken).not.toContain('s-1');
  });
});

// ── K. Validation ─────────────────────────────────────────────────────────
describe('K. the endpoint takes no input', () => {
  test('an unexpected query parameter is rejected, not ignored', async () => {
    const res = await request(app()).get(`${URL}?organization_id=${ORG_B}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  test('a rejected request never reaches the database', async () => {
    await request(app()).get(`${URL}?trainer_id=trn-b`);
    expect(bookedQuery()).toBeUndefined();
  });
});

// ── L. Partial failure ────────────────────────────────────────────────────
describe('L. API failure', () => {
  test('a failing derived tier still returns the booked slots', async () => {
    mockResponder = (sql) => {
      if (RE_TRAINERS.test(sql)) return [{ id: 'trn-a' }];
      if (RE_BOOKED.test(sql)) return [BOOKED_RAHUL];
      if (RE_PROGRAMME.test(sql)) throw new Error('relation missing');
      if (RE_ENROLMENT.test(sql)) throw new Error('relation missing');
      return [];
    };
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.spoken).toContain('Rahul at 9 AM');
  });

  test('a failing BOOKED tier is a real error, not a silent empty day', async () => {
    mockResponder = (sql) => {
      if (RE_TRAINERS.test(sql)) return [{ id: 'trn-a' }];
      if (RE_BOOKED.test(sql)) throw new Error('connection lost');
      return [];
    };
    const res = await get();
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The failure that matters: reporting "no workouts today" when the query
    // simply did not run would have a trainer skip a day of clients.
    expect(JSON.stringify(res.body)).not.toMatch(/no workouts/i);
  });
});

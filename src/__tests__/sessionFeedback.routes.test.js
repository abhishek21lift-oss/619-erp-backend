'use strict';

// The member owns the submission; the studio owns the reading.
//
// The member routes never take a client id. The studio routes take filters but
// every query carries the caller's organization. The tests attack both
// boundaries and assert the SQL, not just the status code.

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CLIENT_A = '33333333-3333-4333-8333-333333333333';
const OTHER_CLIENT = '44444444-4444-4444-8444-444444444444';
const FEEDBACK = '55555555-5555-4555-8555-555555555555';

const mockQueries = [];
let mockRespond = () => ({ rows: [], rowCount: 0 });

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return mockRespond(mockQueries[mockQueries.length - 1]);
  }),
  connect: jest.fn(),
  withTenantSession: jest.fn(async (fn) => fn(null)),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));

const express = require('express');
const request = require('supertest');
const memberRoutes = require('../modules/session-feedback/feedback.routes').member;
const trainerRoutes = require('../modules/session-feedback/feedback.routes').trainer;

const VALID = {
  trainer_behaviour: 'excellent',
  form_technique: 'always',
  workout_intensity: 'perfect',
  motivation_guidance: 'absolutely',
  overall_stars: 5,
  additional_feedback: 'Great session',
};

function app(router, user) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = user; next(); });
  a.use('/api', router);
  a.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}

const member = (user = { id: 'u-member', role: 'member', organization_id: ORG_A, pt_client_id: CLIENT_A }) =>
  app(memberRoutes, user);
const trainer = (user = { id: 'u-trainer', role: 'trainer', organization_id: ORG_A }) =>
  app(trainerRoutes, user);

const allSql = () => mockQueries.map((q) => q.sql).join(' || ');
const allParams = () => mockQueries.flatMap((q) => q.params);

beforeEach(() => {
  mockQueries.length = 0;
  mockRespond = () => ({ rows: [], rowCount: 0 });
});

describe('member feedback routes', () => {
  it('lists only the signed-in client, even when the query names another', async () => {
    mockRespond = () => ({ rows: [{ id: FEEDBACK, status: 'pending' }], rowCount: 1 });
    const res = await request(member())
      .get(`/api/feedback?status=pending&client_id=${OTHER_CLIENT}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(allSql()).toMatch(/f\.client_id = \$\d/);
    expect(allParams()).toContain(CLIENT_A);
    expect(allParams()).not.toContain(OTHER_CLIENT);
  });

  it('reads a request through whichever session source owns it', async () => {
    mockRespond = () => ({ rows: [], rowCount: 0 });
    await request(member()).get('/api/feedback');

    const list = mockQueries[0];
    expect(list.sql).toMatch(/LEFT JOIN pt_sessions s/);
    expect(list.sql).toMatch(/LEFT JOIN workout_sessions ws/);
    expect(list.sql).toMatch(/COALESCE\(s\.title, ws\.program_name\) AS session_title/);
    expect(list.sql).toMatch(/COALESCE\(s\.session_date, ws\.session_date\) AS session_date/);
  });

  it('submits once and stores the weighted score', async () => {
    mockRespond = (q) => {
      if (/^UPDATE pt_session_feedback/i.test(q.sql)) {
        return { rows: [{ id: FEEDBACK, status: 'submitted', score: '5.00' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const res = await request(member()).post(`/api/feedback/${FEEDBACK}`).send(VALID);

    expect(res.status).toBe(200);
    expect(res.body.data.score).toBe('5.00');
    const update = mockQueries.find((q) => /^UPDATE pt_session_feedback/i.test(q.sql));
    expect(update.sql).toMatch(/client_id = \$2/);
    expect(update.sql).toMatch(/organization_id = \$3/);
    expect(update.sql).toMatch(/status = 'pending'/);
    expect(update.sql).toMatch(/COALESCE\(f\.session_id, f\.workout_session_id\) AS session_id/);
    expect(update.params).toContain(CLIENT_A);
    expect(update.params).toContain(ORG_A);
  });

  it('refuses a second submission with 409, not a silent overwrite', async () => {
    mockRespond = (q) => {
      if (/^UPDATE pt_session_feedback/i.test(q.sql)) return { rows: [], rowCount: 0 };
      if (/^SELECT status FROM pt_session_feedback/i.test(q.sql)) return { rows: [{ status: 'submitted' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const res = await request(member()).post(`/api/feedback/${FEEDBACK}`).send(VALID);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBMITTED');
  });

  it('hides another client\'s request behind a 404', async () => {
    mockRespond = () => ({ rows: [], rowCount: 0 });
    const res = await request(member()).post(`/api/feedback/${FEEDBACK}`).send(VALID);
    expect(res.status).toBe(404);
    expect(mockQueries.some((q) => /^UPDATE pt_session_feedback/i.test(q.sql))).toBe(true);
  });

  it.each([
    ['an option the UI does not offer', { trainer_behaviour: 'great' }],
    ['zero stars', { overall_stars: 0 }],
    ['six stars', { overall_stars: 6 }],
    ['a fractional star', { overall_stars: 3.5 }],
    ['a missing answer', { motivation_guidance: undefined }],
    ['over-long text', { additional_feedback: 'x'.repeat(2001) }],
  ])('%s is a 400 and nothing is written', async (_label, patch) => {
    const res = await request(member()).post(`/api/feedback/${FEEDBACK}`).send({ ...VALID, ...patch });
    expect(res.status).toBe(400);
    expect(mockQueries).toHaveLength(0);
  });

  it('alerts the studio exactly once when the session scores 3 or below', async () => {
    mockRespond = (q) => {
      if (/^UPDATE pt_session_feedback/i.test(q.sql)) {
        return { rows: [{ id: FEEDBACK, status: 'submitted', score: '2.50' }], rowCount: 1 };
      }
      if (/INSERT INTO notifications/i.test(q.sql)) return { rows: [{ id: 'n1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const res = await request(member()).post(`/api/feedback/${FEEDBACK}`).send({
      ...VALID, trainer_behaviour: 'poor', overall_stars: 2,
    });

    expect(res.status).toBe(200);
    const alert = mockQueries.find((q) => /session_feedback_low/i.test(q.sql));
    expect(alert).toBeTruthy();
    expect(alert.sql).toMatch(/NOT EXISTS/);
    expect(alert.sql).toMatch(/role = 'trainer'/);
    expect(alert.params).toContain(ORG_A);
  });
});

describe('studio feedback routes', () => {
  it('lists feedback inside the caller\'s organization only', async () => {
    mockRespond = (q) => (/COUNT\(\*\)/i.test(q.sql)
      ? { rows: [{ total: '1' }], rowCount: 1 }
      : { rows: [{ id: FEEDBACK, score: '4.50' }], rowCount: 1 });
    const res = await request(trainer()).get('/api/feedback?from=2026-11-01&to=2026-11-30&min_score=4');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(allSql()).toMatch(/f\.organization_id = \$1/);
    expect(allSql()).toMatch(/f\.completed_at >=/);
    expect(allSql()).toMatch(/f\.score >=/);
    expect(allParams()).toContain(ORG_A);
    expect(allParams()).not.toContain(ORG_B);
  });

  it('filters by trainer, client and flagged low ratings', async () => {
    mockRespond = () => ({ rows: [], rowCount: 0 });
    await request(trainer()).get('/api/feedback?trainer_id=t1&client_id=c1&flagged=1');
    expect(allSql()).toMatch(/f\.trainer_id = \$\d/);
    expect(allSql()).toMatch(/f\.client_id = \$\d/);
    expect(allSql()).toMatch(/f\.score <= 3/);
  });

  it('summarises submitted rows only and fills every star bucket', async () => {
    mockRespond = (q) => {
      if (/COUNT\(\*\) FILTER/i.test(q.sql)) {
        return {
          rows: [{ rated_count: 2, average_score: 4.25, five_star_count: 1, low_rating_count: 1 }],
          rowCount: 1,
        };
      }
      if (/ROUND\(score\)/i.test(q.sql)) {
        return { rows: [{ stars: 5, count: 1 }, { stars: 2, count: 1 }], rowCount: 1 };
      }
      if (/date_trunc\('month', submitted_at\)/i.test(q.sql)) {
        return { rows: [{ month: '2026-11', average: 4.25, count: 2 }], rowCount: 1 };
      }
      return { rows: [{ pending: 3 }], rowCount: 1 };
    };
    const res = await request(trainer()).get('/api/feedback/summary');

    expect(res.status).toBe(200);
    expect(res.body.data.average_score).toBe(4.25);
    expect(res.body.data.rated_count).toBe(2);
    expect(res.body.data.five_star_count).toBe(1);
    expect(res.body.data.pending_count).toBe(3);
    expect(res.body.data.distribution).toEqual([
      { stars: 1, count: 0 }, { stars: 2, count: 1 }, { stars: 3, count: 0 },
      { stars: 4, count: 0 }, { stars: 5, count: 1 },
    ]);
    expect(allSql()).toMatch(/f\.status = 'submitted'/);
    expect(allSql()).toMatch(/f\.status = 'pending'/);
  });

  it('a trainer cannot submit feedback', async () => {
    const res = await request(trainer()).post(`/api/feedback/${FEEDBACK}`).send(VALID);
    expect(res.status).toBe(404);
  });

  it('scopes one feedback row to the caller\'s organization', async () => {
    mockRespond = () => ({ rows: [], rowCount: 0 });
    const res = await request(trainer()).get(`/api/feedback/${FEEDBACK}`);
    expect(res.status).toBe(404);
    expect(allSql()).toMatch(/f\.organization_id = \$1/);
  });
});

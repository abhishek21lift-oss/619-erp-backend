'use strict';
// The member's own PT session packages: session identity only, active rows only.
const CLIENT = 'cl-self';
const ORG = '11111111-1111-4111-8111-111111111111';
const mockQueries = [];
let mockResponder = () => ({ rows: [], rowCount: 0 });

// The hoisted factory may only close over `mock*` names.
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return mockResponder();
  }),
}));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { id: 'usr-m', role: 'member', pt_client_id: CLIENT, organization_id: ORG };
    next();
  });
  a.use('/api/me', require('../modules/client-portal/client-portal.routes'));
  return a;
}

beforeEach(() => { mockQueries.length = 0; mockResponder = () => ({ rows: [], rowCount: 0 }); });

describe('GET /api/me/session-balance', () => {
  it('reads only the session client, in the session studio, active packages only', async () => {
    mockResponder = () => ({
      rows: [{
        package_name: 'PT 12', total_sessions: 12, used_sessions: 4, remaining_sessions: 8,
        start_date: '2026-10-01', end_date: '2026-12-31', status: 'active',
      }],
      rowCount: 1,
    });
    const res = await request(app())
      .get('/api/me/session-balance?client_id=someone-else&organization_id=other')
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].remaining_sessions).toBe(8);
    expect(res.body.data[0].end_date).toBe('2026-12-31');

    expect(mockQueries).toHaveLength(1);
    const q = mockQueries[0];
    expect(q.params[0]).toBe(CLIENT);
    expect(q.params[1]).toBe(ORG);
    expect(q.params).not.toContain('someone-else');
    // Asserted on the SQL, not only the params: dropping a predicate while the
    // parameter list stays the same would otherwise pass this test.
    expect(q.sql).toMatch(/client_id = \$1/);
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.sql).toMatch(/status = 'active'/);
    expect(q.sql).toMatch(/end_date::text/);
  });

  it('answers an empty list when the studio does not track packages', async () => {
    const res = await request(app()).get('/api/me/session-balance').expect(200);
    expect(res.body.data).toEqual([]);
  });
});

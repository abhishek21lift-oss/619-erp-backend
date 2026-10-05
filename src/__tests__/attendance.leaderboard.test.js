'use strict';
// GET /api/attendance/leaderboard — server-side rank aggregation.
//
// The legacy list branch caps at 500 rows, which silently corrupted ranks for
// any studio with more check-ins than that in the window (oldest days
// vanished, no total returned, UI couldn't warn). This endpoint counts per
// member in SQL: one request, exact ranks, roster-bounded rows.

let mockLog;
let mockRows;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: mockRows, rowCount: mockRows.length };
  }),
  connect: jest.fn(),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

const ORG_A = '0a000000-0000-4000-8000-000000000001';
const TRAINER_A = { id: 'usr-trainer-a', role: 'trainer', organization_id: ORG_A };
const MEMBER_A = { id: 'usr-client-a', role: 'member', organization_id: ORG_A, pt_client_id: 'ptc-a' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/attendance', require('../routes/attendance'));
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  mockLog = [];
  mockRows = [];
  mockUser = TRAINER_A;
});

describe('GET /api/attendance/leaderboard', () => {
  test('returns per-member counts ordered by checkins then name', async () => {
    mockRows = [
      { ref_id: 'c1', ref_name: 'Zed', checkins: 20 },
      { ref_id: 'c2', ref_name: 'Amy', checkins: 20 },
      { ref_id: 'c3', ref_name: 'Bo', checkins: 5 },
    ];
    const res = await request(app())
      .get('/api/attendance/leaderboard')
      .query({ from: '2026-09-01', to: '2026-09-30', type: 'client' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockRows);
    const { sql, params } = mockLog[0];
    expect(sql).toMatch(/GROUP BY a\.ref_id/);
    expect(sql).toMatch(/a\.organization_id = \$1/);
    expect(params).toEqual([ORG_A, 'client', '2026-09-01', '2026-09-30']);
    // Roster-bounded, not window-truncated: no 500-row cap on this path.
    expect(sql).not.toMatch(/LIMIT \$|LIMIT 500[^0]/);
  });

  test('a member is refused before any query runs', async () => {
    mockUser = MEMBER_A;
    const res = await request(app()).get('/api/attendance/leaderboard');
    expect(res.status).toBe(403);
    expect(mockLog).toHaveLength(0);
  });
});

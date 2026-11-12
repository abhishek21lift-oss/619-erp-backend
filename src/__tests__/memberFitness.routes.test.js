'use strict';
// The member's read-only fitness-testing route.
//
// Two things matter here and both are authorization: the client id and the
// organization come from the session, never from the query, and the path is
// GET-only. The arithmetic and SQL live in the service/repository beside it.

const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = global.__mockUser; next(); },
  requireClient: (_req, _res, next) => next(),
}));

const mockDashboard = jest.fn();
jest.mock('../modules/progress/member-fitness.service', () => ({
  dashboard: (...args) => mockDashboard(...args),
}));
jest.mock('../modules/progress/retests.service', () => ({
  overview: jest.fn(),
  comparisonFor: jest.fn(),
}));
jest.mock('../modules/progress/habits.service', () => ({
  memberDashboard: jest.fn(),
  listLogs: jest.fn(),
  getLog: jest.fn(),
  todayFor: jest.fn(),
}));

const memberRoutes = require('../modules/progress/member-progress.routes');

function appFor(user) {
  global.__mockUser = user;
  const app = express();
  app.use('/api/me', memberRoutes);
  return app;
}

const member = { id: 'u1', role: 'client', pt_client_id: 'client-1', organization_id: 'org-1' };

beforeEach(() => {
  mockDashboard.mockReset();
  mockDashboard.mockResolvedValue({ client: null, assessments: [], latest_mobility: null });
});

describe('GET /api/me/fitness-tests', () => {
  it('reads the client and organisation from the session', async () => {
    const res = await request(appFor(member))
      .get('/api/me/fitness-tests')
      // A query parameter must make no difference; the route has no client id.
      .query({ client_id: 'client-2', organization_id: 'org-2' });

    expect(res.status).toBe(200);
    expect(mockDashboard).toHaveBeenCalledWith('org-1', 'client-1');
  });

  it('refuses an account with no client profile', async () => {
    const res = await request(appFor({ ...member, pt_client_id: null }))
      .get('/api/me/fitness-tests');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_CLIENT_PROFILE');
    expect(mockDashboard).not.toHaveBeenCalled();
  });

  it('registers no write method beside the read', async () => {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const res = await request(appFor(member))[method]('/api/me/fitness-tests');
      expect(res.status).toBe(404);
    }
  });
});

describe('the repository is the whitelist', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const repo = readFileSync(
    join(__dirname, '..', 'modules', 'progress', 'member-fitness.repo.js'),
    'utf8',
  ).replace(/^\s*\/\/.*$/gm, '');

  it('never reads SELECT * into the member payload', () => {
    expect(repo).not.toMatch(/SELECT\s+\*/i);
  });

  it('scopes every statement by organisation and client', () => {
    const statements = repo.match(/`SELECT[\s\S]*?`/g) || [];
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const sql of statements) {
      expect(sql).toContain('organization_id = $1');
      expect(sql).toMatch(/(client_id|id) = \$2/);
    }
  });

  it('does not select trainer-only or audit columns', () => {
    for (const column of ['trainer_notes', 'created_by', 'strength_test_data', 'flexibility_test_data']) {
      expect(repo).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
  });
});

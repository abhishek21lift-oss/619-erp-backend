'use strict';
// GET /api/profile/me bootstraps user_profiles on first use. That bootstrap is
// a CREATE TABLE, and Postgres checks CREATE privilege before it checks whether
// the table already exists — so `IF NOT EXISTS` is no protection when the
// serving role is app_tenant, which owns no schema rights. The E2E stack runs
// the API exactly that way, and every request to the profile page answered 500
// ("permission denied for schema public") until the bootstrap learned to look
// first. Migrations own the schema; the create is only for a database that
// predates migration 132.

const mockPoolState = { exists: true, queries: [] };

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockPoolState.queries.push(flat);
    if (/to_regclass\('public\.user_profiles'\)/.test(flat)) {
      return { rows: [{ t: mockPoolState.exists ? 'user_profiles' : null }], rowCount: 1 };
    }
    if (/^SELECT u\.id/.test(flat)) {
      return { rows: [{ id: 'usr-t', name: 'T', email: 't@x.test', role: 'trainer', certifications: [] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  connect: jest.fn(),
}));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn() }));
jest.mock('otplib', () => ({ generateSecret: jest.fn(), verifySync: jest.fn() }));
jest.mock('../lib/fileStorage', () => ({
  saveFile: jest.fn(async (cat, name) => `/uploads/${cat}/${name}`),
  deleteFile: jest.fn(async () => {}),
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { id: 'usr-t', role: 'trainer', organization_id: '11111111-1111-4111-8111-111111111111' }; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  invalidateUserCache: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

// A fresh module per test: `schemaReady` is cached for the life of the process,
// which is the whole point of the flag and the reason these cases cannot share
// one import.
function freshApp() {
  let router;
  jest.isolateModules(() => { router = require('../routes/profile'); });
  const app = express();
  app.use(express.json());
  app.use('/api/profile', router);
  return app;
}

beforeEach(() => { mockPoolState.exists = true; mockPoolState.queries.length = 0; });

describe('GET /api/profile/me — user_profiles bootstrap', () => {
  it('does not attempt DDL when the table already exists', async () => {
    await request(freshApp()).get('/api/profile/me').expect(200);
    expect(mockPoolState.queries.some((q) => /CREATE TABLE/i.test(q))).toBe(false);
  });

  it('creates the table when a database predates it', async () => {
    mockPoolState.exists = false;
    await request(freshApp()).get('/api/profile/me').expect(200);
    expect(mockPoolState.queries.some((q) => /CREATE TABLE IF NOT EXISTS user_profiles/i.test(q))).toBe(true);
  });
});

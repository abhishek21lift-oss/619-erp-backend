'use strict';
// The studio's contact details: the trainer writes them, the member reads them
// through their own profile, and nobody else can reach the write.
//
// Two properties matter and neither is visible in the happy path. A blank field
// must erase rather than store whitespace, because the member card drops empty
// rows and a row of spaces would render as one. And an over-long value must be
// refused BEFORE the UPDATE, so a rejected save cannot leave half a block.

const ORG = '11111111-1111-4111-8111-111111111111';
const queries = [];
let mockRow = null;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (/FROM organizations/.test(sql)) return { rows: mockRow ? [mockRow] : [], rowCount: mockRow ? 1 : 0 };
    if (/UPDATE organizations/.test(sql)) return { rows: mockRow ? [mockRow] : [], rowCount: mockRow ? 1 : 0 };
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

const express = require('express');
const request = require('supertest');

// profile.js runs `router.use(auth)` for every route, so the session is
// injected here the way profile.studioLogo.test.js does it: the real
// requireTrainer, a stubbed authentication.
let mockUser = { id: 'usr-t', role: 'trainer', organization_id: ORG };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  requireTrainer: (...a) => jest.requireActual('../middleware/rbac').requireTrainer(...a),
  invalidateUserCache: jest.fn(),
}));

function app(user) {
  mockUser = user;
  const a = express();
  a.use(express.json());
  a.use('/api/profile', require('../routes/profile'));
  return a;
}

const TRAINER = { id: 'usr-t', role: 'trainer', organization_id: ORG };
const MEMBER = { id: 'usr-m', role: 'member', pt_client_id: 'cl-1', organization_id: ORG };

beforeEach(() => { queries.length = 0; mockRow = null; });

describe('GET /api/profile/studio', () => {
  it('returns the trainer studio contact details', async () => {
    mockRow = { name: 'Iron Studio', phone: '9876543210', address: '2nd floor, MG Road', hours: 'Mon–Sat 6am–9pm' };
    const res = await request(app(TRAINER)).get('/api/profile/studio').expect(200);
    expect(res.body).toEqual(mockRow);
    expect(queries[0].params).toEqual([ORG]);
  });

  it('refuses a member', async () => {
    await request(app(MEMBER)).get('/api/profile/studio').expect(403);
    expect(queries).toHaveLength(0);
  });
});

describe('PUT /api/profile/studio', () => {
  it('writes the trimmed values and returns the stored row', async () => {
    mockRow = { name: 'Iron Studio', phone: '9876543210', address: 'MG Road', hours: 'Mon–Sat' };
    const res = await request(app(TRAINER)).put('/api/profile/studio')
      .send({ phone: '  9876543210 ', address: ' MG Road ', hours: 'Mon–Sat' })
      .expect(200);

    expect(res.body).toEqual(mockRow);
    const q = queries.find((x) => /UPDATE organizations/.test(x.sql));
    expect(q.params).toEqual([ORG, '9876543210', 'MG Road', 'Mon–Sat']);
  });

  it('stores null for a blank or missing field', async () => {
    mockRow = { name: 'Iron Studio', phone: null, address: null, hours: 'Mon–Sat' };
    await request(app(TRAINER)).put('/api/profile/studio')
      .send({ phone: '   ', hours: 'Mon–Sat' })
      .expect(200);

    const q = queries.find((x) => /UPDATE organizations/.test(x.sql));
    expect(q.params).toEqual([ORG, null, null, 'Mon–Sat']);
  });

  it('refuses a value over its cap without writing', async () => {
    await request(app(TRAINER)).put('/api/profile/studio')
      .send({ address: 'x'.repeat(301) })
      .expect(400);
    expect(queries.some((x) => /UPDATE organizations/.test(x.sql))).toBe(false);
  });

  it('refuses a member', async () => {
    await request(app(MEMBER)).put('/api/profile/studio').send({ phone: '9876543210' }).expect(403);
    expect(queries.some((x) => /UPDATE organizations/.test(x.sql))).toBe(false);
  });
});

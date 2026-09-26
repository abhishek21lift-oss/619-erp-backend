// A member reads only files attached to THEIR OWN client record.
//
// /uploads checked ownership per studio, which was enough while members could
// not sign in. A member is one client of the studio: without a client check
// they could read another client's PAR-Q, consent PDF, payment screenshot or
// progress report given its key. The trainer's access is unchanged.
'use strict';

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';

let mockRow;
let mockUser;
const mockQueries = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' '), params });
    return { rows: mockRow ? [mockRow] : [] };
  }),
}));
jest.mock('../lib/fileStorage', () => ({
  serveFile: jest.fn(async (_key, res) => res.status(200).send('file')),
}));
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../lib/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use('/uploads', require('../routes/uploads'));
  return a;
}

const member = { id: 'u-m', role: 'member', organization_id: ORG, pt_client_id: 'client-me' };
const trainer = { id: 'u-t', role: 'trainer', organization_id: ORG };

beforeEach(() => { mockQueries.length = 0; mockRow = null; });

describe('a member', () => {
  beforeEach(() => { mockUser = member; });

  test.each([
    ['parq', `parq/pdf/${REC}.pdf`],
    ['informed-consent', `informed-consent/pdf/${REC}.pdf`],
  ])('reads their own %s', async (_c, key) => {
    mockRow = { organization_id: ORG, owner_client: 'client-me' };
    const res = await request(app()).get(`/uploads/${key}`);
    expect(res.status).toBe(200);
    expect(mockQueries[0].sql).toMatch(/client_id::text AS owner_client/);
  });

  test.each([
    ['parq', `parq/pdf/${REC}.pdf`],
    ['informed-consent', `informed-consent/pdf/${REC}.pdf`],
    ['upi-proof', `upi-proof/${REC}-abc.png`],
    ['progress-reports', `progress-reports/${REC}-2026-09-01.pdf`],
  ])('cannot read another client\'s %s in the same studio', async (_c, key) => {
    mockRow = { organization_id: ORG, owner_client: 'client-someone-else' };
    const res = await request(app()).get(`/uploads/${key}`);
    expect(res.status).toBe(404);
  });

  test('cannot read the studio\'s AI knowledge documents', async () => {
    mockRow = { organization_id: ORG };
    const res = await request(app()).get(`/uploads/knowledge/${REC}.pdf`);
    expect(res.status).toBe(404);
    expect(mockQueries).toHaveLength(0);
  });

  test('cannot read portfolio media', async () => {
    mockRow = { organization_id: ORG };
    const res = await request(app()).get(`/uploads/portfolio/${REC}.jpg`);
    expect(res.status).toBe(404);
    expect(mockQueries).toHaveLength(0);
  });

  test('a member login with no client record reads nothing', async () => {
    mockUser = { ...member, pt_client_id: null };
    mockRow = { organization_id: ORG, owner_client: 'null' };
    const res = await request(app()).get(`/uploads/parq/pdf/${REC}.pdf`);
    expect(res.status).toBe(404);
  });
});

describe('the trainer', () => {
  beforeEach(() => { mockUser = trainer; });

  test('still reads any client\'s file in their own studio', async () => {
    mockRow = { organization_id: ORG };
    const res = await request(app()).get(`/uploads/parq/pdf/${REC}.pdf`);
    expect(res.status).toBe(200);
    expect(mockQueries[0].sql).not.toMatch(/owner_client/);
  });

  test('still cannot read another studio\'s file', async () => {
    mockRow = { organization_id: OTHER_ORG };
    const res = await request(app()).get(`/uploads/parq/pdf/${REC}.pdf`);
    expect(res.status).toBe(404);
  });
});

'use strict';
// Pause and deletion requests are unread trainer notifications, nothing more.
//
// The two properties this file exists to pin: a refused request writes nothing,
// and the client it writes about is the session's client, never the request's.
const CLIENT = 'cl-self';
const ORG = '11111111-1111-4111-8111-111111111111';
const mockQueries = [];
let mockResponder = () => ({ rows: [], rowCount: 0 });

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return mockResponder(mockQueries[mockQueries.length - 1].sql);
  }),
}));
jest.mock('../lib/appTime', () => ({
  ...jest.requireActual('../lib/appTime'),
  today: () => '2026-11-05',
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
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const inserts = () => mockQueries.filter((q) => /INSERT INTO notifications/.test(q.sql));

beforeEach(() => { mockQueries.length = 0; mockResponder = () => ({ rows: [], rowCount: 0 }); });

describe('pause requests', () => {
  it('notifies the trainers with the dates and reason, from the session identity', async () => {
    mockResponder = () => ({ rows: [], rowCount: 1 });
    const res = await request(app()).post('/api/me/pause/request')
      .send({ start_date: '2026-11-10', end_date: '2026-11-24', reason: 'Travel' })
      .expect(200);

    expect(res.body.data).toEqual({ sent: true });
    expect(inserts()).toHaveLength(1);
    const q = inserts()[0];
    expect(q.params[0]).toBe(CLIENT);
    expect(q.params[1]).toBe(ORG);
    expect(q.params[2]).toBe('pause_request');
    expect(q.params[4]).toContain('2026-11-10');
    expect(q.params[4]).toContain('2026-11-24');
    expect(q.params[4]).toContain('Travel');
  });

  it('refuses an end before the start without writing anything', async () => {
    await request(app()).post('/api/me/pause/request')
      .send({ start_date: '2026-11-10', end_date: '2026-11-09' })
      .expect(400);
    expect(inserts()).toHaveLength(0);
  });

  it('refuses a start in the past without writing anything', async () => {
    await request(app()).post('/api/me/pause/request')
      .send({ start_date: '2026-11-04' })
      .expect(400);
    expect(inserts()).toHaveLength(0);
  });

  it('refuses a request with no start date', async () => {
    await request(app()).post('/api/me/pause/request').send({ reason: 'Travel' }).expect(400);
    expect(inserts()).toHaveLength(0);
  });

  it('reports sent: false when the trainer already has an unread request', async () => {
    mockResponder = () => ({ rows: [], rowCount: 0 });
    const res = await request(app()).post('/api/me/pause/request')
      .send({ start_date: '2026-11-10' }).expect(200);
    expect(res.body.data).toEqual({ sent: false });
  });

  it('reports the unread request time', async () => {
    mockResponder = (sql) => (/FROM notifications/.test(sql)
      ? { rows: [{ at: '2026-11-05T09:00:00.000Z' }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const res = await request(app()).get('/api/me/pause').expect(200);
    expect(res.body.data.requested_at).toBe('2026-11-05T09:00:00.000Z');
  });
});

describe('deletion requests', () => {
  it('notifies the trainers and deletes nothing', async () => {
    mockResponder = () => ({ rows: [], rowCount: 1 });
    const res = await request(app()).post('/api/me/deletion/request').expect(200);
    expect(res.body.data).toEqual({ sent: true });
    expect(inserts()[0].params[2]).toBe('deletion_request');
    expect(mockQueries.some((q) => /^(DELETE|UPDATE)/i.test(q.sql))).toBe(false);
  });

  it('ignores a client id in the query string', async () => {
    mockResponder = () => ({ rows: [], rowCount: 1 });
    await request(app()).post('/api/me/deletion/request?client_id=other').expect(200);
    expect(inserts()[0].params[0]).toBe(CLIENT);
    expect(inserts()[0].params).not.toContain('other');
  });
});

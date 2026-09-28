// An announcement's link is shown in the notification panel of every studio it
// targets, so it must stay on this site. '//host' and '/\host' begin with '/'
// but browsers treat them as another host (Command Center audit 2026-09-28,
// CC-7). Driven through the real route; a refused link never reaches the DB.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn(async () => ({ rows: [{ id: 'a1' }] })) }));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'op-1', name: 'Owner', role: 'super_admin' }; next(); });
  a.use('/api/super-admin', require('../modules/platform/super-admin/announcements'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const base = { title: 'Maintenance tonight', body: 'Short downtime at 11pm.', severity: 'info', audience: 'all' };
const inserts = () => pool.query.mock.calls.filter(([sql]) => /INSERT INTO platform_announcements/i.test(sql));

beforeEach(() => pool.query.mockClear());

describe('announcement link', () => {
  it.each([
    ['//evil.example/login'],
    ['/\\evil.example/login'],
    ['https://evil.example'],
    ['javascript:alert(1)'],
  ])('refuses %s', async (link) => {
    const res = await request(app()).post('/api/super-admin/announcements').send({ ...base, link });
    expect(res.status).toBe(400);
    expect(inserts()).toHaveLength(0);
  });

  it('accepts an in-app path', async () => {
    const res = await request(app()).post('/api/super-admin/announcements').send({ ...base, link: '/subscription' });
    expect(res.status).toBeLessThan(400);
    expect(inserts()).toHaveLength(1);
  });
});

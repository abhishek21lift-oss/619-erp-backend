'use strict';
// GET /api/me/export — the member's own records, in one read-only document.
//
// The three properties worth pinning: it downloads rather than renders, it
// never writes (opening it must not clear the unread message badge), and every
// read is bound to the session's client and studio.
const CLIENT = 'cl-self';
const ORG = '11111111-1111-4111-8111-111111111111';
const mockQueries = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: [], rowCount: 0 };
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

beforeEach(() => { mockQueries.length = 0; });

describe('GET /api/me/export', () => {
  it('downloads one JSON document with every section and the right headers', async () => {
    const res = await request(app()).get('/api/me/export?client_id=other').expect(200);

    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition'])
      .toBe('attachment; filename="my-pt-studio-data-2026-11-05.json"');

    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual([
      'achievements', 'attendance', 'checkins', 'exported_at', 'form_checks', 'forms',
      'goals', 'measurements', 'member', 'membership', 'messages', 'payments',
      'progress_photos', 'sessions',
    ]);
    expect(data.messages).toEqual([]);
    expect(data.exported_at).toBeTruthy();
  });

  it('is read-only: no write statement and no message read-marking', async () => {
    await request(app()).get('/api/me/export').expect(200);
    expect(mockQueries.some((q) => /^(INSERT|UPDATE|DELETE)/i.test(q.sql))).toBe(false);
    expect(mockQueries.some((q) => /FROM client_messages/.test(q.sql))).toBe(true);
  });

  it('binds every read to the session client and studio', async () => {
    await request(app()).get('/api/me/export').expect(200);
    expect(mockQueries.length).toBeGreaterThan(0);
    for (const q of mockQueries) {
      expect(q.params).not.toContain('other');
    }
    expect(mockQueries.some((q) => /FROM pt_assessments/.test(q.sql))).toBe(true);
  });
});

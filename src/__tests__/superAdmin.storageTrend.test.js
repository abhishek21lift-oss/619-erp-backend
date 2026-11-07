// Storage trend: every day in the window must be present.
//
// The chart draws one point per row. When the SQL grouped straight out of
// storage_objects, a day with no uploads produced no row, the chart joined the
// neighbouring days with a straight line, and empty days were indistinguishable
// from steady traffic. The date spine is what makes a zero a real zero.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const request = require('supertest');
const express = require('express');

const calls = [];
jest.mock('../db/pool', () => ({
  query: jest.fn((sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' '), params });
    return Promise.resolve({
      rows: [
        { day: '2026-11-01', bytes: '2048', objects: 2 },
        { day: '2026-11-02', bytes: '0', objects: 0 },
      ],
    });
  }),
}));

const storage = require('../modules/platform/super-admin/storage');

describe('GET /storage/trend', () => {
  it('zero-fills the window from a continuous date spine', async () => {
    const app = express().use('/api/super-admin', storage);
    const res = await request(app).get('/api/super-admin/storage/trend?days=7');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { day: '2026-11-01', bytes: 2048, objects: 2 },
      { day: '2026-11-02', bytes: 0, objects: 0 },
    ]);

    const trend = calls.find((c) => c.sql.includes('generate_series'));
    expect(trend).toBeDefined();
    expect(trend.sql).toMatch(/LEFT JOIN d ON d\.day = s\.day/);
    // The clamped window is a number, not a string spliced into the interval.
    expect(trend.params).toEqual([7]);
  });
});

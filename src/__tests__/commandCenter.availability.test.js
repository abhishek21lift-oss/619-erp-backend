'use strict';
// Persistent status history: the sampler and the availability rails.
//
// The properties worth pinning are the ones a chart can silently get wrong:
//
//   * a bucket takes the WORST status inside it. A 30-second critical inside a
//     green 15-minute block must stay visible.
//   * a bucket with no sample is null, not healthy. A stopped sampler is a gap,
//     and a gap rendered as green is a chart claiming health it never measured.
//   * window and retention are clamped; both come from a query string.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockCalls = [];
let mockHistoryRows = [];
let mockCards = {};

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockCalls.push({ sql: flat, params: params || [] });
    if (/FROM command_center_status_samples/i.test(flat)) return { rows: mockHistoryRows, rowCount: mockHistoryRows.length };
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../modules/command-center/index', () => ({
  registerCollectors: jest.fn(),
  registry: { names: () => [], get: () => null, runCollector: jest.fn() },
  snapshot: { collect: jest.fn(async () => ({ cards: mockCards })) },
}));

const request = require('supertest');
const express = require('express');
const availability = require('../modules/command-center/availability.service');

const FIXED = Date.UTC(2026, 9, 29, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const BUCKET = 15 * 60_000;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'sa1', role: 'super_admin' }; next(); });
  a.use('/api/super-admin', require('../modules/command-center/command-center.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const AVAILABILITY = '/api/super-admin/command-center/availability';

beforeEach(() => {
  mockCalls.length = 0;
  mockHistoryRows = [];
  mockCards = {};
  jest.spyOn(Date, 'now').mockReturnValue(FIXED);
});

afterEach(() => { jest.restoreAllMocks(); });

describe('persisted availability', () => {
  it('rolls a bucket up to its worst status and leaves gaps empty', async () => {
    mockHistoryRows = [
      { card: 'runtime', status: 'healthy', bucket: iso(FIXED - BUCKET), n: 2 },
      { card: 'runtime', status: 'critical', bucket: iso(FIXED - BUCKET), n: 1 },
      { card: 'runtime', status: 'degraded', bucket: iso(FIXED - 2 * BUCKET), n: 3 },
      { card: 'redis', status: 'healthy', bucket: iso(FIXED), n: 1 },
    ];

    const res = await request(app()).get(AVAILABILITY);
    expect(res.status).toBe(200);

    const body = res.body.data;
    expect(body.window_hours).toBe(24);
    expect(body.bucket_minutes).toBe(15);

    const runtime = body.cards.find((c) => c.card === 'runtime');
    expect(runtime.buckets).toHaveLength(96);
    expect(runtime.buckets.find((b) => b.at === iso(FIXED - BUCKET)).status).toBe('critical');
    expect(runtime.buckets.find((b) => b.at === iso(FIXED - 2 * BUCKET)).status).toBe('degraded');
    // No sample for this bucket: a gap, not health.
    expect(runtime.buckets.find((b) => b.at === iso(FIXED)).status).toBeNull();
    expect(runtime.samples).toBe(6);

    const redis = body.cards.find((c) => c.card === 'redis');
    expect(redis.healthy_pct).toBe(100);
    expect(runtime.healthy_pct).toBe(0);
  });

  it('clamps window and retention at both ends', async () => {
    await availability.history({ hours: '99999' });
    expect(mockCalls[0].params).toEqual([7200, '336']);

    mockCalls.length = 0;
    await availability.history({ hours: '-5' });
    expect(mockCalls[0].params).toEqual([900, '1']);

    mockCalls.length = 0;
    await availability.history({});
    expect(mockCalls[0].params).toEqual([900, '24']);
  });

  it('samples every card in one insert', async () => {
    mockCards = {
      runtime: { name: 'runtime', status: 'healthy' },
      redis: { name: 'redis', status: 'degraded' },
      smtp: { name: 'smtp', status: 'unavailable' },
    };

    const result = await availability.sample();
    expect(result.sampled).toBe(3);

    const insert = mockCalls.find((c) => /INSERT INTO command_center_status_samples/i.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert.params).toEqual(
      [['runtime', 'redis', 'smtp'], ['healthy', 'degraded', 'unavailable']],
    );
  });
});

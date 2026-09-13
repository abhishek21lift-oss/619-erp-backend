'use strict';
// One health reading, not two.
//
// ── The two that disagreed ─────────────────────────────────────────────────
//
// /api/platform/system-health ran its own `SELECT 1`, read `_migrations`
// itself, called process.memoryUsage() itself and summarised the queues
// itself — duplicating four collectors, with no timeout, cache, coalescing or
// cancellation, none of which the registry lacks.
//
// The duplicated VOCABULARY was worse than the duplicated work. This endpoint
// graded the database `up`/`down`; the snapshot grades it against latency,
// pool pressure, connection ratio and idle-in-transaction. A database at 900ms
// with an exhausted pool was `up` here and `critical` there, and the console
// rendered both on one screen without saying which to believe.
//
// It was also missing the field the frontend actually read: `health.status`
// did not exist, so the Infrastructure tile fell through to its `?? 'live'`
// default and showed the literal word "live" forever — a green-looking string
// that was never a health reading at all.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const poolCalls = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql) => {
    poolCalls.push(String(sql).replace(/\s+/g, ' ').trim());
    return { rows: [{ n: 7 }], rowCount: 1 };
  }),
  totalCount: 5, idleCount: 4, waitingCount: 0,
}));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

const mockCollect = jest.fn();
jest.mock('../modules/command-center', () => ({
  registerCollectors: jest.fn(),
  snapshot: { collect: (...a) => mockCollect(...a) },
  registry: {},
}));

const request = require('supertest');
const express = require('express');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'sa1', role: 'super_admin' }; next(); });
  a.use('/api/platform', require('../modules/platform/super-admin/operations'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const SICK_SNAPSHOT = {
  status: 'critical',
  observability: { total: 8, probed: 6, unavailable: 1, not_configured: 1, timed_out: 0, stale: 2, coverage: 0.86 },
  degraded_reasons: [{ card: 'database', status: 'critical', scope: 'platform', reason: 'Database latency 900ms' }],
  collected_at: '2026-09-13T18:00:00.000Z',
  duration_ms: 42,
  cards: {
    database: {
      name: 'database', status: 'critical', reason: 'Database latency 900ms', scope: 'platform',
      data: {
        latency_ms: 900,
        pool: { total: 10, idle: 0, waiting: 4 },
        size_bytes: 123456,
        migrations: { applied: 200, latest: '200_x.sql', applied_at: '2026-09-01T00:00:00.000Z' },
      },
    },
    runtime: {
      name: 'runtime', status: 'healthy', scope: 'process',
      data: {
        uptime_seconds: 3600, node_version: 'v22.0.0',
        memory: { rss_bytes: 111, heap_used_bytes: 222, heap_total_bytes: 333 },
      },
    },
    queues: { name: 'queues', status: 'degraded', data: { summary: { status: 'degraded' } } },
  },
};

beforeEach(() => {
  poolCalls.length = 0;
  mockCollect.mockReset();
  mockCollect.mockResolvedValue(SICK_SNAPSHOT);
});

describe('/system-health measures nothing of its own', () => {
  it('reads the canonical snapshot', async () => {
    await request(app()).get('/api/platform/system-health');
    expect(mockCollect).toHaveBeenCalledTimes(1);
  });

  it('no longer runs a second database probe, migration read or queue summary', async () => {
    // The four duplicated probes, asserted as absences. Each one was a second
    // opinion that could disagree with the card beside it.
    await request(app()).get('/api/platform/system-health');
    const sql = poolCalls.join(' | ');
    expect(sql).not.toMatch(/SELECT 1\b/);
    expect(sql).not.toMatch(/_migrations/);
    expect(sql).not.toMatch(/pg_database_size/);
    // Exactly one query survives, and it is the one no collector covers.
    expect(poolCalls).toHaveLength(1);
    expect(poolCalls[0]).toMatch(/activity_log/);
  });
});

describe('it speaks the canonical vocabulary', () => {
  it('returns the rollup status the frontend was already reading', async () => {
    // The field that did not exist. Its absence is why the Infrastructure tile
    // rendered the literal word "live".
    const res = await request(app()).get('/api/platform/system-health');
    expect(res.body.status).toBe('critical');
    expect(res.body.status).not.toBe('live');
  });

  it('carries observability, so "fine" can be told from "I only saw two things"', async () => {
    const res = await request(app()).get('/api/platform/system-health');
    expect(res.body.observability.coverage).toBe(0.86);
    expect(res.body.observability.unavailable).toBe(1);
    expect(res.body.degraded_reasons[0].card).toBe('database');
  });

  it('does not report a critical database as up', async () => {
    // The exact disagreement: `up` here, `critical` on the card beside it.
    const res = await request(app()).get('/api/platform/system-health');
    expect(res.body.database.status).toBe('down');
    expect(res.body.database.card_status).toBe('critical');
    expect(res.body.database.error).toMatch(/900ms/);
  });

  it('still reports a warning database as up — a warning is not an outage', async () => {
    mockCollect.mockResolvedValue({
      ...SICK_SNAPSHOT,
      cards: {
        ...SICK_SNAPSHOT.cards,
        database: { ...SICK_SNAPSHOT.cards.database, status: 'warning', reason: '4 waiting' },
      },
    });
    const res = await request(app()).get('/api/platform/system-health');
    expect(res.body.database.status).toBe('up');
    expect(res.body.database.card_status).toBe('warning');
  });

  it('labels the process half as process-scoped', async () => {
    // uptime, node version and heap describe ONE container. Behind a second
    // replica that is a much weaker claim than the database numbers beside it.
    const res = await request(app()).get('/api/platform/system-health');
    expect(res.body.process.scope).toBe('process');
  });
});

describe('the shape older callers depend on survives', () => {
  it('keeps every field it had', async () => {
    const res = await request(app()).get('/api/platform/system-health');
    for (const key of ['checked_at', 'check_duration_ms', 'database', 'migrations', 'process', 'queues', 'errors_24h']) {
      expect(res.body).toHaveProperty(key);
    }
    expect(res.body.migrations.applied).toBe(200);
    expect(res.body.process.memory.rss_bytes).toBe(111);
    expect(res.body.errors_24h).toBe(7);
  });

  it('degrades rather than 500s when a card is missing entirely', async () => {
    mockCollect.mockResolvedValue({
      status: 'degraded', observability: {}, degraded_reasons: [],
      collected_at: 'x', duration_ms: 1, cards: {},
    });
    const res = await request(app()).get('/api/platform/system-health');
    expect(res.status).toBe(200);
    expect(res.body.database.status).toBe('down');
    expect(res.body.database.card_status).toBe('unavailable');
  });
});

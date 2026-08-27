'use strict';
// GET /command-center/logs/history — keyset paging, and a stats strip that is
// allowed to cost something bounded.
//
// ── What this replaced ─────────────────────────────────────────────────────
//
// The handler ran two queries: a page of rows capped at 500, and beside it
//
//     SELECT COUNT(*), COUNT(*) FILTER (…), MIN(logged_at) FROM system_logs
//
// with no WHERE at all. The cap on the first made the endpoint look bounded.
// It bounded the list; the aggregate scanned the table.
//
// Measured against production (56,874 rows / 20MB) before the change:
//
//     unwindowed   Seq Scan      1824 buffers   21.1 ms
//     24h window   Index Scan       8 buffers    0.17 ms
//     page (any depth, keyset)     23 buffers    1.0  ms
//
// The History tab polls, so that scan ran on a timer — and `system_logs` is
// small when the platform is healthy and large when it is not. 97.7% of every
// row it holds arrived during one Redis outage. The scan was therefore
// cheapest when nobody was looking and dearest on the screen an operator opens
// during an incident.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const calls = [];
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params: params || [] });
    if (/^SELECT MIN\(logged_at\)/i.test(flat)) {
      return { rows: [{ oldest: '2026-08-04T00:00:00.000Z' }], rowCount: 1 };
    }
    if (/COUNT\(\*\)::int AS in_window/i.test(flat)) {
      return { rows: [{ in_window: 13, from_worker: 2, fatal: 1 }], rowCount: 1 };
    }
    // A page of rows. Ids descend so the cursor is the last one.
    const limit = Number(params[params.length - 1]) || 100;
    const rows = Array.from({ length: limit }, (_, i) => ({
      id: 5000 - i, level: 50, level_label: 'error',
      logged_at: '2026-08-21T09:00:00.000Z', msg: 'boom',
      source: 'api', pid: 1, hostname: 'h', context: null,
    }));
    return { rows, rowCount: rows.length };
  }),
}));

jest.mock('../modules/command-center/index', () => ({
  registerCollectors: jest.fn(),
  registry: {},
  snapshot: { collect: jest.fn(async () => ({})) },
}));

const request = require('supertest');
const express = require('express');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'sa1', role: 'super_admin' }; next(); });
  a.use('/api/super-admin', require('../modules/command-center/command-center.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const HISTORY = '/api/super-admin/command-center/logs/history';
const statsCall = () => calls.find((c) => /AS in_window/i.test(c.sql));
const pageCall = () => calls.find((c) => /FROM system_logs WHERE level >=/i.test(c.sql));

beforeEach(() => { calls.length = 0; });

describe('the stats aggregate is windowed', () => {
  it('constrains the aggregate by time and passes the window as a parameter', async () => {
    const res = await request(app()).get(HISTORY);
    expect(res.status).toBe(200);

    const stats = statsCall();
    expect(stats).toBeDefined();
    expect(stats.sql).toMatch(/WHERE logged_at > NOW\(\) - \(\$1 \|\| ' hours'\)::interval/);
    // Parameterised, not interpolated — the window arrives from a query string.
    expect(stats.params).toEqual(['24']);
  });

  it('honours an explicit window', async () => {
    await request(app()).get(HISTORY).query({ stats_hours: '72' });
    expect(statsCall().params).toEqual(['72']);
  });

  it('clamps the window at both ends', async () => {
    // Upper: an unbounded window is the original bug wearing a parameter.
    await request(app()).get(HISTORY).query({ stats_hours: '99999' });
    expect(statsCall().params).toEqual(['720']);

    calls.length = 0;
    // Lower: 0 and negatives would read as "no window". A negative interval
    // would also invert the comparison and select rows from the future.
    await request(app()).get(HISTORY).query({ stats_hours: '-5' });
    expect(statsCall().params).toEqual(['1']);
  });

  it('skips the aggregate entirely on ?stats=0', async () => {
    // What the poll tick uses. The lines change every few seconds; the strip
    // beside them does not, and recomputing it per tick was most of the cost
    // of having the tab open.
    const res = await request(app()).get(HISTORY).query({ stats: '0' });
    expect(res.body.data.stats).toBeNull();
    expect(statsCall()).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('still reports true history depth, which a window cannot give', async () => {
    const res = await request(app()).get(HISTORY);
    expect(res.body.data.stats.oldest).toBe('2026-08-04T00:00:00.000Z');
    expect(res.body.data.stats.window_hours).toBe(24);
    expect(res.body.data.stats.retention_days).toBe(30);

    // Its own statement: MIN over the whole table is an index-only scan
    // backward reading one row. Folded into the windowed aggregate it would
    // drag the entire table back in and undo the point of the window.
    const min = calls.find((c) => /^SELECT MIN\(logged_at\)/i.test(c.sql));
    expect(min).toBeDefined();
    expect(min.sql).not.toMatch(/COUNT/i);
  });
});

describe('the page is keyset-paginated', () => {
  it('orders by a unique key so a cursor can be exact', async () => {
    await request(app()).get(HISTORY);
    // logged_at is not unique — two lines share a timestamp routinely — so it
    // cannot carry a cursor without dropping or repeating rows at the seam.
    expect(pageCall().sql).toMatch(/ORDER BY id DESC/);
  });

  it('returns a cursor when the page is full', async () => {
    const res = await request(app()).get(HISTORY).query({ limit: '10' });
    expect(res.body.data.lines).toHaveLength(10);
    expect(res.body.data.next_before).toBe('4991');   // 5000 - 9
  });

  it('returns no cursor when the page is short, which is how paging ends', async () => {
    const pool = require('../db/pool');
    pool.query.mockImplementationOnce(async () => ({ rows: [{ id: 7 }], rowCount: 1 }));
    const res = await request(app()).get(HISTORY).query({ limit: '10', stats: '0' });
    expect(res.body.data.next_before).toBeNull();
  });

  it('applies the cursor as a parameter, not as interpolated text', async () => {
    await request(app()).get(HISTORY).query({ before: '4991' });
    const page = pageCall();
    expect(page.sql).toMatch(/id < \$\d/);
    expect(page.params).toContain('4991');
  });

  it('ignores a cursor that is not a number', async () => {
    // The alternative is an injected fragment or a 500; both are worse than
    // starting from the top.
    await request(app()).get(HISTORY).query({ before: "1; DROP TABLE system_logs" });
    const page = pageCall();
    expect(page.sql).not.toMatch(/id < \$/);
    expect(page.params.join(' ')).not.toMatch(/DROP/i);
  });

  it('clamps the page size at both ends', async () => {
    await request(app()).get(HISTORY).query({ limit: '99999', stats: '0' });
    expect(pageCall().params[pageCall().params.length - 1]).toBe(500);

    calls.length = 0;
    // LIMIT -1 is not an empty page — Postgres rejects it outright ("LIMIT
    // must not be negative"), so an unclamped lower end hands any caller a 500
    // from the query string.
    //
    // The floor is 1, not the default of 100: `Number('-1')` is truthy, so the
    // `|| 100` fallback never fires and the clamp is what catches it. That is
    // the same choice every other page-size clamp in the codebase makes, and
    // it is the honest one — a caller who asked for a negative page asked for
    // nonsense, not for the default.
    await request(app()).get(HISTORY).query({ limit: '-1', stats: '0' });
    expect(pageCall().params[pageCall().params.length - 1]).toBe(1);
  });
});

describe('the filters still work and stay parameterised', () => {
  it('parameterises the message search', async () => {
    await request(app()).get(HISTORY).query({ q: "'; DROP TABLE system_logs; --" });
    const page = pageCall();
    expect(page.sql).toMatch(/msg ILIKE \$\d/);
    expect(page.params.some((p) => String(p).includes('DROP TABLE'))).toBe(true);
    expect(page.sql).not.toMatch(/DROP TABLE/);
  });

  it('accepts only the two known sources', async () => {
    await request(app()).get(HISTORY).query({ source: 'worker' });
    expect(pageCall().params).toContain('worker');

    calls.length = 0;
    await request(app()).get(HISTORY).query({ source: 'nonsense' });
    expect(pageCall().sql).not.toMatch(/source = \$/);
  });
});

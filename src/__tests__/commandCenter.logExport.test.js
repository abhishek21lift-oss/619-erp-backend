'use strict';
// GET /command-center/logs/history/export — the durable log as a file.
//
// The History tab pages because a screen is a bad place to read 20,000 lines.
// An operator handing an incident to somebody else needs the window, and this
// endpoint is that window. Two properties matter and neither is cosmetic:
//
//   * injection. Log messages carry attacker-influenced strings (emails, names,
//     query values). A cell beginning with `=` is a formula in Excel, so every
//     risky lead character is neutralised.
//   * the cap is disclosed. A silently truncated incident is worse than a large
//     file, because the missing half is exactly the part nobody knows to ask for.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockCalls = [];
let mockRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockCalls.push({ sql: flat, params: params || [] });
    if (/FROM system_logs/i.test(flat)) return { rows: mockRows, rowCount: mockRows.length };
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../modules/command-center/index', () => ({
  registerCollectors: jest.fn(),
  registry: { names: () => [] },
  snapshot: { collect: jest.fn() },
}));

const request = require('supertest');
const express = require('express');
const logExport = require('../modules/command-center/logExport');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'sa1', role: 'super_admin' }; next(); });
  a.use('/api/super-admin', require('../modules/command-center/command-center.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const EXPORT = '/api/super-admin/command-center/logs/history/export';

const logRow = (over = {}) => ({
  id: '1',
  level: 50,
  level_label: 'error',
  logged_at: new Date('2026-10-29T10:00:00.000Z'),
  msg: 'Redis unreachable',
  source: 'api',
  hostname: 'api-1',
  pid: 42,
  context: { queue: 'email' },
  ...over,
});

beforeEach(() => { mockCalls.length = 0; mockRows = []; });

describe('CSV shape', () => {
  it('writes a header, oldest-first, with cells quoted and escaped', async () => {
    mockRows = [
      logRow({
        id: '2',
        logged_at: new Date('2026-10-29T10:01:00.000Z'),
        msg: 'He said "boom", then\nnew line',
      }),
      logRow({ id: '1' }),
    ];

    const file = await logExport.build({ hours: 24, minLevel: 50 });
    const lines = file.csv.trimEnd().split('\r\n');

    expect(lines[0]).toBe('time,level,level_label,source,hostname,pid,message,context');
    // The SQL returns newest-first so the LIMIT drops the OLDEST rows; the file
    // reverses that so an incident reads in the order it happened.
    expect(lines[1]).toContain('2026-10-29T10:00:00.000Z');
    expect(lines[2]).toContain('2026-10-29T10:01:00.000Z');
    expect(lines[2]).toContain('"He said ""boom"", then\nnew line"');
    expect(lines[1]).toContain('"{""queue"":""email""}"');
    expect(file.row_count).toBe(2);
    expect(file.truncated).toBe(false);
  });

  it('defuses cells that a spreadsheet would treat as a formula', async () => {
    mockRows = [
      logRow({ msg: '=HYPERLINK("http://evil","click")' }),
      logRow({ id: '2', msg: '+1 555 0100' }),
      logRow({ id: '3', msg: '-cmd' }),
      logRow({ id: '4', msg: '@SUM(A1)' }),
      logRow({ id: '5', msg: 'Redis unreachable' }),
    ];

    const file = await logExport.build({ hours: 24, minLevel: 50 });
    expect(file.csv).toContain("'=HYPERLINK");
    expect(file.csv).toContain("'+1 555 0100");
    expect(file.csv).toContain("'-cmd");
    expect(file.csv).toContain("'@SUM(A1)");
    // Not double-guarded: an ordinary message keeps its first character.
    expect(file.csv).toContain('Redis unreachable');
  });
});

describe('the window and filters', () => {
  it('clamps the window and parameterises every filter', async () => {
    await logExport.build({ hours: '99999', minLevel: 50, source: 'worker', q: 'redis' });
    expect(mockCalls[0].params).toEqual([50, '720', 'worker', '%redis%', 20000]);
    expect(mockCalls[0].sql).toContain('source = $3');
    expect(mockCalls[0].sql).toContain('msg ILIKE $4');

    mockCalls.length = 0;
    await logExport.build({ hours: '-5', minLevel: 50 });
    expect(mockCalls[0].params).toEqual([50, '1', 20000]);

    mockCalls.length = 0;
    await logExport.build({ minLevel: 50 });
    expect(mockCalls[0].params).toEqual([50, '24', 20000]);
  });

  it('reports a cap hit rather than returning it silently', async () => {
    const row = logRow();
    mockRows = Array.from({ length: logExport.MAX_ROWS }, (_, i) => ({ ...row, id: String(i + 1) }));

    const file = await logExport.build({ hours: 24, minLevel: 50 });
    expect(file.truncated).toBe(true);
    expect(file.row_count).toBe(logExport.MAX_ROWS);
  });
});

describe('the download route', () => {
  it('serves an attachment with the truncation flag', async () => {
    mockRows = [logRow(), logRow({ id: '2' })];

    const res = await request(app()).get(EXPORT).query({ hours: '720', level: 'error', source: 'worker' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="command-center-logs-/);
    expect(res.headers['x-export-truncated']).toBe('false');
    expect(res.text).toContain('Redis unreachable');
  });
});

'use strict';

/**
 * Refresh tokens were never deleted.
 *
 * Every sign-in inserts a row and every refresh rotates — revoke old, insert
 * new — so the table grew once per refresh with nothing ever removing a row.
 * Production carried 4,914 rows of which 4,885 were dead, from eight accounts
 * in two months. The growth is per-refresh rather than per-user, so it does
 * not level off.
 *
 * These tests pin the shape of the statement and the parsing of its window —
 * the parts that can regress silently in a rewrite.
 *
 * They do NOT prove the DELETE hits the right rows; a mocked pool cannot
 * answer that. That was verified separately by executing this module against
 * PostgreSQL 16 with six fixture tokens spanning every state:
 *
 *   live-1, live-2                  live            → kept
 *   expired-recent, revoked-recent  dead, in window → kept
 *   expired-old, revoked-old        dead, past it   → deleted
 *
 * and the negative-window hazard was confirmed real on the same database: the
 * unclamped predicate matched `live-2`, a valid session. The clamp asserted
 * below is what stops that, so treat it as load-bearing rather than defensive.
 */

const mockQueries = [];
let mockRowCount = 0;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
    return { rows: [], rowCount: mockRowCount };
  }),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

const retention = require('../lib/refreshTokenRetention');
const logger = require('../lib/logger');

beforeEach(() => {
  mockQueries.length = 0;
  mockRowCount = 0;
  jest.clearAllMocks();
  delete process.env.REFRESH_TOKEN_RETENTION_DAYS;
});

describe('refresh token retention sweep', () => {
  it('deletes on both death conditions — expiry AND revocation', () => {
    return retention.prune().then(() => {
      const [q] = mockQueries;
      expect(q.sql).toMatch(/DELETE FROM refresh_tokens/i);
      // A token revoked on day 1 of a 7-day TTL is dead immediately; keying
      // only off expires_at would keep it six days longer for nothing.
      expect(q.sql).toMatch(/expires_at </);
      expect(q.sql).toMatch(/revoked_at IS NOT NULL/);
      expect(q.sql).toMatch(/revoked_at </);
    });
  });

  it('bounds each sweep so the first run cannot lock the whole table', async () => {
    await retention.prune();
    const [q] = mockQueries;
    expect(q.sql).toMatch(/LIMIT \$\d/);
    expect(q.params).toContain(retention.DEFAULT_BATCH);
  });

  it('defaults to a window shorter than LOG_RETENTION_DAYS, not equal to it', async () => {
    await retention.prune();
    // The token TTL is 7 days, so 30 would retain four times more than any
    // use for it. This asserts the reasoning, not just the number.
    expect(retention.DEFAULT_RETENTION_DAYS).toBeLessThan(30);
    expect(mockQueries[0].params).toContain(String(retention.DEFAULT_RETENTION_DAYS));
  });

  it('honours REFRESH_TOKEN_RETENTION_DAYS', async () => {
    process.env.REFRESH_TOKEN_RETENTION_DAYS = '14';
    await retention.prune();
    expect(mockQueries[0].params).toContain('14');
  });

  it('does not treat an explicit 0 as "unset"', async () => {
    // `Number(x) || DEFAULT` conflates the two: Number('0') is falsy, so an
    // operator setting 0 silently got the 7-day default instead.
    process.env.REFRESH_TOKEN_RETENTION_DAYS = '0';
    await retention.prune();
    expect(mockQueries[0].params).toContain('1');
    expect(mockQueries[0].params).not.toContain('7');
  });

  it('clamps a NEGATIVE window, which would otherwise delete live tokens', async () => {
    // This is the one that matters. `NOW() - '-5 days'::interval` is NOW()
    // PLUS five days, so an unclamped negative window makes the DELETE match
    // tokens expiring in the next five days — live sessions, signed out.
    process.env.REFRESH_TOKEN_RETENTION_DAYS = '-5';
    await retention.prune();
    expect(mockQueries[0].params).toContain('1');
    expect(mockQueries[0].params).not.toContain('-5');
  });

  it('falls back to the default for an unparseable window', async () => {
    process.env.REFRESH_TOKEN_RETENTION_DAYS = 'not-a-number';
    await retention.prune();
    expect(mockQueries[0].params).toContain(String(retention.DEFAULT_RETENTION_DAYS));
  });

  it('never throws — it runs on a timer with nobody to catch it', async () => {
    const pool = require('../db/pool');
    pool.query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(retention.prune()).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('stays quiet when there was nothing to remove', async () => {
    mockRowCount = 0;
    await retention.prune();
    // An hourly no-op must not write an hourly log line forever.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('reports what it removed when it removed something', async () => {
    mockRowCount = 42;
    await expect(retention.prune()).resolves.toBe(42);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ removed: 42 }),
      expect.any(String),
    );
  });
});

describe('the sweep is scheduled, not merely written', () => {
  // logCapture.prune() existed for a long time before anything called it. A
  // retention function nobody invokes is the same shape of bug as migration
  // 174's warnings going to a channel with no listener.
  const fs = require('fs');
  const path = require('path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('is required and put on an interval in server.js', () => {
    expect(server).toMatch(/require\(['"]\.\/lib\/refreshTokenRetention['"]\)/);
    expect(server).toMatch(/setInterval\(\s*sweep/);
  });

  it('is not nested inside the LOG_CAPTURE guard', () => {
    // Turning off Command Centre log capture must not silently stop pruning
    // the auth table — they are unrelated concerns.
    const guardAt = server.indexOf("process.env.LOG_CAPTURE !== 'off'");
    const sweepAt = server.indexOf('refreshTokenRetention');
    expect(guardAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(-1);
    // The guarded block ends before the sweep begins.
    const between = server.slice(guardAt, sweepAt);
    expect(between).toMatch(/\n {4}}\n/);
  });
});

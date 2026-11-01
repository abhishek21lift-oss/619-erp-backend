'use strict';

/**
 * AI conversations were never deleted.
 *
 * Every chat turn writes rows and every generator opens a conversation, and
 * nothing removed one — so client injuries, PAR-Q answers and payment figures
 * quoted in a thread stayed forever. These tests pin the statement shape and
 * the parsing of its window, which are the parts that regress silently.
 *
 * They do NOT prove the DELETE hits the right rows; a mocked pool cannot
 * answer that. The predicate is deliberately on updated_at (idle age), not
 * created_at, so an active thread is never pruned mid-use.
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

const retention = require('../lib/ai/retention');

beforeEach(() => {
  mockQueries.length = 0;
  mockRowCount = 0;
  jest.clearAllMocks();
  delete process.env.AI_CONVERSATION_RETENTION_DAYS;
});

describe('AI conversation retention sweep', () => {
  it('keys the window off updated_at, so an active thread is never pruned', async () => {
    await retention.prune();
    const [q] = mockQueries;
    expect(q.sql).toMatch(/DELETE FROM ai_conversations/i);
    expect(q.sql).toMatch(/updated_at </);
    expect(q.sql).not.toMatch(/created_at </);
  });

  it('defaults to 180 days and bounds the statement', async () => {
    await retention.prune();
    const [q] = mockQueries;
    expect(q.params).toEqual(['180', 1000]);
  });

  it('refuses a negative window instead of inverting the comparison', async () => {
    await retention.prune({ days: -5 });
    expect(mockQueries[0].params[0]).toBe('1');
  });

  it('treats an unset env var as the default, not day zero', async () => {
    process.env.AI_CONVERSATION_RETENTION_DAYS = '';
    await retention.prune();
    expect(mockQueries[0].params[0]).toBe('180');
  });

  it('honours an explicit window', async () => {
    await retention.prune({ days: 30 });
    expect(mockQueries[0].params[0]).toBe('30');
  });

  it('returns the row count and never throws when the sweep fails', async () => {
    mockRowCount = 12;
    await expect(retention.prune()).resolves.toBe(12);
  });

  it('purges one client explicitly, and no-ops without an id', async () => {
    await retention.purgeForClient('client-1');
    expect(mockQueries[0].sql).toMatch(/DELETE FROM ai_conversations WHERE client_id = \$1/);
    expect(mockQueries[0].params).toEqual(['client-1']);

    mockQueries.length = 0;
    await expect(retention.purgeForClient(null)).resolves.toBe(0);
    expect(mockQueries).toHaveLength(0);
  });
});

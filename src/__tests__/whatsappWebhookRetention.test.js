'use strict';

/**
 * The WhatsApp webhook ledger was never pruned.
 *
 * whatsapp_webhook_events exists to make at-least-once delivery idempotent, and
 * every verified event is claimed there forever. The gateway's outbox gives up
 * after six attempts (seconds to minutes), so the rows older than the window
 * guard against nothing — they are diagnosis history with no expiry.
 *
 * These tests pin the statement shape and the window parsing, the two parts
 * that regress silently. A mocked pool cannot prove which rows the DELETE
 * matches; the predicate is asserted instead.
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

const retention = require('../lib/whatsappWebhookRetention');
const logger = require('../lib/logger');

beforeEach(() => {
  mockQueries.length = 0;
  mockRowCount = 0;
  jest.clearAllMocks();
  delete process.env.WA_WEBHOOK_EVENT_RETENTION_DAYS;
});

describe('WhatsApp webhook ledger retention sweep', () => {
  it('deletes old events from the ledger, bounded per sweep', async () => {
    await retention.prune();
    const [q] = mockQueries;
    expect(q.sql).toMatch(/DELETE FROM whatsapp_webhook_events/i);
    expect(q.sql).toMatch(/received_at </);
    expect(q.sql).toMatch(/LIMIT \$\d/);
    expect(q.params).toContain(retention.DEFAULT_BATCH);
  });

  it('keeps a month by default, far longer than any outbox redelivery', async () => {
    // The gateway retries for minutes; 30 days is diagnosis history, not
    // idempotency. Shorter would make a past incident unreadable.
    expect(retention.DEFAULT_RETENTION_DAYS).toBe(30);
    await retention.prune();
    expect(mockQueries[0].params).toContain('30');
  });

  it('honours WA_WEBHOOK_EVENT_RETENTION_DAYS', async () => {
    process.env.WA_WEBHOOK_EVENT_RETENTION_DAYS = '14';
    await retention.prune();
    expect(mockQueries[0].params).toContain('14');
  });

  it('clamps a negative window instead of deleting recent events', async () => {
    // `NOW() - '-5 days'::interval` is NOW() PLUS five days, so an unclamped
    // negative window deletes events that have not arrived yet — the ledger
    // stops deduplicating and every redelivery is applied again.
    process.env.WA_WEBHOOK_EVENT_RETENTION_DAYS = '-5';
    await retention.prune();
    expect(mockQueries[0].params).toContain('1');
    expect(mockQueries[0].params).not.toContain('-5');
  });

  it('never throws — it runs on a timer with nobody to catch it', async () => {
    const pool = require('../db/pool');
    pool.query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(retention.prune()).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('the sweep is scheduled, not merely written', () => {
  // A retention function nobody invokes is the same shape of bug as the table
  // it was written to bound.
  const fs = require('fs');
  const path = require('path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('is required and put on an interval in server.js', () => {
    expect(server).toMatch(/require\(['"]\.\/lib\/whatsappWebhookRetention['"]\)/);
    expect(server).toMatch(/setInterval\(\s*sweep/);
  });
});

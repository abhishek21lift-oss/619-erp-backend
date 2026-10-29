// The backup card: does a VERIFIED dump exist, and is it recent enough?
//
// The distinguishing property is that this card reads a row written only after
// scripts/backup-database.js has verified the dump with `pg_restore -l`. A card
// that reported "a job ran" would be green on exactly the dumps that cannot be
// restored, so these tests pin the freshness grades and the missing-row state.
'use strict';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const pool = require('../db/pool');
const backup = require('../modules/command-center/collectors/backup.collector');
const { STATUS } = require('../modules/command-center/registry');

const hoursAgo = (h) => new Date(Date.now() - h * 36e5).toISOString();
const row = (h, over = {}) => ({
  last_ok_at: hoursAgo(h), size_bytes: '1048576', tables: 185, offsite: true, ...over,
});

beforeEach(() => pool.query.mockReset());

describe('backup freshness', () => {
  it('is healthy when a recent verified dump is also off-site', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row(4)] });
    const card = await backup.collect();

    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.offsite).toBe(true);
    expect(card.data.tables).toBe(185);
    expect(card.data.age_hours).toBeGreaterThanOrEqual(4);
    expect(card.reason).toBeNull();
  });

  it('warns when the newest dump is older than the daily window', async () => {
    // One missed run plus drift, not yet evidence the job is broken.
    pool.query.mockResolvedValueOnce({ rows: [row(40)] });
    const card = await backup.collect();
    expect(card.status).toBe(STATUS.WARNING);
    expect(card.reason).toMatch(/40h old/);
  });

  it('goes critical when three nightly runs in a row have been missed', async () => {
    pool.query.mockResolvedValueOnce({ rows: [row(80)] });
    const card = await backup.collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/failing/);
  });

  it('never calls a local-only dump healthy', async () => {
    // A backup on the host it protects is not off-site, which is the entire
    // reason the script uploads at all.
    pool.query.mockResolvedValueOnce({ rows: [row(4, { offsite: false })] });
    const card = await backup.collect();
    expect(card.status).toBe(STATUS.WARNING);
    expect(card.reason).toMatch(/off-site/);
  });

  it('warns, rather than guessing, when nothing has ever been recorded', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const card = await backup.collect();

    expect(card.status).toBe(STATUS.WARNING);
    expect(card.data.last_ok_at).toBeNull();
    expect(card.data.age_hours).toBeNull();
    expect(card.reason).toMatch(/No verified database backup/);
  });

  it('degrades when the status table cannot be read at all', async () => {
    pool.query.mockRejectedValueOnce(new Error('relation does not exist'));
    const card = await backup.collect();
    expect(card.status).toBe(STATUS.DEGRADED);
    expect(card.reason).toMatch(/could not be read/);
  });
});

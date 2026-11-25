'use strict';
// One thread per member: the partial unique index, the first-message race,
// and the bounded history the model is allowed to see.
jest.mock('../db/pool', () => ({ query: jest.fn() }));

const fs = require('node:fs');
const path = require('node:path');
const pool = require('../db/pool');
const thread = require('../modules/member-ai/member-ai.thread');

const ORG = '11111111-1111-4111-8111-111111111111';

beforeEach(() => jest.clearAllMocks());

describe('one thread per member', () => {
  it('reuses the existing thread and does not insert', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });
    await expect(thread.ensureThread(ORG, 'u1', 'c1', 'Hi')).resolves.toBe('conv-1');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('re-selects after losing a first-message race', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] });

    await expect(thread.ensureThread(ORG, 'u1', 'c1', 'Hi')).resolves.toBe('conv-1');
    expect(pool.query.mock.calls[1][0]).toContain('ON CONFLICT DO NOTHING');
    expect(pool.query.mock.calls[2][1]).toEqual([ORG, 'u1']);
  });

  it('pins the uniqueness in the migration', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../db/migrations/292_member_ai_thread.sql'), 'utf8',
    );
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ai_conversations_member_ai_thread/);
    expect(sql).toContain("context->>'feature' = 'member_ai'");
  });
});

describe('messages', () => {
  it('returns the newest N turns oldest-first', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { role: 'assistant', content: 'new', created_at: '2026-11-25T10:00:00Z' },
        { role: 'user', content: 'old', created_at: '2026-11-25T09:59:00Z' },
      ],
    });
    await expect(thread.recentMessages('conv-1', 6)).resolves.toEqual([
      { role: 'user', content: 'old', created_at: '2026-11-25T09:59:00Z' },
      { role: 'assistant', content: 'new', created_at: '2026-11-25T10:00:00Z' },
    ]);
    expect(pool.query.mock.calls[0][1]).toEqual(['conv-1', 6]);
  });

  it('writes the turn and bumps the conversation', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await thread.appendMessage('conv-1', 'user', 'Hi');
    expect(pool.query).toHaveBeenNthCalledWith(
      1, expect.stringContaining('INSERT INTO ai_messages'), ['conv-1', 'user', 'Hi'],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2, expect.stringContaining('UPDATE ai_conversations'), ['conv-1'],
    );
  });

  it('clears only this member thread', async () => {
    pool.query.mockResolvedValue({ rowCount: 3 });
    await expect(thread.clearHistory(ORG, 'u1')).resolves.toBe(3);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("context->>'feature' = 'member_ai'");
    expect(params).toEqual([ORG, 'u1']);
  });
});

'use strict';
// The close-and-open transition must be one transaction. These tests use a
// scripted client so a rollback and a commit are both observable without a
// live database.

jest.mock('../db/pool', () => ({ connect: jest.fn(), query: jest.fn() }));

const pool = require('../db/pool');
const repo = require('../modules/progress/retests.repo');

function scriptedClient({ active = null, backdated = false, insertError = null } = {}) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      const s = sql.trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (s.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (s.includes('FROM progress_retest_schedules')) {
        return { rows: active ? [active] : [], rowCount: active ? 1 : 0 };
      }
      if (s.includes('FROM pt_assessments')) {
        return { rows: backdated ? [{}] : [], rowCount: backdated ? 1 : 0 };
      }
      if (s.startsWith('UPDATE progress_retest_schedules')) {
        return { rows: [{ id: active.id, status: 'completed' }], rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO progress_retest_schedules')) {
        if (insertError) throw insertError;
        return {
          rows: [{ id: 's2', baseline_assessment_id: 'a2', status: 'upcoming' }], rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${s}`);
    }),
    release: jest.fn(),
  };
  return { client, calls };
}

const base = {
  orgId: 'org-1', clientId: 'client-1', assessmentId: 'a2',
  assessmentDate: '2026-06-30', scheduledDate: '2026-10-30', cadenceMonths: 4,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('advanceCycle transaction', () => {
  it('rolls back the close when creating the next cycle fails', async () => {
    const active = { id: 's1', baseline_assessment_id: 'a1', status: 'upcoming' };
    const { client, calls } = scriptedClient({ active, insertError: new Error('insert failed') });
    pool.connect.mockResolvedValue(client);

    await expect(repo.advanceCycle(base)).rejects.toThrow('insert failed');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(calls.some((c) => c.sql.startsWith('UPDATE progress_retest_schedules'))).toBe(true);
  });

  it('locks the client before reading the open cycle', async () => {
    const { client, calls } = scriptedClient();
    pool.connect.mockResolvedValue(client);

    await repo.advanceCycle(base);

    const lock = calls.findIndex((c) => c.sql.startsWith('SELECT pg_advisory_xact_lock'));
    const select = calls.findIndex((c) => c.sql.includes('FROM progress_retest_schedules'));
    expect(lock).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(lock);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('refuses to close a different cycle than the one the request named', async () => {
    const active = { id: 's-other', baseline_assessment_id: 'a1', status: 'upcoming' };
    const { client } = scriptedClient({ active });
    pool.connect.mockResolvedValue(client);

    const out = await repo.advanceCycle({ ...base, expectedScheduleId: 's1' });

    expect(out).toMatchObject({ not_open: true, schedule: active });
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE progress_retest_schedules'))).toBe(false);
  });

  it('returns the open cycle unchanged when the same assessment is posted twice', async () => {
    const active = { id: 's1', baseline_assessment_id: 'a1', status: 'upcoming' };
    const { client } = scriptedClient({ active });
    pool.connect.mockResolvedValue(client);

    const out = await repo.advanceCycle({ ...base, assessmentId: 'a1' });

    expect(out).toMatchObject({ unchanged: true, completed_previous: null });
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO progress_retest_schedules'))).toBe(false);
  });

  it('compares the new assessment against the baseline in the right direction', async () => {
    const active = { id: 's1', baseline_assessment_id: 'a1', status: 'upcoming' };
    const { client, calls } = scriptedClient({ active });
    pool.connect.mockResolvedValue(client);

    await repo.advanceCycle(base);

    const guard = calls.find((c) => c.sql.includes('FROM pt_assessments'));
    expect(guard.sql).toMatch(/assessment_date\s*>\s*\$4::date/);
  });

  it('does not advance the chain from a backdated assessment', async () => {
    const active = { id: 's1', baseline_assessment_id: 'a1', status: 'upcoming' };
    const { client } = scriptedClient({ active, backdated: true });
    pool.connect.mockResolvedValue(client);

    const out = await repo.advanceCycle({ ...base, assessmentDate: '2025-12-01' });

    expect(out).toMatchObject({ backdated: true, completed_previous: null });
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO progress_retest_schedules'))).toBe(false);
  });
});

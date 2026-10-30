'use strict';
// Session reminders: 24 h and 2 h before a scheduled session.
//
// The two facts these tests protect:
//   1. the in-app notification is written for every studio, including ones with
//      automation switched off — so the job does not ask which studios are on;
//   2. a second pass in the same 15-minute window writes nothing twice.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../modules/automation/automation.triggers', () => ({
  sessionReminderFor: jest.fn().mockResolvedValue({ outcome: 'queued' }),
}));

const pool = require('../db/pool');
const triggers = require('../modules/automation/automation.triggers');
const { runSessionReminders } = require('../modules/pt-os/session-reminders');

const row = (over = {}) => ({
  id: 's1',
  organization_id: 'org-1',
  client_id: 'c1',
  name: 'Asha',
  session_date: '2026-11-02',
  start_time: '06:30',
  user_id: 'u-member-1',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2026-11-01T01:00:00Z')); // 06:30 IST
});

afterEach(() => jest.useRealTimers());

describe('runSessionReminders', () => {
  it('picks a session 24 h out, writes the in-app row and emits', async () => {
    const sessions = [row()];
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM pt_sessions/.test(sql)) {
        return { rows: params[0] === '2026-11-02 06:30' ? sessions : [] };
      }
      if (/INSERT INTO notifications/.test(sql)) return { rowCount: 1 };
      return { rows: [] };
    });

    const out = await runSessionReminders();

    expect(out).toMatchObject({ sent: 1, skipped: 0, orgs: 1 });
    expect(triggers.sessionReminderFor).toHaveBeenCalledWith('org-1', {
      clientId: 'c1',
      sessionId: 's1',
      date: '2026-11-02',
      time: '06:30',
      when: 'tomorrow',
      name: 'Asha',
      bucket: '24h',
    });

    const notify = pool.query.mock.calls.find((c) => /INSERT INTO notifications/.test(String(c[0])));
    expect(notify[0]).toMatch(/NOT EXISTS/);
    expect(notify[0]).toMatch(/ref_id = \$4/);
    // The bucket is part of the key: a bare session id would make this row
    // suppress the 2-hour reminder for the same session.
    expect(notify[1][3]).toBe('s1:24h');
  });

  it('writes the 2 h reminder after the 24 h one already exists', async () => {
    const written = new Set();
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM pt_sessions/.test(sql)) {
        return { rows: params[0] === '2026-11-02 06:30' ? [row()] : [] };
      }
      if (/INSERT INTO notifications/.test(sql)) {
        if (written.has(params[3])) return { rowCount: 0 };
        written.add(params[3]);
        return { rowCount: 1 };
      }
      return { rows: [] };
    });

    await runSessionReminders(); // 24 h before: writes s1:24h

    jest.setSystemTime(new Date('2026-11-01T23:00:00Z')); // 04:30 IST, 2 h before
    const second = await runSessionReminders();

    expect(second).toMatchObject({ sent: 1, skipped: 0 });
    expect([...written]).toEqual(['s1:24h', 's1:2h']);
    expect(triggers.sessionReminderFor).toHaveBeenLastCalledWith('org-1', expect.objectContaining({
      sessionId: 's1', bucket: '2h',
    }));
  });

  it('picks a session 2 h out in its own bucket', async () => {
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM pt_sessions/.test(sql)) {
        return {
          rows: params[0] === '2026-11-01 08:30'
            ? [row({ id: 's2', session_date: '2026-11-01', start_time: '08:30' })]
            : [],
        };
      }
      if (/INSERT INTO notifications/.test(sql)) return { rowCount: 1 };
      return { rows: [] };
    });

    await runSessionReminders();

    expect(triggers.sessionReminderFor).toHaveBeenCalledWith('org-1', expect.objectContaining({
      sessionId: 's2', bucket: '2h', when: 'in 2 hours',
    }));
  });

  it('does not remind twice when the notification already exists', async () => {
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM pt_sessions/.test(sql)) {
        return { rows: params[0] === '2026-11-02 06:30' ? [row()] : [] };
      }
      if (/INSERT INTO notifications/.test(sql)) return { rowCount: 0 };
      return { rows: [] };
    });

    const out = await runSessionReminders();

    expect(out).toMatchObject({ sent: 0, skipped: 1 });
    expect(triggers.sessionReminderFor).not.toHaveBeenCalled();
  });

  it('selects only scheduled, live sessions and never asks which studios are on', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await runSessionReminders();

    const selects = pool.query.mock.calls.filter((c) => /FROM pt_sessions/.test(String(c[0])));
    expect(selects).toHaveLength(2);
    for (const [sql] of selects) {
      expect(sql).toMatch(/status = 'scheduled'/);
      expect(sql).toMatch(/deleted_at IS NULL/);
      expect(sql).not.toMatch(/automation_rules|automation_enabled/);
    }
  });
});

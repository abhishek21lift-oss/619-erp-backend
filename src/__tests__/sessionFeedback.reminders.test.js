'use strict';

// The pending-feedback reminder: one nudge per unanswered request, and none
// for a client without a login.

const queries = [];
const ORG = '11111111-1111-4111-8111-111111111111';

let mockPending;
let mockNotificationCreated;

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params: params || [] });
    if (/^SELECT f\.id, f\.organization_id/i.test(flat)) {
      return { rows: mockPending, rowCount: mockPending.length };
    }
    if (/^INSERT INTO notifications/i.test(flat)) {
      return { rows: mockNotificationCreated ? [{ id: 'n1' }] : [], rowCount: mockNotificationCreated ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { runFeedbackReminders, REMIND_AFTER_HOURS } = require('../modules/session-feedback/feedback-reminders');

beforeEach(() => {
  queries.length = 0;
  mockNotificationCreated = true;
  mockPending = [
    {
      id: 'fb-1', organization_id: ORG, session_id: 's1', client_id: 'c1',
      session_title: 'Upper body', session_date: '2026-11-05', user_id: 'u1',
    },
    {
      id: 'fb-2', organization_id: ORG, session_id: 's2', client_id: 'c2',
      session_title: 'Legs', session_date: '2026-11-05', user_id: null,
    },
  ];
});

describe('pending feedback reminders', () => {
  it('looks at pending requests older than a day, never submitted ones', async () => {
    await runFeedbackReminders();
    const scan = queries[0];
    expect(scan.sql).toMatch(/f\.status = 'pending'/);
    expect(scan.sql).toMatch(/f\.completed_at < NOW\(\) - \(\$1::int \* INTERVAL '1 hour'\)/);
    expect(scan.sql).toMatch(/LEFT JOIN workout_sessions ws/);
    expect(scan.sql).toMatch(/COALESCE\(s\.title, ws\.program_name\) AS session_title/);
    expect(scan.params).toEqual([REMIND_AFTER_HOURS]);
    expect(REMIND_AFTER_HOURS).toBe(24);
  });

  it('sends one reminder to the linked client and skips a client without a login', async () => {
    const out = await runFeedbackReminders();

    expect(out).toEqual({ scanned: 2, sent: 1, skipped: 1 });
    const inserts = queries.filter((q) => /^INSERT INTO notifications/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toMatch(/session_feedback_reminder/);
    expect(inserts[0].sql).toMatch(/NOT EXISTS/);
    expect(inserts[0].params).toEqual([
      'u1',
      'A session is still waiting for your rating',
      'Rate "Upper body" — your trainer reads every answer.',
      'fb-1',
    ]);
  });

  it('a second sweep sends nothing new', async () => {
    mockNotificationCreated = false;
    const out = await runFeedbackReminders();
    expect(out.sent).toBe(0);
    expect(out.skipped).toBe(2);
    const insert = queries.find((q) => /^INSERT INTO notifications/i.test(q.sql));
    expect(insert.sql).toMatch(/NOT EXISTS/);
  });
});

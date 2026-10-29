'use strict';
// GET /command-center/timeline — one ordered list of what happened.
//
// The timeline is a join over two stores the platform was already writing:
// system_alerts (a CONDITION and its lifetime) and activity_log (every
// allow-listed command, with its outcome). No sampling job and no new table,
// so the properties that matter here are the merge and the window:
//
//   * a three-day incident must not vanish from a 24h view. An alert opened
//     before the window and still firing appears as `ongoing` at its last
//     observation instead of disappearing with its `opened` event.
//   * the window and the row cap are clamped server-side; both arrive from a
//     query string.
//   * a command's outcome and actor survive the merge, because "who pressed
//     restart, and did it work" is the question the timeline exists to answer.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockCalls = [];
let mockAlerts = [];
let mockCommands = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockCalls.push({ sql: flat, params: params || [] });
    if (/FROM system_alerts/i.test(flat)) return { rows: mockAlerts, rowCount: mockAlerts.length };
    if (/FROM activity_log/i.test(flat)) return { rows: mockCommands, rowCount: mockCommands.length };
    return { rows: [], rowCount: 0 };
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

const TIMELINE = '/api/super-admin/command-center/timeline';
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const alertRow = (over = {}) => ({
  id: 'a1',
  source: 'redis',
  severity: 'critical',
  title: 'Redis unreachable',
  reason: 'Connection refused',
  status: 'resolved',
  first_seen_at: iso(120),
  last_seen_at: iso(31),
  acknowledged_at: iso(60),
  acknowledged_by_name: 'Asha',
  resolved_at: iso(30),
  resolution: 'auto',
  ...over,
});

const commandRow = (over = {}) => ({
  id: 'c1',
  user_name: 'Asha',
  action: 'command_center.cache.flush',
  entity_id: 'cache.flush',
  new_data: {
    actor: { id: 'u1', name: 'Asha' },
    outcome: 'ok',
    duration_ms: 42,
    verdict: { outcome: 'healthy', summary: 'Cache cleared' },
  },
  created_at: iso(10),
  ...over,
});

beforeEach(() => { mockCalls.length = 0; mockAlerts = []; mockCommands = []; });

describe('the incident timeline', () => {
  it('merges alerts and commands newest-first, with their outcomes', async () => {
    mockAlerts = [
      alertRow(),
      alertRow({
        id: 'a2',
        title: 'Email delivery failing',
        reason: 'SMTP timeout',
        status: 'open',
        first_seen_at: iso(3 * 24 * 60),
        last_seen_at: iso(5),
        acknowledged_at: null,
        acknowledged_by_name: null,
        resolved_at: null,
        resolution: null,
      }),
    ];
    mockCommands = [
      commandRow(),
      commandRow({
        id: 'c2',
        action: 'command_center.worker.restart',
        entity_id: 'worker.restart',
        new_data: { actor: { name: 'Ravi' }, outcome: 'error', error: 'No worker container' },
        created_at: iso(20),
      }),
    ];

    const res = await request(app()).get(TIMELINE);
    expect(res.status).toBe(200);

    const events = res.body.data.events;
    expect(events.map((e) => e.id)).toEqual([
      // The long-running alert is still firing: `ongoing` at last_seen, not a
      // stale `opened` three days ago, and not missing.
      'alert:a2:ongoing',
      'command:c1',
      'command:c2',
      'alert:a1:resolved',
      'alert:a1:acknowledged',
      'alert:a1:opened',
    ]);
    expect(events.some((e) => e.id === 'alert:a2:opened')).toBe(false);

    const restart = events.find((e) => e.id === 'command:c2');
    expect(restart).toMatchObject({
      kind: 'command',
      source: 'worker.restart',
      actor: 'Ravi',
      outcome: 'error',
      detail: 'No worker container',
    });

    const flush = events.find((e) => e.id === 'command:c1');
    expect(flush).toMatchObject({ outcome: 'ok', actor: 'Asha', detail: 'Cache cleared' });

    expect(events.find((e) => e.id === 'alert:a1:acknowledged').actor).toBe('Asha');

    // Both reads are bounded by the same window and exclude soft-deleted rows.
    const alertSql = mockCalls.find((c) => /FROM system_alerts/i.test(c.sql));
    expect(alertSql.sql).toContain('deleted_at IS NULL');
    expect(alertSql.sql).toMatch(/last_seen_at > NOW\(\) - \(\$1 \|\| ' hours'\)::interval/);
    const commandSql = mockCalls.find((c) => /FROM activity_log/i.test(c.sql));
    expect(commandSql.sql).toContain("action LIKE 'command_center.%'");
    expect(commandSql.sql).toMatch(/created_at > NOW\(\) - \(\$1 \|\| ' hours'\)::interval/);
  });

  it('clamps the window and row cap at both ends', async () => {
    await request(app()).get(TIMELINE).query({ hours: '99999', limit: '9999' });
    expect(mockCalls[0].params).toEqual(['720', 200]);

    mockCalls.length = 0;
    await request(app()).get(TIMELINE).query({ hours: '-5', limit: '0' });
    expect(mockCalls[0].params).toEqual(['1', 60]);

    mockCalls.length = 0;
    await request(app()).get(TIMELINE);
    expect(mockCalls[0].params).toEqual(['24', 60]);
  });

  it('returns an empty list and the window when nothing happened', async () => {
    const res = await request(app()).get(TIMELINE).query({ hours: '168' });
    expect(res.body.data).toEqual({ events: [], window_hours: 168 });
  });
});

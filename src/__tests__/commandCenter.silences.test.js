'use strict';
// Alert silences.
//
// The property that matters is the difference between "do not page me" and
// "forget this happened". A silenced alert still opens, and because it is NOT
// claimed it is announced when the window closes if it is still firing. The
// last test here walks exactly that path.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockDb = { alert: null, silences: [], notifications: 0, seq: 0 };
const mockCollect = jest.fn();

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    if (/FROM alert_silences/.test(s)) return { rows: mockDb.silences };
    if (/INSERT INTO alert_silences/.test(s)) {
      const row = {
        id: String(mockDb.silences.length + 1), source: params[0], reason: params[1],
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + Number(params[2]) * 60_000).toISOString(),
        created_by: params[3], cancelled_at: null,
      };
      mockDb.silences.push(row);
      return { rows: [row] };
    }
    if (/UPDATE alert_silences/.test(s)) {
      const row = mockDb.silences.find((x) => x.id === params[0] && !x.cancelled_at);
      if (!row) return { rows: [] };
      row.cancelled_at = new Date().toISOString();
      return { rows: [row] };
    }

    if (/FROM users/.test(s) && /super_admin/.test(s)) {
      return { rows: [{ id: 'sa1', email: 'ops@myptstudio.com' }] };
    }
    if (/INSERT INTO notifications/.test(s)) {
      mockDb.notifications += 1;
      return { rows: [{ id: `n${mockDb.notifications}` }] };
    }
    if (/INSERT INTO system_alerts/.test(s)) {
      mockDb.seq += 1;
      mockDb.alert = {
        id: `a${mockDb.seq}`, fingerprint: params[0], source: params[1],
        severity: params[2], title: params[3], reason: params[4],
        status: 'open', occurrences: 1, notified_at: null,
      };
      return { rows: [mockDb.alert] };
    }
    if (/SELECT id, severity, notified_at FROM system_alerts/.test(s)) {
      return {
        rows: mockDb.alert
          ? [{ id: mockDb.alert.id, severity: mockDb.alert.severity, notified_at: mockDb.alert.notified_at }]
          : [],
      };
    }
    if (/^UPDATE system_alerts SET notified_at = NOW\(\)/.test(s)) {
      if (mockDb.alert) mockDb.alert.notified_at = new Date().toISOString();
      return { rows: mockDb.alert ? [mockDb.alert] : [] };
    }
    if (/^UPDATE system_alerts/.test(s) && /occurrences = occurrences \+ 1/.test(s)) {
      if (!mockDb.alert) return { rows: [] };
      mockDb.alert.occurrences += 1;
      mockDb.alert.reason = params[1];
      return { rows: [mockDb.alert] };
    }
    return { rows: [] };
  }),
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));
jest.mock('../lib/activityLog', () => ({ logActivity: jest.fn(async () => {}) }));
jest.mock('../lib/email', () => ({ isConfigured: jest.fn(() => false), sendRaw: jest.fn() }));
jest.mock('../modules/command-center/snapshot.service', () => ({ collect: mockCollect }));
jest.mock('../modules/command-center/index', () => ({
  registerCollectors: jest.fn(),
  registry: { names: () => ['redis', 'smtp'], get: () => null, runCollector: jest.fn() },
  snapshot: { collect: mockCollect },
}));

const request = require('supertest');
const express = require('express');
const alerts = require('../modules/command-center/alerts.service');
const silences = require('../modules/command-center/silences.service');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'sa1', name: 'Ops', role: 'super_admin' }; next(); });
  a.use('/api/super-admin', require('../modules/command-center/command-center.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const SILENCES = '/api/super-admin/command-center/silences';

function snapshotOf(cards) {
  return {
    status: 'critical', collected_at: new Date().toISOString(), duration_ms: 1,
    cards: Object.fromEntries(Object.entries(cards).map(([name, status]) => [
      name, { name, status, data: null, reason: status === 'healthy' ? null : `${name} is ${status}`, checked_at: '' },
    ])),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.alert = null;
  mockDb.silences = [];
  mockDb.notifications = 0;
  mockDb.seq = 0;
  alerts._resetStreaks();
});

describe('silence matching', () => {
  test('a null source covers every card; a named source matches exactly', () => {
    expect(silences.covers([{ source: null }], 'redis')).toBe(true);
    expect(silences.covers([{ source: 'redis' }], 'redis')).toBe(true);
    expect(silences.covers([{ source: 'redis' }], 'smtp')).toBe(false);
    // Deliberately not a pattern: `red%` must not silence redis.
    expect(silences.covers([{ source: 'red%' }], 'redis')).toBe(false);
  });
});

describe('silence API', () => {
  test('validates the source, reason and window', async () => {
    const a = app();
    expect((await request(a).post(SILENCES).send({ reason: 'Maintenance', minutes: 60, source: 'nope' })).status).toBe(400);
    expect((await request(a).post(SILENCES).send({ reason: 'x', minutes: 60 })).status).toBe(400);
    expect((await request(a).post(SILENCES).send({ reason: 'Maintenance', minutes: 1 })).status).toBe(400);
    expect((await request(a).post(SILENCES).send({ reason: 'Maintenance', minutes: 60, source: null })).status).toBe(201);
  });

  test('lists active windows and cancels without deleting the plan', async () => {
    const a = app();
    const created = await request(a).post(SILENCES)
      .send({ reason: 'Redis upgrade', minutes: 30, source: 'redis' });
    expect(created.status).toBe(201);
    expect(created.body.data.source).toBe('redis');

    const listed = await request(a).get(SILENCES);
    expect(listed.body.data.silences).toHaveLength(1);

    const cancelled = await request(a).delete(`${SILENCES}/${created.body.data.id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.cancelled_at).toBeTruthy();

    expect((await request(a).delete(`${SILENCES}/999`)).status).toBe(404);
  });
});

describe('a silenced alert', () => {
  test('still opens, is not announced, and is announced after the window if still firing', async () => {
    mockDb.silences = [{
      id: 's1', source: null, reason: 'Planned DB work',
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      ends_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      created_by: 'Ops',
    }];

    for (let i = 0; i < alerts.CONSECUTIVE_TO_OPEN; i++) {
      mockCollect.mockResolvedValueOnce(snapshotOf({ redis: 'critical' }));
      const out = await alerts.evaluate();
      if (i === alerts.CONSECUTIVE_TO_OPEN - 1) expect(out.silenced).toBe(1);
    }

    expect(mockDb.alert).not.toBeNull();
    expect(mockDb.alert.notified_at).toBeNull();
    expect(mockDb.notifications).toBe(0);

    // Window over, condition unchanged: the next pass pages.
    mockDb.silences = [];
    mockCollect.mockResolvedValueOnce(snapshotOf({ redis: 'critical' }));
    await alerts.evaluate();

    expect(mockDb.alert.notified_at).toBeTruthy();
    expect(mockDb.notifications).toBe(1);
  });
});

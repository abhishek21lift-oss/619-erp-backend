// POST /api/pt-os/clients/:id/checkin-insight — the route wiring around
// checkin-insight.js's pure generation logic: org scoping, the
// not-enough-data short circuit, and that it is quota-gated (a gap
// /clients/:id/coach has and this route deliberately does not repeat).
'use strict';

const ORG_A = '11111111-1111-1111-1111-111111111111';

const queries = [];
let mockClientRow = null;
let mockCheckinRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: flat, params });
    if (/FROM pt_clients/i.test(flat)) return { rows: mockClientRow ? [mockClientRow] : [] };
    if (/FROM weekly_checkins/i.test(flat)) return { rows: mockCheckinRows };
    return { rows: [] };
  }),
}));

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockUser;
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  adminManagerOrTrainer: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireSelfOrRole: () => (_req, _res, next) => next(),
  computeAccess: () => ({ allowed: true, state: 'active' }),
}));

const mockQuotaGuard = jest.fn((_req, _res, next) => next());
jest.mock('../lib/aiQuota', () => ({ requireAiQuota: () => mockQuotaGuard }));

const mockChatResult = { content: '{"summary":"Sleep dropped this week."}', model: 'test-model', usage: {}, latency_ms: 5, used_fallback: false };
const mockRoutedChat = jest.fn();
jest.mock('../lib/ai/router', () => ({ routedChat: (...a) => mockRoutedChat(...a) }));

const express = require('express');
const request = require('supertest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/pt-os', require('../modules/pt-os/pt-os.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const CHECKIN = (i) => ({
  weight: 70 + i, mood: 'ok', sleep_hours: 7, water_glasses: 6, client_notes: null,
  created_at: `2026-08-0${i}T00:00:00Z`,
});

beforeEach(() => {
  queries.length = 0;
  mockQuotaGuard.mockClear();
  mockRoutedChat.mockReset();
  mockRoutedChat.mockResolvedValue(mockChatResult);
  mockClientRow = { id: 'c1', name: 'Ajeet', organization_id: ORG_A };
  mockCheckinRows = [CHECKIN(1), CHECKIN(2)];
  mockUser = { id: 'u1', role: 'admin', organization_id: ORG_A };
});

test('the client lookup is scoped to the caller\'s own org', async () => {
  // The mock answers whatever it's told regardless of the WHERE clause, so
  // cross-org exclusion itself is orgWhere()'s own well-tested job (used
  // identically by every other route in this file); what this route has to
  // get right is USING it, which is what's asserted here.
  await request(app()).post('/api/pt-os/clients/c1/checkin-insight');
  const clientQuery = queries.find((q) => /FROM pt_clients/i.test(q.sql));
  expect(clientQuery.sql).toMatch(/organization_id/i);
  expect(clientQuery.params).toContain(ORG_A);
});

test('no matching client (wrong org or missing) is a 404, not a model call', async () => {
  mockClientRow = null;
  const res = await request(app()).post('/api/pt-os/clients/c1/checkin-insight');
  expect(res.status).toBe(404);
  expect(mockRoutedChat).not.toHaveBeenCalled();
});

test('fewer than two check-ins is a graceful non-answer, not a model call', async () => {
  mockCheckinRows = [CHECKIN(1)];
  const res = await request(app()).post('/api/pt-os/clients/c1/checkin-insight');
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ available: false, reason: 'not_enough_checkins', checkins_count: 1 });
  expect(mockRoutedChat).not.toHaveBeenCalled();
});

test('returns the drafted insight when there is enough history', async () => {
  const res = await request(app()).post('/api/pt-os/clients/c1/checkin-insight');
  expect(res.status).toBe(200);
  expect(res.body.data.available).toBe(true);
  expect(res.body.data.summary).toBe('Sleep dropped this week.');
  expect(mockRoutedChat).toHaveBeenCalledTimes(1);
  expect(mockRoutedChat.mock.calls[0][0].intent).toBe('checkin');
});

test('is quota-gated, unlike /coach', async () => {
  await request(app()).post('/api/pt-os/clients/c1/checkin-insight');
  expect(mockQuotaGuard).toHaveBeenCalledTimes(1);
});

test('no business record is ever written — only the usage-log insert every AI call makes', async () => {
  await request(app()).post('/api/pt-os/clients/c1/checkin-insight');
  const writes = queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql));
  for (const w of writes) {
    expect(w.sql).toMatch(/INSERT INTO ai_usage_log/i);
  }
});

'use strict';
// POST /api/ai/chat may not be handed another studio's client.
//
// `client_id` arrives in the request body and was stored on the conversation
// unchecked. The READ paths were already safe — buildClientContext() and
// loadAuthoritativeClient() both await the org-scoped pt_clients lookup first
// and return nothing for a foreign id before any child query runs — so this
// was never a leak.
//
// What it was is referential pollution: a conversation row in the caller's
// studio pointing at another studio's client. lib/orgGuard.js exists for
// exactly that shape ("the row would then land in the caller's org pointing at
// a foreign client … and a foothold for PII-copy bugs"), and every other write
// path that takes a client id from a caller already uses it.

process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
// requireConfigured() answers 501 before any handler runs when this is unset,
// which would make every assertion below pass for the wrong reason.
process.env.OPENROUTER_API_KEY = 'test-key-not-used-because-the-gate-refuses-first';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockQueries = [];
/** pt_clients rows the org guard will find. Empty = the client is not ours. */
let mockClientRows = [];

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    mockQueries.push({ sql: flat, params: params || [] });
    if (/FROM pt_clients/i.test(flat)) return { rows: mockClientRows, rowCount: mockClientRows.length };
    if (/INSERT INTO ai_conversations/i.test(flat)) return { rows: [{ id: 'conv-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => {
    req.user = { id: 'usr-1', role: 'admin', organization_id: '11111111-1111-4111-8111-111111111111' };
    next();
  },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/ai', require('../routes/ai'));

const conversationWrites = () =>
  mockQueries.filter((q) => /INSERT INTO ai_conversations/i.test(q.sql));

beforeEach(() => {
  mockQueries.length = 0;
  mockClientRows = [];
});

describe('POST /api/ai/chat gates the client id', () => {
  it('does not persist a client the caller studio does not own', async () => {
    mockClientRows = []; // the org-scoped lookup finds nothing
    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hello', client_id: 'client-in-studio-b' });

    const [insert] = conversationWrites();
    expect(insert).toBeDefined();
    // The conversation is opened with NO client rather than another studio's.
    expect(insert.params).toEqual(['usr-1', null, 'hello']);
  });

  it('persists a client the caller studio does own', async () => {
    // The negative above is also satisfied by never storing a client at all,
    // which would break the feature. This is what separates "gated" from
    // "broken".
    mockClientRows = [{ ok: 1 }];
    await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hello', client_id: 'our-client' });

    const [insert] = conversationWrites();
    expect(insert.params).toEqual(['usr-1', 'our-client', 'hello']);
  });

  it('a foreign client is indistinguishable from an unknown one', async () => {
    // Deliberate: this route makes foreign, unknown and soft-deleted clients
    // behave identically, so the response cannot be used to discover which
    // ids exist in another studio. Refusing with a 404 — the first version of
    // this fix — would have broken that AND started rejecting a caller's own
    // archived client.
    mockClientRows = [];
    const res = await request(app)
      .post('/api/ai/chat')
      .send({ message: 'hello', client_id: 'client-in-studio-b' });
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('checks ownership against pt_clients with the caller org bound', async () => {
    mockClientRows = [];
    await request(app).post('/api/ai/chat').send({ message: 'hi', client_id: 'c-1' });

    const guard = mockQueries.find((q) => /FROM pt_clients/i.test(q.sql));
    expect(guard).toBeDefined();
    expect(guard.sql).toMatch(/organization_id\s*=\s*\$\d/i);
    expect(guard.params).toContain(ORG_A);
  });

  it('runs the ownership check before the conversation is opened', async () => {
    // Order is the whole point. Checked after the INSERT, the foreign id is
    // already on the row and the gate has nothing left to protect.
    mockClientRows = [];
    await request(app).post('/api/ai/chat').send({ message: 'hi', client_id: 'c-1' });

    const guardAt = mockQueries.findIndex((q) => /FROM pt_clients/i.test(q.sql));
    const insertAt = mockQueries.findIndex((q) => /INSERT INTO ai_conversations/i.test(q.sql));
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(guardAt);
  });

  it('a request with no client_id is unaffected', async () => {
    // The guard must not turn "no client selected" — the ordinary case — into
    // a 404. A missing id is nothing to check, not a failed check.
    await request(app).post('/api/ai/chat').send({ message: 'hello' });
    expect(mockQueries.some((q) => /FROM pt_clients/i.test(q.sql))).toBe(false);
    const [insert] = conversationWrites();
    expect(insert.params).toEqual(['usr-1', null, 'hello']);
  });
});

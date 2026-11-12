'use strict';
// GET /api/ai/copilot tool-run history.
//
// The tenant and user come from the authenticated request only. A foreign
// conversation, a foreign run and an unknown id are all a 404 with the same
// body, so the endpoint never confirms that someone else's id exists.

jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db/pool');
const router = require('../modules/copilot/copilot.routes');

const ORG = '11111111-1111-1111-1111-111111111111';

let currentUser;
const app = express();
app.use((req, _res, next) => {
  req.user = currentUser;
  next();
});
app.use('/api/ai/copilot', router);

const LIST_ROW = {
  id: 'run-1', tool_name: 'get_client_profile', level: 'READ', status: 'ok',
  error_code: null, error_category: null, duration_ms: 4, source: 'pt-os.client-read',
  source_as_of: '2026-01-01', freshness: { stale: false }, result_meta: { records: 1 },
  client_id: 'client-1', selection_reason: 'profile_intent',
  created_at: '2026-01-01T00:00:00.000Z',
  // Present in the row only to prove the response whitelist drops it:
  organization_id: ORG, user_id: 'usr-1', run_key: 'secret-key',
};

const DETAIL_ROW = {
  ...LIST_ROW,
  conversation_id: 'conv-1', message_id: 'msg-1', correlation_id: 'corr-1',
  sensitivity: 'personal', args_digest: 'digest-1', args_meta: { limit: 10 },
  source_refs: [{ type: 'pt_clients', id: 'client-1' }],
};

const conversationOwned = (rows = [{ id: 'conv-1' }]) => {
  pool.query.mockResolvedValueOnce({ rows });
};

beforeEach(() => {
  pool.query.mockReset();
  currentUser = { id: 'usr-1', role: 'trainer', organization_id: ORG };
});

describe('GET /conversations/:id/tool-runs', () => {
  test('returns the sanitized runs of an owned conversation', async () => {
    conversationOwned();
    pool.query.mockResolvedValueOnce({ rows: [LIST_ROW] });

    const res = await request(app).get('/api/ai/copilot/conversations/conv-1/tool-runs');

    expect(res.status).toBe(200);
    expect(res.body.next).toBeNull();
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toEqual({
      id: 'run-1', tool: 'get_client_profile', level: 'READ', status: 'ok',
      error_code: null, error_category: null, duration_ms: 4,
      source: 'pt-os.client-read', as_of: '2026-01-01',
      freshness: { stale: false }, result: { records: 1 }, client_scoped: true,
      selection_reason: 'profile_intent',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/secret-key|organization_id|user_id|args_digest/);

    // Ownership was re-checked with the authenticated user and tenant.
    const [ownSql, ownParams] = pool.query.mock.calls[0];
    expect(ownSql).toMatch(/id = \$1 AND user_id = \$2 AND organization_id = \$3/);
    expect(ownParams).toEqual(['conv-1', 'usr-1', ORG]);

    const [listSql, listParams] = pool.query.mock.calls[1];
    expect(listSql).toMatch(/organization_id = \$1 AND user_id = \$2 AND conversation_id = \$3/);
    expect(listParams).toEqual([ORG, 'usr-1', 'conv-1', 50]);
  });

  test('a foreign conversation is the same 404 as an unknown one', async () => {
    conversationOwned([]);

    const res = await request(app).get('/api/ai/copilot/conversations/someone-else/tool-runs');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' } });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).not.toMatch(/ai_tool_runs/);
  });

  test('a missing organization is refused before any read', async () => {
    currentUser = { id: 'usr-1', role: 'trainer', organization_id: null };

    const res = await request(app).get('/api/ai/copilot/conversations/conv-1/tool-runs');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_TENANT');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a non-trainer is refused before any read', async () => {
    currentUser = { id: 'm1', role: 'member', organization_id: ORG };

    const res = await request(app).get('/api/ai/copilot/conversations/conv-1/tool-runs');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('invalid pagination is rejected without a query', async () => {
    for (const query of ['limit=0', 'limit=101', 'limit=x', 'before=not-a-date', 'before_id=']) {
      const res = await request(app).get(`/api/ai/copilot/conversations/conv-1/tool-runs?${query}`);
      expect(res.status).toBe(400);
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a full page returns a keyset cursor and passes it through on the next call', async () => {
    conversationOwned();
    pool.query.mockResolvedValueOnce({ rows: [LIST_ROW] });

    const first = await request(app)
      .get('/api/ai/copilot/conversations/conv-1/tool-runs?limit=1');

    expect(first.body.next).toEqual({
      before: '2026-01-01T00:00:00.000Z', before_id: 'run-1',
    });

    conversationOwned();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const next = await request(app).get(
      '/api/ai/copilot/conversations/conv-1/tool-runs?limit=1'
      + '&before=2026-01-01T00%3A00%3A00.000Z&before_id=run-1'
    );

    expect(next.status).toBe(200);
    expect(next.body.next).toBeNull();
    const [sql, params] = pool.query.mock.calls[3];
    expect(sql).toMatch(/\(created_at, id\) < \(\$4::timestamptz, \$5\)/);
    expect(params).toEqual([ORG, 'usr-1', 'conv-1', '2026-01-01T00:00:00.000Z', 'run-1', 1]);
  });
});

describe('GET /tool-runs/:id', () => {
  test('returns one sanitized detail row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [DETAIL_ROW] });

    const res = await request(app).get('/api/ai/copilot/tool-runs/run-1');

    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({
      id: 'run-1', tool: 'get_client_profile', conversation_id: 'conv-1',
      message_id: 'msg-1', correlation_id: 'corr-1', client_scoped: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/secret-key|organization_id|user_id|run_key/);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/id = \$1 AND organization_id = \$2 AND user_id = \$3/);
    expect(params).toEqual(['run-1', ORG, 'usr-1']);
  });

  test('a foreign or unknown run is a generic 404', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/ai/copilot/tool-runs/someone-elses-run');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'TOOL_RUN_NOT_FOUND', message: 'Tool run not found' } });
  });

  test('a missing organization is refused before any read', async () => {
    currentUser = { id: 'usr-1', role: 'trainer', organization_id: null };

    const res = await request(app).get('/api/ai/copilot/tool-runs/run-1');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_TENANT');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

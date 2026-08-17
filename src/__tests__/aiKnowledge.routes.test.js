'use strict';
// POST /api/ai/knowledge/:id/reindex — tenant-safe restart of document
// ingestion for a document stuck in `processing` (or failed).
//
// The route must:
//   * accept only admin/manager (requireRole — the real middleware is used)
//   * verify the document exists AND belongs to the caller's org
//   * enqueue BullMQ job name=reindex_document data={ documentId }
//   * NOT ingest inline while Redis is available (asynchronous via the queue)
//   * return the documented "Reindexing started" message

jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db/pool', () => ({ query: jest.fn() }));
jest.mock('../lib/redis', () => ({
  ensureReady: jest.fn().mockResolvedValue(true),
  getConnection: jest.fn(),
  getWorkerConnection: jest.fn(),
}));
jest.mock('../jobs/queue', () => ({
  aiQueue: { add: jest.fn().mockResolvedValue({ id: 'job-1' }) },
}));
jest.mock('../lib/fileStorage', () => ({
  saveFile: jest.fn(),
  deleteFile: jest.fn(),
}));
// Direct ingestion must never run in the request path while Redis is up —
// this spy proves the fallback is left unused.
jest.mock('../lib/ai/knowledgeBase', () => ({
  ingestDocument: jest.fn().mockResolvedValue(undefined),
}));

let mockUser = { id: 'u1', role: 'admin', organization_id: 'org-1' };

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { aiQueue } = require('../jobs/queue');
const { ingestDocument } = require('../lib/ai/knowledgeBase');

const app = express();
app.use(express.json());
app.use('/api/ai/knowledge', require('../routes/aiKnowledge'));

/** Flush the route's fire-and-forget dispatchAiJob promise chain. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  pool.query.mockReset();
  aiQueue.add.mockClear(); // clears calls but keeps the mockResolvedValue
  ingestDocument.mockReset();
  mockUser = { id: 'u1', role: 'admin', organization_id: 'org-1' };
});

describe('POST /api/ai/knowledge/:id/reindex', () => {
  test('an authorized admin can reindex a document in their own org', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('ai_documents WHERE id')) return Promise.resolve({ rows: [{ id: 'doc-1' }] });
      if (sql.includes('UPDATE ai_documents')) return Promise.resolve({ rows: [], rowCount: 1 });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).post('/api/ai/knowledge/doc-1/reindex');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Reindexing started');

    await flush();

    // The ownership check ran org-scoped: only the caller's org could match.
    const [sql, params] = pool.query.mock.calls.find(([s]) => s.includes('ai_documents WHERE id'));
    expect(sql).toContain('organization_id = $2');
    expect(params).toEqual(['doc-1', 'org-1']);

    // Status was reset to processing before enqueueing.
    expect(pool.query.mock.calls.some(([s]) => s.includes("SET status = 'processing'"))).toBe(true);

    // BullMQ contract: name = reindex_document, data = { documentId }.
    expect(aiQueue.add).toHaveBeenCalledTimes(1);
    expect(aiQueue.add).toHaveBeenCalledWith('reindex_document', { documentId: 'doc-1' }, {});

    // Redis is available → enqueued, so no inline ingestion ran.
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test('an authorized manager can reindex a document in their own org', async () => {
    mockUser = { id: 'm1', role: 'manager', organization_id: 'org-2' };
    pool.query.mockImplementation((sql) => {
      if (sql.includes('ai_documents WHERE id')) return Promise.resolve({ rows: [{ id: 'doc-2' }] });
      if (sql.includes('UPDATE ai_documents')) return Promise.resolve({ rows: [], rowCount: 1 });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).post('/api/ai/knowledge/doc-2/reindex');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Reindexing started');

    await flush();

    const [, params] = pool.query.mock.calls.find(([s]) => s.includes('ai_documents WHERE id'));
    expect(params).toEqual(['doc-2', 'org-2']);
    expect(aiQueue.add).toHaveBeenCalledWith('reindex_document', { documentId: 'doc-2' }, {});
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test('a cross-tenant document returns 404 and nothing is enqueued', async () => {
    // The org-scoped SELECT returns no rows for a document owned elsewhere —
    // this is the DB enforcing the boundary, exactly as in production.
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/ai/knowledge/other-org-doc/reindex');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    await flush();
    expect(aiQueue.add).not.toHaveBeenCalled();
    expect(ingestDocument).not.toHaveBeenCalled();
    // The status was never touched for a document the caller cannot reach.
    expect(pool.query.mock.calls.some(([s]) => s.includes('UPDATE ai_documents'))).toBe(false);
  });

  test('a nonexistent document returns 404', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/ai/knowledge/ghost/reindex');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await flush();
    expect(aiQueue.add).not.toHaveBeenCalled();
  });

  test('an unauthorized role is rejected before any query runs', async () => {
    mockUser = { id: 't1', role: 'trainer', organization_id: 'org-1' };

    const res = await request(app).post('/api/ai/knowledge/doc-1/reindex');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(pool.query).not.toHaveBeenCalled();
    expect(aiQueue.add).not.toHaveBeenCalled();
  });

  test('a super admin without a target org gets no bypass — the route is admin/manager only', async () => {
    mockUser = { id: 'sa-1', role: 'super_admin', organization_id: null };

    const res = await request(app).post('/api/ai/knowledge/doc-1/reindex');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
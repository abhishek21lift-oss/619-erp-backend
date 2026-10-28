'use strict';
// MPTS corpus lifecycle (migration 232 + modules/platform/super-admin/knowledge.js):
//   * a shared corpus document is NOT a generation source until it is both
//     ingestion-'ready' AND approval-'approved' (the review gate);
//   * approving a version deterministically supersedes the prior approved one
//     of the same title family (no contradictory versions live at once);
//   * revocation removes a version from the retrieval set without destroying
//     history;
//   * duplicate bytes cannot enter the corpus twice;
//   * every mutation leaves an activity_log row (platform audit precedent).

jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../lib/fileStorage', () => ({
  saveFile: jest.fn(),
  deleteFile: jest.fn(),
  getFileBuffer: jest.fn(),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({
  deleteDocument: jest.fn().mockResolvedValue(undefined),
  getCorpusVersion: jest.fn().mockResolvedValue('mpts-v20261020000000-n1'),
}));
jest.mock('../lib/logger', () => ({
  warn: jest.fn(), error: jest.fn(), info: jest.fn(), child: jest.fn(() => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() })),
}));
jest.mock('../middleware/errorHandler', () => ({
  invalidFileType: jest.fn((msg) => new Error(msg)),
}));
jest.mock('../services/ai.service', () => ({
  dispatchAiJob: jest.fn().mockResolvedValue({ id: 'job-1' }),
}));
// Needed only because requireActual's getCorpusVersion exercises the real
// knowledgeBase module graph below.
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn(), embedBatch: jest.fn(), toVectorLiteral: jest.fn(() => '[]'),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
}));
jest.mock('../lib/ai/textExtract', () => ({ extractText: jest.fn(), SUPPORTED_MIME_TYPES: ['application/pdf', 'text/plain'] }));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { deleteDocument, getCorpusVersion } = require('../lib/ai/knowledgeBase');
const { dispatchAiJob } = require('../services/ai.service');

const routerModule = require('../modules/platform/super-admin/knowledge');
const app = express();
app.use(express.json());
app.use('/api/platform', routerModule);

const GLOBAL_DOC = (over = {}) => ({
  id: 'doc-9', title: 'MPTS Training Methodology', source_version: '2026-10', category: 'sop',
  status: 'ready', chunk_count: 12, content_hash: 'sha:abc', approval_status: 'pending',
  approved_by: null, approved_at: null, is_global: true, organization_id: null, ...over,
});

let clientMock;

// One mock for both the flat pool and the transaction client. impl() is keyed
// on SQL; the transaction client additionally records BEGIN/COMMIT ordering.
function mockPool(impl) {
  pool.query.mockReset();
  pool.query.mockImplementation(impl ? async (sql, params) => impl(sql, params) : async () => ({ rows: [] }));
  clientMock = { queries: [] };
  clientMock.query = jest.fn(async (sql, params) => {
    clientMock.queries.push([sql, params]);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
    if (impl) return impl(sql, params);
    return { rows: [] };
  });
  clientMock.release = jest.fn();
  pool.connect.mockReset();
  pool.connect.mockResolvedValue(clientMock);
}

describe('corpus lifecycle router', () => {
  test('approve requires ingestion to have finished (ready)', async () => {
    mockPool((sql) => {
      if (sql.startsWith('SELECT * FROM ai_documents')) return { rows: [GLOBAL_DOC({ status: 'processing' })] };
      return { rows: [] };
    });
    const res = await request(app).post('/api/platform/ai/knowledge/doc-9/approve');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_READY');
  });

  test('approve activates the document and supersedes the prior approved version in one transaction', async () => {
    mockPool((sql) => {
      if (sql.startsWith('SELECT * FROM ai_documents')) return { rows: [GLOBAL_DOC()] };
      if (sql.startsWith('SELECT id, title, source_version, approval_status')) {
        return { rows: [GLOBAL_DOC({ approval_status: 'approved', approved_at: '2026-10-20T00:00:00Z' })] };
      }
      return { rows: [] };
    });
    const res = await request(app).post('/api/platform/ai/knowledge/doc-9/approve');
    expect(res.status).toBe(200);
    expect(res.body.data.approval_status).toBe('approved');
    expect(res.body.corpus_version).toMatch(/^mpts-v/);

    // Transaction order: BEGIN → approve → supersede → COMMIT
    const order = clientMock.queries.map(([sql]) => sql.trim().split(/[\s(]/)[0]);
    expect(order[0]).toBe('BEGIN');
    expect(order).toContain('COMMIT');
    expect(order.indexOf('COMMIT')).toBeGreaterThan(order.indexOf('BEGIN'));

    // The supersede statement is part of THIS transaction, family-scoped and
    // never touches the new version itself.
    const supersede = clientMock.queries.find(([sql]) => sql.includes("approval_status = 'revoked'"));
    expect(supersede).toBeTruthy();
    expect(supersede[0]).toContain('id <> $1');
    expect(supersede[0]).toContain('LOWER(BTRIM(title)) = $2');
    expect(supersede[1]).toEqual(['doc-9', 'mpts training methodology']);

    // Platform mutation left an audit row.
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('activity_log'))).toBe(true);
  });

  test('approve refuses an already-approved document (no version-bump side channel)', async () => {
    mockPool((sql) => {
      if (sql.startsWith('SELECT * FROM ai_documents')) return { rows: [GLOBAL_DOC({ approval_status: 'approved' })] };
      return { rows: [] };
    });
    const res = await request(app).post('/api/platform/ai/knowledge/doc-9/approve');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_APPROVED');
  });

  test('approve returns 404 for documents of the studios, not the corpus', async () => {
    mockPool(() => ({ rows: [] }));
    const res = await request(app).post('/api/platform/ai/knowledge/unknown-id/approve');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('revoke takes an approved version out of the corpus; revoking a non-approved one is a 404', async () => {
    mockPool((sql) => {
      // RETURNING reports the NEW row state.
      if (sql.startsWith("UPDATE ai_documents SET approval_status = 'revoked'")) {
        return { rows: [{ id: 'doc-9', title: 'MPTS Training Methodology', source_version: '2026-10', approval_status: 'revoked' }] };
      }
      return { rows: [] };
    });
    const res = await request(app).post('/api/platform/ai/knowledge/doc-9/revoke');
    expect(res.status).toBe(200);
    expect(res.body.data.approval_status).toBe('revoked');
    expect(getCorpusVersion).toHaveBeenCalled();

    // Idempotence guard: a second revoke finds nothing approved to flip.
    mockPool(() => ({ rows: [] }));
    const res2 = await request(app).post('/api/platform/ai/knowledge/doc-9/revoke');
    expect(res2.status).toBe(404);
  });

  test('duplicate bytes are refused and name the document already holding them', async () => {
    mockPool((sql) => {
      if (sql.includes("content_hash = $1 AND approval_status <> 'revoked'")) {
        return { rows: [{ id: 'doc-1', title: 'MPTS WPD SOP', category: 'sop', approval_status: 'approved', status: 'ready' }] };
      }
      return { rows: [] };
    });
    const res = await request(app)
      .post('/api/platform/ai/knowledge')
      .attach('file', Buffer.from('%PDF-1.4 duplicate'), { filename: 'mpts.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_DOCUMENT');
    // The message must identify the existing document, or the rejected
    // upload looks like a failure rather than "these are the same file".
    expect(res.body.error.message).toContain('"MPTS WPD SOP"');
    expect(res.body.error.message).toContain('(sop, approved, ready)');
  });

  test('a first upload inserts a PENDING global document with a content hash (review gate)', async () => {
    mockPool((sql) => {
      if (sql.includes('INSERT INTO ai_documents')) {
        return {
          rows: [{ id: 'doc-new', title: 'MPTS Training Methodology', source_version: '2026-10',
                   category: 'sop', filename: 'mpts.pdf', mime_type: 'application/pdf',
                   file_size_bytes: 22, status: 'processing', chunk_count: 0,
                   approval_status: 'pending', created_at: '2026-10-20' }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app)
      .post('/api/platform/ai/knowledge')
      .attach('file', Buffer.from('%PDF-1.4 methodology v1'), { filename: 'mpts.pdf', contentType: 'application/pdf' })
      .field('title', 'MPTS Training Methodology')
      .field('source_version', '2026-10');
    expect(res.status).toBe(201);
    expect(res.body.data.approval_status).toBe('pending');

    const [sql, params] = pool.query.mock.calls.find(([s]) => s.includes('INSERT INTO ai_documents'));
    // Tenancy is hard-coded in the statement — platform corpus docs are
    // global, org-less, and never request-influenced.
    expect(sql).toContain('VALUES ($1, NULL, TRUE,');
    expect(params[8]).toBe('2026-10');       // source_version
    expect(params[9]).toMatch(/^[0-9a-f]{64}$/); // content_hash (sha256 of bytes)
    expect(sql).toContain("'pending'");

    await flush();
    expect(dispatchAiJob).toHaveBeenCalledWith('ingest_document', { documentId: expect.anything() }, expect.anything());
  });

  test('reindexing an active version demotes it to pending (never half-built evidence)', async () => {
    mockPool((sql) => {
      if (sql.startsWith('UPDATE ai_documents SET status')) return { rows: [{ id: 'doc-9' }] };
      return { rows: [] };
    });
    const res = await request(app).post('/api/platform/ai/knowledge/doc-9/reindex');
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes("SET approval_status = 'pending'"))).toBe(true);

    const flush = () => new Promise((resolve) => setImmediate(resolve));
    await flush();
    expect(dispatchAiJob).toHaveBeenCalledWith('reindex_document', { documentId: 'doc-9' }, expect.anything());
  });

  test('delete removes the corpus document and audits it', async () => {
    mockPool((sql) => {
      if (sql.startsWith('SELECT id, title')) return { rows: [GLOBAL_DOC()] };
      return { rows: [] };
    });
    const res = await request(app).delete('/api/platform/ai/knowledge/doc-9');
    expect(res.status).toBe(200);
    expect(deleteDocument).toHaveBeenCalledWith('doc-9');
  });
});

describe('getCorpusVersion', () => {
  test('the corpus version is derived from approved global documents only', async () => {
    // Deps (pool/logger/files/embeddings) resolve to this file's top-level
    // mocks; only the module under test is the real implementation.
    const realKnowledgeBase = jest.requireActual('../lib/ai/knowledgeBase');
    pool.query.mockReset();
    pool.query.mockResolvedValue({
      rows: [{ n: 3, last_approved: new Date('2026-10-20T04:11:22Z') }],
    });

    const version = await realKnowledgeBase.getCorpusVersion();

    expect(version).toBe('mpts-v20261020041122-n3');
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("approval_status = 'approved'");
    expect(sql).toContain('is_global = TRUE');
    expect(sql).toContain("status = 'ready'");
  });
});

describe('migration 232 (schema contract)', () => {
  const sqlPath = path.join(__dirname, '../db/migrations/232_mpts_knowledge_lifecycle.sql');
  const ddl = fs.readFileSync(sqlPath, 'utf8');

  test('the lifecycle columns + ledger exist and are tenant-scoped', () => {
    expect(ddl).toContain('source_version');
    expect(ddl).toContain('content_hash');
    expect(ddl).toContain('approval_status');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS ai_retrieval_log');
    // The ledger is org-scoped (tenant isolation convention), nullable only
    // for platform-plane queries.
    expect(ddl).toMatch(/organization_id\s+UUID/);
    expect(ddl).toContain("approval_status IN ('pending', 'approved', 'revoked')");
  });
});

/** Flush the route's fire-and-forget dispatchAiJob promise chain. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

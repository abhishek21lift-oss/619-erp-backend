'use strict';
// MPTS Slice 3 — tenancy/isolation hard checks for the knowledge plane and
// the studio AI routes, filling the gaps the existing suites leave:
//   * aiKnowledge.list / POST / / DELETE /:id (search + reindex already have
//     their own suites; the corpus lifecycle lives in mpts.corpus.lifecycle)
//   * member vs trainer vs platform-plane role gates on the knowledge router
//   * the "no route registers without the auth middleware" convention
//
// Isolation is asserted where it is actually implemented: the org-scoped SQL
// the route builds (tenant-db tenantScope — the header-proof rule), plus
// behavioural fail-closed checks on the handlers themselves.

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
  saveFile: jest.fn().mockResolvedValue(undefined),
  deleteFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/ai/knowledgeBase', () => ({
  ingestDocument: jest.fn().mockResolvedValue(undefined),
  deleteDocument: jest.fn().mockResolvedValue(undefined),
  retrieveContext: jest.fn().mockResolvedValue([]),
}));

let mockUser = { id: 'u1', role: 'trainer', organization_id: 'org-1' };

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');
const { aiQueue } = require('../jobs/queue');
const { ingestDocument, deleteDocument } = require('../lib/ai/knowledgeBase');
const { deleteFile, saveFile } = require('../lib/fileStorage');

const app = express();
app.use(express.json());
app.use('/api/ai/knowledge', require('../routes/aiKnowledge'));

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  pool.query.mockReset();
  aiQueue.add.mockClear();
  ingestDocument.mockReset();
  deleteDocument.mockReset();
  saveFile.mockClear();
  deleteFile.mockClear();
  mockUser = { id: 'u1', role: 'trainer', organization_id: 'org-1' };
});

describe('DELETE /api/ai/knowledge/:id stays inside the studio', () => {
  test("a document of ANOTHER studio returns 404 and is not deleted anywhere", async () => {
    // THE gate: the org clause rides along in the existence SELECT.
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).delete('/api/ai/knowledge/doc-1');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  test("the SELECT it relies on carries the org scoping clause", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app).delete('/api/ai/knowledge/doc-1');
    expect(pool.query.mock.calls[0][0]).toContain('AND organization_id = $2');
    expect(pool.query.mock.calls[0][1]).toEqual(['doc-1', 'org-1']);
  });

  test("a document of the caller's own studio deletes for real", async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'doc-1' }] });

    const res = await request(app).delete('/api/ai/knowledge/doc-1');
    await flush();

    expect(res.status).toBe(200);
    expect(deleteDocument).toHaveBeenCalledWith('doc-1');
  });
});

describe('GET /api/ai/knowledge lists only the caller studio', () => {
  test("the list query is scoped to the caller's organization, never a header", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/ai/knowledge');

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toContain('WHERE d.organization_id = $1');
    expect(pool.query.mock.calls[0][1]).toEqual(['org-1']);
  });
});

describe('role/object level gates on the knowledge router', () => {
  test('a member account is refused before any query runs', async () => {
    mockUser = { id: 'm1', role: 'member', organization_id: 'org-1' };

    const res = await request(app).get('/api/ai/knowledge');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('the platform plane is refused on a tenant route (no super-admin bypass)', async () => {
    mockUser = { id: 'sa1', role: 'super_admin', organization_id: null };

    const res = await request(app).get('/api/ai/knowledge');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/knowledge — upload is studio-scoped', () => {
  const attach = () => request(app)
    .post('/api/ai/knowledge')
    .field('title', 'Programming SOP')
    .field('category', 'sop')
    .attach('file', Buffer.from('MPTS SOP body'), { filename: 'sop.txt', contentType: 'text/plain' });

  test("a studio trainer's upload stamps THEIR org and can never create a global document", async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'doc-9', organization_id: 'org-1', is_global: false }] });

    const res = await attach();
    await flush();

    expect(res.status).toBe(201);
    const [sql, params] = pool.query.mock.calls.find(([q]) => q.includes('INSERT INTO ai_documents'));
    expect(sql).toContain('organization_id');
    expect(params[1]).toBe('org-1');       // the caller's studio — not a request field
    expect(params[2]).toBe(false);         // is_global is never trusted from the request
    expect(saveFile).toHaveBeenCalled();
    expect(ingestDocument).not.toHaveBeenCalled();
    expect(aiQueue.add).toHaveBeenCalledWith('ingest_document', expect.objectContaining({ documentId: expect.any(String) }), expect.anything());
  });

  test("an account with no studio never reaches the upload handler", async () => {
    // requireTrainer itself refuses a trainer without an organization — the
    // route's own NO_ORG branch is defense-in-depth behind that guard.
    mockUser = { id: 't2', role: 'trainer', organization_id: null };

    const res = await attach();
    await flush();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(pool.query).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(aiQueue.add).not.toHaveBeenCalled();
  });
});

describe('no AI route registers without the auth middleware', () => {
  // Unauthenticated 401s come from the shared auth middleware — which only
  // protects what it is actually mounted on. This pins the mounting itself,
  // in the same source-assert style aiKnowledge.search.test.js uses for
  // route ordering.
  test('every route line in both AI routers starts with auth', () => {
    // Minimums: the sweep is doing more than scanning zero routes.
    const minRoutes = { 'src/routes/ai.js': 16, 'src/routes/aiKnowledge.js': 5 };
    for (const file of Object.keys(minRoutes)) {
      const src = require('fs').readFileSync(file, 'utf8');
      const routeLines = src.split('\n').filter((l) => /^router\.(get|post|delete|patch|put)\(/.test(l));
      expect(routeLines.length).toBeGreaterThanOrEqual(minRoutes[file]);
      for (const line of routeLines) {
        const name = `${file}: ${line.trim().slice(0, 60)}`;
        expect({ name, authFirst: new RegExp(`^router\\.\\w+\\('[^']*',\\s*auth\\b`).test(line) }).toEqual({ name, authFirst: true });
      }
    }
  });
});

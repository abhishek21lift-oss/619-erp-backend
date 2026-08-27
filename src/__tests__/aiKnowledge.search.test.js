// Retrieval over a studio's own SOPs, guides and policies.
//
// The dangerous failures here are not 500s. They are:
//   * one studio's policy text surfacing in another studio's search,
//   * an empty result reported as "you have no such policy" when the studio has
//     a library and the query simply missed,
//   * a caller spending a studio's AI quota by pasting a novel into ?q=.
// Each has a test below; none of them throws on the way.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

let mockUser = { id: 'u1', role: 'trainer', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
}));

const mockRetrieve = jest.fn();
jest.mock('../lib/ai/knowledgeBase', () => ({
  ingestDocument: jest.fn(),
  deleteDocument: jest.fn(),
  retrieveContext: (...a) => mockRetrieve(...a),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/ai/knowledge', require('../routes/aiKnowledge'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const CHUNK = (over = {}) => ({
  content: 'Sessions cancelled with less than 24 hours notice are charged in full.',
  title: 'Cancellation Policy',
  category: 'policy',
  document_id: 'doc-1',
  chunk_index: 0,
  similarity: 0.81,
  ...over,
});

/** The document-count query this route always runs first. */
const mockDocCount = (n) => pool.query.mockResolvedValueOnce({ rows: [{ n }] });

beforeEach(() => {
  pool.query.mockReset();
  mockRetrieve.mockReset();
  mockRetrieve.mockResolvedValue([]);
  mockUser = { id: 'u1', role: 'trainer', organization_id: 'org-1' };
});

describe('tenant isolation', () => {
  test('retrieval is scoped to the caller\'s organization, never a supplied one', async () => {
    mockDocCount(3);
    mockRetrieve.mockResolvedValue([CHUNK()]);

    await request(app())
      .get('/api/ai/knowledge/search')
      .query({ q: 'cancellation policy', organization_id: 'org-2', orgId: 'org-2' });

    expect(mockRetrieve).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' })
    );
    // The document count is scoped the same way, from the same resolution.
    expect(pool.query.mock.calls[0][1]).toEqual(['org-1']);
  });

  test('a user in another org searches their own library, not the first one\'s', async () => {
    mockUser = { id: 'u2', role: 'manager', organization_id: 'org-2' };
    mockDocCount(0);

    await request(app()).get('/api/ai/knowledge/search').query({ q: 'refunds' });

    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-2' }));
  });

  test('a platform-wide super admin gets nothing rather than everything', async () => {
    // A similarity search across every tenant on the platform is not a query
    // anyone should be able to run, and there is no single org to scope it to.
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };

    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: 'refunds' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ chunks: [], documents_available: 0, scope: 'platform' });
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a super admin targeting one org via x-org-id searches that org', async () => {
    mockUser = { id: 'sa', role: 'super_admin', organization_id: null };
    mockDocCount(2);

    await request(app())
      .get('/api/ai/knowledge/search')
      .set('x-org-id', 'org-7')
      .query({ q: 'refunds' });

    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-7' }));
  });
});

describe('who may search', () => {
  test.each(['admin', 'manager', 'trainer', 'reception', 'staff'])('%s may read the policies', async (role) => {
    // Managing the library stays admin/manager. Reading what a policy says is
    // what the policy is for, and the people asking mid-shift are trainers and
    // reception.
    mockUser = { id: 'u1', role, organization_id: 'org-1' };
    mockDocCount(1);

    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: 'notice period' });

    expect(res.status).toBe(200);
  });

  test('a client account may not', async () => {
    mockUser = { id: 'm1', role: 'member', organization_id: 'org-1' };

    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: 'notice period' });

    expect(res.status).toBe(403);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});

describe('validation and cost control', () => {
  test('a missing query is a 400, not an empty search', async () => {
    const res = await request(app()).get('/api/ai/knowledge/search');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('a whitespace-only query is a 400', async () => {
    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: '   ' });

    expect(res.status).toBe(400);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('an oversized query is refused before anything is embedded', async () => {
    // This route sits inside requireAiQuota(); embedding cost scales with what
    // is sent, so a pasted document must not be chargeable to the studio.
    const res = await request(app())
      .get('/api/ai/knowledge/search')
      .query({ q: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('topK is clamped rather than trusted', async () => {
    mockDocCount(5);
    await request(app()).get('/api/ai/knowledge/search').query({ q: 'refunds', topK: '9999' });
    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ topK: 10 }));

    mockRetrieve.mockClear();
    pool.query.mockReset();
    mockDocCount(5);
    await request(app()).get('/api/ai/knowledge/search').query({ q: 'refunds', topK: '-3' });
    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ topK: 1 }));
  });

  test('a non-numeric topK falls back to the configured default', async () => {
    mockDocCount(5);
    await request(app()).get('/api/ai/knowledge/search').query({ q: 'refunds', topK: 'all' });

    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ topK: undefined }));
  });
});

describe('the two kinds of empty, which must not be confused', () => {
  test('no documents uploaded reports a count of zero', async () => {
    mockDocCount(0);

    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: 'refunds' });

    expect(res.body.data.chunks).toEqual([]);
    expect(res.body.data.documents_available).toBe(0);
  });

  test('a library that exists but did not match says so', async () => {
    // Same empty chunk list, different meaning. Without the count an assistant
    // reports "this studio has no refund policy" about a studio that has one.
    mockDocCount(12);

    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: 'parking' });

    expect(res.body.data.chunks).toEqual([]);
    expect(res.body.data.documents_available).toBe(12);
  });
});

describe('results', () => {
  test('chunks carry the document they came from, so an answer can cite it', async () => {
    mockDocCount(4);
    mockRetrieve.mockResolvedValue([CHUNK(), CHUNK({ chunk_index: 1, similarity: 0.66 })]);

    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: 'cancellation' });

    expect(res.status).toBe(200);
    expect(res.body.data.chunks).toHaveLength(2);
    expect(res.body.data.chunks[0]).toMatchObject({
      title: 'Cancellation Policy',
      category: 'policy',
      document_id: 'doc-1',
      chunk_index: 0,
      similarity: 0.81,
    });
    expect(res.body.data.chunks[0].content).toContain('24 hours notice');
  });

  test('the endpoint returns text, never an answer', async () => {
    // A retrieval endpoint that paraphrases is a second place for a policy to
    // be quietly reworded.
    mockDocCount(1);
    mockRetrieve.mockResolvedValue([CHUNK()]);

    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: 'cancellation' });

    expect(res.body.data).not.toHaveProperty('answer');
    expect(res.body.data).not.toHaveProperty('summary');
    expect(res.body.data.chunks[0].content).toBe(CHUNK().content);
  });

  test('a retrieval failure is not a 500 — it is an honest empty result', async () => {
    // Mirrors the AI Coach's own call site: a cold embedding model must not
    // take the search box down.
    mockDocCount(3);
    mockRetrieve.mockRejectedValue(new Error('embedding model cold'));

    const res = await request(app()).get('/api/ai/knowledge/search').query({ q: 'refunds' });

    expect(res.status).toBe(200);
    expect(res.body.data.chunks).toEqual([]);
    // And the caller can still tell the difference — the library is not empty.
    expect(res.body.data.documents_available).toBe(3);
  });
});

describe('route ordering', () => {
  test('"search" is not swallowed by a :id route', async () => {
    // DELETE and POST /:id exist today, so there is no collision yet. This is
    // about the GET /:id somebody adds next year.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'routes', 'aiKnowledge.js'), 'utf8'
    );
    const search = src.indexOf("router.get('/search'");
    const firstIdRoute = src.search(/router\.(get|delete|post|patch)\('\/:id/);

    expect(search).toBeGreaterThan(-1);
    expect(firstIdRoute).toBeGreaterThan(-1);
    expect(search).toBeLessThan(firstIdRoute);
  });
});

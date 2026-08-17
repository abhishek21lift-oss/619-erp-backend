'use strict';
// retrieveContext (lib/ai/knowledgeBase.js) must only ever return knowledge
// the caller is authorized for: their own org's documents plus documents
// EXPLICITLY marked global (is_global = TRUE, organization_id NULL).
//
// Like exercises.visibility.test.js, tenant isolation is asserted on the SQL
// the service builds — the actual authorization gate — plus behavioural
// fail-closed checks (no org, no query, embed failure, threshold, topK).

jest.mock('../db/pool', () => ({ query: jest.fn() }));
// Never load the real @xenova/transformers 384-dim model in tests.
jest.mock('../lib/ai/embeddings', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  embedBatch: jest.fn().mockResolvedValue([new Array(384).fill(0.1)]),
  toVectorLiteral: jest.fn((v) => `[${v.join(',')}]`),
  EMBEDDING_DIM: 384,
}));
jest.mock('../lib/fileStorage', () => ({
  getFileBuffer: jest.fn(),
  deleteFile: jest.fn(),
}));

const pool = require('../db/pool');
const { retrieveContext } = require('../lib/ai/knowledgeBase');
const { embedText } = require('../lib/ai/embeddings');

const CHUNK = (over = {}) => ({
  content: 'Every session starts with a 10-minute dynamic warm-up.',
  chunk_index: 0,
  title: 'Workout SOP',
  category: 'sop',
  document_id: 'doc-1',
  similarity: 0.91,
  ...over,
});

beforeEach(() => {
  pool.query.mockReset();
  embedText.mockClear();
});

describe('retrieveContext tenant isolation', () => {
  test('org A can retrieve org A knowledge and explicitly-global knowledge', async () => {
    pool.query.mockResolvedValue({
      rows: [CHUNK(), CHUNK({ title: '619 Global', similarity: 0.9 })],
    });

    const rows = await retrieveContext({ organizationId: 'org-a', query: 'warm up protocol' });

    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Workout SOP');
    expect(rows[1].title).toBe('619 Global');

    const [sql, params] = pool.query.mock.calls[0];
    // The authorization gate lives in the SQL, document-level:
    // a chunk is reachable only through a parent document the caller may read.
    expect(sql).toContain('(d.is_global = TRUE OR d.organization_id = $2)');
    expect(sql).toContain('JOIN ai_documents d ON d.id = c.document_id');
    // The denormalized chunk org is never used as the authorization check.
    expect(sql).not.toContain('c.organization_id');
    expect(sql).toContain("d.status = 'ready'");
    expect(params[1]).toBe('org-a');
  });

  test('the caller\'s org is the ONLY tenant the query can reach', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await retrieveContext({ organizationId: 'org-a', query: 'anything' });
    const [sql, params] = pool.query.mock.calls[0];

    // Single tenant parameter, bound to the caller — no way for org B's
    // documents to match, and no other org literal in the statement.
    expect(params[1]).toBe('org-a');
    expect(params).not.toContain('org-b');
    expect(sql).not.toMatch(/org-b/);
    expect(sql).not.toContain('OR 1=1');
    expect(sql.split('organization_id').length - 1).toBe(1);
  });

  test('org B cannot reach org A knowledge (symmetric predicate)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await retrieveContext({ organizationId: 'org-b', query: 'anything' });
    const [, params] = pool.query.mock.calls[0];
    expect(params[1]).toBe('org-b');
    expect(params).not.toContain('org-a');
  });

  test('global knowledge is reachable ONLY when explicitly marked is_global = TRUE', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await retrieveContext({ organizationId: 'org-a', query: 'anything' });
    const [sql] = pool.query.mock.calls[0];

    // The global branch is literally `d.is_global = TRUE`. There is no
    // `is_global = FALSE` branch, no wildcard, and no "any org" escape hatch.
    expect(sql).toContain('d.is_global = TRUE');
    expect(sql).not.toContain('is_global = FALSE');
    expect(sql).not.toContain('organization_id IS NULL OR d.is_global');
  });

  test('a missing organizationId fails closed — no query runs, not even for global docs', async () => {
    const rows = await retrieveContext({ organizationId: undefined, query: 'anything' });
    expect(rows).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();

    await retrieveContext({ organizationId: null, query: 'anything' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('an empty query fails closed', async () => {
    await retrieveContext({ organizationId: 'org-a', query: '   ' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('an embedding failure fails closed — returns [] and never queries', async () => {
    embedText.mockRejectedValueOnce(new Error('model cold'));

    const rows = await retrieveContext({ organizationId: 'org-a', query: 'warm up' });

    expect(rows).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('chunks below the similarity threshold are dropped', async () => {
    pool.query.mockResolvedValue({ rows: [CHUNK(), CHUNK({ similarity: 0.3 })] });

    const rows = await retrieveContext({ organizationId: 'org-a', query: 'warm up' });

    expect(rows).toHaveLength(1);
    expect(rows[0].similarity).toBe(0.91);
  });

  test('retrieval honours topK and the query is embedded once', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await retrieveContext({ organizationId: 'org-a', query: 'warm up', topK: 7 });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('LIMIT $3');
    expect(params[2]).toBe(7);
    expect(embedText).toHaveBeenCalledTimes(1);
    expect(embedText).toHaveBeenCalledWith('warm up');
  });
});

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
  // Retrieval filters on this (migration 207). Must match what the real
  // module resolves to by default, or the SQL binds undefined and every
  // chunk looks like it came from another model.
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
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

  test('an embedding failure throws rather than passing as an empty result', async () => {
    // This asserted `rows).toEqual([])`. Returning [] IS fail-closed for data
    // leakage — nothing is queried, nothing leaks — and that half is still
    // asserted below. But [] is also what a studio with no matching document
    // gets, and retrieveContext's own docstring instructed callers to read
    // that as "the knowledge base holds nothing on this". So during an
    // embedding outage every caller told the model the opposite of the truth:
    // that the base had been consulted and was empty.
    //
    // The two outcomes need opposite answers — "you have not uploaded
    // anything about this" vs "I could not reach your documents" — so they
    // can no longer share a return value.
    embedText.mockRejectedValueOnce(new Error('model cold'));

    await expect(retrieveContext({ organizationId: 'org-a', query: 'warm up' }))
      .rejects.toMatchObject({ code: 'RAG_UNAVAILABLE' });

    // The security half is unchanged: no query is issued.
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a search failure is also reported, not silently empty', async () => {
    // Previously uncaught here at all — it surfaced as a 500 from whichever
    // route was calling, which at least was not a lie. It is now the same
    // typed failure as a cold embedder, so callers handle one case.
    pool.query.mockRejectedValueOnce(new Error('pgvector down'));

    await expect(retrieveContext({ organizationId: 'org-a', query: 'warm up' }))
      .rejects.toMatchObject({ code: 'RAG_UNAVAILABLE' });
  });

  test('a genuinely empty knowledge base still returns [] — the honest zero', async () => {
    // The case that MUST stay distinguishable from every failure above.
    // Two mocks: the similarity search (empty) and the staleness probe that
    // now runs before reporting a zero (also empty = nothing stale).
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] });

    await expect(retrieveContext({ organizationId: 'org-a', query: 'warm up' }))
      .resolves.toEqual([]);
  });
});

describe('embedding model provenance (migration 207)', () => {
  // 384 dimensions is a shape, not a meaning. Two different 384-dim models
  // emit into unrelated coordinate spaces and pgvector compares them without
  // complaint — no error, just confidently wrong passages. The only symptom
  // is an AI that has quietly become bad at its job.

  test('retrieval only compares vectors from the CURRENT model', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await retrieveContext({ organizationId: 'org-a', query: 'warm up' });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('c.embedding_model = $4');
    expect(params[3]).toBe('Xenova/all-MiniLM-L6-v2');
  });

  test('an index built by another model is reported as stale, not as empty', async () => {
    // The whole point of the column. Without it these chunks would have been
    // compared anyway and returned as plausible matches.
    pool.query
      .mockResolvedValueOnce({ rows: [] })          // nothing matches THIS model
      .mockResolvedValueOnce({ rows: [{ n: 42 }] }); // but 42 chunks exist from another

    await expect(retrieveContext({ organizationId: 'org-a', query: 'warm up' }))
      .rejects.toMatchObject({ code: 'RAG_STALE_INDEX', staleChunks: 42 });
  });

  test('the staleness probe is scoped to the caller, and excludes the current model', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] });

    await expect(retrieveContext({ organizationId: 'org-a', query: 'warm up' })).rejects.toThrow();

    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('c.embedding_model <> $2');
    expect(sql).toContain('(d.is_global = TRUE OR d.organization_id = $1)');
    expect(params[0]).toBe('org-a');
    expect(params).not.toContain('org-b');
  });

  test('a failing staleness probe does not manufacture an outage', async () => {
    // The probe is a diagnostic. If it cannot run, the honest zero from the
    // search itself is still the best answer we have.
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('probe blew up'));

    await expect(retrieveContext({ organizationId: 'org-a', query: 'warm up' }))
      .resolves.toEqual([]);
  });

  test('a hit short-circuits the probe — no extra query on the happy path', async () => {
    pool.query.mockResolvedValueOnce({ rows: [CHUNK()] });

    const rows = await retrieveContext({ organizationId: 'org-a', query: 'warm up' });

    expect(rows).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledTimes(1);
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

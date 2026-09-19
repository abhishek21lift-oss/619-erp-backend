'use strict';
// AI knowledge-base service: document ingestion (extract → chunk → embed →
// store) and retrieval (embed query → pgvector similarity search).
//
// Tenant isolation: every read and write here is scoped by organization_id —
// except for documents explicitly marked is_global, which are the platform's
// own knowledge base documents and are available to every organization.
// Retrieval filters at the DOCUMENT level (see retrieveContext), so a chunk is
// only ever reachable through a parent document whose tenancy the caller is
// authorized for.

const pool = require('../../db/pool');
const logger = require('../logger');
const { getFileBuffer, deleteFile } = require('../fileStorage');
const { extractText } = require('./textExtract');
const { chunkText } = require('./chunk');
const { embedBatch, embedText, toVectorLiteral, EMBEDDING_MODEL } = require('./embeddings');

/**
 * Retrieval could not run. NOT the same as "nothing matched".
 *
 * ── Why this is an error and not an empty array ───────────────────────────
 *
 * retrieveContext() used to catch an embed failure, log it, and return [] —
 * the same value it returns when the studio genuinely has no matching
 * document. Its own docstring told callers that [] means "no matching
 * documentation was found ... not let it guess", so during an embedding
 * outage every caller told the model precisely the wrong thing: that the
 * knowledge base had been consulted and held nothing. The model then answered
 * from general knowledge with no indication it was ungrounded.
 *
 * The two outcomes have opposite correct responses — "your studio has not
 * uploaded anything about this" versus "I could not reach your documents just
 * now" — so they cannot share a return value.
 */
class RagStaleIndexError extends Error {
  constructor(model, staleCount) {
    super(
      `Knowledge index was built by a different embedding model — ${staleCount} chunk(s) need reindexing before they can be searched with "${model}".`
    );
    this.name = 'RagStaleIndexError';
    this.code = 'RAG_STALE_INDEX';
    this.currentModel = model;
    this.staleChunks = staleCount;
  }
}

class RagUnavailableError extends Error {
  constructor(cause) {
    super(`Knowledge retrieval is unavailable: ${cause}`);
    this.name = 'RagUnavailableError';
    this.code = 'RAG_UNAVAILABLE';
  }
}

const DEFAULT_TOP_K = parseInt(process.env.AI_RAG_TOP_K, 10) || 5;
const DEFAULT_SIMILARITY_THRESHOLD = parseFloat(process.env.AI_RAG_SIMILARITY_THRESHOLD) || 0.55;

/**
 * Runs the full ingestion pipeline for a document already inserted (with
 * status='processing') and its file already saved to storage. Intended to be
 * called fire-and-forget right after the upload response is sent — a
 * multi-page PDF can take well over Render's ~30s request timeout to embed
 * chunk-by-chunk on CPU, so this must never sit in the request/response path.
 */
async function ingestDocument(documentId) {
  const { rows } = await pool.query('SELECT * FROM ai_documents WHERE id = $1', [documentId]);
  const doc = rows[0];
  if (!doc) {
    logger.warn({ documentId }, 'ai_knowledge_ingest_missing_document');
    return;
  }

  try {
    const buffer = await getFileBuffer(doc.file_key);
    const text = await extractText(buffer, doc.mime_type);
    if (!text || text.length < 20) {
      // The parser ran fine but the file carries no text layer — almost
      // always a scanned/photographed document, where every page is an
      // image. Say that explicitly and give the fix, rather than a bare
      // "no text found" that reads like a bug in the app.
      throw new Error(
        doc.mime_type === 'application/pdf'
          ? 'This PDF has no selectable text — it looks like a scan or photos of pages. Re-export it as a text PDF (or run OCR on it) and upload again.'
          : 'No extractable text found in this document.'
      );
    }

    const chunks = chunkText(text);
    if (!chunks.length) {
      throw new Error('Document text could not be split into chunks.');
    }

    const vectors = await embedBatch(chunks);

    await pool.query('DELETE FROM ai_document_chunks WHERE document_id = $1', [documentId]);
    for (let i = 0; i < chunks.length; i++) {
      await pool.query(
        `INSERT INTO ai_document_chunks (document_id, organization_id, chunk_index, content, embedding, token_count, embedding_model)
         VALUES ($1, $2, $3, $4, $5::vector, $6, $7)`,
        [documentId, doc.organization_id, i, chunks[i], toVectorLiteral(vectors[i]), Math.ceil(chunks[i].length / 4), EMBEDDING_MODEL]
      );
    }

    await pool.query(
      `UPDATE ai_documents SET status = 'ready', chunk_count = $2, error_message = NULL, updated_at = NOW() WHERE id = $1`,
      [documentId, chunks.length]
    );
    logger.info({ documentId, chunks: chunks.length }, 'ai_knowledge_ingest_complete');
  } catch (err) {
    logger.error({ documentId, err: err.message }, 'ai_knowledge_ingest_failed');
    await pool.query(
      `UPDATE ai_documents SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`,
      [documentId, err.message.slice(0, 500)]
    ).catch(() => {});
  }
}

/**
 * Deletes a document: its row (chunks cascade via FK) first, then its stored
 * R2/disk file. Caller must have already verified organizationId ownership.
 *
 * The DB row is deleted BEFORE the file, and the file delete is
 * fire-and-forget rather than awaited — an R2 network hiccup deleting the
 * underlying object must never make "delete this document" hang or fail from
 * the user's side. An orphaned R2 object costs a little storage; a delete
 * button that never responds is a much worse outcome, and was exactly the
 * symptom reported (this mirrors the same R2-request-timeout fix applied to
 * fileStorage.js's S3Client — this fire-and-forget is what actually keeps the
 * user-facing delete fast regardless of how long R2 takes to answer).
 */
async function deleteDocument(documentId) {
  const { rows } = await pool.query('SELECT file_key FROM ai_documents WHERE id = $1', [documentId]);
  await pool.query('DELETE FROM ai_documents WHERE id = $1', [documentId]);
  if (rows[0]) {
    deleteFile(rows[0].file_key).catch((err) =>
      logger.warn({ documentId, err: err.message }, 'ai_knowledge_delete_file_failed')
    );
  }
}

/**
 * Embeds `query` and returns the top-K most similar chunks the caller is
 * authorized to see, above the similarity threshold. An empty array means
 * the studio genuinely has nothing matching — and ONLY that.
 *
 * Tenant filter (enforced here, at the retrieval layer, and document-level):
 *   (d.is_global = TRUE OR d.organization_id = $2)
 * A chunk is reachable only through its parent document (JOIN on
 * document_id), and the document's own tenancy is the single source of
 * truth — the denormalized organization_id on the chunk row is never used as
 * an authorization check. `is_global` documents are only ever produced by
 * super-admin uploads (routes/aiKnowledge.js), never by inference.
 *
 * Fail-closed: a missing organizationId (e.g. a platform super admin with no
 * tenant context) returns [] immediately — global knowledge is NOT served as
 * a workaround.
 *
 * A retrieval FAILURE throws RagUnavailableError; it does not return []. The
 * two cases had shared a return value, and callers — following this very
 * docstring — told the model the knowledge base held nothing whenever
 * embedding was down. Callers must now decide deliberately: continue
 * ungrounded and SAY SO, or fail. Neither may claim the base was consulted.
 *
 * pgvector's `<=>` operator is cosine DISTANCE (0 = identical, 2 = opposite);
 * similarity = 1 - distance.
 */
async function retrieveContext({ organizationId, query, topK = DEFAULT_TOP_K, similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD }) {
  if (!organizationId || !query?.trim()) return [];

  let queryVector;
  try {
    queryVector = await embedText(query);
  } catch (err) {
    // Throws rather than returning []. See RagUnavailableError above: an
    // outage and an empty knowledge base must not look identical to callers.
    logger.error({ err: err.message }, 'ai_knowledge_query_embed_failed');
    throw new RagUnavailableError(err.message);
  }

  let rows;
  try {
    ({ rows } = await pool.query(SIMILARITY_SQL, [toVectorLiteral(queryVector), organizationId, topK, EMBEDDING_MODEL]));
  } catch (err) {
    // A database failure during retrieval is the same class of event as an
    // embed failure, and was previously not caught here at all — it surfaced
    // as a 500 from whichever route happened to be calling.
    logger.error({ err: err.message }, 'ai_knowledge_query_search_failed');
    throw new RagUnavailableError(err.message);
  }

  const hits = rows.filter((r) => Number(r.similarity) >= similarityThreshold);
  if (hits.length) return hits;

  // Nothing came back. Before reporting the honest zero, check whether the
  // studio DOES have documents that were simply embedded by another model —
  // filtered out above because their vectors are not comparable with this
  // query's. That is a stale index needing a reindex, not an empty one, and
  // saying "you have nothing on this" would be the same lie this module was
  // just fixed to stop telling.
  try {
    const { rows: staleRows } = await pool.query(STALE_COUNT_SQL, [organizationId, EMBEDDING_MODEL]);
    const stale = staleRows[0]?.n ?? 0;
    if (stale > 0) {
      logger.error({ model: EMBEDDING_MODEL, stale }, 'ai_knowledge_stale_index');
      throw new RagStaleIndexError(EMBEDDING_MODEL, stale);
    }
  } catch (err) {
    if (err instanceof RagStaleIndexError) throw err;
    // The staleness probe is a diagnostic. If it cannot run, the honest zero
    // above is still the best answer available — do not manufacture an outage.
    logger.warn({ err: err.message }, 'ai_knowledge_stale_probe_failed');
  }

  return hits;
}

const SIMILARITY_SQL = `
    SELECT c.content, c.chunk_index, d.title, d.category, d.id AS document_id,
           1 - (c.embedding <=> $1::vector) AS similarity
    FROM ai_document_chunks c
    JOIN ai_documents d ON d.id = c.document_id
    WHERE d.status = 'ready'
      AND (d.is_global = TRUE OR d.organization_id = $2)
      AND c.embedding_model = $4
    ORDER BY c.embedding <=> $1::vector ASC
    LIMIT $3`;

// Chunks this caller could otherwise have read, held back only because a
// different model embedded them. Used to tell a stale index apart from an
// empty one — the same distinction this module already draws for outages.
const STALE_COUNT_SQL = `
    SELECT COUNT(*)::int AS n
    FROM ai_document_chunks c
    JOIN ai_documents d ON d.id = c.document_id
    WHERE d.status = 'ready'
      AND (d.is_global = TRUE OR d.organization_id = $1)
      AND c.embedding_model <> $2`;

module.exports = { ingestDocument, deleteDocument, retrieveContext, RagUnavailableError, RagStaleIndexError };

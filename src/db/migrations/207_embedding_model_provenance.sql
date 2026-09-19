-- ============================================================
-- 207_embedding_model_provenance.sql
--
-- Records WHICH embedding model produced each vector.
--
-- ── The failure this prevents ──────────────────────────────────────────
--
-- ai_document_chunks.embedding is vector(384), and the column width is the
-- only thing that has ever been checked. But 384 dimensions is a shape, not
-- a meaning: all-MiniLM-L6-v2, bge-small-en and e5-small all emit 384-wide
-- vectors into completely unrelated coordinate spaces.
--
-- AI_EMBEDDING_MODEL is an environment variable (see lib/ai/embeddings.js).
-- Point it at a different 384-dim model — an entirely reasonable thing to
-- do for quality — and every existing chunk keeps its old vector while every
-- new query is embedded by the new one. pgvector compares them happily: the
-- `<=>` operator returns a number, the number passes the similarity
-- threshold or does not, and nothing anywhere errors. The knowledge base
-- simply starts returning confidently wrong passages, and the only symptom
-- is an AI that has quietly become bad at its job.
--
-- A dimension change at least fails loudly (pgvector rejects the insert).
-- This is the same mistake that does not.
--
-- Backfill: existing rows are stamped with the current default, which is the
-- only model this codebase has ever shipped with — see the DEFAULT below and
-- lib/ai/embeddings.js. If a deployment changed AI_EMBEDDING_MODEL before
-- this migration ran, that assumption is wrong for its rows, and the fix is
-- the same as the fix for any stale index: reindex.
-- ============================================================

ALTER TABLE ai_document_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2';

-- Retrieval filters on (organization/document, model), so the model belongs
-- in the index it will be filtered by.
CREATE INDEX IF NOT EXISTS ai_document_chunks_model_idx
  ON ai_document_chunks (embedding_model);

COMMENT ON COLUMN ai_document_chunks.embedding_model IS
  'The embedding model that produced this row''s vector. Vectors from different models are not comparable even at equal width; retrieval filters on this and reports a stale index rather than returning nonsense.';

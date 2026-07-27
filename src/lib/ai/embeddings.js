'use strict';
// Embedding provider for the AI knowledge base RAG pipeline.
//
// Default provider is fully local/offline via @xenova/transformers
// (Transformers.js) — genuinely free and open-source, no API key, no
// per-call cost. This matters for a document-indexing workload: embedding
// every chunk of every uploaded SOP through a paid API would add real,
// ongoing cost with no way to opt out.
//
// The provider is resolved once behind embedText()/embedBatch() so a future
// API-based provider (OpenAI, Cohere, etc.) can be added as a second branch
// on AI_EMBEDDING_PROVIDER without touching any caller.
//
// EMBEDDING_DIM must match the `vector(384)` column width in migration 116.
// Changing the model to one with a different output size requires a new
// migration AND re-embedding every existing chunk — it is not a drop-in swap.

const logger = require('../logger');

const EMBEDDING_PROVIDER = process.env.AI_EMBEDDING_PROVIDER || 'local';
const LOCAL_MODEL = process.env.AI_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

// @xenova/transformers is ESM-only; this file is CommonJS, so the import is
// dynamic and cached. The pipeline itself downloads/caches model weights on
// first use (see TRANSFORMERS_CACHE env var to control where).
let pipelinePromise = null;
function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = import('@xenova/transformers').then(({ pipeline, env }) => {
      // Keep model files under the app's own directory rather than the
      // default OS cache path, so it's predictable across deploys.
      if (process.env.AI_EMBEDDING_CACHE_DIR) {
        env.cacheDir = process.env.AI_EMBEDDING_CACHE_DIR;
      }
      return pipeline('feature-extraction', LOCAL_MODEL);
    });
  }
  return pipelinePromise;
}

async function embedLocal(texts) {
  const extractor = await getPipeline();
  const results = [];
  // Sequential, not Promise.all: ONNX inference is CPU-bound and a batch of
  // concurrent calls would just queue behind Node's single thread anyway,
  // while making memory usage and error attribution harder to reason about.
  for (const text of texts) {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data));
  }
  return results;
}

/**
 * embedBatch(texts: string[]) → Promise<number[][]>
 * Order-preserving; one embedding vector per input string.
 */
async function embedBatch(texts) {
  if (!texts.length) return [];
  if (EMBEDDING_PROVIDER === 'local') {
    return embedLocal(texts);
  }
  logger.error({ provider: EMBEDDING_PROVIDER }, 'ai_embedding_provider_not_implemented');
  throw new Error(`Unknown AI_EMBEDDING_PROVIDER "${EMBEDDING_PROVIDER}" — only "local" is implemented.`);
}

/** embedText(text: string) → Promise<number[]> — single-string convenience wrapper. */
async function embedText(text) {
  const [vec] = await embedBatch([text]);
  return vec;
}

/** Formats a JS number array as a pgvector literal for use in a parameterised query. */
function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}

module.exports = { embedText, embedBatch, toVectorLiteral, EMBEDDING_DIM, EMBEDDING_PROVIDER };

'use strict';
// MPTS grounding enforcement — the single choke point every training-methodology
// AI generation passes through (workout · diet · progress · fitness-testing).
//   evidence assembly  → only the APPROVED corpus is ever considered evidence
//   gate               → no approved corpus ⇒ insufficient_evidence, no model call
//   citation validator → deterministic, runs on the FINAL assembled output, so a
//                        provider fallback (router chain) cannot route around it
//
// Evidence states:
//   'ok'          corpus was searched and returned ≥1 approved passage
//   'empty'       corpus searched fine and genuinely holds nothing relevant
//   'unavailable' retrieval itself failed (embed/embeddings-down/DB)
//   'stale'       passages exist but were embedded by another model (needs reindex)
//   'skipped'     no organization context at all (platform callers)
//
// The retrieval ledger (ai_retrieval_log) records each state via
// knowledgeBase.retrieveContext; this module adds classification only.

const { retrieveContext, getCorpusVersion } = require('./knowledgeBase');

const CITATION_FIELD = 'knowledge_citations';
const EXCERPT_CHARS = 160;

function classifyRagError(err) {
  // Detection by shape, not instanceof: knowledgeBase carries the classes, and
  // a suite that mock-partially replaces the module must still get honest
  // classification — the CODE the real classes set is the contract.
  if (err && (err.code === 'RAG_STALE_INDEX' || err.name === 'RagStaleIndexError')) return 'stale';
  // RagUnavailableError and anything unexpected (embeddings down, DB error,
  // a retrieval layer that returned nothing at all) are all "cannot reach the
  // ledger right now" — the caller must refuse on either, and neither may
  // ever be presented as an empty corpus.
  return 'unavailable';
}

/** Chunk rows → client-renderable source list. No chunk content beyond a short
 *  excerpt, and only rows retrieval already proved authorized for this caller. */
function chunkSources(chunks) {
  return chunks.map((c, i) => ({
    n: i + 1,
    title: c.title,
    document_id: c.document_id,
    chunk_index: c.chunk_index,
    excerpt: String(c.content || '').replace(/\s+/g, ' ').slice(0, EXCERPT_CHARS),
  }));
}

async function safeCorpusVersion() {
  try {
    return await getCorpusVersion();
  } catch {
    return 'corpus_version_unknown';
  }
}

/** Fresh evidence: retrieval runs here (route/userId feed the ledger row).
 *  A retrieval layer that neither throws nor returns an array is broken infra,
 *  not an empty corpus — fail closed as 'unavailable' rather than lying. */
async function assembleEvidence({ organizationId, userId, route, query }) {
  let chunks;
  try {
    const raw = await retrieveContext({ organizationId, query, route, userId });
    if (!Array.isArray(raw)) throw new Error('retrieval returned no result');
    chunks = raw;
  } catch (err) {
    const status = classifyRagError(err);
    return { status, chunks: [], sources: chunkSources([]), corpusVersion: await safeCorpusVersion() };
  }
  const status = !organizationId
    ? 'skipped'
    : (chunks.length ? 'ok' : 'empty');
  return { status, chunks, sources: chunkSources(chunks), corpusVersion: await safeCorpusVersion() };
}

/** Evidence for routes whose retrieval already ran inside
 *  loadAuthoritativeClient (workout/diet). `state` comes from the retrieval
 *  stats out-param (ok/empty/unavailable/stale); blocks the empty-vs-unavailable
 *  conflation that made callers tell the model the wrong thing before. */
async function evidenceFromChunks(chunks, { organizationId, state = null }) {
  const status = state
    || (!organizationId ? 'skipped' : (chunks.length ? 'ok' : 'empty'));
  return { status, chunks, sources: chunkSources(chunks), corpusVersion: await safeCorpusVersion() };
}

/** The 422/503 JSON the gated routes answer with instead of generating. */
function insufficientEvidenceResponse(intent, evidence) {
  const corpusEmpty = evidence.status === 'empty';
  return {
    httpStatus: corpusEmpty ? 422 : 503,
    body: {
      error: corpusEmpty
        ? 'No approved MPTS knowledge is available to ground this generation'
        : 'The MPTS knowledge base could not be searched just now',
      code: 'INSUFFICIENT_EVIDENCE',
      grounding: 'insufficient_evidence',
      detail: evidence.status,
      corpus_version: evidence.corpusVersion,
      message: corpusEmpty
        ? `${intent} requires approved methodology documents. Curate and approve them in the platform knowledge base, then try again — nothing was generated.`
        : `${intent} could not check the approved knowledge base. Try again shortly — nothing was generated.`,
    },
  };
}

/** Deterministic validation of the FINAL assembled output against the evidence
 *  actually provided. Only the top-level knowledge_citations array is read:
 *  scanning the serialized body for "[n]" would re-interpret every JSON array
 *  as a citation, and validator truth must not depend on free-text shapes.
 *  Never throws. */
function validateGroundedOutput(result, evidence) {
  const field = result && Array.isArray(result[CITATION_FIELD]) ? result[CITATION_FIELD] : null;
  const claimed = field ? field.map(Number) : [];
  const max = evidence.chunks.length;

  const valid = new Set();
  const invalid = new Set();
  for (const n of claimed) {
    (Number.isInteger(n) && n >= 1 && n <= max ? valid : invalid).add(n);
  }

  const status = invalid.size
    ? 'invalid_citations'
    : (field && valid.size ? 'ok' : (max ? 'no_citations' : 'ok'));
  return {
    field_present: Boolean(field),
    cited: valid.size > 0,
    valid: [...valid].sort((a, b) => a - b),
    invalid: [...invalid].sort((a, b) => a - b),
    status,
  };
}

/** Enforce: fabricated citations never reach the UI. Replaces the field with
 *  the in-range subset (validated and status-flagged, not silently dropped). */
function sanitizeCitations(result, validation) {
  if (!result || typeof result !== 'object') return;
  result[CITATION_FIELD] = validation.valid;
}

/** The grounding block for the generation ledger (ai_workout_generations.audit)
 *  and the done event. Excerpts are tenant-authorized content already — the
 *  chunk text went into the same caller's prompt. */
function groundingBlock(evidence, validation) {
  return {
    status: evidence.status,
    corpus_version: evidence.corpusVersion,
    validation_status: validation.status,
    citations_claimed: validation.valid.length + validation.invalid.length,
    citations_accepted: validation.valid,
    citations_rejected: validation.invalid,
    sources: evidence.sources,
  };
}

module.exports = {
  CITATION_FIELD,
  classifyRagError,
  chunkSources,
  assembleEvidence,
  evidenceFromChunks,
  insufficientEvidenceResponse,
  validateGroundedOutput,
  sanitizeCitations,
  groundingBlock,
};

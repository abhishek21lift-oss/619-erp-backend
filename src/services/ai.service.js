// src/services/ai.service.js
// AI job orchestration: enqueue long-running AI work (document ingestion,
// reindexing) for the ai worker, and process queued jobs there.
//
// Extraction + chunking + embedding routinely exceeds a request timeout for
// anything beyond a couple of pages, which is why these jobs must run off the
// request path entirely.

const logger = require('../lib/logger');

const AI_TYPES = new Set(['ingest_document', 'reindex_document']);

/**
 * Enqueue an AI job. Returns the BullMQ Job, or null when Redis is not ready
 * so the caller can fall back to the synchronous inline path. Never throws
 * for a queue outage.
 */
async function enqueueAiJob(type, payload, opts = {}) {
  if (!AI_TYPES.has(type)) throw new Error(`Unknown ai job type: ${type}`);

  const redis = require('../lib/redis');
  if (!(await redis.ensureReady())) return null;

  const { aiQueue } = require('../jobs/queue');
  const job = await aiQueue.add(type, payload, opts);
  logger.info({ jobId: job.id, type, queue: 'ai' }, 'ai job enqueued');
  return job;
}

/**
 * Enqueue an AI job, running `fallback` inline when Redis is down or the
 * enqueue fails. Used by routes that must never lose the work, just move it
 * off the request path when possible.
 */
async function dispatchAiJob(type, payload, fallback) {
  let job = null;
  try {
    job = await enqueueAiJob(type, payload);
  } catch (err) {
    logger.warn({ err: err.message, type }, 'ai enqueue failed — running inline');
  }
  if (!job && typeof fallback === 'function') return fallback();
  return job;
}

/**
 * Worker processor. BullMQ's `Queue.add(name, data)` (see enqueueAiJob)
 * carries the job type in `job.name`; `job.data` holds only the payload
 * ({ documentId }). This matches every other worker in the repo
 * (e.g. renewal.worker.js dispatches on job.name).
 *
 * ingestDocument already records failures on the document row
 * (status='failed'), so throwing from here is reserved for actual bugs —
 * including unknown job names, which must fail loudly rather than silently
 * no-op.
 */
async function processAiJob(job) {
  const type = job.name;
  const { ingestDocument } = require('../lib/ai/knowledgeBase');

  if (type === 'ingest_document' || type === 'reindex_document') {
    return ingestDocument(job.data?.documentId);
  }
  throw new Error(`Unknown ai job type: ${type}`);
}

module.exports = { enqueueAiJob, dispatchAiJob, processAiJob, AI_TYPES };

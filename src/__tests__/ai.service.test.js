'use strict';
// AI BullMQ queue contract (src/services/ai.service.js):
//
//   producer:  aiQueue.add(type, { documentId }, opts)   -> type lives in job.name
//   consumer:  processAiJob(job) reads job.name, NOT job.data
//
// Regression: processAiJob used to read `type` from job.data, which only
// carries { documentId }, so every real job failed with
// "Unknown ai job type: undefined" and documents sat stuck in `processing`.
// This suite pins the producer/consumer contract both ways.

jest.mock('../lib/redis', () => ({
  ensureReady: jest.fn().mockResolvedValue(true),
  getConnection: jest.fn(),
  getWorkerConnection: jest.fn(),
}));
jest.mock('../jobs/queue', () => ({
  aiQueue: { add: jest.fn().mockResolvedValue({ id: 'job-1' }) },
}));
jest.mock('../lib/ai/knowledgeBase', () => ({
  ingestDocument: jest.fn().mockResolvedValue(undefined),
}));

const { enqueueAiJob, dispatchAiJob, processAiJob, AI_TYPES } = require('../services/ai.service');
const redis = require('../lib/redis');
const { aiQueue } = require('../jobs/queue');
const { ingestDocument } = require('../lib/ai/knowledgeBase');

const JOB = (name, data = {}) => ({ id: 'job-1', name, data });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('processAiJob (worker side)', () => {
  test('an ingest_document job reaches the ingestion handler with its documentId', async () => {
    const result = await processAiJob(JOB('ingest_document', { documentId: 'doc-abc' }));

    expect(result).toBeUndefined();
    expect(ingestDocument).toHaveBeenCalledTimes(1);
    expect(ingestDocument).toHaveBeenCalledWith('doc-abc');
  });

  test('a reindex_document job reaches the ingestion handler with its documentId', async () => {
    await processAiJob(JOB('reindex_document', { documentId: 'doc-xyz' }));

    expect(ingestDocument).toHaveBeenCalledTimes(1);
    expect(ingestDocument).toHaveBeenCalledWith('doc-xyz');
  });

  test('the documentId payload is forwarded exactly — and only it', async () => {
    await processAiJob(JOB('ingest_document', { documentId: 'doc-123', other: 'ignored' }));

    // One argument, the bare documentId: no tenant/org parameter is
    // introduced at this layer, so the worker cannot widen (or narrow)
    // the retrieval scope that knowledgeBase.js already enforces.
    expect(ingestDocument.mock.calls[0]).toHaveLength(1);
    expect(ingestDocument.mock.calls[0][0]).toBe('doc-123');
  });

  test('an unknown job name fails safely and loudly', async () => {
    await expect(processAiJob(JOB('mystery', { documentId: 'doc-1' }))).rejects.toThrow(
      'Unknown ai job type: mystery'
    );
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test('a job with no name fails safely (undefined type)', async () => {
    await expect(processAiJob({ id: 'job-1', data: { documentId: 'doc-1' } })).rejects.toThrow(
      'Unknown ai job type: undefined'
    );
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test('ingestion failures propagate untouched — error recording stays inside knowledgeBase', async () => {
    ingestDocument.mockRejectedValueOnce(new Error('bad pdf'));

    // processAiJob adds no error handling of its own: ingestDocument records
    // failures on the document row (status='failed'), and that logic is
    // unchanged — the worker only forwards the job to it.
    await expect(processAiJob(JOB('ingest_document', { documentId: 'doc-1' }))).rejects.toThrow('bad pdf');
    expect(ingestDocument).toHaveBeenCalledWith('doc-1');
  });
});

describe('enqueueAiJob / dispatchAiJob (producer side)', () => {
  test('the job name is the type and the payload is job.data', async () => {
    const job = await enqueueAiJob('ingest_document', { documentId: 'doc-abc' });

    expect(job.id).toBe('job-1');
    expect(aiQueue.add).toHaveBeenCalledWith('ingest_document', { documentId: 'doc-abc' }, {});
  });

  test('reindex_document enqueues under its own name', async () => {
    await enqueueAiJob('reindex_document', { documentId: 'doc-xyz' });

    expect(aiQueue.add).toHaveBeenCalledWith('reindex_document', { documentId: 'doc-xyz' }, {});
  });

  test('both known types are admitted and unknown types are rejected before Redis', async () => {
    expect(AI_TYPES.has('ingest_document')).toBe(true);
    expect(AI_TYPES.has('reindex_document')).toBe(true);

    await expect(enqueueAiJob('mystery', {})).rejects.toThrow('Unknown ai job type: mystery');
    expect(redis.ensureReady).not.toHaveBeenCalled();
    expect(aiQueue.add).not.toHaveBeenCalled();
  });

  test('dispatchAiJob runs the inline fallback when the enqueue fails', async () => {
    aiQueue.add.mockRejectedValueOnce(new Error('redis down'));
    const fallback = jest.fn().mockResolvedValue('inline');

    const result = await dispatchAiJob('ingest_document', { documentId: 'doc-1' }, fallback);

    expect(result).toBe('inline');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test('dispatchAiJob skips the fallback when the job was enqueued', async () => {
    const fallback = jest.fn();

    await dispatchAiJob('ingest_document', { documentId: 'doc-1' }, fallback);

    expect(fallback).not.toHaveBeenCalled();
  });
});

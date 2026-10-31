'use strict';
// Platform-side curation of the shared (is_global) MPTS knowledge corpus —
// the write path that migration 173 deferred ("uploaded by a platform super
// admin only"): upload → review → approve/activate → revoke.
//
// Lifecycle (db/migrations/232_mpts_knowledge_lifecycle.sql):
//   * A new corpora document starts approval_status='pending' — NOT retrievable.
//   * POST /:id/approve activates it (requires ingestion status 'ready') and
//     deterministically supersedes every other APPROVED global document of the
//     same title family (older versions stop being retrievable; chunks/files
//     are kept so past generations stay traceable).
//   * POST /:id/revoke takes the current version out of the retrieval set.
// Tenants can READ the approved corpus (lib/ai/knowledgeBase.js retrieval);
// they can never reach any of these routes — they sit behind
// PLATFORM_GUARD on /api/platform (and its /api/super-admin alias).

const express = require('express');
const multer = require('multer');
const { randomUUID, createHash } = require('crypto');
const pool = require('../../../db/pool');
const { saveFile } = require('../../../lib/fileStorage');
const { deleteDocument, getCorpusVersion } = require('../../../lib/ai/knowledgeBase');
const { SUPPORTED_MIME_TYPES } = require('../../../lib/ai/textExtract');
const logger = require('../../../lib/logger');
const { invalidFileType } = require('../../../middleware/errorHandler');
const { audit } = require('./shared');

const router = express.Router();

const CATEGORIES = ['sop', 'guide', 'policy'];
const EXT_BY_MIME = { 'application/pdf': 'pdf', 'text/plain': 'txt' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // same cap as the studio-facing route
  fileFilter(_req, file, cb) {
    if (!SUPPORTED_MIME_TYPES.includes(file.mimetype)) {
      return cb(invalidFileType(`Unsupported file type. Allowed: ${SUPPORTED_MIME_TYPES.join(', ')}`));
    }
    cb(null, true);
  },
});

// Audit through the shared super-admin helper (platform.guards checks every
// mutating route body for `await audit(`); prior state travels in the data
// payload under `previous` since audit() only writes new_data.


/* ═══════════════════════════════════════════════════════════════════════════
   GET /ai/knowledge — the corpus with its lifecycle state + current version
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/ai/knowledge', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.title, d.source_version, d.category, d.filename, d.mime_type,
              d.file_size_bytes, d.content_hash, d.status, d.error_message,
              d.chunk_count, d.approval_status, d.approved_by, d.approved_at, d.created_at,
              CASE WHEN d.approval_status = 'approved' THEN TRUE ELSE FALSE END AS is_active
         FROM ai_documents d
        WHERE d.is_global = TRUE
        ORDER BY d.created_at DESC`
    );
    res.json({ data: rows, corpus_version: await getCorpusVersion() });
  } catch (err) { next(err); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /ai/knowledge — upload a new corpus document (starts as pending review)
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/ai/knowledge', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: { code: 'VALIDATION', message: 'file is required' } });
    const title = (req.body?.title || req.file.originalname || 'Untitled document').trim().slice(0, 255);
    const category = CATEGORIES.includes(req.body?.category) ? req.body.category : 'guide';
    const sourceVersion = (req.body?.source_version || '').trim().slice(0, 64) || null;

    const contentHash = createHash('sha256').update(req.file.buffer).digest('hex');

    // Duplicate detection on the corpus: the exact same bytes must not be
    // ingested again under a second identity (retry idempotency, accidental
    // re-uploads). No-op the row rather than silently spawning a second one.
    const { rows: dupes } = await pool.query(
      `SELECT id, title, category, approval_status, status FROM ai_documents
        WHERE is_global = TRUE AND content_hash = $1 AND approval_status <> 'revoked'
        LIMIT 1`,
      [contentHash]
    );
    if (dupes.length) {
      const existing = dupes[0];
      return res.status(409).json({
        error: {
          code: 'DUPLICATE_DOCUMENT',
          message: `These exact bytes are already in the corpus as "${existing.title}" (${existing.category}, ${existing.approval_status}, ${existing.status}). Delete that document first, or upload different content.`,
          document_id: existing.id,
        },
      });
    }

    const id = randomUUID();
    const ext = EXT_BY_MIME[req.file.mimetype] || 'bin';
    const fileKey = `knowledge/${id}.${ext}`;
    await saveFile('knowledge', `${id}.${ext}`, req.file.buffer, req.file.mimetype,
      { organizationId: null, uploadedBy: req.user?.id });

    const { rows } = await pool.query(
      `INSERT INTO ai_documents
         (id, organization_id, is_global, title, category, filename, file_key, mime_type,
          file_size_bytes, uploaded_by, source_version, content_hash, approval_status)
       VALUES ($1, NULL, TRUE, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       RETURNING id, title, source_version, category, filename, mime_type, file_size_bytes,
                 status, chunk_count, approval_status, created_at`,
      [id, title, category, req.file.originalname, fileKey, req.file.mimetype, req.file.size,
       req.user?.id || null, sourceVersion, contentHash]
    );

    await audit(req, 'ai_knowledge_uploaded', 'ai_knowledge_document', id,
      { title, category, source_version: sourceVersion, content_hash: contentHash, file_size_bytes: req.file.size });

    res.status(201).json({ data: rows[0] });

    // Ingestion off the request path, exactly like the studio route —
    // approval can happen while chunks are being built, but the document only
    // becomes an active generation source once BOTH ingestion=ready AND
    // approval=approved hold.
    const { dispatchAiJob } = require('../../../services/ai.service');
    dispatchAiJob('ingest_document', { documentId: id }, () =>
      require('../../../lib/ai/knowledgeBase').ingestDocument(id)
    ).catch((err) => logger.error({ documentId: id, err: err.message }, 'ai_knowledge_platform_ingest_uncaught'));
  } catch (err) {
    logger.error({ err: err.message }, 'ai_knowledge_platform_upload_error');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to upload corpus document' } });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /ai/knowledge/:id/approve — activate a reviewed document as a
   generation source. Idempotency guard: already-approved → 409.
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/ai/knowledge/:id/approve', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ai_documents WHERE id = $1 AND is_global = TRUE', [req.params.id]);
    const doc = rows[0];
    if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Corpus document not found' } });
    if (doc.approval_status === 'approved') {
      return res.status(409).json({ error: { code: 'ALREADY_APPROVED', message: 'Document is already an active generation source' } });
    }
    if (doc.status !== 'ready') {
      return res.status(409).json({ error: { code: 'NOT_READY', message: `Document ingestion has not completed (status: "${doc.status}")` } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ai_documents SET approval_status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [doc.id, req.user?.id || null]
      );
      // Version activation: the newest approved doc of a title family supersedes
      // prior approved ones, so contradictory versions can never both be live
      // retrieval sources. Revoked history is preserved for traceability.
      await client.query(
        `UPDATE ai_documents SET approval_status = 'revoked', updated_at = NOW()
          WHERE is_global = TRUE AND approval_status = 'approved' AND id <> $1
            AND LOWER(BTRIM(title)) = $2`,
        [doc.id, doc.title.toLowerCase().trim()]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    await audit(req, 'ai_knowledge_approved', 'ai_knowledge_document', doc.id,
      { title: doc.title, source_version: doc.source_version, previous: { approval_status: doc.approval_status } });

    const { rows: updated } = await pool.query(
      'SELECT id, title, source_version, approval_status, approved_at FROM ai_documents WHERE id = $1', [doc.id]);
    res.json({ data: updated[0], corpus_version: await getCorpusVersion() });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_knowledge_approve_error');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to approve corpus document' } });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /ai/knowledge/:id/revoke — stop using this version as a source
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/ai/knowledge/:id/revoke', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE ai_documents SET approval_status = 'revoked', updated_at = NOW()
        WHERE id = $1 AND is_global = TRUE AND approval_status = 'approved'
        RETURNING id, title, source_version, approval_status`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Approved corpus document not found' } });

    await audit(req, 'ai_knowledge_revoked', 'ai_knowledge_document', rows[0].id,
      { approval_status: 'revoked', previous: { title: rows[0].title, approval_status: 'approved' } });

    res.json({ data: rows[0], corpus_version: await getCorpusVersion() });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_knowledge_revoke_error');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to revoke corpus document' } });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   DELETE /ai/knowledge/:id — remove a corpus document (row file and all)
   ═══════════════════════════════════════════════════════════════════════════ */
router.delete('/ai/knowledge/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, source_version, approval_status FROM ai_documents WHERE id = $1 AND is_global = TRUE`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Corpus document not found' } });

    await deleteDocument(req.params.id);
    await audit(req, 'ai_knowledge_deleted', 'ai_knowledge_document', rows[0].id,
      { title: rows[0].title, approval_status: rows[0].approval_status });
    res.json({ message: 'Corpus document deleted' });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_knowledge_delete_error');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to delete corpus document' } });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /ai/knowledge/:id/reindex — re-run extraction + embedding
   (approval is untouched: a revoked document stays revoked)
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/ai/knowledge/:id/reindex', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE ai_documents SET status = 'processing', error_message = NULL, updated_at = NOW()
        WHERE id = $1 AND is_global = TRUE RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Corpus document not found' } });

    // Approving while indexing would activate a half-built source; block it.
    await pool.query(
      `UPDATE ai_documents SET approval_status = 'pending', approved_by = NULL, approved_at = NULL, updated_at = NOW()
        WHERE id = $1 AND approval_status = 'approved'`,
      [req.params.id]
    );
    await audit(req, 'ai_knowledge_reindexed', 'ai_knowledge_document', req.params.id, null);
    res.json({ message: 'Reindexing started' });

    const { dispatchAiJob } = require('../../../services/ai.service');
    dispatchAiJob('reindex_document', { documentId: req.params.id }, () =>
      require('../../../lib/ai/knowledgeBase').ingestDocument(req.params.id)
    ).catch((err) => logger.error({ documentId: req.params.id, err: err.message }, 'ai_knowledge_platform_reindex_uncaught'));
  } catch (err) {
    logger.error({ err: err.message }, 'ai_knowledge_reindex_route_error');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to start reindex' } });
  }
});

module.exports = router;

'use strict';
// src/routes/aiKnowledge.js — AI Coach knowledge base (RAG document library)
// Mounted at /api/ai/knowledge. Registered BEFORE /api/ai in server.js so it
// is matched first regardless of what /api/ai's own router does internally.
//
// Tenant model: org admins/managers upload knowledge scoped to their own
// organization (organization_id = caller's org). Platform super admins can
// additionally upload GLOBAL platform knowledge by sending
// is_global=true — such documents get organization_id NULL and become
// readable by every organization via the retrieval layer
// (lib/ai/knowledgeBase.js). Global uploads are the ONLY way a document
// becomes global; there is no inference or fallback anywhere.

const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');
const { saveFile } = require('../lib/fileStorage');
const { SUPPORTED_MIME_TYPES } = require('../lib/ai/textExtract');
const { ingestDocument, deleteDocument } = require('../lib/ai/knowledgeBase');
const { aiIntentLimit } = require('../lib/ai/rateLimit');
const logger = require('../lib/logger');

const router = express.Router();

const CATEGORIES = ['sop', 'guide', 'policy'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB — generous for a text-heavy SOP/policy PDF
  fileFilter(_req, file, cb) {
    if (!SUPPORTED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type. Allowed: ${SUPPORTED_MIME_TYPES.join(', ')}`));
    }
    cb(null, true);
  },
});

const EXT_BY_MIME = { 'application/pdf': 'pdf', 'text/plain': 'txt' };

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/ai/knowledge  — upload + queue a document for indexing
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/', auth, requireRole('admin', 'manager'), aiIntentLimit('knowledge_ingest'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: { code: 'VALIDATION', message: 'file is required' } });

    const title = (req.body?.title || req.file.originalname || 'Untitled document').trim().slice(0, 255);
    const category = CATEGORIES.includes(req.body?.category) ? req.body.category : 'guide';

    // Global documents: platform super admin only, and only when explicitly
    // requested (is_global=true) — a super admin without that flag goes down
    // the normal org path and still needs an x-org-id. A non-super-admin can
    // never create a global document.
    const isGlobal = req.user?.role === 'super_admin' && req.body?.is_global === 'true';
    const organizationId = isGlobal ? null : orgIdOf(req);
    if (!organizationId) {
      return res.status(400).json({
        error: { code: 'NO_ORG', message: 'Select a target organization (x-org-id) before uploading a document.' },
      });
    }

    const id = randomUUID();
    const ext = EXT_BY_MIME[req.file.mimetype] || 'bin';
    const fileKey = `knowledge/${id}.${ext}`;
    await saveFile('knowledge', `${id}.${ext}`, req.file.buffer, req.file.mimetype,
      { organizationId: req.user?.organization_id, uploadedBy: req.user?.id });

    const { rows } = await pool.query(
      `INSERT INTO ai_documents
         (id, organization_id, is_global, title, category, filename, file_key, mime_type, file_size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, organization_id, is_global, title, category, filename, mime_type, file_size_bytes, status, chunk_count, created_at`,
      [id, organizationId, isGlobal, title, category, req.file.originalname, fileKey, req.file.mimetype, req.file.size, req.user.id]
    );

    res.status(201).json({ data: rows[0] });

    // Move ingestion off the request path: extraction + chunking + embedding
    // can easily exceed a typical request timeout for anything beyond a couple
    // of pages. Enqueue to the 'ai' queue when Redis is available; otherwise
    // fall back to the previous fire-and-forget inline run. ingestDocument
    // records failures on the document row itself (status='failed').
    const { dispatchAiJob } = require('../services/ai.service');
    dispatchAiJob('ingest_document', { documentId: id }, () => ingestDocument(id))
      .catch((err) => logger.error({ documentId: id, err: err.message }, 'ai_knowledge_ingest_uncaught'));
  } catch (err) {
    logger.error({ err: err.message }, 'ai_knowledge_upload_error');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to upload document' } });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/ai/knowledge — list this org's documents
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/', auth, requireRole('admin', 'manager'), async (req, res) => {
  const scope = tenantScope(req);
  if (!scope.applyFilter) return res.json({ data: [] }); // platform-wide super admin: no single org to list

  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.category, d.filename, d.mime_type, d.file_size_bytes,
            d.status, d.error_message, d.chunk_count, d.is_global, d.created_at,
            u.name AS uploaded_by_name
     FROM ai_documents d
     LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.organization_id = $1
     ORDER BY d.created_at DESC`,
    [scope.orgId]
  );
  res.json({ data: rows });
});

/* ═══════════════════════════════════════════════════════════════════════════
   DELETE /api/ai/knowledge/:id
   ═══════════════════════════════════════════════════════════════════════════ */
router.delete('/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const scope = tenantScope(req);
  const params = [req.params.id];
  let orgClause = '';
  if (scope.applyFilter) { params.push(scope.orgId); orgClause = ' AND organization_id = $2'; }

  const { rows } = await pool.query(`SELECT id FROM ai_documents WHERE id = $1${orgClause}`, params);
  if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found' } });

  await deleteDocument(req.params.id);
  res.json({ message: 'Document deleted' });
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/ai/knowledge/:id/reindex — re-run extraction+chunking+embedding
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/reindex', auth, requireRole('admin', 'manager'), aiIntentLimit('knowledge_ingest'), async (req, res) => {
  const scope = tenantScope(req);
  const params = [req.params.id];
  let orgClause = '';
  if (scope.applyFilter) { params.push(scope.orgId); orgClause = ' AND organization_id = $2'; }

  const { rows } = await pool.query(`SELECT id FROM ai_documents WHERE id = $1${orgClause}`, params);
  if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found' } });

  await pool.query(`UPDATE ai_documents SET status = 'processing', error_message = NULL, updated_at = NOW() WHERE id = $1`, [req.params.id]);
  res.json({ message: 'Reindexing started' });

  const { dispatchAiJob } = require('../services/ai.service');
  dispatchAiJob('reindex_document', { documentId: req.params.id }, () => ingestDocument(req.params.id))
    .catch((err) => logger.error({ documentId: req.params.id, err: err.message }, 'ai_knowledge_reindex_uncaught'));
});

module.exports = router;

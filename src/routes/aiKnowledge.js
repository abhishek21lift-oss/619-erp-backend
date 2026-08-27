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
const { requireRole, requireStaff } = require('../middleware/rbac');
const { tenantScope, orgIdOf } = require('../lib/tenant-db');
const { saveFile } = require('../lib/fileStorage');
const { SUPPORTED_MIME_TYPES } = require('../lib/ai/textExtract');
const { ingestDocument, deleteDocument, retrieveContext } = require('../lib/ai/knowledgeBase');
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
router.post('/', auth, requireRole('admin', 'manager'), (req, res, next) => {
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
   GET /api/ai/knowledge/search?q=&topK= — retrieval for first-party assistants

   Until now retrieveContext() was reachable only from inside routes/ai.js, so
   the AI Coach was the only thing that could ever be grounded in a studio's own
   documents. The MY PT STUDIO AI service (repo: mps-ai) answers policy
   questions too, and with nothing to retrieve it can only say "I don't have
   your policy documents" — correct, and less useful than the answer that is
   sitting in the library already.

   Declared BEFORE the /:id routes below so a document can never be named
   "search". Those are DELETE and POST today, so there is no collision yet;
   this is about the GET /:id somebody adds next year.

   ── Why requireStaff, when managing the library is admin/manager ────────────

   Uploading, deleting and reindexing are custodial acts over a shared
   resource, and they stay restricted. READING what a policy says is what the
   policy is for. The people who need "how long is the notice period?" mid-shift
   are trainers and reception, and gating retrieval to admin/manager would leave
   the knowledge base useful only to the two roles least likely to be asking.

   `member` is still excluded — these are internal SOPs, guides and policies,
   and requireStaff is the same allow-list guarding /api/pt-os.

   ── What it deliberately does NOT do ────────────────────────────────────────

   No answer generation, no summarising, no ranking beyond similarity. It
   returns the studio's own text and the document it came from, and leaves the
   interpreting to the caller. A retrieval endpoint that paraphrases is a second
   place for a policy to be quietly reworded.
   ═══════════════════════════════════════════════════════════════════════════ */
const MAX_QUERY_CHARS = 500;
const MAX_TOP_K = 10;

router.get('/search', auth, requireStaff, async (req, res) => {
  const scope = tenantScope(req);
  // Retrieval is per-studio by definition — the chunks table is partitioned by
  // organization_id and a similarity search across every tenant on the platform
  // is not a thing anyone should be able to run. A platform-wide super admin
  // has no single org to search, so this is empty rather than everything.
  // Mirrors GET / above, and retrieveContext() itself fails closed the same way
  // on a null organizationId.
  if (!scope.applyFilter) {
    return res.json({ data: { chunks: [], documents_available: 0, scope: 'platform' } });
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'q is required' } });
  }
  if (q.length > MAX_QUERY_CHARS) {
    // Embedding cost scales with what is sent, and this endpoint sits inside
    // requireAiQuota() — a caller must not be able to spend a studio's quota by
    // pasting a document into the query string.
    return res.status(400).json({
      error: { code: 'VALIDATION', message: `q must be ${MAX_QUERY_CHARS} characters or fewer` },
    });
  }

  const requestedTopK = parseInt(req.query.topK, 10);
  const topK = Number.isFinite(requestedTopK)
    ? Math.min(Math.max(requestedTopK, 1), MAX_TOP_K)
    : undefined;   // undefined → retrieveContext's own AI_RAG_TOP_K default

  // Counted separately, and worth the extra query: it is the difference between
  // "this studio has not uploaded any policies" and "nothing in the policies
  // covers that". An assistant told only that the result was empty will happily
  // report the first as the second, which is how "we have no refund policy"
  // gets said about a studio that has one.
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ai_documents WHERE organization_id = $1 AND status = 'ready'`,
    [scope.orgId]
  );
  const documentsAvailable = countRows[0]?.n ?? 0;

  let chunks = [];
  try {
    chunks = await retrieveContext({ organizationId: scope.orgId, query: q, topK });
  } catch (err) {
    // Same posture as the AI Coach's own call site: a cold embedding model is
    // not a reason to 500 a search box. Empty results with the document count
    // attached still let the caller say something true.
    logger.warn({ err: err.message }, 'ai_knowledge_search_failed');
  }

  res.json({
    data: {
      chunks: chunks.map((c) => ({
        content: c.content,
        title: c.title,
        category: c.category,
        document_id: c.document_id,
        chunk_index: c.chunk_index,
        similarity: Number(c.similarity),
      })),
      documents_available: documentsAvailable,
      scope: 'organization',
    },
  });
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
router.post('/:id/reindex', auth, requireRole('admin', 'manager'), async (req, res) => {
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

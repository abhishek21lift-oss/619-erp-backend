'use strict';

// Whiteboard REST API.
//
// Authorisation model (phase 1): a board belongs to an organization, and any
// authenticated member of that organization who can reach the module may open
// it. Write access is limited to the roles that create clinical/training
// content. Per-board ACLs (share links, per-user view/comment/edit grants) are
// a later phase — they need a whiteboard_members table and a sharing UI, and
// shipping a permissions surface that only half-works is worse than shipping
// the org-scoped rule and saying so.
//
// Tenant isolation is not role-based: it comes from tenantScope(), the same
// fail-closed helper every other module uses. A tenant user with no
// organization resolves to orgId=null and matches no rows.

const router = require('express').Router();
const multer = require('multer');
const { randomUUID } = require('crypto');
const { auth } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { z } = require('../../lib/validation');
const logger = require('../../lib/logger');
const { tenantScope } = require('../../lib/tenant-db');
const { saveFile, serveFile } = require('../../lib/fileStorage');
const svc = require('./whiteboard.service');

router.use(auth);

// Roles allowed to create/modify boards. `member` (a client) is intentionally
// absent: clients may not author annotations on their own record.
const WRITE_ROLES = new Set(['super_admin', 'admin', 'manager', 'trainer']);

function canWrite(req) {
  return WRITE_ROLES.has(req.user?.role);
}

function requireWrite(req, res, next) {
  if (!canWrite(req)) {
    return res.status(403).json({ error: 'You do not have permission to edit whiteboards' });
  }
  next();
}

/**
 * Single place where service errors become HTTP responses. Without this every
 * handler re-implements the same try/catch and they drift.
 */
function handle(fn) {
  return async function (req, res) {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof svc.WhiteboardError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      logger.error({ err, path: req.path, method: req.method }, 'Whiteboard request failed');
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

// ── Schemas ─────────────────────────────────────────────────────────────────

// The document is passed through as an opaque object; the service validates
// its shape and size. Declaring the full Excalidraw element schema here would
// mean editing this file every time the engine adds a property.
const documentSchema = z.object({}).passthrough();

const idParam = { params: z.object({ id: z.string().uuid() }) };

const listSchema = {
  query: z.object({
    entity_type: z.enum(svc.ENTITY_TYPES).optional(),
    entity_id: z.string().max(128).optional(),
    status: z.enum(['active', 'archived']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
};

const createSchema = {
  body: z.object({
    title: z.string().min(1).max(200),
    entity_type: z.enum(svc.ENTITY_TYPES).optional().nullable(),
    entity_id: z.string().max(128).optional().nullable(),
    document: documentSchema.optional(),
  }),
};

const saveSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    document: documentSchema,
    // Required, not optional: making it optional would let a careless client
    // silently opt out of conflict detection, which defeats the mechanism.
    document_version: z.coerce.number().int().min(0),
  }),
};

const metaSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    status: z.enum(['active', 'archived']).optional(),
  }),
};

// ── Boards ──────────────────────────────────────────────────────────────────

// GET /api/whiteboards?entity_type=pt_client&entity_id=<uuid>
router.get('/', validate(listSchema), handle(async (req, res) => {
  const { orgId } = tenantScope(req);
  const rows = await svc.listBoards({
    orgId,
    entityType: req.query.entity_type,
    entityId: req.query.entity_id,
    status: req.query.status || 'active',
    limit: req.query.limit || 50,
    offset: req.query.offset || 0,
  });
  res.json({ data: rows });
}));

// GET /api/whiteboards/search?q=
router.get('/search', validate({ query: z.object({ q: z.string().min(1).max(120) }) }),
  handle(async (req, res) => {
    const { orgId } = tenantScope(req);
    const rows = await svc.searchBoards({ orgId, query: req.query.q });
    res.json({ data: rows });
  }));

// GET /api/whiteboards/:id — full board including document.
router.get('/:id', validate(idParam), handle(async (req, res) => {
  const { orgId } = tenantScope(req);
  const board = await svc.getBoard({ orgId, id: req.params.id });
  if (!board) return res.status(404).json({ error: 'Whiteboard not found' });
  res.json({ data: { ...board, can_edit: canWrite(req) } });
}));

// POST /api/whiteboards
router.post('/', requireWrite, validate(createSchema), handle(async (req, res) => {
  const { orgId } = tenantScope(req);
  if (!orgId) {
    // A platform super_admin with no x-org-id header has no organization to
    // stamp on the row. Fail loudly rather than writing an orphan board.
    return res.status(400).json({ error: 'Select an organization before creating a whiteboard' });
  }
  const board = await svc.createBoard({
    orgId,
    userId: req.user.id,
    title: req.body.title,
    entityType: req.body.entity_type,
    entityId: req.body.entity_id,
    document: req.body.document,
  });
  res.status(201).json({ data: board });
}));

// PUT /api/whiteboards/:id/document — autosave target.
router.put('/:id/document', requireWrite, validate(saveSchema), handle(async (req, res) => {
  const { orgId } = tenantScope(req);
  const result = await svc.saveDocument({
    orgId,
    id: req.params.id,
    userId: req.user.id,
    document: req.body.document,
    expectedVersion: req.body.document_version,
  });
  res.json({ data: result });
}));

// PATCH /api/whiteboards/:id — rename / archive.
router.patch('/:id', requireWrite, validate(metaSchema), handle(async (req, res) => {
  const { orgId } = tenantScope(req);
  const board = await svc.updateMeta({
    orgId, id: req.params.id, title: req.body.title, status: req.body.status,
  });
  if (!board) return res.status(404).json({ error: 'Whiteboard not found' });
  res.json({ data: board });
}));

// DELETE /api/whiteboards/:id — soft delete.
router.delete('/:id', requireWrite, validate(idParam), handle(async (req, res) => {
  const { orgId } = tenantScope(req);
  const ok = await svc.softDelete({ orgId, id: req.params.id });
  if (!ok) return res.status(404).json({ error: 'Whiteboard not found' });
  res.json({ data: { deleted: true } });
}));

// ── Versions ────────────────────────────────────────────────────────────────

router.get('/:id/versions', validate(idParam), handle(async (req, res) => {
  const { orgId } = tenantScope(req);
  res.json({ data: await svc.listVersions({ orgId, boardId: req.params.id }) });
}));

router.post('/:id/versions', requireWrite,
  validate({ params: idParam.params, body: z.object({ label: z.string().max(120).optional() }) }),
  handle(async (req, res) => {
    const { orgId } = tenantScope(req);
    const version = await svc.createVersion({
      orgId, boardId: req.params.id, userId: req.user.id, label: req.body.label,
    });
    res.status(201).json({ data: version });
  }));

router.post('/:id/versions/:versionId/restore', requireWrite,
  validate({ params: z.object({ id: z.string().uuid(), versionId: z.string().uuid() }) }),
  handle(async (req, res) => {
    const { orgId } = tenantScope(req);
    const result = await svc.restoreVersion({
      orgId, boardId: req.params.id, versionId: req.params.versionId, userId: req.user.id,
    });
    res.json({ data: result });
  }));

// ── Attachments ─────────────────────────────────────────────────────────────
//
// memoryStorage + magic-byte sniff, matching the org-logo and PAR-Q upload
// paths: a declared Content-Type is attacker-controlled and cannot be trusted
// to decide what gets written to storage.

const ATTACHMENT_MAX_BYTES =
  parseInt(process.env.WHITEBOARD_ATTACHMENT_MAX_BYTES, 10) || 8 * 1024 * 1024; // 8MB

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (!/^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i.test(file.mimetype || '')) {
      return cb(new Error('Only PNG, JPG, WEBP, GIF or PDF files are allowed'));
    }
    cb(null, true);
  },
});

const ATTACHMENT_SIGNATURES = [
  { mime: 'image/jpeg',      ext: 'jpg',  magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',       ext: 'png',  magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif',       ext: 'gif',  magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp',      ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
  { mime: 'application/pdf', ext: 'pdf',  magic: [0x25, 0x50, 0x44, 0x46] }, // "%PDF"
];

function detectType(buf) {
  for (const sig of ATTACHMENT_SIGNATURES) {
    if (sig.magic.every((b, i) => buf[i] === b)) return sig;
  }
  return null;
}

router.post('/:id/attachments', requireWrite, validate(idParam),
  (req, res, next) => {
    attachmentUpload.single('file')(req, res, (err) => {
      if (err) {
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
          error: tooBig
            ? `File too large (max ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB)`
            : err.message,
        });
      }
      next();
    });
  },
  handle(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const sig = detectType(req.file.buffer);
    if (!sig) {
      // The bytes do not match any format we accept, regardless of what the
      // Content-Type claimed.
      return res.status(400).json({ error: 'File content does not match an allowed format' });
    }

    const { orgId } = tenantScope(req);
    // Server-generated key: a client-supplied filename must never influence
    // the storage path.
    const key = `${randomUUID()}.${sig.ext}`;
    await saveFile('whiteboard', key, req.file.buffer, sig.mime);

    const row = await svc.recordAttachment({
      orgId,
      boardId: req.params.id,
      userId: req.user.id,
      fileKey: `whiteboard/${key}`,
      // Stored for display only, and length-capped. Never used as a path.
      fileName: String(req.file.originalname || 'upload').slice(0, 200),
      mimeType: sig.mime,
      sizeBytes: req.file.size,
    });

    res.status(201).json({ data: { ...row, url: `/api/whiteboards/attachments/${row.id}` } });
  }));

// GET /api/whiteboards/attachments/:id — authorised download.
// Streams through the API rather than exposing bucket URLs, so tenant
// ownership is checked on every fetch.
router.get('/attachments/:id', validate(idParam), handle(async (req, res) => {
  const { orgId } = tenantScope(req);
  const att = await svc.getAttachment({ orgId, id: req.params.id });
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  await serveFile(att.file_key, res, { maxAgeSeconds: 3600 });
}));

module.exports = router;

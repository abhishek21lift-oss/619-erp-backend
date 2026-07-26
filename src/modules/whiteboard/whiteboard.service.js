'use strict';

// Whiteboard persistence. Everything tenant-scoped; the routes layer never
// issues SQL of its own.
//
// The canvas document is treated as an opaque blob: this service validates its
// SHAPE (an object with an elements array) and its SIZE, extracts text for
// search, and otherwise does not interpret it. That keeps the server decoupled
// from the canvas engine's document format, which the engine version-migrates
// on its own.

const pool = require('../../db/pool');

// A board document is one row. Postgres will happily store a 100 MB jsonb and
// then make every read of that board miserable, so the ceiling is enforced
// here rather than discovered in production. 5 MB of JSON is a very large
// board (thousands of elements); images are attachments, not inline data.
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

// Keep the search column bounded — a board with 10k text elements should not
// write an unbounded string into every row and every index entry.
const MAX_SEARCH_TEXT = 20000;

const ENTITY_TYPES = ['pt_client', 'session', 'exercise', 'staff', 'course', 'consultation'];

class WhiteboardError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Pull every piece of user-authored text out of a canvas document so a board
 * can be found by what is written on it.
 *
 * Defensive by construction: the document is client-supplied, so this walks
 * only the fields it expects and never assumes a shape. A malformed document
 * yields an empty string rather than throwing — failing a save because search
 * indexing choked would lose the trainer's work, which is a far worse outcome
 * than a board that is briefly not searchable.
 */
function extractText(document) {
  try {
    const elements = document && Array.isArray(document.elements) ? document.elements : [];
    const parts = [];
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      if (el.isDeleted) continue;
      // `text` covers text elements; `label.text` covers text bound to a shape
      // (arrow labels, container labels).
      if (typeof el.text === 'string' && el.text.trim()) parts.push(el.text.trim());
      if (el.label && typeof el.label.text === 'string' && el.label.text.trim()) {
        parts.push(el.label.text.trim());
      }
    }
    return parts.join(' ').slice(0, MAX_SEARCH_TEXT);
  } catch {
    return '';
  }
}

/**
 * Validate a client-supplied document before it reaches the database.
 * Throws WhiteboardError(422) rather than letting a bad payload become a
 * confusing constraint violation deeper down.
 */
function assertValidDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new WhiteboardError('document must be an object', 422, 'INVALID_DOCUMENT');
  }
  if (!Array.isArray(document.elements)) {
    throw new WhiteboardError('document.elements must be an array', 422, 'INVALID_DOCUMENT');
  }
  // Byte length, not string length — multi-byte text would otherwise sail past
  // a .length check and still blow the row size.
  const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new WhiteboardError(
      `document too large (${Math.round(bytes / 1024)} KB, limit ${MAX_DOCUMENT_BYTES / 1024} KB)`,
      413,
      'DOCUMENT_TOO_LARGE',
    );
  }
}

// Columns returned to list views. Deliberately excludes `document` — a list of
// 50 boards must not drag 50 canvas snapshots across the wire.
const LIST_COLUMNS = `
  id, organization_id, title, entity_type, entity_id,
  document_version, thumbnail_key, status,
  created_by, updated_by, created_at, updated_at
`;

/**
 * Boards attached to an entity (or the studio's recent boards when no entity
 * is given). Newest-updated first, which is what "recent" means to a user.
 */
async function listBoards({ orgId, entityType, entityId, status = 'active', limit = 50, offset = 0 }) {
  const where = ['deleted_at IS NULL'];
  const params = [];

  // orgId is null only for a platform super_admin operating across all orgs.
  if (orgId !== null) {
    params.push(orgId);
    where.push(`organization_id = $${params.length}`);
  }
  if (entityType) {
    params.push(entityType);
    where.push(`entity_type = $${params.length}`);
    // An entity_id without an entity_type is meaningless, so it is only
    // applied inside this branch.
    if (entityId) {
      params.push(String(entityId));
      where.push(`entity_id = $${params.length}`);
    }
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS}
       FROM whiteboards
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/** A single board including its document. Tenant-checked. */
async function getBoard({ orgId, id }) {
  const params = [id];
  let scope = '';
  if (orgId !== null) {
    params.push(orgId);
    scope = ` AND organization_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM whiteboards
      WHERE id = $1 AND deleted_at IS NULL${scope}`,
    params,
  );
  return rows[0] || null;
}

async function createBoard({ orgId, userId, title, entityType, entityId, document }) {
  if (entityType && !ENTITY_TYPES.includes(entityType)) {
    throw new WhiteboardError('unsupported entity_type', 422, 'INVALID_ENTITY_TYPE');
  }
  const doc = document || { elements: [], appState: {} };
  assertValidDocument(doc);

  const { rows } = await pool.query(
    `INSERT INTO whiteboards
       (organization_id, title, entity_type, entity_id, document, search_text, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)
     RETURNING *`,
    [orgId, title, entityType || null, entityId ? String(entityId) : null,
      JSON.stringify(doc), extractText(doc), userId],
  );
  return rows[0];
}

/**
 * Save a document.
 *
 * Optimistic concurrency: the caller must present the document_version it
 * loaded. If the stored version has moved on, someone else saved in the
 * meantime and this write is refused with 409 instead of silently discarding
 * their work. The client decides how to reconcile.
 *
 * `expectedVersion` may be omitted for a force-save (e.g. restoring a version),
 * which is why it is explicitly opt-out rather than merely absent.
 */
async function saveDocument({ orgId, id, userId, document, expectedVersion, force = false }) {
  assertValidDocument(document);

  const params = [JSON.stringify(document), extractText(document), userId, id];
  let scope = '';
  if (orgId !== null) {
    params.push(orgId);
    scope = ` AND organization_id = $${params.length}`;
  }
  let versionGuard = '';
  if (!force) {
    params.push(expectedVersion);
    versionGuard = ` AND document_version = $${params.length}`;
  }

  const { rows } = await pool.query(
    `UPDATE whiteboards
        SET document         = $1::jsonb,
            search_text      = $2,
            updated_by       = $3,
            document_version = document_version + 1
      WHERE id = $4 AND deleted_at IS NULL${scope}${versionGuard}
      RETURNING id, document_version, updated_at`,
    params,
  );

  if (!rows[0]) {
    // Distinguish "gone" from "stale" — the client's recovery differs. A 404
    // means stop; a 409 means reload and merge.
    const existing = await getBoard({ orgId, id });
    if (!existing) throw new WhiteboardError('whiteboard not found', 404, 'NOT_FOUND');
    throw new WhiteboardError(
      `document was modified by someone else (server version ${existing.document_version})`,
      409,
      'VERSION_CONFLICT',
    );
  }
  return rows[0];
}

async function updateMeta({ orgId, id, title, status }) {
  const sets = [];
  const params = [];
  if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
  if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }
  if (!sets.length) return getBoard({ orgId, id });

  params.push(id);
  let scope = '';
  if (orgId !== null) {
    params.push(orgId);
    scope = ` AND organization_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `UPDATE whiteboards SET ${sets.join(', ')}
      WHERE id = $${sets.length + 1} AND deleted_at IS NULL${scope}
      RETURNING ${LIST_COLUMNS}`,
    params,
  );
  return rows[0] || null;
}

/** Soft delete — boards can hold clinical annotations; nothing is hard-deleted here. */
async function softDelete({ orgId, id }) {
  const params = [id];
  let scope = '';
  if (orgId !== null) {
    params.push(orgId);
    scope = ` AND organization_id = $${params.length}`;
  }
  const { rowCount } = await pool.query(
    `UPDATE whiteboards SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL${scope}`,
    params,
  );
  return rowCount > 0;
}

// ── Versions ────────────────────────────────────────────────────────────────

async function listVersions({ orgId, boardId, limit = 30 }) {
  const board = await getBoard({ orgId, id: boardId });
  if (!board) throw new WhiteboardError('whiteboard not found', 404, 'NOT_FOUND');

  // `document` is excluded: a version list is metadata. Fetching 30 snapshots
  // to render 30 timestamps is exactly the mistake this column list avoids.
  const { rows } = await pool.query(
    `SELECT id, document_version, label, created_by, created_at
       FROM whiteboard_versions
      WHERE whiteboard_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [boardId, limit],
  );
  return rows;
}

async function createVersion({ orgId, boardId, userId, label }) {
  const board = await getBoard({ orgId, id: boardId });
  if (!board) throw new WhiteboardError('whiteboard not found', 404, 'NOT_FOUND');

  const { rows } = await pool.query(
    `INSERT INTO whiteboard_versions
       (whiteboard_id, organization_id, document, document_version, label, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     RETURNING id, document_version, label, created_by, created_at`,
    [boardId, board.organization_id, JSON.stringify(board.document),
      board.document_version, label || null, userId],
  );
  return rows[0];
}

/**
 * Restore a previous snapshot.
 *
 * Snapshots the CURRENT document first, so restoring is itself undoable —
 * without that, one mis-click permanently destroys the live board, which is
 * the whole reason version history exists.
 */
async function restoreVersion({ orgId, boardId, versionId, userId }) {
  const board = await getBoard({ orgId, id: boardId });
  if (!board) throw new WhiteboardError('whiteboard not found', 404, 'NOT_FOUND');

  const { rows: vrows } = await pool.query(
    `SELECT document FROM whiteboard_versions WHERE id = $1 AND whiteboard_id = $2`,
    [versionId, boardId],
  );
  if (!vrows[0]) throw new WhiteboardError('version not found', 404, 'NOT_FOUND');

  await createVersion({ orgId, boardId, userId, label: 'Auto-saved before restore' });

  // force: the restore intentionally overwrites whatever is live, and the
  // pre-restore snapshot above is what makes that safe.
  return saveDocument({
    orgId, id: boardId, userId,
    document: vrows[0].document,
    force: true,
  });
}

// ── Attachments ─────────────────────────────────────────────────────────────

async function recordAttachment({ orgId, boardId, userId, fileKey, fileName, mimeType, sizeBytes }) {
  const board = await getBoard({ orgId, id: boardId });
  if (!board) throw new WhiteboardError('whiteboard not found', 404, 'NOT_FOUND');

  const { rows } = await pool.query(
    `INSERT INTO whiteboard_attachments
       (whiteboard_id, organization_id, file_key, file_name, mime_type, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, file_key, file_name, mime_type, size_bytes, created_at`,
    [boardId, board.organization_id, fileKey, fileName, mimeType, sizeBytes, userId],
  );
  return rows[0];
}

/** Ownership lookup used to authorise a download. */
async function getAttachment({ orgId, id }) {
  const params = [id];
  let scope = '';
  if (orgId !== null) {
    params.push(orgId);
    scope = ` AND organization_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM whiteboard_attachments WHERE id = $1${scope}`,
    params,
  );
  return rows[0] || null;
}

// ── Search ──────────────────────────────────────────────────────────────────

/** Title or canvas-text match, for the global search bar. */
async function searchBoards({ orgId, query, limit = 10 }) {
  const params = [`%${query}%`];
  let scope = '';
  if (orgId !== null) {
    params.push(orgId);
    scope = ` AND organization_id = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT ${LIST_COLUMNS}
       FROM whiteboards
      WHERE deleted_at IS NULL
        AND status = 'active'
        AND (title ILIKE $1 OR search_text ILIKE $1)${scope}
      ORDER BY updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

module.exports = {
  WhiteboardError,
  ENTITY_TYPES,
  MAX_DOCUMENT_BYTES,
  extractText,
  assertValidDocument,
  listBoards,
  getBoard,
  createBoard,
  saveDocument,
  updateMeta,
  softDelete,
  listVersions,
  createVersion,
  restoreVersion,
  recordAttachment,
  getAttachment,
  searchBoards,
};

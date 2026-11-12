'use strict';
// Durable, tenant-scoped recording for every Copilot tool attempt.
//
// The registry calls `recordToolRun` after it has classified an attempt. This
// module never decides authorization and never throws: a ledger outage is
// logged, and the caller keeps the envelope it already produced. In
// particular, a failed execution can never become a successful one because
// the audit write failed — the write is additive only.
//
// Nothing sensitive enters the ledger. Arguments are reduced to a digest plus
// bounded scalars (dates, limits, windows in the current tools), provenance is
// ids and flags, and result metadata is a summary (record count, missing
// markers, stale flag), never the tool payload.

const crypto = require('crypto');
const pool = require('../../../db/pool');
const logger = require('../../../lib/logger');

const LEVELS = Object.freeze(['READ', 'ANALYZE', 'DRAFT', 'EXECUTE']);
const SENSITIVITIES = Object.freeze(['public', 'business', 'schedule', 'personal', 'clinical']);
const ERROR_CATEGORIES = Object.freeze([
  'NO_TOOL_MATCH',
  'AUTHORIZATION_DENIED',
  'TENANT_SCOPE_DENIED',
  'CLIENT_SCOPE_DENIED',
  'ARGUMENT_VALIDATION_FAILED',
  'TOOL_EXECUTION_FAILED',
  'TOOL_TIMEOUT',
]);

const CATEGORY_BY_CODE = Object.freeze({
  NO_TOOL_MATCH: 'NO_TOOL_MATCH',
  UNKNOWN_TOOL: 'AUTHORIZATION_DENIED',
  UNAUTHENTICATED: 'AUTHORIZATION_DENIED',
  FORBIDDEN: 'AUTHORIZATION_DENIED',
  NO_TENANT: 'TENANT_SCOPE_DENIED',
  CLIENT_REQUIRED: 'CLIENT_SCOPE_DENIED',
  CLIENT_NOT_FOUND: 'CLIENT_SCOPE_DENIED',
  BAD_ARGS: 'ARGUMENT_VALIDATION_FAILED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
});

const DENIAL_CATEGORIES = new Set([
  'AUTHORIZATION_DENIED',
  'TENANT_SCOPE_DENIED',
  'CLIENT_SCOPE_DENIED',
]);

/** Credential-shaped or free-text keys are never audit metadata. */
const UNSAFE_ARG_KEY = /(^|_)(password|passwd|secret|token|api_?key|authorization|cookie|note|notes|comment|comments|message|prompt|query|reason|description)(_|$)/i;

function classifyError(code) {
  return CATEGORY_BY_CODE[code] || 'TOOL_EXECUTION_FAILED';
}

function statusFor(ok, category) {
  if (ok) return 'ok';
  if (category === 'TOOL_TIMEOUT') return 'timeout';
  if (DENIAL_CATEGORIES.has(category)) return 'denied';
  return 'failed';
}

/** Stable per-attempt key: a repeated write of the same attempt is deduped. */
function runKey({
  organizationId, userId, correlationId, conversationId, messageId, toolName, argsDigest, ordinal,
}) {
  return crypto.createHash('sha256')
    .update([
      organizationId || '',
      userId || '',
      correlationId,
      conversationId || '',
      messageId || '',
      toolName,
      argsDigest || 'none',
      ordinal ?? 0,
    ].join('|'))
    .digest('hex');
}

/**
 * Bounded scalar argument metadata.
 *
 * The eleven Phase 3 tools take dates, limits and small integers only. This
 * deliberately drops objects, arrays and non-finite numbers rather than
 * serialising a future tool's free text into an audit table.
 */
function safeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const out = {};
  let kept = 0;
  for (const [key, value] of Object.entries(args)) {
    if (kept >= 20) break;
    if (!/^[a-z][a-z0-9_]{0,40}$/i.test(key)) continue;
    if (UNSAFE_ARG_KEY.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 200);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else continue;
    kept += 1;
  }
  return kept ? out : null;
}

function resultMeta(provenance, extra) {
  const p = provenance && typeof provenance === 'object' ? provenance : {};
  const records = Array.isArray(p.records) ? p.records.length : 0;
  const missing = Array.isArray(p.missing) ? p.missing.slice(0, 20) : [];
  const stale = p.freshness && typeof p.freshness === 'object' ? p.freshness.stale === true : null;
  return {
    records,
    missing,
    stale,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

function json(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

const DUPLICATE_ATTEMPTS = 3;
const RETRYABLE_CONFLICT_CODES = new Set(['40001', '40P01']);

/**
 * Append without UPDATE permission.
 *
 * DO NOTHING never reads or writes the conflicting row, so app_tenant needs
 * SELECT and INSERT only. At READ COMMITTED the INSERT waits for a concurrent
 * writer to commit, and the next statement's snapshot sees the winner; the
 * SELECT therefore returns the original id. A stronger isolation level raises
 * a serialization failure instead, retried a bounded number of times.
 *
 * Returns null if the insert conflicted but no visible row exists — a genuine
 * audit gap the caller must not report as recorded.
 */
async function insertRun(params) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO ai_tool_runs (
           organization_id, user_id, conversation_id, message_id, correlation_id, run_key,
           tool_name, level, sensitivity, client_id, args_digest, args_meta,
           status, error_code, error_category, source, source_refs, source_as_of,
           freshness, result_meta, duration_ms, selection_reason
         ) VALUES (
           $1, $2,
           (SELECT c.id FROM ai_conversations c
             WHERE c.id = $3 AND c.user_id = $2 AND c.organization_id = $1),
           (SELECT m.id FROM ai_messages m
              JOIN ai_conversations c ON c.id = m.conversation_id
             WHERE m.id = $4 AND m.conversation_id = $3
               AND c.user_id = $2 AND c.organization_id = $1),
           $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
           $13, $14, $15, $16, $17::jsonb, NULLIF($18, '')::timestamptz,
           $19::jsonb, $20::jsonb, $21, $22
         )
         ON CONFLICT (run_key) DO NOTHING
         RETURNING id`,
        params
      );
      if (rows[0]) return { id: rows[0].id, duplicate: false };

      const { rows: existing } = await pool.query(
        'SELECT id FROM ai_tool_runs WHERE run_key = $1',
        [params[5]]
      );
      return existing[0] ? { id: existing[0].id, duplicate: true } : null;
    } catch (err) {
      if (!RETRYABLE_CONFLICT_CODES.has(err.code) || attempt >= DUPLICATE_ATTEMPTS) throw err;
    }
  }
}

/**
 * Append one attempt. Never throws.
 *
 * @returns {Promise<{recorded: boolean, run_id: string|null, duplicate: boolean}>}
 */
async function recordToolRun(entry = {}) {
  const {
    organizationId = null,
    userId = null,
    conversationId = null,
    messageId = null,
    correlationId = null,
    toolName,
    level = null,
    sensitivity = null,
    clientId = null,
    argsDigest = 'none',
    argsMeta = null,
    ok = false,
    code = null,
    durationMs = 0,
    provenance = null,
    extraResultMeta = null,
    ordinal = 0,
    selectionReason = null,
  } = entry;

  if (!correlationId || !toolName) {
    return { recorded: false, run_id: null, duplicate: false };
  }

  const category = ok ? null : classifyError(code);
  const status = statusFor(ok, category);
  const p = provenance && typeof provenance === 'object' ? provenance : {};
  const run_key = runKey({
    organizationId, userId, correlationId, conversationId, messageId, toolName, argsDigest, ordinal,
  });

  const params = [
    organizationId,
    userId,
    conversationId,
    messageId,
    correlationId,
    run_key,
    String(toolName).slice(0, 64),
    LEVELS.includes(level) ? level : null,
    SENSITIVITIES.includes(sensitivity) ? sensitivity : null,
    clientId,
    String(argsDigest).slice(0, 64),
    json(safeArgs(argsMeta)),
    status,
    ok ? null : String(code || 'TOOL_FAILED').slice(0, 64),
    category,
    p.source ? String(p.source).slice(0, 200) : null,
    json(Array.isArray(p.records) ? p.records.slice(0, 50) : []),
    p.as_of ? String(p.as_of) : null,
    json(p.freshness && typeof p.freshness === 'object' ? p.freshness : null),
    json(resultMeta(p, extraResultMeta)),
    Math.max(0, Number.isFinite(Number(durationMs)) ? Math.round(Number(durationMs)) : 0),
    selectionReason ? String(selectionReason).slice(0, 80) : null,
  ];

  try {
    // conversation_id and message_id are resolved through the caller's own
    // user and organization. A foreign id becomes NULL rather than a link.
    const row = await insertRun(params);
    if (!row) {
      logger.warn(
        { tool: String(toolName).slice(0, 64) },
        'copilot_tool_ledger_duplicate_unresolved'
      );
      return { recorded: false, run_id: null, duplicate: true };
    }
    return { recorded: true, run_id: row.id, duplicate: row.duplicate };
  } catch (err) {
    // Ids and the database error code only. The SQL text can quote column
    // names; the arguments are never logged.
    logger.warn(
      { err: err.message, code: err.code, tool: String(toolName).slice(0, 64) },
      'copilot_tool_ledger_write_failed'
    );
    return { recorded: false, run_id: null, duplicate: false };
  }
}

/** Conversation ownership, re-checked before any ledger read. */
async function conversationForUser(organizationId, userId, conversationId) {
  const { rows } = await pool.query(
    `SELECT id FROM ai_conversations
      WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
    [conversationId, userId, organizationId]
  );
  return rows[0] || null;
}

function listRow(r) {
  return {
    id: r.id,
    tool: r.tool_name,
    level: r.level,
    status: r.status,
    error_code: r.error_code,
    error_category: r.error_category,
    duration_ms: r.duration_ms,
    source: r.source,
    as_of: r.source_as_of,
    freshness: r.freshness,
    result: r.result_meta,
    client_scoped: Boolean(r.client_id),
    selection_reason: r.selection_reason,
    created_at: r.created_at,
  };
}

function detailRow(r) {
  return {
    ...listRow(r),
    conversation_id: r.conversation_id,
    message_id: r.message_id,
    correlation_id: r.correlation_id,
    sensitivity: r.sensitivity,
    args_digest: r.args_digest,
    args: r.args_meta,
    source_refs: r.source_refs,
  };
}

async function listToolRuns({ organizationId, userId, conversationId, limit = 50, before = null, beforeId = null }) {
  const params = [organizationId, userId, conversationId];
  let cursor = '';
  if (before) {
    if (beforeId) {
      params.push(before, beforeId);
      cursor = `AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`;
    } else {
      params.push(before);
      cursor = `AND created_at < $${params.length}::timestamptz`;
    }
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, tool_name, level, status, error_code, error_category, duration_ms,
            source, source_as_of, freshness, result_meta, client_id, selection_reason, created_at
       FROM ai_tool_runs
      WHERE organization_id = $1 AND user_id = $2 AND conversation_id = $3
      ${cursor}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return rows.map(listRow);
}

async function getToolRun({ organizationId, userId, id }) {
  const { rows } = await pool.query(
    `SELECT id, tool_name, level, status, error_code, error_category, duration_ms,
            source, source_as_of, freshness, result_meta, client_id, selection_reason, created_at,
            conversation_id, message_id, correlation_id, sensitivity, args_digest, args_meta,
            source_refs
       FROM ai_tool_runs
      WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
    [id, organizationId, userId]
  );
  return rows[0] ? detailRow(rows[0]) : null;
}

module.exports = {
  recordToolRun,
  conversationForUser,
  listToolRuns,
  getToolRun,
  classifyError,
  statusFor,
  safeArgs,
  ERROR_CATEGORIES,
};

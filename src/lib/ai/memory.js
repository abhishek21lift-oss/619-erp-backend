'use strict';

// src/lib/ai/memory.js — Phase 2B Durable Client Memory
//
// CRUD operations and lifecycle management for semantic + episodic memory.
//
// DESIGN PRINCIPLES:
//   1. Every query enforces organization_id + client_id (tenant + client isolation)
//   2. The LLM never directly creates CONFIRMED/ACTIVE memory
//   3. Authoritative DB facts and confirmed trainer/client info may enter as 'active'
//   4. Every memory is source-backed (source_type + source_id)
//   5. Conflicts are detected, not silently overwritten
//   6. Soft delete preserves audit trail

const pool = require('../../db/pool');
const logger = require('../logger');

// ── Constants ──────────────────────────────────────────────────────────────

const VALID_CATEGORIES = [
  'preference', 'constraint', 'observation',
  'goal', 'medical', 'schedule', 'equipment',
];

const VALID_SOURCE_TYPES = [
  'trainer_confirmed', 'client_reported',
  'db_derived', 'assessment', 'system_observed',
];

const VALID_STATUSES = ['candidate', 'active', 'stale', 'superseded', 'deleted'];

const VALID_EPISODE_TYPES = [
  'programme_change', 'pr_achieved', 'injury_reported',
  'deload', 'assessment', 'milestone', 'observation',
  'session_completed', 'coach_decision', 'client_feedback',
];

const VALID_EPISODE_SOURCES = [
  'workout_log', 'trainer_note', 'assessment',
  'checkin', 'system_detected', 'ai_detected',
];

const VALID_SEVERITIES = ['info', 'warning', 'significant'];

// Source types that are authoritative enough to enter as 'active' directly.
// Everything else starts as 'candidate'.
const TRUSTED_SOURCES = new Set([
  'trainer_confirmed', 'client_reported', 'db_derived', 'assessment',
]);

// Source types that represent AI observations — must be confirmed before active.
const AI_SOURCES = new Set(['system_observed']);

// ── Helpers ────────────────────────────────────────────────────────────────

function validateRequired(fields, name = 'memory') {
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      throw new Error(`${name}: ${key} is required`);
    }
  }
}

function validateEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new Error(`Invalid ${field}: '${value}'. Must be one of: ${allowed.join(', ')}`);
  }
}

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1.0;
  return Math.max(0, Math.min(1, n));
}

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC MEMORY CRUD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new memory record.
 *
 * If source_type is trusted (trainer_confirmed, client_reported, db_derived,
 * assessment), the memory enters as 'active' directly.
 *
 * If source_type is AI (system_observed), the memory enters as 'candidate'
 * and must be confirmed before it becomes active.
 *
 * @param {object} opts
 * @param {string} opts.organization_id
 * @param {string} opts.client_id
 * @param {string} opts.category
 * @param {string} opts.fact
 * @param {string} opts.source_type
 * @param {string} [opts.subcategory]
 * @param {string} [opts.source_id]
 * @param {string} [opts.source_text]
 * @param {number} [opts.confidence=1.0]
 * @param {string} [opts.created_by]
 * @param {string} [opts.as_of]
 * @param {string} [opts.expires_at]
 * @param {string} [opts.status] — override auto-determination (only 'active' allowed for trusted sources)
 * @returns {Promise<object>} the created memory row
 */
async function createMemory(opts) {
  const {
    organization_id, client_id, category, fact, source_type,
    subcategory = null, source_id = null, source_text = null,
    confidence = 1.0, created_by = null, as_of = null,
    expires_at = null, status: requestedStatus = null,
  } = opts;

  // ── Validation ─────────────────────────────────────────────────────────
  validateRequired({ organization_id, client_id, category, fact, source_type });
  validateEnum(category, VALID_CATEGORIES, 'category');
  validateEnum(source_type, VALID_SOURCE_TYPES, 'source_type');

  const conf = clampConfidence(confidence);

  // ── Lifecycle: determine initial status ────────────────────────────────
  let status;
  if (requestedStatus && requestedStatus !== 'candidate' && requestedStatus !== 'active') {
    throw new Error(`Cannot create memory with status '${requestedStatus}'. Only 'candidate' or 'active' allowed at creation.`);
  }

  if (TRUSTED_SOURCES.has(source_type)) {
    status = requestedStatus || 'active';
  } else if (AI_SOURCES.has(source_type)) {
    // AI sources must be candidate — trainer must confirm
    if (requestedStatus === 'active') {
      throw new Error('AI-sourced memory (system_observed) cannot be created as active. Must be confirmed first.');
    }
    status = 'candidate';
  } else {
    status = requestedStatus || 'candidate';
  }

  // ── Conflict detection ────────────────────────────────────────────────
  const conflicts = await detectConflicts(organization_id, client_id, category, subcategory);

  // ── Insert ────────────────────────────────────────────────────────────
  const { rows } = await pool.query(
    `INSERT INTO ai_client_memory
       (organization_id, client_id, category, subcategory,
        fact, confidence, source_type, source_id, source_text,
        status, created_by, as_of, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      organization_id, client_id, category, subcategory,
      fact, conf, source_type, source_id, source_text,
      status, created_by, as_of || null, expires_at || null,
    ],
  );

  const memory = rows[0];

  // Attach conflict info if any
  if (conflicts.length > 0) {
    memory._conflicts = conflicts;
    logger.warn(
      { memory_id: memory.id, conflicts: conflicts.map((c) => c.id) },
      'memory_created_with_conflicts',
    );
  }

  logger.info(
    { memory_id: memory.id, category, status, source_type },
    'memory_created',
  );

  return memory;
}

/**
 * Promote a candidate memory to active.
 * Only valid for memories currently in 'candidate' status.
 *
 * @param {string} memoryId
 * @param {string} organizationId — for tenant isolation
 * @param {object} [opts]
 * @param {string} [opts.verified_by] — who confirmed it
 * @returns {Promise<object|null>} updated memory, or null if not found
 */
async function confirmMemory(memoryId, organizationId, opts = {}) {
  const { verified_by = null } = opts;

  const { rows } = await pool.query(
    `UPDATE ai_client_memory
     SET status = 'active',
         verified_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND organization_id = $2
       AND status = 'candidate'
     RETURNING *`,
    [memoryId, organizationId],
  );

  if (rows.length === 0) {
    logger.warn({ memory_id: memoryId }, 'confirm_memory_not_found_or_not_candidate');
    return null;
  }

  logger.info({ memory_id: memoryId, verified_by }, 'memory_confirmed');
  return rows[0];
}

/**
 * Reject a candidate memory — mark it as 'deleted' without activating.
 *
 * @param {string} memoryId
 * @param {string} organizationId
 * @returns {Promise<object|null>}
 */
async function rejectMemory(memoryId, organizationId) {
  const { rows } = await pool.query(
    `UPDATE ai_client_memory
     SET status = 'deleted',
         updated_at = NOW()
     WHERE id = $1
       AND organization_id = $2
       AND status = 'candidate'
     RETURNING *`,
    [memoryId, organizationId],
  );

  if (rows.length === 0) {
    logger.warn({ memory_id: memoryId }, 'reject_memory_not_found_or_not_candidate');
    return null;
  }

  logger.info({ memory_id: memoryId }, 'memory_rejected');
  return rows[0];
}

/**
 * Get all active memories for a client, optionally filtered by category.
 *
 * @param {string} clientId
 * @param {string} organizationId
 * @param {object} [opts]
 * @param {string} [opts.category] — filter by category
 * @param {number} [opts.limit=50]
 * @returns {Promise<object[]>}
 */
async function getActiveMemories(clientId, organizationId, opts = {}) {
  const { category = null, limit = 50 } = opts;

  const params = [clientId, organizationId];
  let where = `WHERE client_id = $1 AND organization_id = $2 AND status = 'active'`;

  if (category) {
    params.push(category);
    where += ` AND category = $${params.length}`;
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM ai_client_memory ${where}
     ORDER BY confidence DESC, created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows;
}

/**
 * Get all memories for a client (all statuses), optionally filtered.
 *
 * @param {string} clientId
 * @param {string} organizationId
 * @param {object} [opts]
 * @param {string} [opts.category]
 * @param {string} [opts.status] — filter by specific status
 * @param {number} [opts.limit=100]
 * @returns {Promise<object[]>}
 */
async function getMemories(clientId, organizationId, opts = {}) {
  const { category = null, status = null, limit = 100 } = opts;

  const params = [clientId, organizationId];
  let where = `WHERE client_id = $1 AND organization_id = $2`;

  if (category) {
    params.push(category);
    where += ` AND category = $${params.length}`;
  }
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  } else {
    where += ` AND status != 'deleted'`; // exclude soft-deleted by default
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM ai_client_memory ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows;
}

/**
 * Update a memory's fact or metadata. Cannot change lifecycle status —
 * use confirmMemory/rejectMemory/invalidateMemory for that.
 *
 * @param {string} memoryId
 * @param {string} organizationId
 * @param {object} updates — { fact, subcategory, confidence, as_of, expires_at }
 * @returns {Promise<object|null>}
 */
async function updateMemory(memoryId, organizationId, updates = {}) {
  const allowed = ['fact', 'subcategory', 'confidence', 'as_of', 'expires_at'];
  const sets = [];
  const params = [memoryId, organizationId];
  let idx = 3;

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      if (key === 'confidence') {
        params.push(clampConfidence(updates[key]));
      } else {
        params.push(updates[key]);
      }
      sets.push(`${key} = $${idx}`);
      idx++;
    }
  }

  if (sets.length === 0) return null;

  sets.push('updated_at = NOW()');
  params.push(memoryId); // for RETURNING

  const { rows } = await pool.query(
    `UPDATE ai_client_memory
     SET ${sets.join(', ')}
     WHERE id = $1 AND organization_id = $2 AND status != 'deleted'
     RETURNING *`,
    params,
  );

  if (rows.length > 0) {
    logger.info({ memory_id: memoryId }, 'memory_updated');
  }
  return rows[0] || null;
}

/**
 * Mark an active memory as stale (source no longer valid).
 * Does not delete — preserves for audit.
 *
 * @param {string} memoryId
 * @param {string} organizationId
 * @returns {Promise<object|null>}
 */
async function invalidateMemory(memoryId, organizationId) {
  const { rows } = await pool.query(
    `UPDATE ai_client_memory
     SET status = 'stale',
         updated_at = NOW()
     WHERE id = $1
       AND organization_id = $2
       AND status = 'active'
     RETURNING *`,
    [memoryId, organizationId],
  );

  if (rows.length > 0) {
    logger.info({ memory_id: memoryId }, 'memory_invalidated');
  }
  return rows[0] || null;
}

/**
 * Soft-delete a memory. Kept for audit trail (status='deleted').
 * Only allowed for active or candidate memories.
 *
 * @param {string} memoryId
 * @param {string} organizationId
 * @returns {Promise<object|null>}
 */
async function deleteMemory(memoryId, organizationId) {
  const { rows } = await pool.query(
    `UPDATE ai_client_memory
     SET status = 'deleted',
         updated_at = NOW()
     WHERE id = $1
       AND organization_id = $2
       AND status IN ('active', 'candidate')
     RETURNING *`,
    [memoryId, organizationId],
  );

  if (rows.length > 0) {
    logger.info({ memory_id: memoryId }, 'memory_deleted');
  }
  return rows[0] || null;
}

/**
 * Refresh a memory — re-verify it's still valid.
 * Updates verified_at. Does not change status.
 *
 * @param {string} memoryId
 * @param {string} organizationId
 * @returns {Promise<object|null>}
 */
async function refreshMemory(memoryId, organizationId) {
  const { rows } = await pool.query(
    `UPDATE ai_client_memory
     SET verified_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND organization_id = $2
       AND status = 'active'
     RETURNING *`,
    [memoryId, organizationId],
  );

  return rows[0] || null;
}

/**
 * Supersede an old memory with a new one.
 * Marks the old as 'superseded' and points superseded_by to the new.
 *
 * @param {string} oldMemoryId — the memory being replaced
 * @param {string} newMemoryId — the replacement memory
 * @param {string} organizationId
 * @returns {Promise<object|null>} the old memory (now superseded)
 */
async function supersedeMemory(oldMemoryId, newMemoryId, organizationId) {
  const { rows } = await pool.query(
    `UPDATE ai_client_memory
     SET status = 'superseded',
         superseded_by = $2,
         updated_at = NOW()
     WHERE id = $1
       AND organization_id = $3
       AND status = 'active'
     RETURNING *`,
    [oldMemoryId, newMemoryId, organizationId],
  );

  if (rows.length > 0) {
    logger.info({ old_id: oldMemoryId, new_id: newMemoryId }, 'memory_superseded');
  }
  return rows[0] || null;
}

/**
 * Detect conflicting active memories for the same client + category.
 * Does NOT prevent creation — surfaces conflicts for review.
 *
 * @param {string} organizationId
 * @param {string} clientId
 * @param {string} category
 * @param {string|null} subcategory
 * @returns {Promise<object[]>} existing active memories that may conflict
 */
async function detectConflicts(organizationId, clientId, category, subcategory = null) {
  const params = [clientId, organizationId, category];
  let where = `WHERE client_id = $1 AND organization_id = $2
               AND category = $3 AND status = 'active'`;

  if (subcategory) {
    params.push(subcategory);
    where += ` AND subcategory = $${params.length}`;
  } else {
    where += ` AND subcategory IS NULL`;
  }

  const { rows } = await pool.query(
    `SELECT id, fact, confidence, source_type, created_at, as_of
     FROM ai_client_memory ${where}
     ORDER BY created_at DESC`,
    params,
  );

  return rows;
}

/**
 * Mark expired memories as stale (sweep job).
 * Finds active memories past their expires_at and sets status='stale'.
 *
 * @param {string} [organizationId] — limit to one org (null = all)
 * @returns {Promise<number>} count of memories invalidated
 */
async function sweepExpired(organizationId = null) {
  const params = [];
  let where = `WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW()`;

  if (organizationId) {
    params.push(organizationId);
    where += ` AND organization_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `UPDATE ai_client_memory
     SET status = 'stale',
         updated_at = NOW()
     ${where}
     RETURNING id`,
    params,
  );

  if (rows.length > 0) {
    logger.info({ count: rows.length }, 'memory_sweep_expired');
  }

  return rows.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// EPISODIC MEMORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create an episodic memory (notable event).
 * Episodes are immutable once written.
 *
 * @param {object} opts
 * @param {string} opts.organization_id
 * @param {string} opts.client_id
 * @param {string} opts.episode_type
 * @param {string} opts.title
 * @param {string} [opts.detail]
 * @param {number} [opts.week_number]
 * @param {string} [opts.session_date]
 * @param {string} opts.source_type
 * @param {string} [opts.source_id]
 * @param {string} [opts.severity='info']
 * @returns {Promise<object>} the created episode
 */
async function createEpisode(opts) {
  const {
    organization_id, client_id, episode_type, title,
    detail = null, week_number = null, session_date = null,
    source_type, source_id = null, severity = 'info',
  } = opts;

  validateRequired({ organization_id, client_id, episode_type, title, source_type });
  validateEnum(episode_type, VALID_EPISODE_TYPES, 'episode_type');
  validateEnum(source_type, VALID_EPISODE_SOURCES, 'source_type');
  validateEnum(severity, VALID_SEVERITIES, 'severity');

  const { rows } = await pool.query(
    `INSERT INTO ai_client_episodes
       (organization_id, client_id, episode_type, title, detail,
        week_number, session_date, source_type, source_id, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      organization_id, client_id, episode_type, title, detail,
      week_number, session_date || null, source_type, source_id, severity,
    ],
  );

  logger.info(
    { episode_id: rows[0].id, episode_type, severity },
    'episode_created',
  );

  return rows[0];
}

/**
 * Get episodes for a client, optionally filtered.
 *
 * @param {string} clientId
 * @param {string} organizationId
 * @param {object} [opts]
 * @param {string} [opts.episode_type]
 * @param {number} [opts.limit=20]
 * @returns {Promise<object[]>}
 */
async function getEpisodes(clientId, organizationId, opts = {}) {
  const { episode_type = null, limit = 20 } = opts;

  const params = [clientId, organizationId];
  let where = `WHERE client_id = $1 AND organization_id = $2`;

  if (episode_type) {
    params.push(episode_type);
    where += ` AND episode_type = $${params.length}`;
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM ai_client_episodes ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows;
}

/**
 * Get the count of episodes by type for a client.
 * Useful for quick summary (e.g., "3 PRs achieved, 1 deload").
 *
 * @param {string} clientId
 * @param {string} organizationId
 * @returns {Promise<object>} { episode_type: count, ... }
 */
async function getEpisodeCounts(clientId, organizationId) {
  const { rows } = await pool.query(
    `SELECT episode_type, COUNT(*)::int AS count
     FROM ai_client_episodes
     WHERE client_id = $1 AND organization_id = $2
     GROUP BY episode_type
     ORDER BY count DESC`,
    [clientId, organizationId],
  );

  const counts = {};
  for (const r of rows) counts[r.episode_type] = r.count;
  return counts;
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY PROJECTION (for buildClientState integration)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a compact memory projection for a client.
 * Returns semantic + episodic memories in a format suitable for
 * inclusion in the canonical client state.
 *
 * @param {string} clientId
 * @param {string} organizationId
 * @returns {Promise<object>} memory projection
 */
async function buildMemoryProjection(clientId, organizationId) {
  const [semantic, episodes, episodeCounts] = await Promise.all([
    getActiveMemories(clientId, organizationId, { limit: 30 }),
    getEpisodes(clientId, organizationId, { limit: 15 }),
    getEpisodeCounts(clientId, organizationId),
  ]);

  return {
    semantic: semantic.map((m) => ({
      id: m.id,
      category: m.category,
      subcategory: m.subcategory,
      fact: m.fact,
      confidence: m.confidence,
      source_type: m.source_type,
      as_of: m.as_of ? String(m.as_of).slice(0, 10) : null,
      verified_at: m.verified_at ? m.verified_at.toISOString?.() || String(m.verified_at) : null,
    })),
    episodes: episodes.map((e) => ({
      id: e.id,
      type: e.episode_type,
      title: e.title,
      detail: e.detail,
      week_number: e.week_number,
      session_date: e.session_date ? String(e.session_date).slice(0, 10) : null,
      severity: e.severity,
      source_type: e.source_type,
      created_at: e.created_at?.toISOString?.() || String(e.created_at),
    })),
    episode_counts: episodeCounts,
    freshness: semantic.length > 0 ? 'has_data' : 'empty',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Semantic memory CRUD
  createMemory,
  confirmMemory,
  rejectMemory,
  getActiveMemories,
  getMemories,
  updateMemory,
  invalidateMemory,
  deleteMemory,
  refreshMemory,
  supersedeMemory,
  detectConflicts,
  sweepExpired,

  // Episodic memory
  createEpisode,
  getEpisodes,
  getEpisodeCounts,

  // Projection
  buildMemoryProjection,

  // Constants (for testing)
  VALID_CATEGORIES,
  VALID_SOURCE_TYPES,
  VALID_STATUSES,
  VALID_EPISODE_TYPES,
  VALID_EPISODE_SOURCES,
  VALID_SEVERITIES,
  TRUSTED_SOURCES,
  AI_SOURCES,
};

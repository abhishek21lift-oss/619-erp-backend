'use strict';

// src/lib/ai/memoryIndexer.js — Phase 2D Memory Indexer
//
// Inspects conversations and confirmed events, extracts durable client facts,
// validates them, detects conflicts, and creates candidate memories.
//
// CORE RULE: The LLM NEVER writes ACTIVE memory.
// Every AI-extracted fact enters as status='candidate' and must be confirmed
// by a trainer, client, or system process before becoming trusted.
//
// PIPELINE:
//   Conversation / confirmed event
//     → Memory Indexer (extract candidates)
//     → Validation + provenance + conflict detection
//     → createMemory() with status='candidate'
//     → trainer/system confirmation
//     → ACTIVE memory
//     → buildClientState() → future AI context

const pool = require('../../db/pool');
const logger = require('../logger');
const {
  createMemory,
  createEpisode,
  detectConflicts,
  getActiveMemories,
  getMemories,
  VALID_CATEGORIES,
  VALID_SOURCE_TYPES,
} = require('./memory');

// ── Constants ──────────────────────────────────────────────────────────────

// Categories that AI extraction is allowed to produce.
// Medical memories require explicit trusted source — AI cannot extract them.
const AI_EXTRACTABLE_CATEGORIES = new Set([
  'preference', 'constraint', 'observation',
  'schedule', 'equipment',
]);

// Categories that require explicit confirmation (not just AI detection).
const REQUIRES_CONFIRMATION_CATEGORIES = new Set([
  'medical', 'goal',
]);

// Minimum confidence threshold for AI-extracted candidates.
// Below this, the fact is too uncertain to warrant a memory entry.
const MIN_CONFIDENCE = 0.6;

// Maximum candidates per extraction call (prevents runaway extraction).
const MAX_CANDIDATES_PER_EXTRACTION = 5;

// ── Schema ─────────────────────────────────────────────────────────────────

/**
 * Schema for a single memory candidate produced by the indexer.
 * The LLM output is validated against this before any memory service call.
 */
const CANDIDATE_SCHEMA = {
  required: ['category', 'fact', 'confidence'],
  optional: ['subcategory', 'source_type', 'source_id', 'source_text', 'as_of', 'reason'],
  validCategories: [...VALID_CATEGORIES],
  validSourceTypes: [...VALID_SOURCE_TYPES],
};

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a single candidate object against the schema.
 * Returns { valid: true, candidate } or { valid: false, error }.
 *
 * @param {object} candidate
 * @returns {{ valid: boolean, candidate?: object, error?: string }}
 */
function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, error: 'Candidate must be a non-null object' };
  }

  // Check required fields
  for (const field of CANDIDATE_SCHEMA.required) {
    if (candidate[field] === undefined || candidate[field] === null || candidate[field] === '') {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Validate category
  if (!CANDIDATE_SCHEMA.validCategories.includes(candidate.category)) {
    return { valid: false, error: `Invalid category: '${candidate.category}'` };
  }

  // AI extraction cannot produce medical memories
  if (candidate.category === 'medical' && candidate.source_type === 'ai_detected') {
    return { valid: false, error: 'AI extraction cannot create medical memories' };
  }

  // Validate confidence is a number 0-1
  const conf = Number(candidate.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
    return { valid: false, error: `Confidence must be 0-1, got: ${candidate.confidence}` };
  }

  // Validate source_type if provided
  if (candidate.source_type && !CANDIDATE_SCHEMA.validSourceTypes.includes(candidate.source_type)) {
    return { valid: false, error: `Invalid source_type: '${candidate.source_type}'` };
  }

  // Validate fact is a non-empty string
  if (typeof candidate.fact !== 'string' || candidate.fact.trim().length < 5) {
    return { valid: false, error: 'Fact must be a string with at least 5 characters' };
  }

  // Sanitize — trim strings
  const sanitized = {
    category: candidate.category.trim(),
    subcategory: candidate.subcategory?.trim() || null,
    fact: candidate.fact.trim(),
    confidence: Math.max(0, Math.min(1, conf)),
    source_type: candidate.source_type?.trim() || 'ai_detected',
    source_id: candidate.source_id?.trim() || null,
    source_text: candidate.source_text?.trim() || null,
    as_of: candidate.as_of || null,
    reason: candidate.reason?.trim() || null,
  };

  return { valid: true, candidate: sanitized };
}

/**
 * Validate an array of candidates.
 * Returns { valid: boolean, candidates: [], errors: [] }.
 *
 * @param {object[]} candidates
 * @returns {{ valid: boolean, candidates: object[], errors: string[] }}
 */
function validateCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    return { valid: false, candidates: [], errors: ['Candidates must be an array'] };
  }

  const valid = [];
  const errors = [];

  for (let i = 0; i < candidates.length; i++) {
    const result = validateCandidate(candidates[i]);
    if (result.valid) {
      valid.push(result.candidate);
    } else {
      errors.push(`Candidate ${i}: ${result.error}`);
    }
  }

  return { valid: errors.length === 0, candidates: valid, errors };
}

// ── Deduplication ──────────────────────────────────────────────────────────

/**
 * Normalize a fact string for deduplication comparison.
 * Lowercases, removes punctuation, collapses whitespace.
 */
function normalizeFact(fact) {
  return fact
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a candidate duplicates an existing memory (active or candidate).
 * Uses normalized fact comparison within the same category + subcategory.
 *
 * @param {string} organizationId
 * @param {string} clientId
 * @param {object} candidate
 * @returns {Promise<object|null>} existing duplicate memory, or null
 */
async function findDuplicate(organizationId, clientId, candidate) {
  const normalized = normalizeFact(candidate.fact);

  // Check active memories in same category
  const activeMemories = await getActiveMemories(clientId, organizationId, {
    category: candidate.category,
    limit: 50,
  });

  for (const m of activeMemories) {
    if (normalizeFact(m.fact) === normalized) return m;
  }

  // Check candidate memories in same category
  const candidateMemories = await getMemories(clientId, organizationId, {
    category: candidate.category,
    status: 'candidate',
    limit: 50,
  });

  for (const m of candidateMemories) {
    if (normalizeFact(m.fact) === normalized) return m;
  }

  return null;
}

// ── Conflict Detection ─────────────────────────────────────────────────────

/**
 * Check if a candidate conflicts with existing active memories.
 * A conflict is when the candidate contradicts an active memory
 * in the same category + subcategory.
 *
 * @param {string} organizationId
 * @param {string} clientId
 * @param {object} candidate
 * @returns {Promise<{ conflicts: object[], duplicates: object[] }>}
 */
async function checkConflicts(organizationId, clientId, candidate) {
  const conflicts = await detectConflicts(organizationId, clientId, candidate.category, candidate.subcategory);
  const duplicate = await findDuplicate(organizationId, clientId, candidate);

  return {
    conflicts: conflicts.filter((c) => c.id !== duplicate?.id),
    duplicates: duplicate ? [duplicate] : [],
  };
}

// ── Extraction from Conversation ───────────────────────────────────────────

/**
 * System prompt for the memory extraction model.
 * Instructs the model to extract durable client facts from a conversation.
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system for a personal training platform.
Your job is to identify DURABLE facts about a client from a conversation between a trainer and the client.

EXTRACT ONLY facts that are:
- Likely to remain true across future sessions
- Specific enough to be useful for programming/coaching
- Confirmed or clearly stated (not inferred or guessed)

DO NOT extract:
- Temporary workout numbers (sets, reps, weights for a single session)
- Casual comments or small talk
- Model-generated recommendations
- Unverified medical claims
- Anything that might change session-to-session
- Opinions or speculation

CATEGORY RULES:
- preference: Client preferences (training time, exercise likes/dislikes, equipment)
- constraint: Confirmed limitations (injury history, scheduling restrictions)
- observation: Trainer-confirmed observations about the client
- schedule: Scheduling patterns (availability, travel, work schedule)
- equipment: Equipment preferences or availability
- goal: Confirmed goals (NOT model-suggested goals)

MEDICAL MEMORIES: You MUST NOT extract medical memories. If the conversation mentions medical conditions, injuries, or health issues, note them as observations or constraints only — never as medical category.

RESPOND WITH VALID JSON ONLY. No markdown, no prose, no code fences.
{
  "candidates": [
    {
      "category": "preference",
      "subcategory": "exercise",
      "fact": "Client prefers barbell exercises over dumbbells",
      "confidence": 0.85,
      "reason": "Client explicitly stated preference twice in conversation"
    }
  ]
}

If no durable facts are found, return: {"candidates": []}`;

/**
 * Extract memory candidates from a conversation using the LLM.
 * The LLM output is validated against the candidate schema.
 * Every candidate enters as status='candidate' — never active.
 *
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.clientId
 * @param {string} opts.conversationId
 * @param {string} opts.userMessage — the user's latest message
 * @param {string} opts.assistantReply — the assistant's latest reply
 * @param {string} [opts.trainerId] — who is the trainer
 * @returns {Promise<{ created: object[], conflicts: object[], errors: string[] }>}
 */
async function extractFromConversation(opts) {
  const {
    organizationId, clientId, conversationId,
    userMessage, assistantReply,
    trainerId = null,
  } = opts;

  if (!organizationId || !clientId || !userMessage || !assistantReply) {
    return { created: [], conflicts: [], errors: ['Missing required parameters'] };
  }

  try {
    // Build the extraction prompt
    const extractionPrompt = [
      'CONVERSATION:',
      `Trainer/Client: ${userMessage}`,
      `AI Assistant: ${assistantReply}`,
      '',
      'Extract durable client facts from this conversation.',
    ].join('\n');

    // Call the model for extraction
    const { routedChat } = require('./router');
    const result = await routedChat({
      intent: 'chat',
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: extractionPrompt },
      ],
      temperature: 0,
      max_tokens: 1024,
    });

    // Parse the model output
    let parsed;
    try {
      // Strip markdown code fences if present
      let raw = result.content.trim();
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      logger.warn({ err: parseErr.message }, 'memory_indexer_parse_failed');
      return { created: [], conflicts: [], errors: [`Failed to parse model output: ${parseErr.message}`] };
    }

    if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
      return { created: [], conflicts: [], errors: ['Model output missing candidates array'] };
    }

    // Validate candidates
    const { candidates, errors: validationErrors } = validateCandidates(parsed.candidates);

    // Limit candidates
    const limited = candidates.slice(0, MAX_CANDIDATES_PER_EXTRACTION);

    // Filter by confidence threshold
    const confident = limited.filter((c) => c.confidence >= MIN_CONFIDENCE);

    // Process each candidate
    const created = [];
    const allConflicts = [];
    const allErrors = [...validationErrors];

    for (const candidate of confident) {
      // Check for duplicates and conflicts
      const { conflicts, duplicates } = await checkConflicts(organizationId, clientId, candidate);

      // Skip if exact duplicate exists
      if (duplicates.length > 0) {
        allErrors.push(`Duplicate of existing memory: ${duplicates[0].id}`);
        continue;
      }

      // If conflicts exist, still create the candidate but flag it
      if (conflicts.length > 0) {
        allConflicts.push({
          candidate,
          existing: conflicts,
        });
      }

      // Create the candidate memory
      try {
        const memory = await createMemory({
          organization_id: organizationId,
          client_id: clientId,
          category: candidate.category,
          subcategory: candidate.subcategory,
          fact: candidate.fact,
          confidence: candidate.confidence,
          source_type: 'ai_detected',
          source_id: conversationId,
          source_text: candidate.source_text || candidate.fact,
          created_by: 'system',
          as_of: candidate.as_of,
          // AI-detected candidates always enter as candidate status
          status: 'candidate',
        });

        created.push(memory);
      } catch (memErr) {
        logger.warn({ err: memErr.message, candidate }, 'memory_indexer_create_failed');
        allErrors.push(`Failed to create memory: ${memErr.message}`);
      }
    }

    logger.info({
      organization_id: organizationId,
      client_id: clientId,
      candidates_found: parsed.candidates.length,
      candidates_valid: confident.length,
      candidates_created: created.length,
      conflicts: allConflicts.length,
    }, 'memory_indexer_extraction_complete');

    return { created, conflicts: allConflicts, errors: allErrors };

  } catch (err) {
    // Model call failure — non-fatal, transaction continues
    logger.warn({ err: err.message }, 'memory_indexer_extraction_failed');
    return { created: [], conflicts: [], errors: [`Extraction failed: ${err.message}`] };
  }
}

// ── Event-Based Extraction ─────────────────────────────────────────────────

/**
 * Create an episodic memory from a confirmed event.
 * This does NOT go through the LLM — it's deterministic.
 *
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.clientId
 * @param {string} opts.episodeType
 * @param {string} opts.title
 * @param {string} [opts.detail]
 * @param {number} [opts.weekNumber]
 * @param {string} [opts.sessionDate]
 * @param {string} opts.sourceType
 * @param {string} [opts.sourceId]
 * @param {string} [opts.severity]
 * @returns {Promise<object|null>}
 */
async function createEventEpisode(opts) {
  const {
    organizationId, clientId, episodeType, title,
    detail = null, weekNumber = null, sessionDate = null,
    sourceType, sourceId = null, severity = 'info',
  } = opts;

  if (!organizationId || !clientId || !episodeType || !title || !sourceType) {
    return null;
  }

  try {
    return await createEpisode({
      organization_id: organizationId,
      client_id: clientId,
      episode_type: episodeType,
      title,
      detail,
      week_number: weekNumber,
      session_date: sessionDate,
      source_type: sourceType,
      source_id: sourceId,
      severity,
    });
  } catch (err) {
    // Episode creation failure — non-fatal
    logger.warn({ err: err.message }, 'memory_indexer_episode_failed');
    return null;
  }
}

/**
 * Create a semantic memory from a confirmed DB fact.
 * This does NOT go through the LLM — it's deterministic.
 * Uses trusted source_type so it enters as 'active' directly.
 *
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.clientId
 * @param {string} opts.category
 * @param {string} opts.fact
 * @param {string} [opts.sourceType='db_derived']
 * @param {string} [opts.sourceId]
 * @param {string} [opts.asOf]
 * @returns {Promise<object|null>}
 */
async function createConfirmedFact(opts) {
  const {
    organizationId, clientId, category, fact,
    sourceType = 'db_derived', sourceId = null, asOf = null,
  } = opts;

  if (!organizationId || !clientId || !category || !fact) return null;

  try {
    return await createMemory({
      organization_id: organizationId,
      client_id: clientId,
      category,
      fact,
      source_type: sourceType,
      source_id: sourceId,
      as_of: asOf,
      confidence: 1.0,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'memory_indexer_confirmed_fact_failed');
    return null;
  }
}

// ── Pending Candidates ─────────────────────────────────────────────────────

/**
 * List pending candidate memories for a client.
 * Used by the confirmation UI/API.
 *
 * @param {string} clientId
 * @param {string} organizationId
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @returns {Promise<object[]>}
 */
async function getPendingCandidates(clientId, organizationId, opts = {}) {
  return getMemories(clientId, organizationId, { status: 'candidate', ...opts });
}

// ── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  // Extraction
  extractFromConversation,

  // Event-based (deterministic, no LLM)
  createEventEpisode,
  createConfirmedFact,

  // Candidate management
  getPendingCandidates,
  validateCandidate,
  validateCandidates,
  checkConflicts,
  findDuplicate,
  normalizeFact,

  // Constants
  AI_EXTRACTABLE_CATEGORIES,
  REQUIRES_CONFIRMATION_CATEGORIES,
  MIN_CONFIDENCE,
  MAX_CANDIDATES_PER_EXTRACTION,
  EXTRACTION_SYSTEM_PROMPT,
};

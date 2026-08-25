'use strict';

// src/lib/ai/programmerAgent.js — Phase 2E Programmer Agent
//
// A thin AI intelligence layer ABOVE the deterministic progression engine.
// The LLM interprets what the deterministic system already decided and
// proposes adjustments when evidence supports them. The model NEVER directly
// changes workout plans, exercises, loads, reps, sets, or progression state.
//
// ARCHITECTURE:
//   Completed Training → Deterministic Analytics → Deterministic Progression
//   → Canonical Client State + Memory → Programmer Agent → Structured Proposal
//   → Safety/Validation → Trainer Approval → Existing Write Path
//
// NON-NEGOTIABLE:
//   DETERMINISTIC SYSTEM = SOURCE OF TRUTH
//   AI = INTERPRETER + PROPOSER
//   TRAINER = APPROVER
//   DATABASE WRITE = EXISTING CONTROLLED WRITE PATH
//   THE MODEL IS NEVER IN THE WRITE PATH.

const pool = require('../../db/pool');
const logger = require('../logger');
const { buildClientState, coachingContext, programmingContext, memoryContext } = require('./clientState');
const { getActiveMemories } = require('./memory');

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Allowed proposal types — explicit allow-list.
 * The agent CANNOT propose anything outside this list.
 */
const ALLOWED_PROPOSAL_TYPES = [
  'progress_load',           // Increase weight
  'regress_load',            // Decrease weight
  'change_rep_range',        // Modify rep targets
  'adjust_sets',             // Modify set count
  'exercise_substitution',   // Replace an exercise
  'volume_adjustment',       // Modify weekly volume
  'intensity_adjustment',    // Modify RPE/RIR targets
  'deload_proposal',         // Propose a deload week
  'recovery_modification',   // Modify based on recovery data
  'explain_progression',     // Explain why deterministic system did what it did
];

/**
 * Required fields for a valid proposal.
 */
const PROPOSAL_REQUIRED_FIELDS = [
  'proposal_type',
  'summary',
  'reason',
  'evidence',
  'confidence',
  'requires_trainer_approval',
];

/**
 * Confidence thresholds.
 */
const MIN_CONFIDENCE_FOR_PROPOSAL = 0.5;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Proposal expiry (7 days).
 */
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Max proposals per client per request.
 */
const MAX_PROPOSALS_PER_REQUEST = 3;

// ── Schema Validation ──────────────────────────────────────────────────────

/**
 * Validate a proposal object against the schema.
 * Returns { valid: true, proposal } or { valid: false, error }.
 *
 * @param {object} proposal
 * @returns {{ valid: boolean, proposal?: object, error?: string }}
 */
function validateProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return { valid: false, error: 'Proposal must be a non-null object' };
  }

  // Check required fields
  for (const field of PROPOSAL_REQUIRED_FIELDS) {
    if (proposal[field] === undefined || proposal[field] === null) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Validate proposal_type is in allow-list
  if (!ALLOWED_PROPOSAL_TYPES.includes(proposal.proposal_type)) {
    return { valid: false, error: `Invalid proposal_type: '${proposal.proposal_type}'. Allowed: ${ALLOWED_PROPOSAL_TYPES.join(', ')}` };
  }

  // Validate confidence
  const conf = Number(proposal.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
    return { valid: false, error: `Confidence must be 0-1, got: ${proposal.confidence}` };
  }

  // Validate evidence is a non-empty array
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0) {
    return { valid: false, error: 'Evidence must be a non-empty array' };
  }

  // Validate each evidence item
  for (let i = 0; i < proposal.evidence.length; i++) {
    const e = proposal.evidence[i];
    if (!e || typeof e !== 'object') {
      return { valid: false, error: `Evidence ${i} must be an object` };
    }
    if (!e.description || typeof e.description !== 'string') {
      return { valid: false, error: `Evidence ${i} must have a description` };
    }
  }

  // Validate requires_trainer_approval is boolean
  if (typeof proposal.requires_trainer_approval !== 'boolean') {
    return { valid: false, error: 'requires_trainer_approval must be boolean' };
  }

  // Sanitize
  const sanitized = {
    proposal_type: proposal.proposal_type.trim(),
    summary: String(proposal.summary).trim(),
    reason: String(proposal.reason).trim(),
    evidence: proposal.evidence.map((e) => ({
      type: e.type || 'observation',
      description: String(e.description).trim(),
      source: e.source || null,
      value: e.value ?? null,
    })),
    current_state: proposal.current_state || {},
    deterministic_recommendation: proposal.deterministic_recommendation || null,
    ai_recommendation: proposal.ai_recommendation || null,
    confidence: Math.max(0, Math.min(1, conf)),
    safety_flags: Array.isArray(proposal.safety_flags) ? proposal.safety_flags : [],
    requires_trainer_approval: true, // ALWAYS true — trainer must approve
  };

  return { valid: true, proposal: sanitized };
}

// ── Safety Validation ──────────────────────────────────────────────────────

/**
 * Check safety conditions and return flags.
 * Hard-stops or requires additional review when conditions are met.
 *
 * @param {object} state — canonical client state
 * @returns {{ safe: boolean, flags: string[], hardStop: boolean }}
 */
function checkSafety(state) {
  const flags = [];
  let hardStop = false;

  // PAR-Q blocking
  if (state.clearance?.parq?.gate_status === 'blocked') {
    flags.push('PAR-Q blocks training — cannot generate proposals');
    hardStop = true;
  }

  // Missing PAR-Q
  if (!state.clearance?.parq) {
    flags.push('No PAR-Q screening on file — proposals require medical clearance');
  }

  // Missing assessment
  if (!state.body || state.body.source === 'missing') {
    flags.push('No fitness assessment — proposals may lack baseline data');
  }

  // Injuries
  if (state.limitations?.injuries) {
    flags.push(`Client has injuries: ${state.limitations.injuries} — exercise selection must account for this`);
  }

  // Mobility restrictions
  if (state.limitations?.mobility?.findings?.length) {
    const restrictions = state.limitations.mobility.findings
      .filter((f) => f.restriction || f.pain)
      .map((f) => f.region);
    if (restrictions.length) {
      flags.push(`Mobility restrictions: ${restrictions.join(', ')}`);
    }
  }

  // Recovery concern
  if (state.recovery?.readiness && state.recovery.readiness.score < 40) {
    flags.push(`Recovery score is low (${state.recovery.readiness.score}/100) — consider deload or rest`);
  }

  // Recovery trend declining
  if (state.analytics?.recoveryTrend?.direction === 'declining') {
    flags.push('Recovery trend is declining over recent check-ins');
  }

  // Missing performance data
  if (!state.performance?.sessions?.length) {
    flags.push('No training session data — cannot assess recent performance');
  }

  // Adherence low
  if (state.analytics?.adherence?.trend === 'low') {
    flags.push('Adherence is low — address consistency before intensity changes');
  }

  // Critical gaps
  if (state.missing?.critical_gaps?.length) {
    for (const gap of state.missing.critical_gaps) {
      flags.push(`Critical gap: ${gap}`);
    }
  }

  return {
    safe: !hardStop,
    flags,
    hardStop,
  };
}

// ── Agent Prompt ───────────────────────────────────────────────────────────

/**
 * System prompt for the programmer agent.
 * Instructs the model to produce structured proposals.
 */
const PROGRAMMER_SYSTEM_PROMPT = `You are a programming intelligence assistant for a personal training platform.
Your job is to analyze a client's training data and produce structured programming proposals.

You work ABOVE the deterministic progression engine. The engine has already calculated
what the next prescription should be. Your job is to:
1. Explain WHY the deterministic system made its decision
2. Flag any concerns the deterministic system cannot see (recovery, adherence, memory)
3. Propose adjustments ONLY when you have strong evidence

RULES:
- NEVER guess or invent data. If evidence is insufficient, say so.
- NEVER contradict the deterministic progression without evidence.
- If deterministic says "+2.5kg" and you disagree, present BOTH views and require trainer review.
- Every proposal MUST have evidence from actual stored data.
- Medical/injury constraints are ABSOLUTE — never propose exercises that conflict.
- Recovery data is advisory — declining recovery suggests caution, not prohibition.
- Memory facts are confirmed truths — incorporate them naturally.

ALLOWED PROPOSAL TYPES:
- progress_load: Increase weight (evidence: consistent completion, RPE below target)
- regress_load: Decrease weight (evidence: failed sets, high RPE, recovery concern)
- change_rep_range: Modify rep targets
- adjust_sets: Modify set count
- exercise_substitution: Replace an exercise (must account for injuries/equipment)
- volume_adjustment: Modify weekly volume (must respect MEV/MRV landmarks)
- intensity_adjustment: Modify RPE/RIR targets
- deload_proposal: Propose a deload week (evidence: consecutive high-RPE weeks, declining recovery)
- recovery_modification: Modify based on recovery data
- explain_progression: Explain why the deterministic system did what it did

RESPOND WITH VALID JSON ONLY. No markdown, no prose, no code fences.

{
  "proposals": [
    {
      "proposal_type": "explain_progression",
      "summary": "Explain the deterministic progression for Bench Press",
      "reason": "The double progression rule fired because all sets hit the rep target",
      "evidence": [
        {
          "type": "performance",
          "description": "Last 3 sessions: all sets completed at 80kg × 12 reps",
          "source": "workout_sets",
          "value": { "weight": 80, "reps": 12, "sets": 3 }
        }
      ],
      "current_state": {
        "exercise": "Bench Press",
        "prescription": { "target_weight": 80, "target_reps_min": 10, "target_reps_max": 12 },
        "deterministic_recommendation": { "target_weight": 82.5 }
      },
      "ai_recommendation": null,
      "confidence": 0.9,
      "safety_flags": []
    }
  ]
}

If no proposals are warranted, return: {"proposals": []}`;

// ── Core Agent Function ────────────────────────────────────────────────────

/**
 * Run the programmer agent for a client.
 * Produces structured proposals based on deterministic progression + client state + memory.
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.organizationId
 * @param {object} opts.progressionResult — output from progression.propose()
 * @param {string} [opts.exerciseName] — specific exercise to analyze
 * @param {string} [opts.context] — additional context for the agent
 * @returns {Promise<{ proposals: object[], safety: object, state: object }>}
 */
async function runProgrammerAgent(opts) {
  const {
    clientId, organizationId, progressionResult,
    exerciseName = null, context = null,
  } = opts;

  if (!clientId || !organizationId) {
    return { proposals: [], safety: { safe: false, flags: ['Missing clientId or organizationId'], hardStop: true }, state: null };
  }

  // 1. Build canonical client state (with analytics + memory)
  const state = await buildClientState(clientId, organizationId);
  if (!state) {
    return { proposals: [], safety: { safe: false, flags: ['Client not found'], hardStop: true }, state: null };
  }

  // 2. Check safety
  const safety = checkSafety(state);
  if (safety.hardStop) {
    return { proposals: [], safety, state };
  }

  // 3. Load relevant active memories
  let memories = [];
  try {
    memories = await getActiveMemories(clientId, organizationId, { limit: 10 });
  } catch (memErr) {
    logger.warn({ err: memErr.message }, 'programmer_agent_memory_load_failed');
  }

  // 4. Build the agent prompt
  const stateContext = programmingContext(state);
  const memCtx = memoryContext(state, {
    categories: ['preference', 'constraint', 'equipment', 'schedule'],
    maxEpisodes: 3,
  });

  const agentPrompt = [
    'CLIENT STATE:',
    stateContext,
    '',
    memCtx ? `CLIENT MEMORY:\n${memCtx}` : '',
    '',
    progressionResult ? `DETERMINISTIC PROGRESSION RESULT:\n${JSON.stringify(progressionResult, null, 2)}` : 'No deterministic progression result provided.',
    '',
    exerciseName ? `FOCUS EXERCISE: ${exerciseName}` : '',
    context ? `ADDITIONAL CONTEXT: ${context}` : '',
    '',
    'SAFETY FLAGS:',
    ...safety.flags.map((f) => `- ${f}`),
    '',
    'Produce structured proposals based on this data.',
  ].filter(Boolean).join('\n');

  // 5. Call the model
  try {
    const { routedChat } = require('./router');
    const result = await routedChat({
      intent: 'chat',
      messages: [
        { role: 'system', content: PROGRAMMER_SYSTEM_PROMPT },
        { role: 'user', content: agentPrompt },
      ],
      temperature: 0,
      max_tokens: 2048,
    });

    // 6. Parse model output
    let parsed;
    try {
      let raw = result.content.trim();
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      logger.warn({ err: parseErr.message }, 'programmer_agent_parse_failed');
      return { proposals: [], safety, state, errors: [`Failed to parse model output: ${parseErr.message}`] };
    }

    if (!parsed.proposals || !Array.isArray(parsed.proposals)) {
      return { proposals: [], safety, state, errors: ['Model output missing proposals array'] };
    }

    // 7. Validate and limit proposals
    const validProposals = [];
    const errors = [];

    for (const p of parsed.proposals.slice(0, MAX_PROPOSALS_PER_REQUEST)) {
      const validation = validateProposal(p);
      if (validation.valid) {
        // Ensure trainer approval is always required
        validation.proposal.requires_trainer_approval = true;
        validProposals.push(validation.proposal);
      } else {
        errors.push(validation.error);
      }
    }

    // 8. Filter by confidence
    const confident = validProposals.filter((p) => p.confidence >= MIN_CONFIDENCE_FOR_PROPOSAL);

    logger.info({
      client_id: clientId,
      proposals_found: parsed.proposals.length,
      proposals_valid: confident.length,
      safety_flags: safety.flags.length,
    }, 'programmer_agent_complete');

    return { proposals: confident, safety, state, errors };

  } catch (err) {
    logger.warn({ err: err.message }, 'programmer_agent_failed');
    return { proposals: [], safety, state, errors: [`Agent failed: ${err.message}`] };
  }
}

// ── Proposal Storage ───────────────────────────────────────────────────────

/**
 * Store a proposal in the database.
 *
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.clientId
 * @param {string} opts.proposalType
 * @param {string} opts.summary
 * @param {string} opts.reason
 * @param {object[]} opts.evidence
 * @param {object} opts.currentState
 * @param {object} [opts.deterministicRecommendation]
 * @param {object} [opts.aiRecommendation]
 * @param {number} opts.confidence
 * @param {string[]} opts.safetyFlags
 * @param {string} opts.createdBy
 * @returns {Promise<object>}
 */
async function storeProposal(opts) {
  const {
    organizationId, clientId, proposalType, summary, reason,
    evidence, currentState, deterministicRecommendation = null,
    aiRecommendation = null, confidence, safetyFlags,
    createdBy,
  } = opts;

  const { rows } = await pool.query(
    `INSERT INTO ai_programmer_proposals
       (organization_id, client_id, proposal_type, summary, reason,
        evidence, current_state, deterministic_recommendation,
        ai_recommendation, confidence, safety_flags, status, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$13)
     RETURNING *`,
    [
      organizationId, clientId, proposalType, summary, reason,
      JSON.stringify(evidence), JSON.stringify(currentState),
      deterministicRecommendation ? JSON.stringify(deterministicRecommendation) : null,
      aiRecommendation ? JSON.stringify(aiRecommendation) : null,
      confidence, JSON.stringify(safetyFlags),
      createdBy,
      new Date(Date.now() + PROPOSAL_TTL_MS),
    ],
  );

  return rows[0];
}

/**
 * List proposals for a client.
 *
 * @param {string} clientId
 * @param {string} organizationId
 * @param {object} [opts]
 * @param {string} [opts.status]
 * @param {number} [opts.limit=20]
 * @returns {Promise<object[]>}
 */
async function listProposals(clientId, organizationId, opts = {}) {
  const { status = null, limit = 20 } = opts;
  const params = [clientId, organizationId];
  let where = `WHERE client_id = $1 AND organization_id = $2`;

  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  } else {
    where += ` AND status != 'deleted'`;
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM ai_programmer_proposals ${where}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );

  return rows;
}

/**
 * Approve a proposal → status becomes 'approved'.
 *
 * @param {string} proposalId
 * @param {string} organizationId
 * @param {string} approvedBy
 * @returns {Promise<object|null>}
 */
async function approveProposal(proposalId, organizationId, approvedBy) {
  const { rows } = await pool.query(
    `UPDATE ai_programmer_proposals
     SET status = 'approved', reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND status = 'draft'
     RETURNING *`,
    [proposalId, organizationId, approvedBy],
  );
  return rows[0] || null;
}

/**
 * Reject a proposal → status becomes 'rejected'.
 *
 * @param {string} proposalId
 * @param {string} organizationId
 * @param {string} rejectedBy
 * @param {string} [reason]
 * @returns {Promise<object|null>}
 */
async function rejectProposal(proposalId, organizationId, rejectedBy, reason = null) {
  const { rows } = await pool.query(
    `UPDATE ai_programmer_proposals
     SET status = 'rejected', reviewed_by = $3, reviewed_at = NOW(),
         rejection_reason = $4, updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND status = 'draft'
     RETURNING *`,
    [proposalId, organizationId, rejectedBy, reason],
  );
  return rows[0] || null;
}

/**
 * Mark a proposal as executed after the write path completes.
 *
 * @param {string} proposalId
 * @param {string} organizationId
 * @returns {Promise<object|null>}
 */
async function markExecuted(proposalId, organizationId) {
  const { rows } = await pool.query(
    `UPDATE ai_programmer_proposals
     SET status = 'executed', executed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND status = 'approved'
     RETURNING *`,
    [proposalId, organizationId],
  );
  return rows[0] || null;
}

/**
 * Expire old proposals (sweep job).
 *
 * @param {string} [organizationId]
 * @returns {Promise<number>}
 */
async function expireProposals(organizationId = null) {
  const params = [];
  let where = `WHERE status = 'draft' AND expires_at < NOW()`;

  if (organizationId) {
    params.push(organizationId);
    where += ` AND organization_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `UPDATE ai_programmer_proposals
     SET status = 'expired', updated_at = NOW()
     ${where}
     RETURNING id`,
    params,
  );

  return rows.length;
}

// ── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  // Core agent
  runProgrammerAgent,

  // Proposal CRUD
  storeProposal,
  listProposals,
  approveProposal,
  rejectProposal,
  markExecuted,
  expireProposals,

  // Validation
  validateProposal,
  checkSafety,

  // Constants
  ALLOWED_PROPOSAL_TYPES,
  PROPOSAL_REQUIRED_FIELDS,
  MIN_CONFIDENCE_FOR_PROPOSAL,
  HIGH_CONFIDENCE_THRESHOLD,
  PROPOSAL_TTL_MS,
  MAX_PROPOSALS_PER_REQUEST,
  PROGRAMMER_SYSTEM_PROMPT,
};

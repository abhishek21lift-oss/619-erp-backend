'use strict';

// src/lib/ai/trainerIntelligence.js — Phase 2F Trainer Intelligence
//
// Unified pending work queue + client intelligence summary + stale proposal
// revalidation + audit trail. This is the operations center where trainers
// review AI discoveries and approve/reject safely.
//
// NON-NEGOTIABLE:
//   DETERMINISTIC SYSTEM = SOURCE OF TRUTH
//   AI = INTERPRETATION + RECOMMENDATION
//   TRAINER = DECISION MAKER
//   CONTROLLED WRITE PATH = ONLY WAY STATE CHANGES

const pool = require('../../db/pool');
const logger = require('../logger');
const { buildClientState, coachingContext, memoryContext } = require('./clientState');
const { getPendingCandidates, checkConflicts } = require('./memoryIndexer');
const { confirmMemory, rejectMemory, supersedeMemory, getActiveMemories } = require('./memory');
const { listProposals, approveProposal, rejectProposal, validateProposal, checkSafety } = require('./programmerAgent');

// ── Priority Scoring ───────────────────────────────────────────────────────

/**
 * Compute a priority score for a pending item.
 * Higher = more urgent. Deterministic rules, no AI involvement.
 *
 * @param {object} item
 * @param {string} item.type — 'memory' or 'proposal'
 * @param {object} item.data — the raw memory or proposal row
 * @returns {number} priority score 0-100
 */
function computePriority(item) {
  let score = 50; // baseline

  if (item.type === 'proposal') {
    const p = item.data;

    // Safety flags increase priority
    const safetyFlags = Array.isArray(p.safety_flags) ? p.safety_flags : [];
    if (safetyFlags.length > 0) score += 15;

    // High confidence proposals are more actionable
    if (p.confidence >= 0.8) score += 10;

    // Expiring soon increases urgency
    if (p.expires_at) {
      const hoursUntilExpiry = (new Date(p.expires_at).getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntilExpiry < 24) score += 20;
      else if (hoursUntilExpiry < 72) score += 10;
    }

    // Proposals with AI recommendation different from deterministic need review
    if (p.ai_recommendation && p.deterministic_recommendation) {
      score += 10;
    }

    // Deload/recovery proposals are time-sensitive
    if (p.proposal_type === 'deload_proposal' || p.proposal_type === 'recovery_modification') {
      score += 5;
    }
  }

  if (item.type === 'memory') {
    const m = item.data;

    // High confidence memories are more actionable
    if (m.confidence >= 0.8) score += 5;

    // Medical/constraint memories are higher priority
    if (m.category === 'medical' || m.category === 'constraint') score += 10;

    // Conflicts increase priority
    if (m._conflicts && m._conflicts.length > 0) score += 15;
  }

  // Recency bonus (newer = slightly higher)
  const createdAt = item.data.created_at;
  if (createdAt) {
    const hoursOld = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
    if (hoursOld < 1) score += 5;
    else if (hoursOld < 24) score += 3;
  }

  return Math.min(100, Math.max(0, score));
}

// ── Unified Pending Queue ──────────────────────────────────────────────────

/**
 * Get the unified pending work queue for a trainer.
 * Combines memory candidates and programmer proposals.
 *
 * @param {string} organizationId
 * @param {string} clientId — optional, filter to one client
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @returns {Promise<{ memory_candidates: object[], programmer_proposals: object[], total_pending: number }>}
 */
async function getPendingWorkQueue(organizationId, clientId, opts = {}) {
  const { limit = 20 } = opts;

  const memoryCandidates = [];
  const programmerProposals = [];

  // Get memory candidates
  try {
    if (clientId) {
      const candidates = await getPendingCandidates(clientId, organizationId, { limit });
      for (const c of candidates) {
        memoryCandidates.push({ type: 'memory', data: c, priority: computePriority({ type: 'memory', data: c }) });
      }
    } else {
      // Get all pending memories across clients (admin/manager view)
      const { rows } = await pool.query(
        `SELECT * FROM ai_client_memory WHERE organization_id = $1 AND status = 'candidate'
         ORDER BY created_at DESC LIMIT $2`,
        [organizationId, limit],
      );
      for (const c of rows) {
        memoryCandidates.push({ type: 'memory', data: c, priority: computePriority({ type: 'memory', data: c }) });
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'trainer_intelligence_memory_queue_failed');
  }

  // Get programmer proposals
  try {
    if (clientId) {
      const proposals = await listProposals(clientId, organizationId, { status: 'draft', limit });
      for (const p of proposals) {
        programmerProposals.push({ type: 'proposal', data: p, priority: computePriority({ type: 'proposal', data: p }) });
      }
    } else {
      const { rows } = await pool.query(
        `SELECT * FROM ai_programmer_proposals WHERE organization_id = $1 AND status = 'draft'
         ORDER BY created_at DESC LIMIT $2`,
        [organizationId, limit],
      );
      for (const p of rows) {
        programmerProposals.push({ type: 'proposal', data: p, priority: computePriority({ type: 'proposal', data: p }) });
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'trainer_intelligence_proposal_queue_failed');
  }

  // Sort by priority (descending)
  memoryCandidates.sort((a, b) => b.priority - a.priority);
  programmerProposals.sort((a, b) => b.priority - a.priority);

  return {
    memory_candidates: memoryCandidates,
    programmer_proposals: programmerProposals,
    total_pending: memoryCandidates.length + programmerProposals.length,
  };
}

// ── Client Intelligence Summary ────────────────────────────────────────────

/**
 * Build a compact intelligence summary for a client.
 * Used on the trainer's client view.
 *
 * @param {string} clientId
 * @param {string} organizationId
 * @returns {Promise<object>}
 */
async function buildClientIntelligenceSummary(clientId, organizationId) {
  // Build canonical state (includes analytics + memory)
  const state = await buildClientState(clientId, organizationId);
  if (!state) return null;

  // Get pending items for this client
  const pending = await getPendingWorkQueue(organizationId, clientId, { limit: 5 });

  // Get active memories
  let activeMemories = [];
  try {
    activeMemories = await getActiveMemories(clientId, organizationId, { limit: 10 });
  } catch (err) {
    logger.warn({ err: err.message }, 'intelligence_summary_memory_failed');
  }

  // Build the summary sections
  const summary = {
    client_id: clientId,
    client_name: state.identity.name,
    generated_at: new Date().toISOString(),

    // WHAT CHANGED — recent meaningful changes
    what_changed: [],

    // WHAT AI KNOWS — active verified memories
    what_ai_knows: activeMemories.map((m) => ({
      category: m.category,
      fact: m.fact,
      confidence: m.confidence,
      source_type: m.source_type,
      as_of: m.as_of,
    })),

    // WHAT AI SUGGESTS — pending programmer proposals
    what_ai_suggests: pending.programmer_proposals.map((p) => ({
      id: p.data.id,
      type: p.data.proposal_type,
      summary: p.data.summary,
      confidence: p.data.confidence,
      safety_flags: Array.isArray(p.data.safety_flags) ? p.data.safety_flags : [],
      expires_at: p.data.expires_at,
    })),

    // WHAT NEEDS ATTENTION — safety/risk/data-gap signals
    what_needs_attention: [],

    // WHAT IS MISSING — important missing measurements/data
    what_is_missing: [],

    // NEXT BEST ACTION — actionable recommendation
    next_best_action: null,
  };

  // Populate WHAT CHANGED
  if (state.performance?.personalRecords?.length) {
    const latestPR = state.performance.personalRecords[0];
    summary.what_changed.push({
      type: 'pr',
      text: `New PR: ${latestPR.exercise} ${latestPR.value} ${latestPR.unit} on ${latestPR.achieved_on}`,
    });
  }

  if (state.analytics?.recoveryTrend?.direction === 'declining') {
    summary.what_changed.push({
      type: 'recovery',
      text: `Recovery trend declining (score ${state.analytics.recoveryTrend.latest_score}/100)`,
    });
  }

  if (state.analytics?.adherence?.trend === 'low') {
    summary.what_changed.push({
      type: 'adherence',
      text: `Adherence is low (${state.analytics.adherence.overall_pct || '?'}%)`,
    });
  }

  // Populate WHAT NEEDS ATTENTION
  if (state.missing?.critical_gaps?.length) {
    for (const gap of state.missing.critical_gaps) {
      summary.what_needs_attention.push({ type: 'critical_gap', text: gap });
    }
  }

  if (state.clearance?.parq?.gate_status === 'blocked') {
    summary.what_needs_attention.push({ type: 'safety', text: 'PAR-Q blocks training' });
  }

  if (!state.clearance?.parq) {
    summary.what_needs_attention.push({ type: 'safety', text: 'No PAR-Q screening on file' });
  }

  if (state.recovery?.readiness && state.recovery.readiness.score < 40) {
    summary.what_needs_attention.push({ type: 'recovery', text: `Low recovery score: ${state.recovery.readiness.score}/100` });
  }

  if (state.limitations?.injuries) {
    summary.what_needs_attention.push({ type: 'injury', text: `Injuries: ${state.limitations.injuries}` });
  }

  // Populate WHAT IS MISSING
  if (state.missing?.sections) {
    for (const section of state.missing.sections) {
      summary.what_is_missing.push(section);
    }
  }

  // Populate NEXT BEST ACTION
  if (pending.programmer_proposals.length > 0) {
    const top = pending.programmer_proposals[0];
    summary.next_best_action = {
      type: 'proposal_review',
      text: `Review ${top.data.proposal_type} proposal: ${top.data.summary}`,
      proposal_id: top.data.id,
    };
  } else if (pending.memory_candidates.length > 0) {
    const top = pending.memory_candidates[0];
    summary.next_best_action = {
      type: 'memory_review',
      text: `Review memory candidate: ${top.data.fact}`,
      memory_id: top.data.id,
    };
  } else if (state.missing?.critical_gaps?.length) {
    summary.next_best_action = {
      type: 'data_collection',
      text: `Collect missing data: ${state.missing.critical_gaps[0]}`,
    };
  }

  return summary;
}

// ── Stale Proposal Revalidation ────────────────────────────────────────────

/**
 * Revalidate a proposal against current database state.
 * A proposal may be stale if the client trained again after it was generated.
 *
 * @param {string} proposalId
 * @param {string} organizationId
 * @returns {Promise<{ valid: boolean, reason?: string, currentFingerprint?: string, proposalFingerprint?: string }>}
 */
async function revalidateProposal(proposalId, organizationId) {
  // Fetch the proposal
  const { rows: proposalRows } = await pool.query(
    `SELECT * FROM ai_programmer_proposals WHERE id = $1 AND organization_id = $2`,
    [proposalId, organizationId],
  );

  if (!proposalRows.length) {
    return { valid: false, reason: 'Proposal not found' };
  }

  const proposal = proposalRows[0];

  // Check expiry
  if (new Date(proposal.expires_at).getTime() <= Date.now()) {
    return { valid: false, reason: 'Proposal has expired' };
  }

  // Check status
  if (proposal.status !== 'draft') {
    return { valid: false, reason: `Proposal is ${proposal.status}, not draft` };
  }

  // Build current state fingerprint from current_state JSONB
  const currentState = typeof proposal.current_state === 'string'
    ? JSON.parse(proposal.current_state)
    : proposal.current_state;

  // Simple fingerprint: hash of key state fields
  const fingerprintData = JSON.stringify({
    exercise: currentState.exercise,
    weight: currentState.prescription?.target_weight,
    reps: currentState.prescription?.target_reps_min,
    sets: currentState.prescription?.target_sets,
  });

  const crypto = require('crypto');
  const currentFingerprint = crypto.createHash('sha256').update(fingerprintData).digest('hex').slice(0, 16);

  // Compare with stored fingerprint (if any)
  // For now, we check if the client has new sessions since proposal creation
  const clientId = proposal.client_id;
  const { rows: newSessions } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM workout_sessions
     WHERE client_id = $1 AND created_at > $2`,
    [clientId, proposal.created_at],
  );

  if (newSessions[0].count > 0) {
    return {
      valid: false,
      reason: `Client has ${newSessions[0].count} new session(s) since proposal was created. Please regenerate.`,
      sessionsSinceProposal: newSessions[0].count,
    };
  }

  return { valid: true };
}

// ── Audit Trail ────────────────────────────────────────────────────────────

/**
 * Record an audit event.
 *
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.actorId
 * @param {string} opts.targetType — 'memory' or 'proposal'
 * @param {string} opts.targetId
 * @param {string} opts.action — 'confirm', 'reject', 'approve', 'reject_proposal', 'supersede'
 * @param {string} [opts.previousState]
 * @param {string} [opts.newState]
 * @param {string} [opts.reason]
 * @param {string} [opts.requestId]
 */
async function recordAuditEvent(opts) {
  const {
    organizationId, actorId, targetType, targetId,
    action, previousState = null, newState = null,
    reason = null, requestId = null,
  } = opts;

  try {
    await pool.query(
      `INSERT INTO ai_intelligence_audit
         (organization_id, actor_id, target_type, target_id,
          action, previous_state, new_state, reason, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        organizationId, actorId, targetType, targetId,
        action, previousState, newState, reason, requestId,
      ],
    );
  } catch (err) {
    // Audit failure is non-fatal but logged loudly
    logger.error({ err: err.message }, 'audit_trail_write_failed');
  }
}

// ── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  // Pending queue
  getPendingWorkQueue,
  computePriority,

  // Client intelligence
  buildClientIntelligenceSummary,

  // Revalidation
  revalidateProposal,

  // Audit
  recordAuditEvent,
};

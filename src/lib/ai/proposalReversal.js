'use strict';

// src/lib/ai/proposalReversal.js — Phase 2J Execution Reversal
//
// Safely reverses successfully executed Programmer Agent proposals
// by restoring the exact previous state recorded in execution_history.
//
// CRITICAL INVARIANT:
//   AI NEVER performs undo.
//   AI NEVER calculates the reverse value.
//   The stored execution_history is the ONLY source for reversal.
//   Trainer explicitly requests. Backend revalidates. Deterministic write path executes.

const pool = require('../../db/pool');
const logger = require('../logger');

// ── Revalidation ───────────────────────────────────────────────────────────

/**
 * Revalidate before reversal.
 * Checks: proposal exists, is executed, not already reversed,
 * target client exists, exercise still exists, current state matches.
 *
 * @param {string} proposalId
 * @param {string} organizationId
 * @returns {{ valid: boolean, reason?: string, proposal?: object }}
 */
async function revalidateForReversal(proposalId, organizationId) {
  // 1. Load proposal
  const { rows } = await pool.query(
    `SELECT * FROM ai_programmer_proposals WHERE id = $1 AND organization_id = $2`,
    [proposalId, organizationId],
  );

  if (!rows.length) {
    return { valid: false, reason: 'Proposal not found' };
  }

  const proposal = rows[0];

  // 2. Must be executed
  if (proposal.status !== 'executed') {
    if (proposal.status === 'reversed') {
      return { valid: false, reason: 'ALREADY_REVERSED', proposal };
    }
    return { valid: false, reason: `Proposal is ${proposal.status}, not executed`, proposal };
  }

  // 3. Must have execution_history
  if (!proposal.execution_history) {
    return { valid: false, reason: 'No execution history recorded — cannot reverse', proposal };
  }

  // 4. Client must exist
  const { rows: clientRows } = await pool.query(
    `SELECT id, deleted_at FROM pt_clients WHERE id = $1`,
    [proposal.client_id],
  );
  if (!clientRows.length || clientRows[0].deleted_at) {
    return { valid: false, reason: 'Client no longer exists', proposal };
  }

  // 5. Tenant check
  if (organizationId) {
    const { rows: orgCheck } = await pool.query(
      `SELECT id FROM pt_clients WHERE id = $1 AND organization_id = $2`,
      [proposal.client_id, organizationId],
    );
    if (!orgCheck.length) {
      return { valid: false, reason: 'Client not in this organization', proposal };
    }
  }

  // 6. Verify current state still matches the "after" value from execution_history
  const history = typeof proposal.execution_history === 'string'
    ? JSON.parse(proposal.execution_history)
    : proposal.execution_history;

  const currentState = typeof proposal.current_state === 'string'
    ? JSON.parse(proposal.current_state)
    : proposal.current_state;

  // Find the target exercise in the current programme
  const { rows: exerciseRows } = await pool.query(
    `SELECT we.*, e.name AS exercise_name
     FROM workout_exercises we
     LEFT JOIN exercises e ON e.id = we.exercise_id
     LEFT JOIN workout_assignments wa ON wa.workout_plan_id = we.workout_plan_id
     WHERE wa.client_id = $1 AND wa.status = 'active'
       AND (e.name ILIKE $2 OR we.exercise_id = $3)
     ORDER BY we.sort_order
     LIMIT 1`,
    [
      proposal.client_id,
      `%${currentState?.exercise || ''}%`,
      currentState?.exercise_id || null,
    ],
  );

  if (!exerciseRows.length) {
    return { valid: false, reason: 'Target exercise not found in active programme', proposal };
  }

  const exercise = exerciseRows[0];

  // Verify the current value matches what was recorded as the "after" state
  if (history.field === 'target_weight' && history.to != null) {
    if (Math.abs(Number(exercise.target_weight) - Number(history.to)) > 0.1) {
      return {
        valid: false,
        reason: `EXECUTION_STATE_CHANGED: Current weight (${exercise.target_weight}kg) differs from recorded after-value (${history.to}kg). The training data has changed since this AI action was applied. Review the current state before reversing.`,
        proposal,
      };
    }
  } else if (history.field === 'reps' && history.to != null) {
    if (Number(exercise.reps) !== Number(history.to)) {
      return {
        valid: false,
        reason: `EXECUTION_STATE_CHANGED: Current reps (${exercise.reps}) differs from recorded after-value (${history.to}). The training data has changed since this AI action was applied.`,
        proposal,
      };
    }
  } else if (history.field === 'sets' && history.to != null) {
    if (Number(exercise.sets) !== Number(history.to)) {
      return {
        valid: false,
        reason: `EXECUTION_STATE_CHANGED: Current sets (${exercise.sets}) differs from recorded after-value (${history.to}). The training data has changed since this AI action was applied.`,
        proposal,
      };
    }
  } else if (history.field === 'exercise_id' && history.to != null) {
    if (exercise.exercise_id !== history.to) {
      return {
        valid: false,
        reason: `EXECUTION_STATE_CHANGED: Current exercise differs from what was applied. The training data has changed since this AI action was applied.`,
        proposal,
      };
    }
  } else if (history.fields) {
    // Multi-field change (volume/intensity)
    for (const [field, change] of Object.entries(history.fields)) {
      const currentVal = Number(exercise[field]);
      if (currentVal !== Number(change.to)) {
        return {
          valid: false,
          reason: `EXECUTION_STATE_CHANGED: Current ${field} (${currentVal}) differs from recorded after-value (${change.to}). The training data has changed since this AI action was applied.`,
          proposal,
        };
      }
    }
  }

  return { valid: true, proposal, exercise, history };
}

// ── Reversal ───────────────────────────────────────────────────────────────

/**
 * Reverse an executed proposal by restoring the exact previous state.
 * Uses the stored execution_history — never AI or percentage calculations.
 *
 * @param {object} opts
 * @param {string} opts.proposalId
 * @param {string} opts.organizationId
 * @param {string} opts.actorId
 * @param {string} [opts.reason]
 * @param {string} [opts.requestId]
 * @returns {{ success: boolean, reversal?: object, error?: string }}
 */
async function reverseProposal(opts) {
  const { proposalId, organizationId, actorId, reason = null, requestId } = opts;

  // 1. Revalidate
  const revalidation = await revalidateForReversal(proposalId, organizationId);
  if (!revalidation.valid) {
    if (revalidation.proposal?.status === 'reversed') {
      return { success: true, reversal: { status: 'already_reversed', proposal: revalidation.proposal } };
    }
    return { success: false, error: revalidation.reason, proposal: revalidation.proposal };
  }

  const { proposal, exercise, history } = revalidation;

  // 2. Begin transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 3. Atomic claim — status 'executed' → 'reversing'
    const { rows: claimed } = await client.query(
      `UPDATE ai_programmer_proposals
       SET status = 'reversing', updated_at = NOW()
       WHERE id = $1 AND status = 'executed'
       RETURNING *`,
      [proposalId],
    );

    if (!claimed.length) {
      await client.query('ROLLBACK');
      return { success: false, error: 'ALREADY_REVERSED' };
    }

    // 4. Apply the reverse — restore the exact "before" value
    let reverseResult;

    if (history.field && history.from != null && !history.fields) {
      // Single-field reversal
      await client.query(
        `UPDATE workout_exercises SET ${history.field} = $1, updated_at = NOW() WHERE id = $2`,
        [history.from, exercise.id],
      );
      reverseResult = {
        exercise: exercise.exercise_name,
        field: history.field,
        restored_from: history.to,
        restored_to: history.from,
      };
    } else if (history.fields) {
      // Multi-field reversal — restore each field's "before" value
      const sets = [];
      const values = [];
      for (const [field, change] of Object.entries(history.fields)) {
        values.push(change.from);
        sets.push(`${field} = $${values.length + 1}`);
      }
      values.push(exercise.id);

      await client.query(
        `UPDATE workout_exercises SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
        values,
      );
      reverseResult = {
        exercise: exercise.exercise_name,
        fields: Object.fromEntries(
          Object.entries(history.fields).map(([field, change]) => [field, { from: change.to, to: change.from }])
        ),
      };
    } else {
      await client.query('ROLLBACK');
      return { success: false, error: 'Invalid execution history — cannot reverse' };
    }

    // 5. Mark proposal as reversed
    await client.query(
      `UPDATE ai_programmer_proposals
       SET status = 'reversed', reversed_at = NOW(), reversed_by = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [proposalId, actorId],
    );

    // 6. Commit
    await client.query('COMMIT');

    // 7. Audit (outside transaction — non-fatal)
    try {
      await pool.query(
        `INSERT INTO ai_intelligence_audit
           (organization_id, actor_id, target_type, target_id, action,
            previous_state, new_state, reason, request_id)
         VALUES ($1, $2, 'proposal', $3, 'reverse', 'executed', 'reversed', $4, $5)`,
        [organizationId, actorId, proposalId, reason || null, requestId || null],
      );
    } catch (auditErr) {
      logger.error({ err: auditErr.message }, 'proposal_reversal_audit_failed');
    }

    return {
      success: true,
      reversal: {
        status: 'reversed',
        proposal_type: proposal.proposal_type,
        restored: reverseResult,
        proposal_id: proposalId,
      },
    };

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message, proposal_id: proposalId }, 'proposal_reversal_failed');

    // Mark as reversal_failed (non-fatal)
    try {
      await pool.query(
        `UPDATE ai_programmer_proposals SET status = 'executed', updated_at = NOW() WHERE id = $1 AND status = 'reversing'`,
        [proposalId],
      );
    } catch { /* best effort */ }

    return { success: false, error: `Reversal failed: ${err.message}` };
  } finally {
    client.release();
  }
}

// ── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  revalidateForReversal,
  reverseProposal,
};

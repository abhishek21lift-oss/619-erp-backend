'use strict';

// src/lib/ai/proposalExecutor.js — Phase 2I Controlled Training Execution
//
// Executes approved programmer proposals through existing deterministic
// training write paths. The LLM NEVER writes training data.
//
// FLOW:
//   APPROVE → revalidate → safety check → fingerprint check →
//   execute through existing write path → audit → return result
//
// NON-NEGOTIABLE:
//   DETERMINISTIC SYSTEM = SOURCE OF TRUTH
//   AI = INTERPRETER + PROPOSER
//   TRAINER = APPROVER
//   EXISTING WRITE PATH = ONLY WAY STATE CHANGES
//   THE MODEL IS NEVER IN THE WRITE PATH.

const pool = require('../../db/pool');
const logger = require('../logger');
const crypto = require('crypto');

// ── Execution allowed types ────────────────────────────────────────────────

/**
 * Proposal types that can be EXECUTED (mutate training data).
 * explain_progression is excluded — it's informational only.
 */
const EXECUTABLE_PROPOSAL_TYPES = [
  'progress_load',
  'regress_load',
  'change_rep_range',
  'adjust_sets',
  'exercise_substitution',
  'volume_adjustment',
  'intensity_adjustment',
  'deload_proposal',
  'recovery_modification',
];

// ── Revalidation ───────────────────────────────────────────────────────────

/**
 * Full revalidation at execution time.
 * Never trust data captured when proposal was created.
 *
 * @param {string} proposalId
 * @param {string} organizationId
 * @returns {{ valid: boolean, reason?: string, proposal?: object, sessionsSinceProposal?: number }}
 */
async function revalidateForExecution(proposalId, organizationId) {
  // 1. Load proposal
  const { rows } = await pool.query(
    `SELECT * FROM ai_programmer_proposals WHERE id = $1 AND organization_id = $2`,
    [proposalId, organizationId],
  );

  if (!rows.length) {
    return { valid: false, reason: 'Proposal not found' };
  }

  const proposal = rows[0];

  // 2. Check status
  if (proposal.status === 'executed') {
    return { valid: false, reason: 'ALREADY_EXECUTED', proposal };
  }
  if (proposal.status === 'rejected') {
    return { valid: false, reason: 'Proposal was rejected', proposal };
  }
  if (proposal.status === 'expired') {
    return { valid: false, reason: 'Proposal has expired', proposal };
  }
  if (proposal.status !== 'approved' && proposal.status !== 'draft') {
    return { valid: false, reason: `Unexpected proposal status: ${proposal.status}`, proposal };
  }

  // 3. Check expiry
  if (new Date(proposal.expires_at).getTime() <= Date.now()) {
    return { valid: false, reason: 'Proposal has expired', proposal };
  }

  // 4. Check client still exists and is authorized
  const { rows: clientRows } = await pool.query(
    `SELECT id, deleted_at FROM pt_clients WHERE id = $1`,
    [proposal.client_id],
  );
  if (!clientRows.length || clientRows[0].deleted_at) {
    return { valid: false, reason: 'Client no longer exists', proposal };
  }

  // 5. Check tenant
  if (organizationId) {
    const { rows: orgCheck } = await pool.query(
      `SELECT id FROM pt_clients WHERE id = $1 AND organization_id = $2`,
      [proposal.client_id, organizationId],
    );
    if (!orgCheck.length) {
      return { valid: false, reason: 'Client not in this organization', proposal };
    }
  }

  // 6. Check PAR-Q safety gate
  const { rows: parqRows } = await pool.query(
    `SELECT workout_gate_status FROM pt_parq_forms
     WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [proposal.client_id],
  );
  if (parqRows.length && parqRows[0].workout_gate_status === 'blocked') {
    return { valid: false, reason: 'PAR-Q blocks training — cannot execute', proposal };
  }

  // 7. Check for new sessions since proposal creation (staleness)
  const { rows: sessionRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM workout_sessions
     WHERE client_id = $1 AND created_at > $2`,
    [proposal.client_id, proposal.created_at],
  );
  if (sessionRows[0].count > 0) {
    return {
      valid: false,
      reason: `Client has ${sessionRows[0].count} new session(s) since proposal was created. Please regenerate.`,
      proposal,
      sessionsSinceProposal: sessionRows[0].count,
    };
  }

  // 8. Check proposal type is executable
  if (!EXECUTABLE_PROPOSAL_TYPES.includes(proposal.proposal_type)) {
    return { valid: false, reason: `Proposal type '${proposal.proposal_type}' is not executable`, proposal };
  }

  // 9. Fingerprint check — verify current state matches what proposal was based on
  const currentState = typeof proposal.current_state === 'string'
    ? JSON.parse(proposal.current_state)
    : proposal.current_state;

  if (currentState && currentState.exercise) {
    // Find the relevant workout exercise row
    const { rows: exerciseRows } = await pool.query(
      `SELECT we.id, we.target_weight, we.sets, we.reps, we.exercise_id, e.name
       FROM workout_exercises we
       LEFT JOIN exercises e ON e.id = we.exercise_id
       WHERE we.workout_plan_id IN (
         SELECT workout_plan_id FROM workout_assignments
         WHERE client_id = $1 AND status = 'active'
       ) AND (e.name ILIKE $2 OR we.exercise_id = $3)
       LIMIT 1`,
      [
        proposal.client_id,
        `%${currentState.exercise}%`,
        currentState.exercise_id || null,
      ],
    );

    if (exerciseRows.length) {
      const current = exerciseRows[0];
      // Compare key fields
      if (currentState.prescription?.target_weight != null &&
          current.target_weight != null &&
          Math.abs(Number(current.target_weight) - Number(currentState.prescription.target_weight)) > 0.1) {
        return {
          valid: false,
          reason: `Exercise weight has changed (${current.target_weight}kg vs ${currentState.prescription.target_weight}kg in proposal)`,
          proposal,
        };
      }
    }
  }

  return { valid: true, proposal };
}

// ── Fingerprint ────────────────────────────────────────────────────────────

/**
 * Compute a fingerprint for the current state of a proposal's target exercise.
 * Used for staleness detection.
 */
function computeFingerprint(state) {
  const data = JSON.stringify({
    exercise: state.exercise,
    weight: state.prescription?.target_weight,
    reps: state.prescription?.target_reps_min,
    sets: state.prescription?.target_sets,
  });
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// ── Execution ──────────────────────────────────────────────────────────────

/**
 * Execute an approved proposal through the existing deterministic write path.
 * This is the ONLY function that mutates training data.
 *
 * @param {object} opts
 * @param {string} opts.proposalId
 * @param {string} opts.organizationId
 * @param {string} opts.actorId
 * @param {string} [opts.requestId]
 * @returns {{ success: boolean, execution?: object, error?: string }}
 */
async function executeProposal(opts) {
  const { proposalId, organizationId, actorId, requestId } = opts;

  // 1. Revalidate
  const revalidation = await revalidateForExecution(proposalId, organizationId);
  if (!revalidation.valid) {
    if (revalidation.proposal?.status === 'executed') {
      return { success: true, execution: { status: 'already_executed', proposal: revalidation.proposal } };
    }
    return { success: false, error: revalidation.reason };
  }

  const proposal = revalidation.proposal;

  // 2. Begin transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 3. Atomic claim — update status to 'executing' (prevents double execution)
    const { rows: claimed } = await client.query(
      `UPDATE ai_programmer_proposals
       SET status = 'executing', updated_at = NOW()
       WHERE id = $1 AND status = 'approved'
       RETURNING *`,
      [proposalId],
    );

    if (!claimed.length) {
      await client.query('ROLLBACK');
      return { success: false, error: 'ALREADY_EXECUTED' };
    }

    // 4. Execute the mutation
    const currentState = typeof proposal.current_state === 'string'
      ? JSON.parse(proposal.current_state)
      : proposal.current_state;

    const aiRec = typeof proposal.ai_recommendation === 'string'
      ? JSON.parse(proposal.ai_recommendation)
      : proposal.ai_recommendation;

    const detRec = typeof proposal.deterministic_recommendation === 'string'
      ? JSON.parse(proposal.deterministic_recommendation)
      : proposal.deterministic_recommendation;

    // Determine which recommendation to apply:
    // If AI and deterministic agree → use deterministic
    // If they disagree → use deterministic (AI is advisory)
    const recommendation = detRec || aiRec;

    let executionResult;
    switch (proposal.proposal_type) {
      case 'progress_load':
      case 'regress_load':
        executionResult = await executeLoadChange(client, proposal, currentState, recommendation);
        break;
      case 'change_rep_range':
        executionResult = await executeRepChange(client, proposal, currentState, recommendation);
        break;
      case 'adjust_sets':
        executionResult = await executeSetChange(client, proposal, currentState, recommendation);
        break;
      case 'volume_adjustment':
      case 'intensity_adjustment':
        executionResult = await executeVolumeOrIntensity(client, proposal, currentState, recommendation);
        break;
      case 'deload_proposal':
      case 'recovery_modification':
        executionResult = await executeDeloadOrRecovery(client, proposal, currentState, recommendation);
        break;
      case 'exercise_substitution':
        executionResult = await executeExerciseSubstitution(client, proposal, currentState, recommendation);
        break;
      default:
        await client.query('ROLLBACK');
        return { success: false, error: `Unknown proposal type: ${proposal.proposal_type}` };
    }

    if (!executionResult.success) {
      await client.query('ROLLBACK');
      return { success: false, error: executionResult.error };
    }

    // 5. Mark proposal as executed — store execution_history for reversal
    await client.query(
      `UPDATE ai_programmer_proposals
       SET status = 'executed', executed_at = NOW(), updated_at = NOW(),
           execution_history = $2
       WHERE id = $1`,
      [proposalId, JSON.stringify(executionResult.changes)],
    );

    // 6. Commit
    await client.query('COMMIT');

    // 7. Audit (outside transaction — non-fatal)
    try {
      await pool.query(
        `INSERT INTO ai_intelligence_audit
           (organization_id, actor_id, target_type, target_id, action, previous_state, new_state, request_id)
         VALUES ($1, $2, 'proposal', $3, 'execute', 'approved', 'executed', $4)`,
        [organizationId, actorId, proposalId, requestId || null],
      );
    } catch (auditErr) {
      logger.error({ err: auditErr.message }, 'proposal_execution_audit_failed');
    }

    return {
      success: true,
      execution: {
        status: 'executed',
        proposal_type: proposal.proposal_type,
        changes: executionResult.changes,
        proposal_id: proposalId,
      },
    };

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message, proposal_id: proposalId }, 'proposal_execution_failed');

    // Mark as execution_failed (non-fatal, outside transaction)
    try {
      await pool.query(
        `UPDATE ai_programmer_proposals SET status = 'draft', updated_at = NOW() WHERE id = $1 AND status = 'executing'`,
        [proposalId],
      );
    } catch { /* best effort */ }

    return { success: false, error: `Execution failed: ${err.message}` };
  } finally {
    client.release();
  }
}

// ── Mutation handlers ──────────────────────────────────────────────────────

/**
 * Find the workout exercise row for a proposal's target exercise.
 * Returns the exercise row with its workout_plan_id.
 */
async function findTargetExercise(client, proposal, currentState) {
  // Try to find via exercise name in active assignment
  const { rows } = await client.query(
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
  return rows[0] || null;
}

/**
 * Execute a load change (progress_load or regress_load).
 */
async function executeLoadChange(client, proposal, currentState, recommendation) {
  const exercise = await findTargetExercise(client, proposal, currentState);
  if (!exercise) {
    return { success: false, error: 'Target exercise not found in active programme' };
  }

  const currentWeight = Number(exercise.target_weight) || 0;
  let newWeight;

  if (recommendation?.target_weight != null) {
    newWeight = Number(recommendation.target_weight);
  } else if (recommendation?.amount) {
    // Parse "2.5kg" or "+2.5" or "-5"
    const match = String(recommendation.amount).match(/([+-]?\d+(?:\.\d+)?)/);
    newWeight = match ? currentWeight + Number(match[1]) : currentWeight;
  } else {
    // Default increment based on type
    newWeight = proposal.proposal_type === 'progress_load'
      ? currentWeight + 2.5
      : currentWeight - 2.5;
  }

  if (newWeight <= 0) {
    return { success: false, error: 'Calculated weight would be zero or negative' };
  }

  await client.query(
    `UPDATE workout_exercises SET target_weight = $1, updated_at = NOW() WHERE id = $2`,
    [newWeight, exercise.id],
  );

  return {
    success: true,
    changes: {
      exercise: exercise.exercise_name,
      field: 'target_weight',
      from: currentWeight,
      to: newWeight,
    },
  };
}

/**
 * Execute a rep range change.
 */
async function executeRepChange(client, proposal, currentState, recommendation) {
  const exercise = await findTargetExercise(client, proposal, currentState);
  if (!exercise) {
    return { success: false, error: 'Target exercise not found in active programme' };
  }

  const currentReps = Number(exercise.reps) || 0;
  const newReps = recommendation?.target_reps_min ?? recommendation?.reps ?? currentReps;

  if (newReps <= 0 || newReps > 30) {
    return { success: false, error: `Invalid rep target: ${newReps}` };
  }

  await client.query(
    `UPDATE workout_exercises SET reps = $1, updated_at = NOW() WHERE id = $2`,
    [newReps, exercise.id],
  );

  return {
    success: true,
    changes: {
      exercise: exercise.exercise_name,
      field: 'reps',
      from: currentReps,
      to: newReps,
    },
  };
}

/**
 * Execute a set count change.
 */
async function executeSetChange(client, proposal, currentState, recommendation) {
  const exercise = await findTargetExercise(client, proposal, currentState);
  if (!exercise) {
    return { success: false, error: 'Target exercise not found in active programme' };
  }

  const currentSets = Number(exercise.sets) || 0;
  const newSets = recommendation?.target_sets ?? recommendation?.sets ?? currentSets;

  if (newSets <= 0 || newSets > 10) {
    return { success: false, error: `Invalid set count: ${newSets}` };
  }

  await client.query(
    `UPDATE workout_exercises SET sets = $1, updated_at = NOW() WHERE id = $2`,
    [newSets, exercise.id],
  );

  return {
    success: true,
    changes: {
      exercise: exercise.exercise_name,
      field: 'sets',
      from: currentSets,
      to: newSets,
    },
  };
}

/**
 * Execute volume or intensity adjustment.
 */
async function executeVolumeOrIntensity(client, proposal, currentState, recommendation) {
  const exercise = await findTargetExercise(client, proposal, currentState);
  if (!exercise) {
    return { success: false, error: 'Target exercise not found in active programme' };
  }

  // Volume = sets × reps × weight; Intensity = RPE
  const changes = {};

  if (recommendation?.sets != null && Number(recommendation.sets) !== Number(exercise.sets)) {
    changes.sets = { from: Number(exercise.sets), to: Number(recommendation.sets) };
  }
  if (recommendation?.reps != null && Number(recommendation.reps) !== Number(exercise.reps)) {
    changes.reps = { from: Number(exercise.reps), to: Number(recommendation.reps) };
  }
  if (recommendation?.target_weight != null && Number(recommendation.target_weight) !== Number(exercise.target_weight)) {
    changes.target_weight = { from: Number(exercise.target_weight), to: Number(recommendation.target_weight) };
  }
  if (recommendation?.rpe != null && Number(recommendation.rpe) !== Number(exercise.rpe)) {
    changes.rpe = { from: Number(exercise.rpe), to: Number(recommendation.rpe) };
  }

  if (Object.keys(changes).length === 0) {
    return { success: false, error: 'No changes specified in recommendation' };
  }

  // Build SET clause
  const sets = [];
  const values = [];
  for (const [field, change] of Object.entries(changes)) {
    values.push(change.to);
    sets.push(`${field} = $${values.length + 1}`);
  }
  values.push(exercise.id);

  await client.query(
    `UPDATE workout_exercises SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
    values,
  );

  return {
    success: true,
    changes: {
      exercise: exercise.exercise_name,
      fields: changes,
    },
  };
}

/**
 * Execute deload or recovery modification — reduce load by a percentage.
 */
async function executeDeloadOrRecovery(client, proposal, currentState, recommendation) {
  const exercise = await findTargetExercise(client, proposal, currentState);
  if (!exercise) {
    return { success: false, error: 'Target exercise not found in active programme' };
  }

  const currentWeight = Number(exercise.target_weight) || 0;
  const reductionPct = recommendation?.reduction_pct ?? 10; // default 10% deload
  const newWeight = Math.round(currentWeight * (1 - reductionPct / 100) * 4) / 4; // round to nearest 0.25

  if (newWeight <= 0) {
    return { success: false, error: 'Deload would reduce weight to zero' };
  }

  await client.query(
    `UPDATE workout_exercises SET target_weight = $1, updated_at = NOW() WHERE id = $2`,
    [newWeight, exercise.id],
  );

  return {
    success: true,
    changes: {
      exercise: exercise.exercise_name,
      field: 'target_weight',
      from: currentWeight,
      to: newWeight,
      reason: `Deload: ${reductionPct}% reduction`,
    },
  };
}

/**
 * Execute exercise substitution.
 */
async function executeExerciseSubstitution(client, proposal, currentState, recommendation) {
  if (!recommendation?.new_exercise_id && !recommendation?.new_exercise_name) {
    return { success: false, error: 'No replacement exercise specified' };
  }

  const exercise = await findTargetExercise(client, proposal, currentState);
  if (!exercise) {
    return { success: false, error: 'Target exercise not found in active programme' };
  }

  let newExerciseId = recommendation.new_exercise_id;

  // If only name provided, look it up
  if (!newExerciseId && recommendation.new_exercise_name) {
    const { rows: found } = await client.query(
      `SELECT id FROM exercises WHERE name ILIKE $1 LIMIT 1`,
      [`%${recommendation.new_exercise_name}%`],
    );
    if (!found.length) {
      return { success: false, error: `Exercise '${recommendation.new_exercise_name}' not found in library` };
    }
    newExerciseId = found[0].id;
  }

  const oldName = exercise.exercise_name;
  await client.query(
    `UPDATE workout_exercises SET exercise_id = $1, updated_at = NOW() WHERE id = $2`,
    [newExerciseId, exercise.id],
  );

  // Get new exercise name
  const { rows: newName } = await client.query(`SELECT name FROM exercises WHERE id = $1`, [newExerciseId]);

  return {
    success: true,
    changes: {
      exercise: oldName,
      field: 'exercise_id',
      from: exercise.exercise_id,
      to: newExerciseId,
      new_exercise_name: newName[0]?.name || 'unknown',
    },
  };
}

// ── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  revalidateForExecution,
  executeProposal,
  computeFingerprint,
  EXECUTABLE_PROPOSAL_TYPES,
};

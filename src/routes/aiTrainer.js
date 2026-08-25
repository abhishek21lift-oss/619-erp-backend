'use strict';

// src/routes/aiTrainer.js — Phase 2F Trainer Intelligence API
//
// Unified endpoints for trainer intelligence + approval center:
//   GET  /api/ai/trainer/pending                    — unified pending work queue
//   GET  /api/ai/trainer/intelligence/:client_id    — client intelligence summary
//   POST /api/ai/trainer/memory/:id/confirm         — confirm a memory candidate
//   POST /api/ai/trainer/memory/:id/reject          — reject a memory candidate
//   POST /api/ai/trainer/proposal/:id/approve       — approve a programmer proposal
//   POST /api/ai/trainer/proposal/:id/reject        — reject a programmer proposal

const express = require('express');
const { auth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { tenantScope } = require('../lib/tenant-db');
const logger = require('../lib/logger');
const {
  getPendingWorkQueue,
  buildClientIntelligenceSummary,
  revalidateProposal,
  recordAuditEvent,
} = require('../lib/ai/trainerIntelligence');
const {
  confirmMemory,
  rejectMemory,
  supersedeMemory,
} = require('../lib/ai/memory');
const {
  approveProposal,
  rejectProposal,
} = require('../lib/ai/programmerAgent');
const {
  executeProposal,
} = require('../lib/ai/proposalExecutor');
const {
  reverseProposal,
} = require('../lib/ai/proposalReversal');

const router = express.Router();
const pool = require('../db/pool');

async function verifyClient(clientId, organizationId) {
  const { rows } = await pool.query(
    `SELECT id FROM pt_clients WHERE id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR organization_id=$2)`,
    [clientId, organizationId],
  );
  return rows.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/ai/trainer/pending
// Unified pending work queue
// ═══════════════════════════════════════════════════════════════════════════
router.get('/pending', auth, requireRole('trainer'), async (req, res) => {
  const { client_id, limit } = req.query;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (client_id && !await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  try {
    const queue = await getPendingWorkQueue(org, client_id, {
      limit: limit ? parseInt(limit, 10) : 20,
    });
    res.json({ data: queue });
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_pending_failed');
    res.status(500).json({ error: 'Failed to load pending work' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/ai/trainer/intelligence/:client_id
// Client intelligence summary
// ═══════════════════════════════════════════════════════════════════════════
router.get('/intelligence/:client_id', auth, requireRole('trainer'), async (req, res) => {
  const { client_id } = req.params;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (!await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  try {
    const summary = await buildClientIntelligenceSummary(client_id, org);
    if (!summary) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json({ data: summary });
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_intelligence_failed');
    res.status(500).json({ error: 'Failed to build intelligence summary' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/trainer/memory/:id/confirm
// Confirm a memory candidate → active
// ═══════════════════════════════════════════════════════════════════════════
router.post('/memory/:id/confirm', auth, requireRole('trainer'), async (req, res) => {
  const { id } = req.params;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  try {
    const memory = await confirmMemory(id, org, { verified_by: req.user?.id });
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found or not a candidate' });
    }

    // Audit trail
    await recordAuditEvent({
      organizationId: org,
      actorId: req.user?.id,
      targetType: 'memory',
      targetId: id,
      action: 'confirm',
      previousState: 'candidate',
      newState: 'active',
      requestId: req.id,
    });

    res.json({ data: memory });
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_memory_confirm_failed');
    res.status(500).json({ error: 'Failed to confirm memory' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/trainer/memory/:id/reject
// Reject a memory candidate
// ═══════════════════════════════════════════════════════════════════════════
router.post('/memory/:id/reject', auth, requireRole('trainer'), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  try {
    const memory = await rejectMemory(id, org);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found or not a candidate' });
    }

    await recordAuditEvent({
      organizationId: org,
      actorId: req.user?.id,
      targetType: 'memory',
      targetId: id,
      action: 'reject',
      previousState: 'candidate',
      newState: 'deleted',
      reason,
      requestId: req.id,
    });

    res.json({ data: memory });
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_memory_reject_failed');
    res.status(500).json({ error: 'Failed to reject memory' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/trainer/proposal/:id/approve
// Approve a programmer proposal (with stale revalidation)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/proposal/:id/approve', auth, requireRole('trainer'), async (req, res) => {
  const { id } = req.params;
  const { execute } = req.body || {};  // optional: { execute: true } to run immediately
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  // Revalidate before approval
  const revalidation = await revalidateProposal(id, org);
  if (!revalidation.valid) {
    return res.status(409).json({
      error: 'Proposal is no longer valid',
      code: 'stale_proposal',
      reason: revalidation.reason,
      sessionsSinceProposal: revalidation.sessionsSinceProposal,
    });
  }

  try {
    // Step 1: Approve
    const proposal = await approveProposal(id, org, req.user?.id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found or not in draft status' });
    }

    await recordAuditEvent({
      organizationId: org,
      actorId: req.user?.id,
      targetType: 'proposal',
      targetId: id,
      action: 'approve',
      previousState: 'draft',
      newState: 'approved',
      requestId: req.id,
    });

    // Step 2: Execute if requested
    if (execute) {
      const execution = await executeProposal({
        proposalId: id,
        organizationId: org,
        actorId: req.user?.id,
        requestId: req.id,
      });

      if (execution.success) {
        return res.json({ data: { ...proposal, ...execution.execution } });
      } else {
        // Approval succeeded but execution failed — return both statuses
        return res.json({
          data: proposal,
          execution_error: execution.error,
          execution_status: 'failed',
        });
      }
    }

    res.json({ data: proposal });
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_proposal_approve_failed');
    res.status(500).json({ error: 'Failed to approve proposal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/trainer/proposal/:id/reject
// Reject a programmer proposal
// ═══════════════════════════════════════════════════════════════════════════
router.post('/proposal/:id/reject', auth, requireRole('trainer'), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  try {
    const proposal = await rejectProposal(id, org, req.user?.id, reason);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found or not in draft status' });
    }

    await recordAuditEvent({
      organizationId: org,
      actorId: req.user?.id,
      targetType: 'proposal',
      targetId: id,
      action: 'reject_proposal',
      previousState: 'draft',
      newState: 'rejected',
      reason,
      requestId: req.id,
    });

    res.json({ data: proposal });
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_proposal_reject_failed');
    res.status(500).json({ error: 'Failed to reject proposal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/trainer/proposal/:id/execute
// Execute an already-approved proposal
// ═══════════════════════════════════════════════════════════════════════════
router.post('/proposal/:id/execute', auth, requireRole('trainer'), async (req, res) => {
  const { id } = req.params;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  try {
    const execution = await executeProposal({
      proposalId: id,
      organizationId: org,
      actorId: req.user?.id,
      requestId: req.id,
    });

    if (execution.success) {
      res.json({ data: execution.execution });
    } else if (execution.error === 'ALREADY_EXECUTED') {
      res.json({ data: { status: 'already_executed' } });
    } else {
      res.status(409).json({ error: execution.error, code: 'execution_failed' });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_proposal_execute_failed');
    res.status(500).json({ error: 'Failed to execute proposal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/trainer/proposal/:id/reverse
// Reverse an executed proposal — restore exact previous state
// ═══════════════════════════════════════════════════════════════════════════
router.post('/proposal/:id/reverse', auth, requireRole('trainer'), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  try {
    const result = await reverseProposal({
      proposalId: id,
      organizationId: org,
      actorId: req.user?.id,
      reason,
      requestId: req.id,
    });

    if (result.success) {
      res.json({ data: result.reversal });
    } else if (result.error === 'ALREADY_REVERSED') {
      res.json({ data: { status: 'already_reversed' } });
    } else if (result.error?.includes('EXECUTION_STATE_CHANGED')) {
      res.status(409).json({
        error: result.error,
        code: 'execution_state_changed',
      });
    } else {
      res.status(400).json({ error: result.error, code: 'reversal_failed' });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_proposal_reverse_failed');
    res.status(500).json({ error: 'Failed to reverse proposal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/ai/trainer/audit
// Audit trail for intelligence actions
// ═══════════════════════════════════════════════════════════════════════════
router.get('/audit', auth, requireRole('trainer'), async (req, res) => {
  const { client_id, target_type, limit: limitStr } = req.query;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;
  const limit = Math.min(parseInt(limitStr || '50', 10), 100);

  try {
    let query;
    let params;

    if (client_id) {
      // Filter audit events by client — join against memory/proposal tables
      query = `
        SELECT a.*,
          CASE
            WHEN a.target_type = 'memory' THEN m.fact
            WHEN a.target_type = 'proposal' THEN p.summary
          END AS target_description,
          CASE
            WHEN a.target_type = 'memory' THEN m.client_id
            WHEN a.target_type = 'proposal' THEN p.client_id
          END AS client_id
        FROM ai_intelligence_audit a
        LEFT JOIN ai_client_memory m ON a.target_type = 'memory' AND a.target_id = m.id
        LEFT JOIN ai_programmer_proposals p ON a.target_type = 'proposal' AND a.target_id = p.id
        WHERE ($1::uuid IS NULL OR a.organization_id = $1)
          AND (($2::uuid IS NULL AND $3::uuid IS NULL)
            OR (a.target_type = 'memory' AND m.client_id = $3)
            OR (a.target_type = 'proposal' AND p.client_id = $3))
        ORDER BY a.created_at DESC LIMIT $4
      `;
      params = [org, org, client_id, limit];
    } else if (target_type) {
      query = `
        SELECT a.*,
          CASE
            WHEN a.target_type = 'memory' THEN m.fact
            WHEN a.target_type = 'proposal' THEN p.summary
          END AS target_description
        FROM ai_intelligence_audit a
        LEFT JOIN ai_client_memory m ON a.target_type = 'memory' AND a.target_id = m.id
        LEFT JOIN ai_programmer_proposals p ON a.target_type = 'proposal' AND a.target_id = p.id
        WHERE ($1::uuid IS NULL OR a.organization_id = $1)
          AND a.target_type = $2
        ORDER BY a.created_at DESC LIMIT $3
      `;
      params = [org, target_type, limit];
    } else {
      query = `
        SELECT a.*,
          CASE
            WHEN a.target_type = 'memory' THEN m.fact
            WHEN a.target_type = 'proposal' THEN p.summary
          END AS target_description
        FROM ai_intelligence_audit a
        LEFT JOIN ai_client_memory m ON a.target_type = 'memory' AND a.target_id = m.id
        LEFT JOIN ai_programmer_proposals p ON a.target_type = 'proposal' AND a.target_id = p.id
        WHERE ($1::uuid IS NULL OR a.organization_id = $1)
        ORDER BY a.created_at DESC LIMIT $2
      `;
      params = [org, limit];
    }

    const { rows } = await pool.query(query, params);
    res.json({ data: rows });
  } catch (err) {
    logger.error({ err: err.message }, 'trainer_audit_failed');
    res.status(500).json({ error: 'Failed to load audit trail' });
  }
});

module.exports = router;

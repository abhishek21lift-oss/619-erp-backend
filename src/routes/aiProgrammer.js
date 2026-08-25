'use strict';

// src/routes/aiProgrammer.js — Phase 2E Programmer Agent API
//
// Endpoints:
//   POST /api/ai/programmer/propose           — generate proposals for a client
//   GET  /api/ai/programmer/proposals/:client_id — list proposals
//   POST /api/ai/programmer/proposals/:id/approve — approve a proposal
//   POST /api/ai/programmer/proposals/:id/reject  — reject a proposal

const express = require('express');
const { auth } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');
const logger = require('../lib/logger');
const {
  runProgrammerAgent,
  storeProposal,
  listProposals,
  approveProposal,
  rejectProposal,
} = require('../lib/ai/programmerAgent');
const { aiIntentLimit } = require('../lib/ai/rateLimit');

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
// POST /api/ai/programmer/propose
// Generate proposals for a client
// ═══════════════════════════════════════════════════════════════════════════
router.post('/propose', auth, aiIntentLimit('chat'), async (req, res) => {
  const { client_id, exercise_name, context } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (!await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  try {
    // Run the programmer agent
    const result = await runProgrammerAgent({
      clientId: client_id,
      organizationId: org,
      exerciseName: exercise_name,
      context,
    });

    if (result.safety?.hardStop) {
      return res.status(403).json({
        error: 'Safety gate blocked proposals',
        safety: result.safety,
      });
    }

    // Store each valid proposal
    const stored = [];
    for (const p of result.proposals) {
      try {
        const proposal = await storeProposal({
          organizationId: org,
          clientId: client_id,
          proposalType: p.proposal_type,
          summary: p.summary,
          reason: p.reason,
          evidence: p.evidence,
          currentState: p.current_state,
          deterministicRecommendation: p.deterministic_recommendation,
          aiRecommendation: p.ai_recommendation,
          confidence: p.confidence,
          safetyFlags: p.safety_flags,
          createdBy: req.user?.id || 'system',
        });
        stored.push(proposal);
      } catch (storeErr) {
        logger.warn({ err: storeErr.message }, 'programmer_proposal_store_failed');
      }
    }

    res.json({
      data: {
        proposals: stored,
        safety: result.safety,
        errors: result.errors || [],
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'programmer_propose_failed');
    res.status(500).json({ error: 'Failed to generate proposals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/ai/programmer/proposals/:client_id
// List proposals for a client
// ═══════════════════════════════════════════════════════════════════════════
router.get('/proposals/:client_id', auth, async (req, res) => {
  const { client_id } = req.params;
  const { status, limit } = req.query;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (!await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  try {
    const proposals = await listProposals(client_id, org, {
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    res.json({ data: proposals });
  } catch (err) {
    logger.error({ err: err.message }, 'programmer_list_failed');
    res.status(500).json({ error: 'Failed to list proposals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/programmer/proposals/:id/approve
// Approve a proposal
// ═══════════════════════════════════════════════════════════════════════════
router.post('/proposals/:id/approve', auth, async (req, res) => {
  const { id } = req.params;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  try {
    const proposal = await approveProposal(id, org, req.user?.id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found or not in draft status' });
    }
    res.json({ data: proposal });
  } catch (err) {
    logger.error({ err: err.message }, 'programmer_approve_failed');
    res.status(500).json({ error: 'Failed to approve proposal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/programmer/proposals/:id/reject
// Reject a proposal
// ═══════════════════════════════════════════════════════════════════════════
router.post('/proposals/:id/reject', auth, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  try {
    const proposal = await rejectProposal(id, org, req.user?.id, reason);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found or not in draft status' });
    }
    res.json({ data: proposal });
  } catch (err) {
    logger.error({ err: err.message }, 'programmer_reject_failed');
    res.status(500).json({ error: 'Failed to reject proposal' });
  }
});

module.exports = router;

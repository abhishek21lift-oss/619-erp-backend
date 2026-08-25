'use strict';

// src/routes/aiMemory.js — Phase 2D Memory Confirmation API
//
// Provides trainer-facing endpoints for managing AI-extracted candidate memories:
//   GET    /api/ai/memory/:client_id       — list memories (all or filtered)
//   GET    /api/ai/memory/:client_id/pending — list pending candidates
//   POST   /api/ai/memory/:client_id/confirm/:memory_id — confirm a candidate
//   POST   /api/ai/memory/:client_id/reject/:memory_id  — reject a candidate
//   DELETE /api/ai/memory/:memory_id        — soft-delete a memory
//   POST   /api/ai/memory/:client_id/supersede — supersede old with new

const express = require('express');
const { auth } = require('../middleware/auth');
const { tenantScope } = require('../lib/tenant-db');
const logger = require('../lib/logger');
const {
  getMemories,
  getActiveMemories,
  confirmMemory,
  rejectMemory,
  deleteMemory,
  supersedeMemory,
  createMemory,
  detectConflicts,
} = require('../lib/ai/memory');
const {
  getPendingCandidates,
  checkConflicts,
} = require('../lib/ai/memoryIndexer');

const router = express.Router();

// ── Helper: verify client belongs to org ───────────────────────────────────
const pool = require('../db/pool');

async function verifyClient(clientId, organizationId) {
  const { rows } = await pool.query(
    `SELECT id FROM pt_clients WHERE id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR organization_id=$2)`,
    [clientId, organizationId],
  );
  return rows.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/ai/memory/:client_id
// List memories for a client (all non-deleted by default)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:client_id', auth, async (req, res) => {
  const { client_id } = req.params;
  const { category, status, limit } = req.query;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (!await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  try {
    const memories = await getMemories(client_id, org, {
      category: category || undefined,
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : 100,
    });
    res.json({ data: memories });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_memory_list_failed');
    res.status(500).json({ error: 'Failed to list memories' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/ai/memory/:client_id/pending
// List pending candidate memories for a client
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:client_id/pending', auth, async (req, res) => {
  const { client_id } = req.params;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (!await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  try {
    const candidates = await getPendingCandidates(client_id, org);
    res.json({ data: candidates });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_memory_pending_failed');
    res.status(500).json({ error: 'Failed to list pending candidates' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/memory/:client_id/confirm/:memory_id
// Confirm a candidate memory → status becomes 'active'
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:client_id/confirm/:memory_id', auth, async (req, res) => {
  const { client_id, memory_id } = req.params;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (!await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  try {
    const memory = await confirmMemory(memory_id, org, {
      verified_by: req.user?.id,
    });
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found or not a candidate' });
    }
    res.json({ data: memory });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_memory_confirm_failed');
    res.status(500).json({ error: 'Failed to confirm memory' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/memory/:client_id/reject/:memory_id
// Reject a candidate memory → status becomes 'deleted'
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:client_id/reject/:memory_id', auth, async (req, res) => {
  const { client_id, memory_id } = req.params;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (!await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  try {
    const memory = await rejectMemory(memory_id, org);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found or not a candidate' });
    }
    res.json({ data: memory });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_memory_reject_failed');
    res.status(500).json({ error: 'Failed to reject memory' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/ai/memory/:memory_id
// Soft-delete a memory
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:memory_id', auth, async (req, res) => {
  const { memory_id } = req.params;
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  try {
    const memory = await deleteMemory(memory_id, org);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    res.json({ data: memory });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_memory_delete_failed');
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/ai/memory/:client_id/supersede
// Supersede an old memory with a new one
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:client_id/supersede', auth, async (req, res) => {
  const { client_id } = req.params;
  const { old_memory_id, new_fact, new_category, new_subcategory } = req.body || {};
  const scope = tenantScope(req);
  const org = scope.applyFilter ? scope.orgId : null;

  if (!await verifyClient(client_id, org)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  if (!old_memory_id || !new_fact) {
    return res.status(400).json({ error: 'old_memory_id and new_fact are required' });
  }

  try {
    // Create the new memory first (as active, since trainer is confirming)
    const newMemory = await createMemory({
      organization_id: org,
      client_id,
      category: new_category || 'preference',
      subcategory: new_subcategory,
      fact: new_fact,
      source_type: 'trainer_confirmed',
      confidence: 1.0,
      created_by: req.user?.id,
    });

    // Then supersede the old one
    const oldMemory = await supersedeMemory(old_memory_id, newMemory.id, org);
    if (!oldMemory) {
      return res.status(404).json({ error: 'Old memory not found or not active' });
    }

    res.json({ data: { old: oldMemory, new: newMemory } });
  } catch (err) {
    logger.error({ err: err.message }, 'ai_memory_supersede_failed');
    res.status(500).json({ error: 'Failed to supersede memory' });
  }
});

module.exports = router;

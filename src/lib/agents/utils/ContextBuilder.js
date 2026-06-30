'use strict';
const { randomUUID }   = require('crypto');
const pool             = require('../../../db/pool');
const { AgentContext } = require('../base/AgentContext');

/**
 * Assembles an AgentContext from an Express request object.
 * Enriches user fields (trainerId, memberId, branchId) from DB if needed.
 * Called once at the /api/agent boundary before any agent is invoked.
 */
async function buildContext(req, overrides = {}) {
  const user = req.user; // set by auth middleware

  // Fetch additional user fields not stored in the JWT claim
  let branchId = null, trainerId = null, memberId = null;

  try {
    const { rows } = await pool.query(
      `SELECT branch_id, trainer_id, member_id FROM users WHERE id = $1 AND is_active = TRUE`,
      [user.id]
    );
    if (rows[0]) {
      branchId  = rows[0].branch_id  || null;
      trainerId = rows[0].trainer_id || null;
      memberId  = rows[0].member_id  || null;
    }
  } catch { /* non-critical — proceed without enrichment */ }

  // Fetch last 5 conversation turns for memory (if conversation_id provided)
  const conversationId = req.body?.conversation_id || null;
  let memory = [];
  if (conversationId) {
    try {
      const { rows } = await pool.query(
        `SELECT role, content FROM ai_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [conversationId]
      );
      memory = rows.reverse(); // chronological order
    } catch { /* non-critical */ }
  }

  return new AgentContext({
    userId:          user.id,
    userRole:        user.role,
    userName:        user.name || null,
    branchId,
    trainerId,
    memberId,
    conversationId,
    sessionId:       req.body?.session_id || null,
    originalMessage: (req.body?.message || '').trim(),
    parsedIntent:    null,
    entities:        {},
    memory,
    ipAddress:       req.ip || req.headers?.['x-forwarded-for'] || null,
    requestId:       randomUUID(),
    ...overrides,
  });
}

module.exports = { buildContext };

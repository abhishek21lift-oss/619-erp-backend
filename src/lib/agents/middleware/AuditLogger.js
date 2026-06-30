'use strict';
const pool   = require('../../../db/pool');
const logger = require('../../logger');

/**
 * Immutable audit trail for every agent tool call.
 * Writes to agent_audit_log.  Never throws — logging failures must not break execution.
 */
const AuditLogger = {
  async log({
    taskId,
    agentName,
    toolName,
    action,
    entityType,
    entityId,
    params,
    result,
    status = 'success',
    error,
    userId,
    ipAddress,
  }) {
    try {
      await pool.query(
        `INSERT INTO agent_audit_log
           (task_id, agent_name, tool_name, action, entity_type, entity_id,
            params, result, status, error_message, user_id, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          taskId    || null,
          agentName || 'unknown',
          toolName  || null,
          action    || null,
          entityType || null,
          entityId   ? String(entityId) : null,
          params  ? JSON.stringify(params)  : null,
          result  ? JSON.stringify(result)  : null,
          status,
          error   || null,
          userId  || null,
          ipAddress || null,
        ]
      );
    } catch (err) {
      logger.error({ err: err.message }, 'agent_audit_log_insert_failed');
    }
  },
};

module.exports = { AuditLogger };

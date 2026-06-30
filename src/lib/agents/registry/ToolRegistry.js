'use strict';
const { z } = require('zod');
const { AgentError } = require('../base/AgentError');
const { AuditLogger } = require('../middleware/AuditLogger');

/**
 * Singleton registry mapping tool names → { fn, schema, requiredRoles, isWriteAction }.
 * Called by agents to execute named tools with automatic:
 *  - Input schema validation (Zod)
 *  - Permission check (role-based)
 *  - Audit trail (agent_audit_log)
 */
class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  /**
   * Register a tool.
   * @param {string} name - Unique tool identifier (e.g. 'attendance.getAbsentees')
   * @param {Function} fn - async (params, context) => result
   * @param {z.ZodSchema} schema - Zod schema for input params
   * @param {string[]} requiredRoles - Roles allowed to call this tool ([] = all authenticated)
   * @param {boolean} isWriteAction - Whether this tool mutates state (triggers confirmation)
   */
  register(name, fn, schema, requiredRoles = [], isWriteAction = false) {
    if (this._tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this._tools.set(name, { fn, schema, requiredRoles, isWriteAction });
    return this;
  }

  /**
   * Call a tool by name.  Validates params, checks permissions, executes, logs audit.
   * @param {string} name
   * @param {object} params
   * @param {AgentContext} context
   * @param {string} agentName - Name of the calling agent (for audit log)
   * @param {string} [taskId] - Agent task id (for audit log)
   */
  async call(name, params, context, agentName, taskId) {
    const tool = this._tools.get(name);
    if (!tool) {
      throw AgentError.toolFailed(name, `Tool "${name}" is not registered`);
    }

    // Permission check
    if (tool.requiredRoles.length > 0 && !tool.requiredRoles.includes(context.userRole)) {
      await AuditLogger.log({
        taskId, agentName, toolName: name,
        action: 'call', params, result: null,
        status: 'failed', error: 'PERMISSION_DENIED',
        userId: context.userId, ipAddress: context.ipAddress,
      });
      throw AgentError.permissionDenied(
        `Role "${context.userRole}" cannot call tool "${name}". Required: ${tool.requiredRoles.join(', ')}`
      );
    }

    // Input validation
    let validatedParams = params;
    if (tool.schema) {
      const parsed = tool.schema.safeParse(params);
      if (!parsed.success) {
        const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        throw AgentError.validationFailed(`Tool "${name}" input invalid: ${msg}`);
      }
      validatedParams = parsed.data;
    }

    // Execute
    let result;
    let status = 'success';
    let errorMsg;
    try {
      result = await tool.fn(validatedParams, context);
    } catch (err) {
      status   = 'failed';
      errorMsg = err.message;
      await AuditLogger.log({
        taskId, agentName, toolName: name,
        action: 'call', params: validatedParams, result: null,
        status, error: errorMsg,
        userId: context.userId, ipAddress: context.ipAddress,
      });
      throw AgentError.toolFailed(name, `Tool "${name}" execution failed: ${err.message}`, { cause: err });
    }

    await AuditLogger.log({
      taskId, agentName, toolName: name,
      action: 'call', params: validatedParams, result,
      status, userId: context.userId, ipAddress: context.ipAddress,
    });

    return result;
  }

  get(name)  { return this._tools.get(name) || null; }
  list()     { return Array.from(this._tools.keys()); }
  isWrite(name) { return this._tools.get(name)?.isWriteAction || false; }
}

const toolRegistry = new ToolRegistry();
module.exports = { ToolRegistry, toolRegistry };

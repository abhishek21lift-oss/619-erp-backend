'use strict';
const { AgentError } = require('./AgentError');

/**
 * Abstract base class for every agent at all 3 levels.
 * All subclasses must implement the contract methods below.
 *
 * Lifecycle for READ agents:
 *   execute() → validate() → perform() → summarize()
 *
 * Lifecycle for WRITE agents:
 *   execute() → validate() → plan() → [return requires_confirmation]
 *   → (after user confirms) → perform() → summarize()
 *   → (on failure) → rollback()
 */
class AgentBase {
  constructor(name, description) {
    if (new.target === AgentBase) throw new Error('AgentBase is abstract');
    this.name        = name;
    this.description = description;
    this.isWriteAgent = false; // override in write agents
  }

  /**
   * Main entry point.  Returns:
   *   { status: 'completed', result, summary }  — read-only or after confirmed write
   *   { status: 'requires_confirmation', plan, confirmationToken }  — write action pending
   *   { status: 'failed', error }  — unrecoverable failure
   */
  async execute(context) {
    throw new AgentError('NOT_IMPLEMENTED', `${this.name}.execute() not implemented`);
  }

  /**
   * Validate inputs before any action.  Throws AgentError on failure.
   */
  async validate(context) {
    // Default: no-op (subclasses add domain validation)
  }

  /**
   * For write agents: return a human-readable structured plan describing
   * exactly what will happen.  Used to ask the user for confirmation.
   * Returns: { actions: [{type, description, entity_type, entity_id, params}], summary }
   */
  async plan(context) {
    throw new AgentError('NOT_IMPLEMENTED', `${this.name}.plan() not implemented for write agent`);
  }

  /**
   * Chain-of-thought reasoning string explaining why this action is appropriate.
   */
  async reason(context) {
    return `${this.name} acting on: "${context.originalMessage}"`;
  }

  /**
   * Actually perform the action (called after validation and — for write agents — confirmation).
   * Returns the raw result object.
   */
  async perform(context) {
    throw new AgentError('NOT_IMPLEMENTED', `${this.name}.perform() not implemented`);
  }

  /**
   * Best-effort undo for write agents.  Called on downstream failure after partial execution.
   * Must not throw — log and return.
   */
  async rollback(context, partialResult) {
    // Default: no-op (subclasses override for reversible writes)
  }

  /**
   * Human-readable one-sentence summary of the result.
   */
  summarize(result) {
    return `${this.name} completed successfully.`;
  }
}

module.exports = { AgentBase };

'use strict';

/**
 * Singleton registry mapping agent names → AgentBase subclass instances.
 * Agents are registered once at startup and shared across requests (stateless).
 */
class AgentRegistry {
  constructor() {
    this._agents = new Map();
  }

  /**
   * Register an agent instance.
   * @param {string} name - Unique agent identifier (e.g. 'attendance.checkin')
   * @param {AgentBase} instance - Instantiated agent
   */
  register(name, instance) {
    if (this._agents.has(name)) {
      throw new Error(`Agent "${name}" is already registered`);
    }
    this._agents.set(name, instance);
    return this;
  }

  /**
   * Retrieve an agent by name.  Returns null if not found.
   */
  get(name) {
    return this._agents.get(name) || null;
  }

  /**
   * Returns an array of all registered agent descriptors.
   */
  list() {
    return Array.from(this._agents.entries()).map(([name, agent]) => ({
      name,
      description: agent.description,
      isWriteAgent: agent.isWriteAgent,
    }));
  }

  /**
   * Returns all agents whose name starts with the given prefix (e.g. 'attendance.').
   */
  getByDepartment(department) {
    const prefix = department.toLowerCase() + '.';
    return Array.from(this._agents.entries())
      .filter(([name]) => name.startsWith(prefix))
      .map(([, agent]) => agent);
  }
}

// Export a single shared instance
const registry = new AgentRegistry();
module.exports = { AgentRegistry, registry };

'use strict';
const { randomUUID } = require('crypto');

/**
 * Immutable context passed to every agent at every level.
 * Created once at the API boundary (ContextBuilder) and passed through unchanged.
 */
class AgentContext {
  constructor({
    userId,
    userRole,
    branchId,
    userName,
    trainerId,
    memberId,
    conversationId,
    sessionId,
    originalMessage,
    parsedIntent,
    entities,
    memory,
    ipAddress,
    requestId,
    taskId,
    plan,
    confirmationToken,
  }) {
    const id             = requestId || randomUUID();
    this.userId          = userId;
    this.userRole        = userRole;
    this.branchId        = branchId     || null;
    this.userName        = userName     || null;
    this.trainerId       = trainerId    || null;
    this.memberId        = memberId     || null;
    this.conversationId  = conversationId || null;
    this.sessionId       = sessionId    || null;
    this.originalMessage = originalMessage || '';
    this.parsedIntent    = parsedIntent || null;
    this.entities        = entities     || {};
    this.memory          = memory       || [];
    this.ipAddress       = ipAddress    || null;
    this.requestId       = id;
    this.taskId          = taskId       || id;
    this.plan            = plan         || null;
    this.confirmationToken = confirmationToken || null;
    this.timestamp       = new Date().toISOString();
    Object.freeze(this);
  }

  /** Returns a new context with updated fields (immutable update). */
  with(overrides) {
    return new AgentContext({ ...this, ...overrides, requestId: this.requestId, taskId: this.taskId });
  }

  isAdmin()     { return this.userRole === 'admin'; }
  isManager()   { return this.userRole === 'manager' || this.isAdmin(); }
  isTrainer()   { return this.userRole === 'trainer'; }
  isStaff()     { return this.userRole === 'staff' || this.isManager(); }
  isReception() { return this.userRole === 'reception' || this.userRole === 'receptionist' || this.isStaff(); }
  isMember()    { return this.userRole === 'member'; }
}

module.exports = { AgentContext };

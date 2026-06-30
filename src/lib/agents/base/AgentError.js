'use strict';

const CODES = {
  PERMISSION_DENIED:       'PERMISSION_DENIED',
  VALIDATION_FAILED:       'VALIDATION_FAILED',
  TOOL_FAILED:             'TOOL_FAILED',
  ENTITY_NOT_FOUND:        'ENTITY_NOT_FOUND',
  REQUIRES_CONFIRMATION:   'REQUIRES_CONFIRMATION',
  CONFIRMATION_EXPIRED:    'CONFIRMATION_EXPIRED',
  CONFIRMATION_REJECTED:   'CONFIRMATION_REJECTED',
  INTENT_UNCLEAR:          'INTENT_UNCLEAR',
  RATE_LIMIT_EXCEEDED:     'RATE_LIMIT_EXCEEDED',
  ALL_AGENTS_FAILED:       'ALL_AGENTS_FAILED',
  ROLLBACK_FAILED:         'ROLLBACK_FAILED',
};

class AgentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name      = 'AgentError';
    this.code      = code;
    this.details   = details;
    this.isAgent   = true;
  }

  static permissionDenied(msg, details)     { return new AgentError(CODES.PERMISSION_DENIED,     msg || 'Permission denied',           details); }
  static validationFailed(msg, details)     { return new AgentError(CODES.VALIDATION_FAILED,     msg || 'Validation failed',           details); }
  static toolFailed(tool, msg, details)     { return new AgentError(CODES.TOOL_FAILED,           msg || `Tool ${tool} failed`,         { tool, ...details }); }
  static entityNotFound(type, id)           { return new AgentError(CODES.ENTITY_NOT_FOUND,      `${type} not found`,                  { entity_type: type, entity_id: id }); }
  static requiresConfirmation(plan, token)  { return new AgentError(CODES.REQUIRES_CONFIRMATION, 'Action requires confirmation',       { plan, confirmation_token: token }); }
  static confirmationExpired()              { return new AgentError(CODES.CONFIRMATION_EXPIRED,  'Confirmation token expired or used'); }
  static confirmationRejected()             { return new AgentError(CODES.CONFIRMATION_REJECTED, 'Action cancelled by user'); }
  static intentUnclear(msg)                 { return new AgentError(CODES.INTENT_UNCLEAR,        msg || 'Intent is unclear'); }
  static rateLimitExceeded()                { return new AgentError(CODES.RATE_LIMIT_EXCEEDED,   'Rate limit exceeded — try again later'); }
  static allAgentsFailed(primary, fallback) { return new AgentError(CODES.ALL_AGENTS_FAILED,     'All agents failed',                  { primary_error: primary, fallback_error: fallback }); }
}

module.exports = { AgentError, CODES };

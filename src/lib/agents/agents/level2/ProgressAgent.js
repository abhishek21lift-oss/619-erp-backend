'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');

class ProgressAgent extends AgentBase {
  constructor() {
    super('progress', 'Fetches client progress: assessments, check-ins, and strength logs');
  }

  async execute(context) {
    const msg  = context.originalMessage.toLowerCase();
    const ents = context.entities;

    if (!ents.client_id) {
      return { status: 'needs_info', message: 'Which client\'s progress would you like to see?', missing_fields: ['client_id'] };
    }
    if (msg.includes('assessment') || msg.includes('body') || msg.includes('weight')) {
      const result = await toolRegistry.call('progress.getAssessments', { client_id: ents.client_id }, context, this.name, context.taskId);
      return { status: 'completed', result, summary: `${result.count} assessment(s) found for client.` };
    }
    // Default: full summary
    const result = await toolRegistry.call('progress.getSummary', { client_id: ents.client_id }, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `Progress summary for ${result.client?.name || 'client'} — ${result.sessions_total} total sessions.`,
    };
  }

  async perform(context) { return this.execute(context); }

  summarize(result) {
    if (result?.sessions_total !== undefined) return `Progress summary: ${result.sessions_total} sessions completed.`;
    if (result?.count !== undefined)          return `${result.count} record(s) found.`;
    return 'Progress lookup complete.';
  }
}

module.exports = { ProgressAgent };

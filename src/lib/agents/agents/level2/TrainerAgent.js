'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');
const { randomUUID }   = require('crypto');

class TrainerAgent extends AgentBase {
  constructor() {
    super('trainer', 'Manages trainer operations, assignment, and performance stats');
    this.isWriteAgent = false;
  }

  async execute(context) {
    const msg  = context.originalMessage.toLowerCase();
    const ents = context.entities;

    if (ents.action === 'assign' || msg.includes('assign')) {
      this.isWriteAgent = true;
      return this._planAssignment(context);
    }
    if (msg.includes('performance') || msg.includes('stats') || msg.includes('revenue') || msg.includes('earned')) {
      return this._handleStats(context);
    }
    return this._handleList(context);
  }

  async _planAssignment(context) {
    const ents = context.entities;
    const plan = {
      actions: [{
        type:        'write',
        description: `Assign trainer ${ents.trainer_name || '?'} to client ${ents.client_name || '?'}`,
        tool:        'trainer.assign',
        params:      { client_id: ents.client_id, trainer_id: ents.trainer_id },
      }],
      summary: `Assign trainer ${ents.trainer_name || '?'} to ${ents.client_name || 'client'}`,
    };
    return { status: 'requires_confirmation', plan, confirmationToken: randomUUID() };
  }

  async _handleStats(context) {
    const ents = context.entities;
    if (ents.trainer_id) {
      const result = await toolRegistry.call('trainer.getStats', { trainer_id: ents.trainer_id }, context, this.name, context.taskId);
      return { status: 'completed', result, summary: `Trainer stats for ${result.trainer.name}: ${result.sessions.total_sessions} sessions, ₹${result.revenue.total_revenue} revenue.` };
    }
    // All trainers revenue
    const result = await toolRegistry.call('finance.getTrainerRevenue', {}, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: result.trainers[0]
        ? `Top trainer: ${result.trainers[0].trainer_name} (₹${Number(result.trainers[0].revenue).toLocaleString('en-IN')})`
        : 'No trainer revenue data.',
    };
  }

  async _handleList(context) {
    const result = await toolRegistry.call('trainer.list', {}, context, this.name, context.taskId);
    return { status: 'completed', result, summary: `${result.count} active trainer(s).` };
  }

  async perform(context) {
    const ents = context.entities;
    return toolRegistry.call('trainer.assign', {
      client_id:  ents.client_id,
      trainer_id: ents.trainer_id,
    }, context, this.name, context.taskId);
  }

  summarize(result) {
    if (result?.success)       return `Trainer ${result.trainer_name} assigned to ${result.client_name}.`;
    if (result?.count !== undefined) return `${result.count} trainer(s) found.`;
    return 'Trainer operation completed.';
  }
}

module.exports = { TrainerAgent };

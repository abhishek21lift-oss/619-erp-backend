'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');

class AICoachAgent extends AgentBase {
  constructor() {
    super('aicoach', 'Generates personalised workout and diet plans for PT clients');
  }

  async execute(context) {
    const msg  = context.originalMessage.toLowerCase();
    const ents = context.entities;

    if (!ents.client_id) {
      return { status: 'needs_info', message: 'Which client would you like a plan for?', missing_fields: ['client_id'] };
    }

    if (msg.includes('diet') || msg.includes('nutrition') || msg.includes('food') || msg.includes('meal')) {
      return this._generateDiet(context);
    }
    // Default: workout
    return this._generateWorkout(context);
  }

  async _generateWorkout(context) {
    const ents   = context.entities;
    const result = await toolRegistry.call('aicoach.generateWorkout', {
      client_id: ents.client_id,
      goal:      ents.notes || context.originalMessage,
    }, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `Workout plan generated for ${result.client_name || 'client'}.`,
    };
  }

  async _generateDiet(context) {
    const ents   = context.entities;
    const result = await toolRegistry.call('aicoach.generateDiet', {
      client_id: ents.client_id,
      goal:      ents.notes || context.originalMessage,
    }, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `Diet plan generated for ${result.client_name || 'client'}.`,
    };
  }

  async perform(context) { return this.execute(context); }

  summarize(result) {
    if (result?.plan) return `AI-generated plan ready for ${result.client_name || 'client'}.`;
    return 'AI coaching plan generated.';
  }
}

module.exports = { AICoachAgent };

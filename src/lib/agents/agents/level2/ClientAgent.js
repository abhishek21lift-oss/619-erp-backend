'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');

class ClientAgent extends AgentBase {
  constructor() {
    super('client', 'Handles client search, profile lookup, and health condition queries');
  }

  async execute(context) {
    const msg   = context.originalMessage.toLowerCase();
    const ents  = context.entities;

    if (this._isHealthQuery(msg)) {
      return this._handleHealth(context);
    }
    if (ents.client_name || this._isProfileQuery(msg)) {
      return this._handleSearch(context);
    }
    if (msg.includes('inactive') || msg.includes('lost')) {
      return this._handleInactive(context);
    }
    // Default: search
    return this._handleSearch(context);
  }

  async _handleSearch(context) {
    const query = context.entities.client_name || context.originalMessage;
    const result = await toolRegistry.call('client.search', { query }, context, this.name, context.taskId);
    return { status: 'completed', result, summary: `Found ${result.count} client(s) matching "${query}".` };
  }

  async _handleHealth(context) {
    const msg = context.originalMessage.toLowerCase();
    // Extract condition keyword
    const conditions = ['diabetic','diabetes','hypertension','heart','asthma','injury','injured','overweight','obese'];
    const condition   = conditions.find(c => msg.includes(c)) || msg.match(/with\s+(\w+)/)?.[1] || 'medical condition';

    const result = await toolRegistry.call('client.searchByCondition', { condition }, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `Found ${result.count} client(s) with "${condition}".`,
    };
  }

  async _handleInactive(context) {
    const result = await toolRegistry.call('client.search', { query: '', limit: 50 }, context, this.name, context.taskId);
    return { status: 'completed', result, summary: 'Inactive client search complete.' };
  }

  async perform(context) {
    return this.execute(context);
  }

  summarize(result) {
    if (result?.count !== undefined) return `${result.count} client(s) found.`;
    return 'Client lookup complete.';
  }

  _isHealthQuery(msg) {
    return msg.includes('diabetic') || msg.includes('medical') || msg.includes('condition')
        || msg.includes('injury') || msg.includes('hypertension') || msg.includes('obese')
        || msg.includes('overweight') || msg.includes('health');
  }

  _isProfileQuery(msg) {
    return msg.includes('profile') || msg.includes('details') || msg.includes('info') || msg.includes('show');
  }
}

module.exports = { ClientAgent };

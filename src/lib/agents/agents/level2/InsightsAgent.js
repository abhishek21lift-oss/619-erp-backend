'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');

class InsightsAgent extends AgentBase {
  constructor() {
    super('insights', 'Fetches business insights: revenue trends, retention, and performance stats');
  }

  async execute(context) {
    const msg = context.originalMessage.toLowerCase();

    if (msg.includes('trend') || msg.includes('monthly') || msg.includes('over time') || msg.includes('growth')) {
      return this._handleRevenueTrend(context);
    }
    if (msg.includes('retention') || msg.includes('churn') || msg.includes('drop') || msg.includes('inactive')) {
      return this._handleRetention(context);
    }
    // Default: full business snapshot
    return this._handleSnapshot(context);
  }

  async _handleSnapshot(context) {
    const result = await toolRegistry.call('insights.getBusinessSnapshot', {}, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `Business snapshot: ₹${Number(result.revenue?.total_revenue || 0).toLocaleString('en-IN')} revenue, ${result.clients?.active_clients || 0} active clients.`,
    };
  }

  async _handleRevenueTrend(context) {
    const ents   = context.entities;
    const months = ents.count || 6;
    const result = await toolRegistry.call('insights.getRevenueTrend', { months }, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `Revenue trend over ${months} months — ${result.trend?.length || 0} data points.`,
    };
  }

  async _handleRetention(context) {
    const result = await toolRegistry.call('insights.getRetentionStats', {}, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `Retention: ${result.active_count || 0} active, ${result.inactive_count || 0} inactive clients.`,
    };
  }

  async perform(context) { return this.execute(context); }

  summarize(result) {
    if (result?.revenue)         return `Revenue: ₹${Number(result.revenue.total_revenue || 0).toLocaleString('en-IN')}.`;
    if (result?.trend?.length)   return `Revenue trend: ${result.trend.length} months of data.`;
    if (result?.active_count !== undefined) return `${result.active_count} active clients.`;
    return 'Business insights fetched.';
  }
}

module.exports = { InsightsAgent };

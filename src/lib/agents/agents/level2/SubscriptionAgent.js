'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');
const { randomUUID }   = require('crypto');

class SubscriptionAgent extends AgentBase {
  constructor() {
    super('subscription', 'Manages PT subscriptions, renewals, and expiry tracking');
    this.isWriteAgent = false;
  }

  async execute(context) {
    const msg  = context.originalMessage.toLowerCase();
    const ents = context.entities;

    if (ents.action === 'renew' || msg.includes('renew') || msg.includes('renewal')) {
      this.isWriteAgent = true;
      return this._planRenewal(context);
    }
    if (msg.includes('expir') || msg.includes('ending soon') || msg.includes('due for renewal')) {
      return this._handleExpiring(context);
    }
    if (ents.client_id || ents.client_name) {
      return this._handleClientHistory(context);
    }
    return this._handleExpiring(context);
  }

  async _planRenewal(context) {
    const ents = context.entities;
    const plan = {
      actions: [{
        type:        'write',
        description: `Renew subscription for ${ents.client_name || 'client'} — ${ents.duration_months || '?'} months at ₹${ents.amount || '?'}`,
        tool:        'subscription.renew',
        params: {
          client_id:       ents.client_id,
          duration_months: ents.duration_months,
          final_amount:    ents.amount,
          paid_amount:     ents.amount,
          notes:           ents.notes || null,
        },
      }],
      summary: `Renew ${ents.client_name || 'client'} for ${ents.duration_months || '?'} months (₹${ents.amount || '?'})`,
    };
    return { status: 'requires_confirmation', plan, confirmationToken: randomUUID() };
  }

  async _handleExpiring(context) {
    const ents   = context.entities;
    const days   = ents.count || 7;
    const result = await toolRegistry.call('subscription.getExpiring', { days }, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `${result.count} clients have subscriptions expiring within ${result.expiring_within_days} days.`,
    };
  }

  async _handleClientHistory(context) {
    const ents = context.entities;
    const result = await toolRegistry.call('subscription.getHistory', { client_id: ents.client_id }, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `${result.subscriptions.length} subscription records found.`,
    };
  }

  async perform(context) {
    const ents = context.entities;
    return toolRegistry.call('subscription.renew', {
      client_id:       ents.client_id,
      duration_months: ents.duration_months,
      final_amount:    ents.amount,
      paid_amount:     ents.amount,
      notes:           ents.notes || null,
    }, context, this.name, context.taskId);
  }

  summarize(result) {
    if (result?.count !== undefined) return `${result.count} subscriptions expiring soon.`;
    if (result?.success)             return `Subscription renewed. New end date: ${result.new_end_date}.`;
    return 'Subscription operation completed.';
  }
}

module.exports = { SubscriptionAgent };

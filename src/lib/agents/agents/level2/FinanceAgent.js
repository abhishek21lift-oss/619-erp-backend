'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');
const { randomUUID }   = require('crypto');

class FinanceAgent extends AgentBase {
  constructor() {
    super('finance', 'Handles revenue queries, dues, payment recording, and financial reports');
    this.isWriteAgent = false;
  }

  async execute(context) {
    const msg  = context.originalMessage.toLowerCase();
    const ents = context.entities;

    // Write: record payment
    if (ents.action === 'pay' || msg.includes('record payment') || msg.includes('paid')) {
      this.isWriteAgent = true;
      return this._planPayment(context);
    }
    if (msg.includes('due') || msg.includes("didn't pay") || msg.includes('unpaid') || msg.includes('outstanding')) {
      return this._handleDues(context);
    }
    if (msg.includes('revenue') || msg.includes('earning') || msg.includes('income')) {
      return this._handleRevenue(context);
    }
    if (msg.includes('trainer') && (msg.includes('revenue') || msg.includes('earned') || msg.includes('highest'))) {
      return this._handleTrainerRevenue(context);
    }
    return this._handleRevenue(context);
  }

  async _planPayment(context) {
    const ents = context.entities;
    const plan = {
      actions: [{
        type:        'write',
        description: `Record payment of ₹${ents.amount || '?'} for ${ents.client_name || 'client'} via ${ents.payment_mode || 'cash'}`,
        tool:        'finance.recordPTPayment',
        params:      {
          client_id:    ents.client_id,
          amount:       ents.amount,
          payment_mode: ents.payment_mode || 'cash',
          notes:        ents.notes || null,
          date:         ents.date  || null,
        },
      }],
      summary: `Record PT payment of ₹${ents.amount || '?'} for ${ents.client_name || 'client'}`,
    };
    return { status: 'requires_confirmation', plan, confirmationToken: randomUUID() };
  }

  async _handleDues(context) {
    const result = await toolRegistry.call('finance.getDues', {}, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `${result.clients_with_dues} clients have outstanding dues totalling ₹${Number(result.total_outstanding).toLocaleString('en-IN')}.`,
    };
  }

  async _handleRevenue(context) {
    const ents = context.entities;
    const result = await toolRegistry.call('finance.getRevenue', {
      from: ents.date || undefined,
    }, context, this.name, context.taskId);
    return {
      status:  'completed',
      result,
      summary: `Total revenue: ₹${Number(result.combined_total).toLocaleString('en-IN')} for period ${result.period.from} to ${result.period.to}.`,
    };
  }

  async _handleTrainerRevenue(context) {
    const result = await toolRegistry.call('finance.getTrainerRevenue', {}, context, this.name, context.taskId);
    const top    = result.trainers[0];
    return {
      status:  'completed',
      result,
      summary: top
        ? `Top trainer: ${top.trainer_name} with ₹${Number(top.revenue).toLocaleString('en-IN')} revenue.`
        : 'No trainer revenue data found.',
    };
  }

  async perform(context) {
    const ents = context.entities;
    const result = await toolRegistry.call('finance.recordPTPayment', {
      client_id:    ents.client_id,
      amount:       ents.amount,
      payment_mode: ents.payment_mode || 'cash',
      notes:        ents.notes || null,
      date:         ents.date  || null,
    }, context, this.name, context.taskId);
    return result;
  }

  summarize(result) {
    if (result?.clients_with_dues !== undefined) return `${result.clients_with_dues} clients owe a total of ₹${Number(result.total_outstanding).toLocaleString('en-IN')}.`;
    if (result?.combined_total    !== undefined) return `Revenue: ₹${Number(result.combined_total).toLocaleString('en-IN')}.`;
    if (result?.payment?.id)                     return `Payment of ₹${result.payment.amount} recorded successfully.`;
    return 'Finance operation completed.';
  }
}

module.exports = { FinanceAgent };

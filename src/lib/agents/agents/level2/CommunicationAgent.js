'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');
const { randomUUID }   = require('crypto');

class CommunicationAgent extends AgentBase {
  constructor() {
    super('communication', 'Sends WhatsApp messages, emails, and bulk reminders');
    this.isWriteAgent = true;
  }

  async execute(context) {
    const msg  = context.originalMessage.toLowerCase();
    const ents = context.entities;

    if (msg.includes('bulk') || msg.includes('all') || msg.includes('everyone')) {
      return this._planBulk(context);
    }
    if (msg.includes('reminder') || msg.includes('remind')) {
      return this._planReminder(context);
    }
    if (ents.client_id || ents.client_name) {
      return this._planIndividual(context);
    }
    return this._planReminder(context);
  }

  async _planIndividual(context) {
    const ents = context.entities;
    const message = ents.message_text || `Hi ${ents.client_name || 'there'}, this is a message from 619 Fitness Studio.`;
    const plan = {
      actions: [{
        type:        'write',
        description: `Send WhatsApp to ${ents.client_name || 'client'}: "${message.slice(0, 80)}..."`,
        tool:        'communication.sendWhatsApp',
        params:      { client_id: ents.client_id, message },
      }],
      summary: `Send WhatsApp message to ${ents.client_name || 'client'}`,
    };
    return { status: 'requires_confirmation', plan, confirmationToken: randomUUID() };
  }

  async _planBulk(context) {
    const ents    = context.entities;
    const message = ents.message_text || 'Message from 619 Fitness Studio.';
    const plan = {
      actions: [{
        type:        'write',
        description: `Send bulk WhatsApp to all clients: "${message.slice(0, 80)}..."`,
        tool:        'communication.sendBulkWhatsApp',
        params:      { message },
      }],
      summary: `Broadcast WhatsApp to all active clients`,
    };
    return { status: 'requires_confirmation', plan, confirmationToken: randomUUID() };
  }

  async _planReminder(context) {
    const msg    = context.originalMessage.toLowerCase();
    const type   = msg.includes('due') || msg.includes('payment') ? 'dues'
                 : msg.includes('expir') || msg.includes('renewal') ? 'expiry'
                 : 'dues';
    const plan = {
      actions: [{
        type:        'write',
        description: `Send ${type} reminders via WhatsApp to eligible clients`,
        tool:        'communication.sendReminder',
        params:      { type },
      }],
      summary: `Send ${type} reminder messages to relevant clients`,
    };
    return { status: 'requires_confirmation', plan, confirmationToken: randomUUID() };
  }

  async perform(context) {
    const ents = context.entities;
    const msg  = context.originalMessage.toLowerCase();

    if (msg.includes('reminder') || msg.includes('remind')) {
      const type = msg.includes('due') ? 'dues' : 'expiry';
      return toolRegistry.call('communication.sendReminder', { type }, context, this.name, context.taskId);
    }
    if (msg.includes('bulk') || msg.includes('all')) {
      return toolRegistry.call('communication.sendBulkWhatsApp', {
        message: ents.message_text || 'Message from 619 Fitness Studio.',
      }, context, this.name, context.taskId);
    }
    return toolRegistry.call('communication.sendWhatsApp', {
      client_id: ents.client_id,
      message:   ents.message_text || 'Message from 619 Fitness Studio.',
    }, context, this.name, context.taskId);
  }

  summarize(result) {
    if (result?.sent !== undefined) return `Sent ${result.sent} message(s) (${result.failed || 0} failed).`;
    if (result?.success)            return `Message sent successfully.`;
    return 'Communication task completed.';
  }
}

module.exports = { CommunicationAgent };

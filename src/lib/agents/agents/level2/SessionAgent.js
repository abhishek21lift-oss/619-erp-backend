'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');
const { randomUUID }   = require('crypto');

class SessionAgent extends AgentBase {
  constructor() {
    super('session', 'Books, lists, and cancels PT sessions');
    this.isWriteAgent = false;
  }

  async execute(context) {
    const msg  = context.originalMessage.toLowerCase();
    const ents = context.entities;

    if (ents.action === 'book' || msg.includes('book') || msg.includes('schedule')) {
      this.isWriteAgent = true;
      return this._planBooking(context);
    }
    if (ents.action === 'cancel' || msg.includes('cancel')) {
      this.isWriteAgent = true;
      return this._planCancellation(context);
    }
    if (msg.includes('schedule') || msg.includes("today's") || msg.includes('upcoming')) {
      return this._handleSchedule(context);
    }
    return this._handleList(context);
  }

  async _planBooking(context) {
    const ents = context.entities;
    const plan = {
      actions: [{
        type:        'write',
        description: `Book PT session for ${ents.client_name || 'client'} with ${ents.trainer_name || 'trainer'} on ${ents.date || '?'} at ${ents.time || '?'}`,
        tool:        'session.book',
        params: {
          client_id:  ents.client_id,
          trainer_id: ents.trainer_id,
          date:       ents.date,
          time:       ents.time,
        },
      }],
      summary: `Book PT session on ${ents.date || '?'} at ${ents.time || '?'}`,
    };
    return { status: 'requires_confirmation', plan, confirmationToken: randomUUID() };
  }

  async _planCancellation(context) {
    const ents = context.entities;
    const plan = {
      actions: [{
        type:        'write',
        description: `Cancel PT session ${ents.session_id || '?'}`,
        tool:        'session.cancel',
        params:      { session_id: ents.session_id },
      }],
      summary: `Cancel PT session`,
    };
    return { status: 'requires_confirmation', plan, confirmationToken: randomUUID() };
  }

  async _handleSchedule(context) {
    const ents   = context.entities;
    const result = await toolRegistry.call('session.getSchedule', {
      date:       ents.date || undefined,
      trainer_id: ents.trainer_id || undefined,
    }, context, this.name, context.taskId);
    return { status: 'completed', result, summary: `${result.count} sessions on ${result.date}.` };
  }

  async _handleList(context) {
    const ents   = context.entities;
    const result = await toolRegistry.call('session.list', {
      date:       ents.date       || undefined,
      client_id:  ents.client_id  || undefined,
      trainer_id: ents.trainer_id || undefined,
    }, context, this.name, context.taskId);
    return { status: 'completed', result, summary: `${result.count} session(s) found.` };
  }

  async perform(context) {
    const ents = context.entities;
    const msg  = context.originalMessage.toLowerCase();

    if (msg.includes('cancel') || ents.action === 'cancel') {
      return toolRegistry.call('session.cancel', { session_id: ents.session_id }, context, this.name, context.taskId);
    }
    return toolRegistry.call('session.book', {
      client_id:  ents.client_id,
      trainer_id: ents.trainer_id,
      date:       ents.date,
      time:       ents.time,
    }, context, this.name, context.taskId);
  }

  summarize(result) {
    if (result?.success && result?.session) return `Session booked for ${result.client_name} on ${result.session.date}.`;
    if (result?.count !== undefined)         return `${result.count} session(s) found.`;
    return 'Session operation completed.';
  }
}

module.exports = { SessionAgent };

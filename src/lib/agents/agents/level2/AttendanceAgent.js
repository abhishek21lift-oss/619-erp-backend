'use strict';
const { AgentBase }    = require('../../base/AgentBase');
const { toolRegistry } = require('../../registry/ToolRegistry');
const { AuditLogger }  = require('../../middleware/AuditLogger');

class AttendanceAgent extends AgentBase {
  constructor() {
    super('attendance', 'Handles all attendance-related queries and check-in operations');
    this.isWriteAgent = false; // Set dynamically based on action
  }

  async execute(context) {
    const { entities, parsedIntent } = context;
    const action = entities.action || this._inferAction(context.originalMessage);

    // Route to appropriate tool
    if (action === 'checkin') {
      this.isWriteAgent = true;
      return this._handleCheckIn(context);
    }
    if (action === 'checkout') {
      this.isWriteAgent = true;
      return this._handleCheckOut(context);
    }
    if (this._isAbsentQuery(context.originalMessage)) {
      return this._handleAbsentees(context);
    }
    if (this._isReportQuery(context.originalMessage)) {
      return this._handleReport(context);
    }
    // Default: today's attendance
    return this._handleToday(context);
  }

  async _handleToday(context) {
    const result = await toolRegistry.call(
      'attendance.getToday', {}, context, this.name, context.taskId
    );
    return {
      status: 'completed',
      result,
      summary: `Today's attendance: ${result.count} check-ins on ${result.date}.`,
    };
  }

  async _handleAbsentees(context) {
    const date = context.entities.date || undefined;
    const result = await toolRegistry.call(
      'attendance.getAbsentees', { date }, context, this.name, context.taskId
    );
    return {
      status:  'completed',
      result,
      summary: `${result.absent_count} members absent on ${result.date}.`,
    };
  }

  async _handleReport(context) {
    const { date, entities } = context;
    const result = await toolRegistry.call(
      'attendance.getReport',
      { from: entities.date || undefined },
      context, this.name, context.taskId
    );
    return {
      status:  'completed',
      result,
      summary: `Attendance report: ${result.summary.total_checkins} total check-ins, ${result.summary.unique_members} unique members.`,
    };
  }

  async _handleCheckIn(context) {
    const { entities } = context;
    const plan = {
      actions: [{ type: 'write', description: `Check in member (id: ${entities.client_id || 'unknown'})`, tool: 'attendance.checkIn' }],
      summary: `Check in member for today`,
    };
    return { status: 'requires_confirmation', plan };
  }

  async _handleCheckOut(context) {
    const { entities } = context;
    const plan = {
      actions: [{ type: 'write', description: `Check out member (id: ${entities.client_id || 'unknown'})`, tool: 'attendance.checkOut' }],
      summary: `Check out member`,
    };
    return { status: 'requires_confirmation', plan };
  }

  async perform(context) {
    const { entities } = context;
    const action = entities.action || this._inferAction(context.originalMessage);

    if (action === 'checkin') {
      return toolRegistry.call('attendance.checkIn', { ref_id: entities.client_id, method: 'manual' }, context, this.name, context.taskId);
    }
    if (action === 'checkout') {
      return toolRegistry.call('attendance.checkOut', { ref_id: entities.client_id }, context, this.name, context.taskId);
    }
  }

  summarize(result) {
    if (result?.absent_count !== undefined) return `${result.absent_count} members absent.`;
    if (result?.count !== undefined)       return `${result.count} attendance records found.`;
    if (result?.success)                   return `Check-in/out recorded for ${result.ref_name || 'member'}.`;
    return 'Attendance operation completed.';
  }

  _inferAction(message) {
    const lower = message.toLowerCase();
    if (lower.includes('check in') || lower.includes('checkin') || lower.includes('mark present')) return 'checkin';
    if (lower.includes('check out') || lower.includes('checkout')) return 'checkout';
    if (lower.includes('absent') || lower.includes('miss') || lower.includes('no show')) return 'absentees';
    if (lower.includes('report') || lower.includes('summary') || lower.includes('week')) return 'report';
    return 'today';
  }

  _isAbsentQuery(message) {
    const lower = message.toLowerCase();
    return lower.includes('absent') || lower.includes('miss') || lower.includes('no show') || lower.includes("didn't come");
  }

  _isReportQuery(message) {
    const lower = message.toLowerCase();
    return lower.includes('report') || lower.includes('summary') || lower.includes('weekly') || lower.includes('monthly');
  }
}

module.exports = { AttendanceAgent };

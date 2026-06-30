'use strict';
const { AgentBase }         = require('../../base/AgentBase');
const { AgentError }        = require('../../base/AgentError');
const { RateLimiter }       = require('../../middleware/RateLimiter');
const { AuditLogger }       = require('../../middleware/AuditLogger');
const { PermissionValidator }= require('../../middleware/PermissionValidator');
const { detectIntent }      = require('../../utils/IntentDetector');
const { extractEntities }   = require('../../utils/EntityExtractor');
const { buildPlan }         = require('../../utils/ActionPlanner');
const { randomUUID }        = require('crypto');

// Department agent imports
const { AttendanceAgent }    = require('../level2/AttendanceAgent');
const { ClientAgent }        = require('../level2/ClientAgent');
const { TrainerAgent }       = require('../level2/TrainerAgent');
const { SessionAgent }       = require('../level2/SessionAgent');
const { FinanceAgent }       = require('../level2/FinanceAgent');
const { SubscriptionAgent }  = require('../level2/SubscriptionAgent');
const { CommunicationAgent } = require('../level2/CommunicationAgent');
const { ProgressAgent }      = require('../level2/ProgressAgent');
const { InsightsAgent }      = require('../level2/InsightsAgent');
const { AICoachAgent }       = require('../level2/AICoachAgent');

const DEPT_AGENTS = {
  attendance:    AttendanceAgent,
  client:        ClientAgent,
  trainer:       TrainerAgent,
  session:       SessionAgent,
  finance:       FinanceAgent,
  subscription:  SubscriptionAgent,
  communication: CommunicationAgent,
  progress:      ProgressAgent,
  insights:      InsightsAgent,
  aicoach:       AICoachAgent,
};

class CEOAgent extends AgentBase {
  constructor() {
    super('ceo', '619 COMMAND AI — orchestrates all departments to answer natural-language requests');
    this._agents = {};
    for (const [dept, AgentClass] of Object.entries(DEPT_AGENTS)) {
      this._agents[dept] = new AgentClass();
    }
  }

  _getDeptAgent(department) {
    return this._agents[department] || null;
  }

  async execute(context, sseEmit) {
    const emit = typeof sseEmit === 'function' ? sseEmit : () => {};

    // Rate limit check
    try {
      RateLimiter.check(context);
    } catch (err) {
      emit('error', { message: err.message, code: err.code });
      throw err;
    }

    emit('thinking', { message: 'Analysing your request…' });

    // 1. Detect intent + extract entities in parallel
    let intentResult, entities;
    try {
      [intentResult, entities] = await Promise.all([
        detectIntent(context.originalMessage),
        extractEntities(context.originalMessage),
      ]);
    } catch (err) {
      emit('error', { message: 'Could not understand the request. Please rephrase.' });
      throw AgentError.intentUnclear(context.originalMessage);
    }

    const { departments } = intentResult;
    const updatedContext  = context.with({ parsedIntent: intentResult.intent, entities });

    emit('thinking', { message: `Routing to: ${departments.join(', ')}` });

    // 2. Build action plan
    const plan = await buildPlan(departments, entities, context.originalMessage);

    // 3. Permission pre-flight — check first write step
    try {
      if (plan.steps && plan.steps.some(s => s.is_write)) {
        PermissionValidator.requireMinRole(updatedContext, 'staff');
      }
    } catch (err) {
      emit('error', { message: err.message, code: err.code });
      throw err;
    }

    // 4. Check if any step requires confirmation
    const hasWriteSteps = plan.steps.some(s => s.is_write);

    if (hasWriteSteps) {
      const confirmationToken = randomUUID();
      const deptPlans = [];

      for (const step of plan.steps) {
        const agent = this._getDeptAgent(step.department);
        if (!agent) continue;

        const stepCtx = updatedContext.with({ entities: { ...entities, ...step.entities } });
        try {
          const result = await agent.execute(stepCtx);
          if (result.plan) deptPlans.push(...(result.plan.actions || []));
          else if (result.status === 'completed') {
            deptPlans.push({ type: 'read', description: result.summary, department: step.department });
          }
        } catch (err) {
          deptPlans.push({ type: 'error', description: `${step.department}: ${err.message}` });
        }
      }

      const consolidatedPlan = {
        summary:           plan.summary,
        steps:             plan.steps,
        actions:           deptPlans,
        confirmationToken,
        taskId:            updatedContext.taskId,
      };

      emit('requires_confirmation', { plan: consolidatedPlan, confirmationToken });
      return {
        status:            'requires_confirmation',
        plan:              consolidatedPlan,
        confirmationToken,
        taskId:            updatedContext.taskId,
      };
    }

    // 5. Read-only — execute all steps immediately
    emit('thinking', { message: 'Fetching data…' });
    const results = [];

    for (const step of plan.steps) {
      const agent = this._getDeptAgent(step.department);
      if (!agent) {
        results.push({ department: step.department, status: 'skipped', message: 'Unknown department' });
        continue;
      }

      const stepCtx = updatedContext.with({ entities: { ...entities, ...step.entities } });
      try {
        const result = await agent.execute(stepCtx);
        results.push({ department: step.department, ...result });
        emit('action_result', { department: step.department, summary: result.summary });
      } catch (err) {
        results.push({ department: step.department, status: 'failed', error: err.message });
        emit('action_result', { department: step.department, summary: `Error: ${err.message}`, error: true });
      }
    }

    const finalResult = {
      status:  'completed',
      results,
      summary: this._buildSummary(results),
      taskId:  updatedContext.taskId,
    };

    emit('done', finalResult);

    AuditLogger.log({
      taskId:    updatedContext.taskId,
      agentName: this.name,
      toolName:  'ceo.execute',
      action:    'orchestrate',
      params:    { message: context.originalMessage, departments },
      result:    { resultCount: results.length },
      status:    'success',
      userId:    context.userId,
      ipAddress: context.ipAddress,
    }).catch(() => {});

    return finalResult;
  }

  async perform(context, sseEmit) {
    const emit = typeof sseEmit === 'function' ? sseEmit : () => {};

    const { taskId, plan } = context;
    if (!plan) throw AgentError.validationFailed('No plan to execute — missing plan in context');

    emit('thinking', { message: 'Executing approved actions…' });

    const entities = context.entities || {};
    const results  = [];

    for (const step of (plan.steps || [])) {
      if (!step.is_write) continue;

      const agent = this._getDeptAgent(step.department);
      if (!agent) continue;

      const stepCtx = context.with({ entities: { ...entities, ...step.entities } });
      try {
        const result = await agent.perform(stepCtx);
        results.push({ department: step.department, status: 'completed', result });
        emit('action_result', { department: step.department, summary: agent.summarize(result) });

        AuditLogger.log({
          taskId,
          agentName: step.department,
          toolName:  `${step.department}.perform`,
          action:    step.action || 'perform',
          params:    step.entities,
          result,
          status:    'success',
          userId:    context.userId,
          ipAddress: context.ipAddress,
        }).catch(() => {});
      } catch (err) {
        results.push({ department: step.department, status: 'failed', error: err.message });
        emit('action_result', { department: step.department, summary: `Failed: ${err.message}`, error: true });

        AuditLogger.log({
          taskId,
          agentName: step.department,
          toolName:  `${step.department}.perform`,
          action:    step.action || 'perform',
          params:    step.entities,
          result:    null,
          status:    'failed',
          error:     err.message,
          userId:    context.userId,
          ipAddress: context.ipAddress,
        }).catch(() => {});
      }
    }

    const finalResult = {
      status:  'completed',
      results,
      summary: this._buildSummary(results),
      taskId,
    };

    emit('done', finalResult);
    return finalResult;
  }

  _buildSummary(results) {
    const completed = results.filter(r => r.status === 'completed');
    const failed    = results.filter(r => r.status === 'failed');

    if (failed.length === 0 && completed.length === 1) {
      return completed[0].summary || 'Done.';
    }
    const parts = [];
    if (completed.length) parts.push(`${completed.length} operation(s) completed`);
    if (failed.length)    parts.push(`${failed.length} failed`);
    return parts.join(', ') + '.';
  }

  summarize(result) {
    return result?.summary || 'Operation completed.';
  }
}

module.exports = { CEOAgent };

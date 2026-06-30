'use strict';
const { routedChat } = require('../../ai/router');

/**
 * Given a parsed intent + entities, produces a structured execution plan:
 * a sequence of department calls, each with their sub-actions.
 *
 * For simple single-department requests, builds the plan directly.
 * For multi-step requests (like "renew + pay + assign + book + send WhatsApp"),
 * uses LLM to sequence the steps correctly with dependencies.
 */
async function buildPlan(departments, entities, originalMessage) {
  if (departments.length === 1 && !isMultiStep(originalMessage)) {
    return buildSimplePlan(departments[0], entities, originalMessage);
  }
  return buildLLMPlan(departments, entities, originalMessage);
}

function isMultiStep(message) {
  const lower = message.toLowerCase();
  // Heuristic: commas, "and", "also", "then" with 2+ action words suggest multi-step
  const actionWords = ['pay', 'renew', 'book', 'send', 'assign', 'notify', 'cancel', 'create', 'record'];
  const count = actionWords.filter(w => lower.includes(w)).length;
  return count >= 2;
}

function buildSimplePlan(department, entities, message) {
  return {
    type:    'single',
    summary: `Handle "${message}" via ${department} department`,
    steps: [
      {
        order:      1,
        department,
        action:     entities.action || 'execute',
        entities,
        depends_on: [],
        is_write:   isWriteDepartment(department, entities.action),
      },
    ],
  };
}

async function buildLLMPlan(departments, entities, message) {
  const VALID_DEPTS = ['attendance','client','trainer','session','finance',
                       'subscription','communication','progress','aicoach','insights'];

  const systemPrompt = `You are a task planner for a gym management AI system.
Given a user request, break it into ordered steps. Each step calls one department.
Departments: ${VALID_DEPTS.join(', ')}

CRITICAL: Sequence dependencies correctly. Examples:
- "Renew subscription, record payment, send WhatsApp": subscription(1) → finance(2) → communication(3)
- "Assign trainer and book session": trainer(1) → session(2)
- "Find overdue members and send reminder": client(1) → communication(2, depends_on:[1])

Respond ONLY with valid JSON:
{
  "type": "multi",
  "summary": "one sentence description",
  "steps": [
    {
      "order": 1,
      "department": "dept_name",
      "action": "action_name",
      "description": "what this step does",
      "entities": {},
      "depends_on": [],
      "is_write": true/false
    }
  ]
}
No prose, no markdown.`;

  try {
    const result = await routedChat({
      intent:      'audit',
      messages:    [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Message: "${message}"\nDetected departments: ${departments.join(', ')}\nEntities: ${JSON.stringify(entities)}`,
        },
      ],
      temperature: 0.1,
      max_tokens:  600,
    });

    const json = tryParseJSON(result.content);
    if (json?.steps?.length) {
      return json;
    }
  } catch { /* fall through to simple plan */ }

  // Fallback: build sequential plan for all detected departments
  return {
    type:    'multi',
    summary: `Multi-step: "${message}"`,
    steps: departments.map((dept, i) => ({
      order:      i + 1,
      department: dept,
      action:     'execute',
      description: `Handle ${dept} aspect of request`,
      entities,
      depends_on: i === 0 ? [] : [i],
      is_write:   isWriteDepartment(dept, null),
    })),
  };
}

const WRITE_DEPTS = new Set(['finance', 'subscription', 'communication', 'session', 'attendance']);
const WRITE_ACTIONS = new Set(['pay','renew','book','cancel','send','assign','create','record','checkin','checkout']);

function isWriteDepartment(dept, action) {
  if (action && WRITE_ACTIONS.has(action)) return true;
  return WRITE_DEPTS.has(dept);
}

function tryParseJSON(text) {
  try { return JSON.parse(text); } catch { /* ignore */ }
  const m = text.match(/\{[\s\S]+\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

module.exports = { buildPlan };

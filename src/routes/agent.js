'use strict';
// src/routes/agent.js — 619 COMMAND AI agent endpoint
// POST /api/agent/execute  — SSE streaming agent execution
// POST /api/agent/confirm  — Approve or reject a pending write plan
// GET  /api/agent/tasks    — List recent agent tasks
// GET  /api/agent/tasks/:id — Task detail with audit trail

const express  = require('express');
const pool     = require('../db/pool');
const { auth } = require('../middleware/auth');
const logger   = require('../lib/logger');
const { CEOAgent }     = require('../lib/agents/agents/level1/CEOAgent');
const { buildContext } = require('../lib/agents/utils/ContextBuilder');

const router   = express.Router();
const ceoAgent = new CEOAgent();

/* ─── Guard ──────────────────────────────────────────────────────────────── */
function requireConfigured(req, res, next) {
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(501).json({ error: 'AI not configured', message: 'OPENROUTER_API_KEY is not set.' });
  }
  next();
}

/* ─── SSE helpers ────────────────────────────────────────────────────────── */
function startSSE(res) {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function sseWrite(res, event, data) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  }
}

/* ─── Task persistence helpers ───────────────────────────────────────────── */
async function createTask(context, plan) {
  try {
    const res = await pool.query(
      `INSERT INTO agent_tasks
         (id, user_id, session_id, conversation_id, input_text, parsed_intent, parsed_entities,
          status, plan, confirmation_token, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       RETURNING id`,
      [
        context.taskId,
        context.userId,
        context.sessionId || null,
        context.conversationId || null,
        context.originalMessage,
        context.parsedIntent || null,
        context.entities ? JSON.stringify(context.entities) : null,
        plan ? 'awaiting_confirmation' : 'executing',
        plan ? JSON.stringify(plan) : null,
        plan?.confirmationToken || null,
      ],
    );
    return res.rows[0]?.id;
  } catch (err) {
    logger.warn({ err: err.message }, 'agent_task_create_failed');
    return null;
  }
}

async function updateTask(taskId, status, result, error) {
  try {
    await pool.query(
      `UPDATE agent_tasks SET status=$1, result=$2, error=$3, completed_at=NOW() WHERE id=$4`,
      [status, result ? JSON.stringify(result) : null, error || null, taskId],
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'agent_task_update_failed');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. EXECUTE  —  POST /api/agent/execute
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/execute', auth, requireConfigured, async (req, res) => {
  const { message, conversation_id, session_id } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  startSSE(res);

  const context = await buildContext(req, {
    originalMessage: message.trim(),
    conversationId:  conversation_id || null,
    sessionId:       session_id || null,
  });

  sseWrite(res, 'start', { taskId: context.taskId, message });

  // Keepalive every 5 s to survive Render's 30 s timeout
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 5000);

  const emit = (event, data) => sseWrite(res, event, data || {});

  try {
    const result = await ceoAgent.execute(context, emit);

    if (result.status === 'requires_confirmation') {
      await createTask(context.with({ parsedIntent: context.parsedIntent, entities: context.entities }), {
        ...result.plan,
        confirmationToken: result.confirmationToken,
      });
    } else {
      await updateTask(context.taskId, 'completed', result, null);
    }

    if (!res.writableEnded) {
      if (result.status !== 'requires_confirmation') {
        sseWrite(res, 'done', result);
      }
      res.end();
    }
  } catch (err) {
    logger.error({ err: err.message, taskId: context.taskId }, 'agent_execute_error');
    await updateTask(context.taskId, 'failed', null, err.message);
    sseWrite(res, 'error', { message: err.message, code: err.code });
    if (!res.writableEnded) res.end();
  } finally {
    clearInterval(keepalive);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. CONFIRM  —  POST /api/agent/confirm
   ═══════════════════════════════════════════════════════════════════════════ */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/confirm', auth, requireConfigured, async (req, res) => {
  const { task_id, confirmation_token, approved } = req.body || {};
  if (!task_id)            return res.status(400).json({ error: 'task_id is required' });
  if (!confirmation_token) return res.status(400).json({ error: 'confirmation_token is required' });
  // Guard against non-UUID task_id before it hits the UUID-typed Postgres column
  // (Safari throws "The string did not match the expected pattern" on JSON.parse of SSE)
  if (!UUID_RE.test(task_id)) return res.status(400).json({ error: 'task_id must be a valid UUID' });

  // Load pending task
  let taskRow;
  try {
    const result = await pool.query(
      `SELECT * FROM agent_tasks WHERE id=$1 AND user_id=$2 AND status='awaiting_confirmation'`,
      [task_id, req.user.id],
    );
    taskRow = result.rows[0];
  } catch (err) {
    logger.error({ err: err.message }, 'agent_confirm_query_failed');
    return res.status(500).json({ error: 'Database error' });
  }

  if (!taskRow) return res.status(404).json({ error: 'Task not found or not awaiting confirmation' });
  if (taskRow.confirmation_token !== confirmation_token) {
    return res.status(403).json({ error: 'Invalid confirmation token' });
  }

  if (!approved) {
    await updateTask(task_id, 'cancelled', null, 'User rejected the plan');
    return res.json({ status: 'cancelled', message: 'Action cancelled.' });
  }

  // Execute synchronously and return JSON.
  // Previously this used SSE, but the frontend's api.agent.confirm() uses the JSON http()
  // wrapper — calling res.json() on an SSE body throws a SyntaxError in Safari
  // ("The string did not match the expected pattern").
  try {
    await pool.query(`UPDATE agent_tasks SET status='executing' WHERE id=$1`, [task_id]);

    const context = await buildContext(req, {
      originalMessage:   taskRow.input_text,
      conversationId:    taskRow.conversation_id,
      sessionId:         taskRow.session_id,
      taskId:            task_id,
      entities:          taskRow.parsed_entities || {},
      plan:              taskRow.plan,
      confirmationToken: confirmation_token,
    });

    const result = await ceoAgent.perform(context, () => {});
    await updateTask(task_id, 'completed', result, null);

    return res.json({ status: 'completed', summary: result.summary || 'Actions completed.', result });
  } catch (err) {
    logger.error({ err: err.message, taskId: task_id }, 'agent_confirm_execute_error');
    await updateTask(task_id, 'failed', null, err.message);
    return res.status(500).json({ error: err.message, code: err.code });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. TASKS LIST  —  GET /api/agent/tasks
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/tasks', auth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
    const offset = parseInt(req.query.offset || '0',  10);

    const result = await pool.query(
      `SELECT id, input_text, parsed_intent, status, result, error, created_at, completed_at
       FROM agent_tasks WHERE user_id=$1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset],
    );
    res.json({ tasks: result.rows, count: result.rows.length });
  } catch (err) {
    logger.error({ err: err.message }, 'agent_tasks_list_failed');
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. TASK DETAIL  —  GET /api/agent/tasks/:id
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/tasks/:id', auth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id must be a valid UUID' });
  try {
    const [taskRes, auditRes] = await Promise.all([
      pool.query(
        `SELECT * FROM agent_tasks WHERE id=$1 AND user_id=$2`,
        [req.params.id, req.user.id],
      ),
      pool.query(
        `SELECT agent_name, tool_name, action, entity_type, entity_id, params, result, status, error_message, created_at
         FROM agent_audit_log WHERE task_id=$1 ORDER BY created_at ASC`,
        [req.params.id],
      ),
    ]);

    if (!taskRes.rows[0]) return res.status(404).json({ error: 'Task not found' });

    res.json({ task: taskRes.rows[0], audit_trail: auditRes.rows });
  } catch (err) {
    logger.error({ err: err.message }, 'agent_task_detail_failed');
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

module.exports = router;

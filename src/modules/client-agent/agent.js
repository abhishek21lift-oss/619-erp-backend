'use strict';
// The Client Agent orchestrator, consolidated into the ERP backend.
//
//   question ─▶ authorise client ─▶ plan tools ─▶ run tools in-process
//            ─▶ fence results ─▶ build prompt ─▶ central router ─▶ answer
//
// The order is the security design, not a style choice:
//
//   AUTHORISE FIRST. findVisibleClient() is an org-scoped, soft-delete-aware
//   read of pt_clients. A clientId the caller may not see returns 404 before a
//   single tool runs, before a token is spent, and before any client text
//   enters a prompt.
//
//   FENCE BEFORE PROMPTING. Tool output is wrapped with a per-request nonce
//   (lib/ai/agent/untrustedContext.js) and re-neutralised on replay. Client
//   free text — notes, injuries, communication history — is data, never
//   instructions.
//
//   CENTRAL SPEND. The model call goes through lib/ai/router (provider
//   abstraction, DB model overrides, fallback) and the turn is written to
//   ai_usage_log with the authenticated studio. There is no second provider,
//   quota or ledger in this module.
//
// Conversation history is bounded and re-fenced on every turn — see
// buildMessages().

const { planTools, planIntent } = require('../../lib/ai/agent/planner');
const { systemPrompt } = require('../../lib/ai/agent/prompt');
const { newFenceId, buildContextBlock, neutralise } = require('../../lib/ai/agent/untrustedContext');
const { run: runTool } = require('./tools');
const { routedStream } = require('../../lib/ai/router');
const { logUsage } = require('../../lib/ai/usage');
const { usageFields } = require('../../lib/ai/metering');
const read = require('../pt-os/client-read.service');
const { orgIdOf } = require('../../lib/tenant-db');
const logger = require('../../lib/logger');

/** How many prior turns to replay. Enough for "what about his attendance?";
 *  not enough for a prompt that grows until it costs real money. */
const HISTORY_TURNS = 6;

function buildMessages({ system, contextBlock, history, question }) {
  const messages = [{ role: 'system', content: system }];

  // Prior turns are replayed as plain text. The trainer's own past questions
  // are legitimate instructions; past ASSISTANT text is not re-trusted blindly
  // — it may have quoted a malicious note verbatim, and replaying that quote
  // unfenced would smuggle it back outside the fence that contained it.
  for (const turn of (history || []).slice(-HISTORY_TURNS)) {
    if (turn?.role === 'user') {
      messages.push({ role: 'user', content: String(turn.content).slice(0, 4000) });
    } else if (turn?.role === 'assistant') {
      messages.push({ role: 'assistant', content: neutralise(String(turn.content).slice(0, 4000), '') });
    }
  }

  if (contextBlock) messages.push({ role: 'user', content: contextBlock });
  messages.push({ role: 'user', content: question });
  return messages;
}

/**
 * @param {object} o
 * @param {object} o.req              authenticated request (org + user)
 * @param {string} o.clientId
 * @param {string} o.message
 * @param {Array}  [o.history]        [{role, content}], most recent last
 * @param {object} [o.authorised]     {id,name} already resolved by the route
 * @param {function} [o.onDelta]      receives (cumulativeText, provenance)
 * @param {AbortSignal} [o.signal]
 * @param {string} [o.requestId]
 */
async function ask({
  req, clientId, message, history = [], authorised = null,
  onDelta, signal, requestId = null,
}) {
  const started = Date.now();
  const orgId = orgIdOf(req);
  const userId = req.user?.id ?? null;

  // 1. Authorise. Nothing else happens until this passes.
  let client = authorised;
  if (!client) {
    try {
      client = await read.findVisibleClient(orgId, clientId);
    } catch (err) {
      logger.error({ requestId, err: err.message }, 'client_agent_authorise_failed');
      return {
        ok: false, status: 503, code: 'UNAVAILABLE',
        message: 'The assistant is temporarily unavailable. Please try again.',
        toolsUsed: [],
      };
    }
  }
  if (!client) {
    logger.info({ requestId }, 'client_agent_denied');
    return {
      ok: false, status: 404, code: 'CLIENT_NOT_FOUND',
      message: 'Not found, or not visible to you.',
      toolsUsed: [],
    };
  }

  // 2. Plan — deterministic, so cheap questions stay cheap and data-minimal.
  const { tools: planned } = planTools(message);
  const intent = planIntent(message);

  // The profile always runs. It is the authorisation payload in the legacy
  // service and the panel expects it in toolsUsed on every turn.
  const toRun = ['getClientProfile', ...planned.filter((t) => t !== 'getClientProfile')];

  // 3. Retrieve in parallel — independent local reads. Knowledge search takes
  //    the trainer's question; every client tool is addressed by clientId.
  //    The route allows a 2000-char message but a search query is capped at
  //    500 — truncate rather than fail the tool on a long question.
  const results = await Promise.all(toRun.map((name) => runTool({
    name,
    args: name === 'search_knowledge'
      ? { q: String(message).slice(0, 500) }
      : { clientId },
    orgId,
    userId,
    requestId,
  })));

  const okResults = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  // 4. Fence, then prompt.
  const fenceId = newFenceId();
  const contextBlock = buildContextBlock(
    okResults.map((r) => ({ label: r.label, tool: r.tool, data: r.data })),
    fenceId,
  );

  const system = systemPrompt({
    clientName: client.name,
    toolsRun: okResults.map((r) => r.tool),
    toolsFailed: failed.map((r) => r.tool),
  });
  const messages = buildMessages({ system, contextBlock, history, question: message });

  const provenance = {
    clientName: client.name,
    toolsUsed: okResults.map((r) => r.tool),
    toolsUnavailable: failed.map((r) => ({ tool: r.tool, reason: r.message })),
  };

  // 5. Answer through the central router. Collect the generator's RETURN
  //    value manually — `for await` discards it, and it carries the model that
  //    actually answered plus exact token usage.
  let full = '';
  let meta = null;
  try {
    const iterator = routedStream({
      intent,
      messages,
      signal,
      // The fallback notice is a human-readable marker the ERP's own chat
      // streams. This panel renders provider text verbatim; a retry marker
      // would read as part of the answer.
      fallbackNotice: false,
    })[Symbol.asyncIterator]();

    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        meta = step.value;
        break;
      }
      full += step.value;
      if (onDelta) onDelta(full, provenance);
    }
  } catch (err) {
    // The trainer closed the panel mid-answer. There is nobody to deliver a
    // reply to, and reporting usage would bill a studio for one nobody saw.
    if (err?.code === 'AI_ABORTED' || signal?.aborted) {
      logger.info({ requestId }, 'client_agent_client_disconnected');
      return {
        ok: false, status: 499, code: 'CLIENT_DISCONNECTED',
        message: 'The request was cancelled.',
        toolsUsed: provenance.toolsUsed,
      };
    }

    logger.error({ requestId, code: err?.code }, 'client_agent_model_failed');
    return {
      ok: false,
      status: err?.status || 503,
      code: err?.code || 'MODEL_FAILED',
      message: 'The assistant is temporarily unavailable. Please try again.',
      toolsUsed: provenance.toolsUsed,
    };
  }

  // The caller can hang up after the last token but before the ledger write.
  // They saw no completed answer, so they are not billed for one.
  if (signal?.aborted) {
    logger.info({ requestId }, 'client_agent_client_disconnected');
    return {
      ok: false, status: 499, code: 'CLIENT_DISCONNECTED',
      message: 'The request was cancelled.',
      toolsUsed: provenance.toolsUsed,
    };
  }

  const elapsed = Date.now() - started;
  const usage = usageFields(meta?.usage, full);

  // Exactly once: request_id is idempotent at the ledger (ON CONFLICT
  // (request_id, user_id) DO NOTHING). Logging failures never break the answer.
  await logUsage({
    user_id: userId,
    organization_id: orgId,
    model: meta?.model || 'unknown',
    intent_type: 'client_agent',
    ...usage,
    latency_ms: elapsed,
    used_fallback: Boolean(meta?.used_fallback),
    routed_via: meta?.routed_via ?? null,
    request_id: requestId,
  });

  logger.info({
    requestId,
    intent,
    model: meta?.model,
    used_fallback: Boolean(meta?.used_fallback),
    tools_ok: okResults.length,
    tools_failed: failed.length,
    tokens: usage.tokens_prompt + usage.tokens_completion,
    usage_known: usage.usage_source === 'provider',
    latency_ms: elapsed,
  }, 'client_agent_answered');

  return {
    ok: true,
    status: 200,
    message: full,
    clientId,
    clientName: client.name,
    toolsUsed: provenance.toolsUsed,
    toolsUnavailable: provenance.toolsUnavailable,
    // Phase 1 stays read-only; the fields exist so a write is additive.
    proposedAction: null,
    requiresConfirmation: false,
    meta: {
      requestId,
      intent,
      model: meta?.model,
      used_fallback: Boolean(meta?.used_fallback),
      latency_ms: elapsed,
      usage_known: usage.usage_source === 'provider',
    },
  };
}

module.exports = { ask, buildMessages, HISTORY_TURNS };

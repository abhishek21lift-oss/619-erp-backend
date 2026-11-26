'use strict';
// The member assistant orchestrator.
//
// ── Order is the security design ───────────────────────────────────────────
//
//   1. identity from the session (never from the request body)
//   2. deterministic plan (data minimisation)
//   3. resolve the member's one thread
//   4. save the user turn before spending a token
//   5. run self-scoped tools in-process
//   6. fence their output with a per-request nonce
//   7. answer through the central router (one spend path)
//   8. persist the assistant turn only after a complete answer
//   9. write exactly one usage row
//
// A failed or aborted call writes no assistant turn and no usage row: the
// member saw no answer, so the studio is not billed for one.
//
// ── The draft is a proposal ────────────────────────────────────────────────
//
// The model may end its answer with a [[DRAFT]] protocol line. This module
// strips it from the visible text and returns `proposedMessage`; it performs
// no write. The member sends through the existing member ↔ trainer thread
// after reviewing the text.

const { orgIdOf } = require('../../lib/tenant-db');
const logger = require('../../lib/logger');
const { routedStream } = require('../../lib/ai/router');
const { usageFields } = require('../../lib/ai/metering');
const { logUsage } = require('../../lib/ai/usage');
const { memberAssistantPrompt } = require('../../lib/ai/prompts/system');
const {
  newFenceId, buildContextBlock, neutralise,
} = require('../../lib/ai/agent/untrustedContext');
const { planMemberQuestion } = require('./member-ai.planner');
const tools = require('./member-ai.tools');
const { visibleDuringStream, extractDraft } = require('./member-ai.draft');
const thread = require('./member-ai.thread');

/** Prior turns replayed to the model. Bounded so a long thread cannot grow
 *  the prompt without limit; the UI reads more than this separately. */
const HISTORY_TURNS = 6;

const DRAFT_ONLY_REPLY = "I've drafted a message for your trainer — review it below before sending.";
const UNAVAILABLE = 'The assistant is temporarily unavailable. Please try again.';

/**
 * Prompt messages: system instructions, bounded history, one fenced data
 * block, then the member's question.
 *
 * Past assistant text is re-neutralised on replay — it may have quoted a
 * malicious note verbatim, and replaying that quote unfenced would smuggle it
 * back outside the fence that contained it. Same rule as the Client Assistant.
 */
function buildMessages({ system, contextBlock, history, question }) {
  const messages = [{ role: 'system', content: system }];

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

function disconnected(toolsUsed = []) {
  return {
    ok: false,
    status: 499,
    code: 'MEMBER_AI_DISCONNECTED',
    message: 'The request was cancelled.',
    toolsUsed,
  };
}

/**
 * Answer one member turn.
 *
 * @param {object} o
 * @param {object} o.req            authenticated member request
 * @param {string} o.message        validated member message
 * @param {AbortSignal} [o.signal]
 * @param {function} [o.onDelta]    receives (visibleCumulativeText, provenance)
 * @param {string} [o.requestId]
 */
async function ask({ req, message, signal, onDelta, requestId = null }) {
  const started = Date.now();

  // 1. Identity comes only from the session. The route already requires a
  //    member; this is defence in depth for a direct call.
  const clientId = req.user?.pt_client_id ?? null;
  const userId = req.user?.id ?? null;
  if (!clientId) {
    return {
      ok: false,
      status: 403,
      code: 'NO_CLIENT',
      message: 'This area is for client accounts.',
      toolsUsed: [],
    };
  }

  let orgId;
  try {
    orgId = orgIdOf(req);
  } catch {
    return { ok: false, status: 403, code: 'NO_CLIENT', message: 'This area is for client accounts.', toolsUsed: [] };
  }
  if (!userId || !orgId) {
    return { ok: false, status: 401, code: 'UNAUTH', message: 'Please sign in again.', toolsUsed: [] };
  }

  // 2. Deterministic plan — cheap questions stay cheap and data-minimal.
  const plan = planMemberQuestion(message);

  // 3. One thread per member, resolved without an id from the request.
  let conversationId;
  try {
    conversationId = await thread.ensureThread(orgId, userId, clientId, String(message).slice(0, 60));
  } catch (err) {
    logger.error({ requestId, code: err?.code }, 'member_ai_thread_failed');
    return { ok: false, status: 503, code: 'UNAVAILABLE', message: UNAVAILABLE, toolsUsed: [] };
  }
  if (!conversationId) {
    return { ok: false, status: 503, code: 'UNAVAILABLE', message: UNAVAILABLE, toolsUsed: [] };
  }

  // 4. History, then the user turn. The turn survives even if the answer does
  //    not: what the member typed is never lost to a provider failure.
  let history = [];
  try {
    history = await thread.recentMessages(conversationId, HISTORY_TURNS);
    await thread.appendMessage(conversationId, 'user', message);
  } catch (err) {
    logger.error({ requestId, code: err?.code }, 'member_ai_history_failed');
    return { ok: false, status: 503, code: 'UNAVAILABLE', message: UNAVAILABLE, toolsUsed: [] };
  }

  // 5. Tools in-process, in parallel, each addressed by the session ids.
  const today = new Date().toISOString().slice(0, 10);
  const ctx = { clientId, orgId, userId, today };
  const results = await Promise.all(plan.tools.map((name) => tools.run(name, ctx)));
  const okResults = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const toolsUsed = okResults.map((r) => r.tool);
  const toolsUnavailable = failed.map((r) => ({ tool: r.tool, reason: r.message }));

  // 6. Fence before prompting. Tool output is data, never instructions.
  const fenceId = newFenceId();
  const contextBlock = buildContextBlock(
    okResults.map((r) => ({ label: r.label, tool: r.tool, data: r.data })),
    fenceId,
  );
  const messages = buildMessages({
    system: memberAssistantPrompt(),
    history,
    contextBlock,
    question: message,
  });

  const provenance = { toolsUsed, toolsUnavailable };

  // 7. One spend path. Collect the generator's return value manually —
  //    `for await` discards it, and it carries the answering model and usage.
  let full = '';
  let meta = null;
  try {
    const iterator = routedStream({
      intent: plan.intent,
      messages,
      signal,
      // This panel renders provider text verbatim; a retry marker would read
      // as part of the answer.
      fallbackNotice: false,
    })[Symbol.asyncIterator]();

    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        meta = step.value;
        break;
      }
      full += step.value;
      if (onDelta) onDelta(visibleDuringStream(full), provenance);
      if (signal?.aborted) return disconnected(toolsUsed);
    }
  } catch (err) {
    if (err?.code === 'AI_ABORTED' || signal?.aborted) {
      logger.info({ requestId }, 'member_ai_member_disconnected');
      return disconnected(toolsUsed);
    }
    logger.error({ requestId, code: err?.code }, 'member_ai_model_failed');
    return { ok: false, status: 502, code: 'AI_FAILED', message: UNAVAILABLE, toolsUsed };
  }

  // An abort can land on the generator's final .next(): the member closed the
  // tab after the last token but before persistence. No answer was seen.
  if (signal?.aborted) {
    logger.info({ requestId }, 'member_ai_member_disconnected');
    return disconnected(toolsUsed);
  }

  // 8. Split the protocol line from the answer. A draft the planner did not
  //    permit is discarded, not shown.
  const { visible: rawVisible, draft: extracted } = extractDraft(full);
  const draft = plan.allowDraft ? extracted : null;
  const visible = rawVisible || (draft ? DRAFT_ONLY_REPLY : rawVisible);

  try {
    await thread.appendMessage(conversationId, 'assistant', visible);
  } catch (err) {
    // The member has a complete answer; losing the transcript must not turn
    // it into an error. The next turn simply lacks this one in its history.
    logger.error({ requestId, code: err?.code }, 'member_ai_assistant_turn_failed');
  }

  // 9. Exactly one usage row. request_id makes a retried request idempotent at
  //    the ledger. logUsage never throws.
  const elapsed = Date.now() - started;
  const usage = usageFields(meta?.usage, visible);
  await logUsage({
    user_id: userId,
    organization_id: orgId,
    conversation_id: conversationId,
    model: meta?.model ?? null,
    intent_type: plan.intent,
    ...usage,
    latency_ms: elapsed,
    used_fallback: Boolean(meta?.used_fallback),
    routed_via: meta?.routed_via ?? null,
    request_id: requestId,
  });

  return {
    ok: true,
    message: visible,
    toolsUsed,
    toolsUnavailable,
    proposedMessage: draft,
    requiresConfirmation: Boolean(draft),
    meta: {
      requestId,
      intent: plan.intent,
      model: meta?.model ?? null,
      used_fallback: Boolean(meta?.used_fallback),
      latency_ms: elapsed,
      usage_known: usage.usage_source === 'provider',
    },
  };
}

/** The member's recent turns for the UI, oldest-first. */
async function historyFor(orgId, userId, limit = 40) {
  const conversationId = await thread.findThread(orgId, userId);
  if (!conversationId) return [];
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 100);
  return thread.recentMessages(conversationId, cap);
}

/** Delete this member's turns, keeping the thread row. */
async function clearHistory(orgId, userId) {
  return thread.clearHistory(orgId, userId);
}

module.exports = {
  ask, historyFor, clearHistory, buildMessages, HISTORY_TURNS, DRAFT_ONLY_REPLY,
};

'use strict';

// One batched model call per refresh. The model writes prose only: it cannot
// choose the queue, the score, the recipient or the channel. Everything it
// sees is fenced, everything it returns is validated, and every call is metered
// even when the response is unusable — the spend happened.

const crypto = require('crypto');
const { routedChat } = require('../../lib/ai/router');
const { logUsage } = require('../../lib/ai/usage');
const { usageFields } = require('../../lib/ai/metering');
const { fenceToolResult } = require('../../lib/ai/agent/untrustedContext');
const { buildOpsQueueSystemPrompt } = require('../../lib/ai/prompts/system');
const logger = require('../../lib/logger');
const { firstName, reasonIdentity } = require('./priority');

const MAX_ITEMS = 12;
const MAX_MESSAGE = 1200;
const MAX_BRIEF = 600;

const UNAVAILABLE = 'AI drafts are unavailable right now.';

function eligible(items) {
  return (items || [])
    .filter((item) => item?.recommended_action?.kind === 'message')
    .filter((item) => item?.channel?.status === 'connected')
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
    .slice(0, MAX_ITEMS);
}

function payloadFor(items, studioName) {
  return {
    studio_name: studioName ?? null,
    counts: { total: items.length },
    items: items.map((item) => ({
      id: item.id,
      first_name: firstName(item.subject?.name),
      // Screening labels name medical facts. They are useful to the trainer
      // and have no place in a model prompt or a WhatsApp draft.
      reasons: (item.reasons || [])
        .filter((reason) => reason.family !== 'screening')
        .map((reason) => reason.label),
      channel: 'whatsapp',
    })),
  };
}

function stripFence(content) {
  return String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function confidenceOf(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function parseResponse(content, items) {
  const parsed = JSON.parse(stripFence(content));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const brief = typeof parsed.brief === 'string' ? parsed.brief.trim() : '';
  if (!brief || brief.length > MAX_BRIEF) return null;
  if (!Array.isArray(parsed.items)) return null;

  const byId = new Map(items.map((item) => [item.id, item]));
  const drafts = new Map();
  const rejected = [];

  for (const entry of parsed.items) {
    if (!entry || typeof entry.id !== 'string') continue;

    const message = typeof entry.message === 'string' ? entry.message.trim() : '';
    // A malformed message poisons the batch: we cannot tell a truncated
    // response from a model that ignored the length rule.
    if (!message || message.length > MAX_MESSAGE) return null;

    const item = byId.get(entry.id);
    if (!item) {
      rejected.push(entry.id);
      continue;
    }

    const reasons = item.reasons || [];
    const primary = reasons.find((reason) => reason.code === item.recommended_action?.reason_code)
      || reasons[0];

    drafts.set(entry.id, {
      body: message,
      channel: 'whatsapp',
      source: 'ai',
      model: null,
      generated_at: new Date().toISOString(),
      confidence: confidenceOf(entry.confidence),
      rationale: typeof entry.rationale === 'string' ? entry.rationale.trim().slice(0, 300) : null,
      reason_key: primary ? reasonIdentity(primary) : null,
    });
  }

  return { brief, drafts, rejected };
}

async function generateDrafts({ orgId, items, studioName, actor, requestId }) {
  const candidates = eligible(items);
  if (!candidates.length) {
    return { ok: false, reason: 'no_items', message: 'No message items need AI drafts.' };
  }

  const fenceId = crypto.randomBytes(16).toString('hex');
  const fenced = fenceToolResult({
    label: 'ops queue items',
    tool: 'ai_ops_queue',
    data: payloadFor(candidates, studioName),
    fenceId,
  });

  let result;
  try {
    result = await routedChat({
      intent: 'ops_queue',
      messages: [
        { role: 'system', content: buildOpsQueueSystemPrompt() },
        { role: 'user', content: fenced },
      ],
      temperature: 0.4,
      max_tokens: 1400,
    });
  } catch (err) {
    logger.warn({ code: err?.code ?? null, message: err?.message ?? 'provider failed' }, 'ai_ops_draft_failed');
    return { ok: false, reason: 'model_failed', message: UNAVAILABLE };
  }

  // Meter before parsing: the provider was paid whether or not its JSON parses.
  const usage = usageFields(result?.usage, result?.content);
  try {
    await logUsage({
      user_id: actor?.userId ?? null,
      organization_id: orgId,
      model: result?.model,
      intent_type: 'ai_ops_queue',
      ...usage,
      latency_ms: result?.latency_ms ?? 0,
      used_fallback: Boolean(result?.used_fallback),
      routed_via: result?.routed_via ?? null,
      request_id: requestId ?? null,
    });
  } catch (err) {
    logger.warn({ message: err?.message ?? 'usage log failed' }, 'ai_ops_usage_failed');
  }

  let parsed;
  try {
    parsed = parseResponse(result?.content, candidates);
  } catch (err) {
    logger.warn({ message: err?.message ?? 'invalid json' }, 'ai_ops_draft_failed');
    return { ok: false, reason: 'invalid_response', message: UNAVAILABLE };
  }
  if (!parsed) {
    logger.warn({ model: result?.model ?? null }, 'ai_ops_draft_failed');
    return { ok: false, reason: 'invalid_response', message: UNAVAILABLE };
  }

  for (const draft of parsed.drafts.values()) draft.model = result?.model ?? null;

  return {
    ok: true,
    brief: parsed.brief,
    drafts: parsed.drafts,
    model: result?.model ?? null,
    rejected: parsed.rejected,
  };
}

module.exports = { generateDrafts, MAX_ITEMS, MAX_MESSAGE };

'use strict';
// One AI draft reply for one conversation.
//
// The model writes prose only. It cannot choose the recipient, the channel or
// whether the message is sent; this module has no write path to
// client_messages at all. The trainer reads the draft in the composer, edits
// it, and sends it as themselves.
//
// Everything client-authored is fenced with a per-request nonce before it
// reaches the model. The prompt is instructions; the thread is data.

const { routedChat } = require('../../lib/ai/router');
const { logUsage } = require('../../lib/ai/usage');
const { usageFields } = require('../../lib/ai/metering');
const { fenceToolResult, newFenceId } = require('../../lib/ai/agent/untrustedContext');
const { trainerInboxDraftPrompt } = require('../../lib/ai/prompts/system');
const { firstName } = require('../ai-ops/priority');
const read = require('../pt-os/client-read.service');
const svc = require('./client-messages.service');
const logger = require('../../lib/logger');

const THREAD_LIMIT = 20;
/** 20 messages at the column's 2000-character limit would be a 40k prompt. */
const MAX_MESSAGE_CHARS = 400;
/** The prompt asks for 600; this is the hard ceiling, not a second target. */
const MAX_DRAFT_CHARS = 1200;

const UNAVAILABLE = 'The draft is unavailable right now.';

/** Cap by code points, so a surrogate pair is never split. */
function capText(value) {
  const characters = Array.from(String(value ?? ''));
  if (characters.length <= MAX_MESSAGE_CHARS) return characters.join('');
  return `${characters.slice(0, MAX_MESSAGE_CHARS - 1).join('')}…`;
}

/**
 * Strip the shapes a model adds around the text it was asked for: a code
 * fence, or one pair of quotes. Anything else is left alone — the trainer
 * edits the draft before it is sent.
 */
function cleanDraft(content) {
  let text = String(content ?? '').trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();

  const quoted =
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"));
  if (quoted && text.length >= 2) text = text.slice(1, -1).trim();

  return text;
}

function payloadFor(client, profile, messages) {
  return {
    client: {
      // The model addresses the client by first name only. The full name is
      // included as a fact, not as a salutation instruction.
      first_name: firstName(client.name),
      name: client.name,
    },
    // Exactly the fields getClientProfile returns. Screening, notes, injuries
    // and the rest of the profile row never enter the prompt.
    membership: {
      days_left: profile.days_left,
      due_status: profile.due_status,
      current_term_balance: profile.current_term_balance,
      pt_end_date: profile.pt_end_date,
    },
    conversation: (messages || []).map((message) => ({
      from: message.sender === 'studio' ? 'trainer' : 'client',
      at: message.created_at,
      text: capText(message.body),
    })),
  };
}

async function generateInboxDraft({ orgId, client, actor, requestId }) {
  const messages = await svc.thread(orgId, client.id, { limit: THREAD_LIMIT });
  const profile = await read.getClientProfile(orgId, client.id);

  // Authorise the subject before the prompt: a client the caller can no longer
  // see must not have their conversation sent to a provider.
  if (!profile) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Client not found.' };
  }

  const fenceId = newFenceId();
  const fenced = fenceToolResult({
    label: 'client and conversation',
    tool: 'inbox_thread',
    data: payloadFor(client, profile, messages),
    fenceId,
  });

  let result;
  try {
    result = await routedChat({
      intent: 'inbox_draft',
      messages: [
        { role: 'system', content: trainerInboxDraftPrompt() },
        { role: 'user', content: fenced },
      ],
      temperature: 0.5,
      max_tokens: 500,
    });
  } catch (err) {
    logger.warn(
      { code: err?.code ?? null, message: err?.message ?? 'provider failed' },
      'inbox_draft_failed',
    );
    // No usage row: the call produced no response to meter.
    return { ok: false, status: 503, code: 'AI_UNAVAILABLE', message: UNAVAILABLE };
  }

  // Meter before validating: the provider was paid whether or not the text is
  // usable. A usage-write failure must not turn a paid draft into a 500.
  const usage = usageFields(result?.usage, result?.content);
  try {
    await logUsage({
      user_id: actor?.userId ?? null,
      organization_id: orgId,
      model: result?.model,
      intent_type: 'inbox_draft',
      ...usage,
      latency_ms: result?.latency_ms ?? 0,
      used_fallback: Boolean(result?.used_fallback),
      routed_via: result?.routed_via ?? null,
      request_id: requestId ?? null,
    });
  } catch (err) {
    logger.warn({ message: err?.message ?? 'usage log failed' }, 'inbox_draft_usage_failed');
  }

  const draft = cleanDraft(result?.content);
  if (!draft || Array.from(draft).length > MAX_DRAFT_CHARS) {
    logger.warn({ model: result?.model ?? null }, 'inbox_draft_invalid');
    return { ok: false, status: 502, code: 'AI_INVALID_DRAFT', message: 'The draft could not be used. Try again.' };
  }

  return {
    ok: true,
    draft,
    meta: {
      model: result?.model ?? null,
      used_fallback: Boolean(result?.used_fallback),
    },
  };
}

module.exports = { generateInboxDraft, MAX_DRAFT_CHARS, MAX_MESSAGE_CHARS };

'use strict';
// src/lib/ai/metering.js
//
// What an AI call cost, and a way to make sure it is recorded (AI audit
// 2026-09-28, AI-3). Kept apart from usage.js so the pure part is testable on
// its own and so code that stubs the usage LOG still gets real metering.

// Provider cost arrives in USD (OpenRouter credits). Converted at a
// configurable rate so the Command Center can show rupees; the rate is an
// operator setting, not a live FX feed, and ai_usage_log keeps what was
// charged in INR at the time.
function usdToInr() {
  const r = Number(process.env.AI_USD_TO_INR);
  return Number.isFinite(r) && r > 0 ? r : 84;
}

/**
 * Token counts and cost for the usage log, from what the provider reported.
 *
 * AI audit 2026-09-28, AI-3: the streaming paths logged prompt_tokens = 0 and
 * guessed completion tokens as characters / 4, and every cost as ₹0 — the
 * quota counted a fraction of real use. The provider now returns exact usage
 * (lib/ai/openrouter.js requests it). The estimate survives only for a
 * response that carried no usage at all, and says so in usage_source.
 */
function usageFields(usage, completionText = '') {
  const prompt = Number(usage?.prompt_tokens);
  const completion = Number(usage?.completion_tokens);
  if (Number.isFinite(prompt) && Number.isFinite(completion) && (prompt > 0 || completion > 0)) {
    const costUsd = Number(usage?.cost);
    return {
      tokens_prompt: prompt,
      tokens_completion: completion,
      cost_inr: Number.isFinite(costUsd) ? Math.round(costUsd * usdToInr() * 10000) / 10000 : null,
      usage_source: 'provider',
    };
  }
  return {
    tokens_prompt: 0,
    tokens_completion: Math.ceil(String(completionText || '').length / 4),
    cost_inr: null,
    usage_source: 'estimated',
  };
}

/**
 * A chat function that logs what it spent.
 *
 * Several AI calls never reached the usage log — the workout generator's
 * revision and review passes, the client coach card, the check-in insight —
 * so the quota could not count them and nobody could see them. Wrapping the
 * function they are handed logs each call with the provider's own figures,
 * without those modules having to know about the log.
 */
function meteredChat(req, intent_type, chat) {
  return async (args) => {
    const result = await chat(args);
    require('./usage').logUsage({
      user_id: req.user?.id,
      model: result?.model,
      intent_type,
      ...usageFields(result?.usage, result?.content),
      latency_ms: result?.latency_ms ?? 0,
      used_fallback: Boolean(result?.used_fallback),
    }).catch(() => {});
    return result;
  };
}

module.exports = { usageFields, meteredChat, usdToInr };

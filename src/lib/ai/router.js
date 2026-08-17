'use strict';
const { chatCompletion, streamCompletion } = require('./openrouter');
const { resolveModel, getFallbackChain } = require('./models');
const logger = require('../logger');

/**
 * Fallback chain for a tier, e.g. primary → secondary → fallback, with
 * duplicate model IDs already removed (see models.js getFallbackChain).
 * Logs when the configured chain was shortened by duplicates so operators
 * can see the effective ordering without redeploying.
 */
function chainFor(tier, attemptedModel, intent) {
  const chain = getFallbackChain(tier, attemptedModel);
  const expected = tier === 'primary' ? 2 : tier === 'secondary' ? 1 : 0;
  if (chain.length < expected) {
    logger.warn(
      { model: attemptedModel, intent, chain: chain.map((s) => s.model) },
      'ai_model_duplicate_skipped'
    );
  }
  return chain;
}

function buildAllModelsFailed(primaryErr, attempts) {
  const final = new Error('AI service temporarily unavailable — all models failed');
  final.code = 'ALL_MODELS_FAILED';
  final.primary_error = primaryErr.message;
  final.fallback_error = attempts[attempts.length - 1]?.err?.message;
  final.errors = attempts.map((a) => ({ model: a.model, tier: a.tier, error: a.err.message }));
  return final;
}

/**
 * Non-streaming chat completion with automatic fallback routing.
 * Returns { content, usage, model, tier, intent, latency_ms, used_fallback }
 * Throws ALL_MODELS_FAILED with { primary_error, fallback_error, errors }.
 */
async function routedChat({ intent, messages, temperature, max_tokens, timeout }) {
  const { model, tier } = resolveModel(intent);
  const chain = chainFor(tier, model, intent);

  try {
    const result = await chatCompletion({ model, messages, temperature, max_tokens, timeout });
    return { ...result, intent, tier, used_fallback: false };
  } catch (primaryErr) {
    logger.warn({ model, tier, intent, err: primaryErr.message }, 'ai_primary_failed');

    const attempts = [{ model, tier, err: primaryErr }];
    for (const step of chain) {
      try {
        const result = await chatCompletion({ model: step.model, messages, temperature, max_tokens, timeout });
        logger.info({ model: step.model, tier: step.tier, intent }, 'ai_fallback_success');
        return { ...result, intent, tier: step.tier, used_fallback: true, original_error: primaryErr.message };
      } catch (fbErr) {
        attempts.push({ model: step.model, tier: step.tier, err: fbErr });
        logger.error({ model: step.model, tier: step.tier, err: fbErr.message }, 'ai_fallback_failed');
      }
    }

    throw buildAllModelsFailed(primaryErr, attempts);
  }
}

/**
 * Streaming chat completion with automatic fallback routing.
 * Yields SSE-ready string chunks. Returns metadata as generator return value.
 */
async function* routedStream({ intent, messages, temperature, max_tokens, timeout }) {
  const { model, tier } = resolveModel(intent);
  const chain = chainFor(tier, model, intent);

  try {
    const gen = streamCompletion({ model, messages, temperature, max_tokens, timeout });
    for await (const chunk of gen) {
      yield chunk;
    }
    return { model, tier, intent, used_fallback: false };
  } catch (primaryErr) {
    logger.warn({ model, tier, intent, err: primaryErr.message }, 'ai_stream_primary_failed');

    const attempts = [{ model, tier, err: primaryErr }];
    for (const step of chain) {
      // Notify caller we're switching
      yield '\n\n[Retrying with backup model…]\n\n';

      try {
        const gen = streamCompletion({ model: step.model, messages, temperature, max_tokens, timeout });
        for await (const chunk of gen) {
          yield chunk;
        }
        return { model: step.model, tier: step.tier, intent, used_fallback: true };
      } catch (fbErr) {
        attempts.push({ model: step.model, tier: step.tier, err: fbErr });
        logger.error({ model: step.model, tier: step.tier, err: fbErr.message }, 'ai_stream_fallback_failed');
      }
    }

    throw buildAllModelsFailed(primaryErr, attempts);
  }
}

module.exports = { routedChat, routedStream };

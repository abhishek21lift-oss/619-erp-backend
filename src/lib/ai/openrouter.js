'use strict';
const logger = require('../logger');
const aiConfig = require('./config');

const BASE_URL     = process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1';
const SITE_URL     = process.env.FRONTEND_URL || 'https://619fitness.app';
const SITE_NAME    = 'MY PT STUDIO';

// Request timeout for OpenRouter calls, including response-body streaming.
// Configurable via AI_OPENROUTER_TIMEOUT_MS; bounds keep a typo from either
// killing fast requests (anything under 1s) or pinning the process to a
// hung upstream forever (anything over 5 minutes). The 90s default is
// unchanged from the historical hard-coded value.
const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS     = 1_000;
const MAX_TIMEOUT_MS     = 300_000;

function defaultTimeoutMs() {
  const raw = Number(process.env.AI_OPENROUTER_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= MIN_TIMEOUT_MS && raw <= MAX_TIMEOUT_MS) return raw;
  if (process.env.AI_OPENROUTER_TIMEOUT_MS) {
    logger.warn({ value: process.env.AI_OPENROUTER_TIMEOUT_MS }, 'ai_openrouter_timeout_invalid');
  }
  return DEFAULT_TIMEOUT_MS;
}

function getApiKey() {
  const key = aiConfig.apiKey();
  if (!key) {
    const err = new Error('AI_API_KEY / OPENROUTER_API_KEY is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return key;
}

function buildHeaders() {
  return {
    'Authorization':  `Bearer ${getApiKey()}`,
    'Content-Type':   'application/json',
    'HTTP-Referer':   SITE_URL,
    'X-Title':        SITE_NAME,
  };
}

/**
 * Non-streaming chat completion.
 * Returns { content, usage, model, latency_ms }
 */
async function chatCompletion({ model, messages, temperature = 0.7, max_tokens = 2048, timeout = defaultTimeoutMs() }) {
  const start      = Date.now();
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ model, messages, temperature, max_tokens }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err  = new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      err.body   = text;
      throw err;
    }

    // Keep the abort timer alive through body read — free-tier models can be
    // slow to stream the full response body after sending headers.
    const data     = await res.json();
    clearTimeout(timer);

    const content  = data.choices?.[0]?.message?.content ?? '';
    const usage    = data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const latency  = Date.now() - start;

    logger.info({ model, latency_ms: latency, tokens: usage.total_tokens }, 'ai_completion_ok');
    return { content, usage, model: data.model || model, latency_ms: latency };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError' || err.message === 'This operation was aborted.' ||
        err.message === 'Load failed') {
      const elapsed = Date.now() - start;
      logger.warn({ model, timeout_ms: timeout, latency_ms: elapsed }, 'ai_completion_timeout');
      const t = new Error(`OpenRouter request timed out after ${elapsed}ms`);
      t.code = 'TIMEOUT';
      throw t;
    }
    throw err;
  }
}

/**
 * Streaming chat completion — yields text delta strings.
 * Returns { usage } after the stream is exhausted.
 */
async function* streamCompletion({ model, messages, temperature = 0.7, max_tokens = 2048, timeout = defaultTimeoutMs() }) {
  const start      = Date.now();
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ model, messages, temperature, max_tokens, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      logger.warn({ model, timeout_ms: timeout, latency_ms: Date.now() - start }, 'ai_stream_timeout');
      const t = new Error(`Stream timed out after ${timeout}ms`);
      t.code = 'TIMEOUT';
      throw t;
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    const err  = new Error(`OpenRouter stream ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';
  let usage     = null;
  // ── Which model actually answered ────────────────────────────────────────
  //
  // OpenRouter stamps `model` on every streamed chunk, and this loop read the
  // usage off those chunks while throwing the model away. The non-streaming
  // path above has always kept it (`data.model || model`), so the two
  // disagreed — and the streaming path is the one the workout and diet
  // generators use.
  //
  // It matters because the configured model is an AUTO-ROUTER. Production
  // sends "auto", which picks a different underlying model per request by
  // design, so the requested name is never the answer to "what wrote this
  // plan". Measured on the live database: 137 calls in 45 days logged as
  // "auto", and every row of ai_workout_generations recording "auto" in the
  // column that exists to answer exactly that question. A quality score of 82
  // and one of 88 could have come from different models and nothing recorded
  // which.
  let servedModel = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) usage = parsed.usage;
          if (!servedModel && parsed.model) servedModel = parsed.model;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch { /* skip malformed chunk */ }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || err.message === 'This operation was aborted.' ||
        err.message === 'Load failed') {
      logger.warn({ model, timeout_ms: timeout, latency_ms: Date.now() - start }, 'ai_stream_timeout');
      const t = new Error(`OpenRouter stream timed out after ${timeout}ms`);
      t.code = 'TIMEOUT';
      throw t;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    logger.info(
      { model, served_model: servedModel, latency_ms: Date.now() - start },
      'ai_stream_done'
    );
  }

  // Both, and the shape is deliberate. Callers that only wanted the usage got
  // an object before too; `served_model` is additive and `model` names what
  // was REQUESTED, so a caller can report "asked for auto, got X" rather than
  // having to choose between the two facts.
  return { usage, model: servedModel || model, requested_model: model };
}

/**
 * Quick model health check — 1-token completion.
 */
async function pingModel(model) {
  const start = Date.now();
  try {
    await chatCompletion({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 20,
      temperature: 0,
      timeout: 30_000,
    });
    return { model, status: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    return { model, status: 'error', error: err.message, latency_ms: Date.now() - start };
  }
}

module.exports = { chatCompletion, streamCompletion, pingModel };

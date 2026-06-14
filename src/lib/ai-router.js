// src/lib/ai-router.js
// Multi-provider AI router. Selects OpenAI or Gemini based on the active mode
// stored in ai_provider_settings, with automatic fallback on failure.
'use strict';

const openai = require('./openai');
const gemini = require('./gemini');
const pool   = require('../db/pool');
const logger = require('./logger');

const VALID_MODES = ['auto', 'openai_only', 'gemini_only', 'openai_primary', 'gemini_primary'];

const VALID_GEMINI_MODELS = [
  'gemini-2.5-flash-preview-05-20',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro-latest',
];

// Cache both mode and gemini_model to avoid a DB round-trip on every chat
let _cached     = null; // { mode, gemini_model }
let _cacheExpiry = 0;
const CACHE_TTL  = 60_000; // 1 minute

async function getCachedConfig() {
  if (Date.now() < _cacheExpiry && _cached) return _cached;
  try {
    const { rows } = await pool.query(
      `SELECT mode, gemini_model FROM ai_provider_settings WHERE id = 'singleton'`
    );
    _cached = {
      mode:         rows[0]?.mode         || 'auto',
      gemini_model: rows[0]?.gemini_model || gemini.DEFAULT_MODEL,
    };
  } catch {
    _cached = { mode: 'auto', gemini_model: gemini.DEFAULT_MODEL };
  }
  _cacheExpiry = Date.now() + CACHE_TTL;
  return _cached;
}

function invalidateCache() {
  _cached      = null;
  _cacheExpiry = 0;
}

function isConfigured() {
  return openai.isConfigured() || gemini.isConfigured();
}

// Resolve {primary, fallback, name} for the current mode
function resolveProviders(mode) {
  if (mode === 'openai_only')    return { primary: openai, fallback: null,   name: 'openai' };
  if (mode === 'gemini_only')    return { primary: gemini, fallback: null,   name: 'gemini' };
  if (mode === 'openai_primary') return { primary: openai, fallback: gemini, name: 'openai' };
  if (mode === 'gemini_primary') return { primary: gemini, fallback: openai, name: 'gemini' };
  // auto: prefer OpenAI if configured, else Gemini
  if (openai.isConfigured()) return { primary: openai, fallback: gemini.isConfigured() ? gemini : null, name: 'openai' };
  if (gemini.isConfigured()) return { primary: gemini, fallback: null, name: 'gemini' };
  return { primary: null, fallback: null, name: null };
}

async function streamChat(params, res) {
  const config = await getCachedConfig();
  let { primary, fallback, name } = resolveProviders(config.mode);

  // If primary not configured, promote fallback
  if (!primary || !primary.isConfigured()) {
    if (fallback && fallback.isConfigured()) {
      primary  = fallback;
      name     = primary === openai ? 'openai' : 'gemini';
      fallback = null;
    } else {
      return res.status(501).json({ error: 'No AI provider is configured. Set OPENAI_API_KEY or GEMINI_API_KEY.' });
    }
  }

  // Inject the configured Gemini model when Gemini is the chosen provider
  const enrichedParams = primary === gemini
    ? { ...params, gemini_model: config.gemini_model }
    : params;

  // Tell the client which provider is being used (before streaming starts)
  res.setHeader('X-Provider-Used', name);

  try {
    await primary.streamChat(enrichedParams, res);
  } catch (err) {
    // Fallback only works if headers haven't been sent yet (pre-streaming failure)
    if (!res.headersSent && fallback && fallback.isConfigured()) {
      logger.warn({ err: err.message, name }, 'Primary AI provider failed before streaming — trying fallback');
      const fbName         = fallback === openai ? 'openai' : 'gemini';
      const fbParams       = fallback === gemini ? { ...params, gemini_model: config.gemini_model } : params;
      res.setHeader('X-Provider-Used', fbName);
      return fallback.streamChat(fbParams, res);
    }
    throw err;
  }
}

// ── Provider settings CRUD ────────────────────────────────────────────────────

async function getSettings() {
  try {
    const { rows } = await pool.query(
      `SELECT id, mode, gemini_model, updated_at FROM ai_provider_settings WHERE id = 'singleton'`
    );
    const row = rows[0] || { id: 'singleton', mode: 'auto', gemini_model: gemini.DEFAULT_MODEL };
    return {
      ...row,
      openai_configured:    openai.isConfigured(),
      gemini_configured:    gemini.isConfigured(),
      valid_gemini_models:  VALID_GEMINI_MODELS,
    };
  } catch {
    return {
      id: 'singleton', mode: 'auto', gemini_model: gemini.DEFAULT_MODEL,
      openai_configured:    openai.isConfigured(),
      gemini_configured:    gemini.isConfigured(),
      valid_gemini_models:  VALID_GEMINI_MODELS,
    };
  }
}

async function updateSettings({ mode, gemini_model: gModel } = {}) {
  const setClauses = [];
  const vals       = [];

  if (mode !== undefined) {
    if (!VALID_MODES.includes(mode)) throw Object.assign(new Error('Invalid mode'), { status: 400 });
    vals.push(mode);
    setClauses.push(`mode = $${vals.length}`);
  }

  if (gModel !== undefined) {
    if (!VALID_GEMINI_MODELS.includes(gModel)) throw Object.assign(new Error('Invalid Gemini model'), { status: 400 });
    vals.push(gModel);
    setClauses.push(`gemini_model = $${vals.length}`);
  }

  if (!setClauses.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  await pool.query(
    `UPDATE ai_provider_settings SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = 'singleton'`,
    vals
  );
  invalidateCache();
}

// ── Per-provider usage stats (last 30 days) ───────────────────────────────────

async function getStats() {
  const cfg = await getCachedConfig().catch(() => ({ mode: 'auto', gemini_model: gemini.DEFAULT_MODEL }));

  const safe = (p) =>
    pool.query(
      `SELECT
         COUNT(*)                                                           AS requests,
         COALESCE(SUM(tokens_total), 0)                                    AS tokens_total,
         COALESCE(SUM(tokens_prompt), 0)                                   AS tokens_prompt,
         COALESCE(SUM(tokens_completion), 0)                               AS tokens_completion,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS requests_today,
         COALESCE(SUM(tokens_total) FILTER
           (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)           AS tokens_today
       FROM ai_usage_log
       WHERE provider = $1 AND created_at > NOW() - INTERVAL '30 days'`,
      [p]
    ).catch(() => ({ rows: [{ requests: 0, tokens_total: 0, tokens_prompt: 0, tokens_completion: 0, requests_today: 0, tokens_today: 0 }] }));

  const [oaiRes, gemRes] = await Promise.all([safe('openai'), safe('gemini')]);

  return {
    openai: { configured: openai.isConfigured(), model: 'gpt-4o',         ...oaiRes.rows[0] },
    gemini: { configured: gemini.isConfigured(), model: cfg.gemini_model, ...gemRes.rows[0] },
  };
}

// ── Test a provider's API key ─────────────────────────────────────────────────

async function testProvider(provider) {
  if (provider === 'openai') {
    if (!openai.isConfigured()) return { success: false, message: 'OPENAI_API_KEY is not set' };
    try {
      const OpenAI   = require('openai');
      const client   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      await client.models.retrieve('gpt-4o');
      return { success: true, message: 'OpenAI connected — gpt-4o available' };
    } catch (err) {
      return { success: false, message: err.message || 'OpenAI connection failed' };
    }
  }

  if (provider === 'gemini') {
    if (!gemini.isConfigured()) return { success: false, message: 'GEMINI_API_KEY is not set' };
    // Use the currently-configured model for the health check
    const cfg     = await getCachedConfig().catch(() => ({ gemini_model: gemini.DEFAULT_MODEL }));
    const modelId = cfg.gemini_model;
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model  = genAI.getGenerativeModel({ model: modelId });
      // Short ping — cheaper than a full conversation
      await model.generateContent('Reply with exactly one word: ok');
      return { success: true, message: `Gemini connected — ${modelId} available` };
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('[429') || msg.includes('RESOURCE_EXHAUSTED')) {
        const hasZeroLimit = msg.includes('limit: 0') || msg.includes('free_tier');
        return {
          success: false,
          message: hasZeroLimit
            ? 'API key valid but quota is zero — enable billing at console.cloud.google.com or get a fresh key from aistudio.google.com'
            : 'API key valid but rate-limited (quota exceeded). Wait and retry, or upgrade your plan.',
        };
      }
      if (msg.includes('[403') || msg.includes('API_KEY_INVALID')) {
        return { success: false, message: 'Invalid API key — check GEMINI_API_KEY in your environment variables.' };
      }
      if (msg.includes('[404')) {
        return { success: false, message: `Model "${modelId}" not found. Try selecting a different model.` };
      }
      return { success: false, message: msg || 'Gemini connection failed' };
    }
  }

  return { success: false, message: 'Unknown provider' };
}

// Re-export checkRateLimit from openai (rate limiting uses DB only, not provider-specific)
const { checkRateLimit } = require('./openai');

module.exports = {
  isConfigured,
  streamChat,
  getSettings,
  updateSettings,
  getStats,
  testProvider,
  checkRateLimit,
  VALID_GEMINI_MODELS,
};

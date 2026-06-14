// src/lib/ai-router.js
// Multi-provider AI router. Selects OpenAI or Gemini based on the active mode
// stored in ai_provider_settings, with automatic fallback on failure.
'use strict';

const openai = require('./openai');
const gemini = require('./gemini');
const pool   = require('../db/pool');
const logger = require('./logger');

const VALID_MODES = ['auto', 'openai_only', 'gemini_only', 'openai_primary', 'gemini_primary'];

// Simple in-process cache for the mode (avoids a DB round-trip on every chat)
let _cachedMode   = null;
let _cacheExpiry  = 0;
const CACHE_TTL   = 60_000; // 1 minute

async function getMode() {
  if (Date.now() < _cacheExpiry && _cachedMode) return _cachedMode;
  try {
    const { rows } = await pool.query(
      `SELECT mode FROM ai_provider_settings WHERE id = 'singleton'`
    );
    _cachedMode = rows[0]?.mode || 'auto';
  } catch {
    _cachedMode = 'auto';
  }
  _cacheExpiry = Date.now() + CACHE_TTL;
  return _cachedMode;
}

function invalidateCache() {
  _cachedMode  = null;
  _cacheExpiry = 0;
}

function isConfigured() {
  return openai.isConfigured() || gemini.isConfigured();
}

// Resolve {primary, fallback} providers for the current mode
function resolveProviders(mode) {
  if (mode === 'openai_only')  return { primary: openai, fallback: null, name: 'openai' };
  if (mode === 'gemini_only')  return { primary: gemini, fallback: null, name: 'gemini' };
  if (mode === 'openai_primary') return { primary: openai, fallback: gemini, name: 'openai' };
  if (mode === 'gemini_primary') return { primary: gemini, fallback: openai, name: 'gemini' };
  // auto: prefer OpenAI if configured, else Gemini
  if (openai.isConfigured()) return { primary: openai, fallback: gemini.isConfigured() ? gemini : null, name: 'openai' };
  if (gemini.isConfigured()) return { primary: gemini, fallback: null, name: 'gemini' };
  return { primary: null, fallback: null, name: null };
}

async function streamChat(params, res) {
  const mode = await getMode();
  let { primary, fallback, name } = resolveProviders(mode);

  // If primary not configured, promote fallback
  if (!primary || !primary.isConfigured()) {
    if (fallback && fallback.isConfigured()) {
      primary = fallback;
      name    = primary === openai ? 'openai' : 'gemini';
      fallback = null;
    } else {
      return res.status(501).json({ error: 'No AI provider is configured. Set OPENAI_API_KEY or GEMINI_API_KEY.' });
    }
  }

  // Tell the client which provider is being used (header set before streaming)
  res.setHeader('X-Provider-Used', name);

  try {
    await primary.streamChat(params, res);
  } catch (err) {
    // Fallback only works if headers haven't been sent yet (pre-streaming failure)
    if (!res.headersSent && fallback && fallback.isConfigured()) {
      logger.warn({ err: err.message, name }, 'Primary AI provider failed before streaming — trying fallback');
      const fbName = fallback === openai ? 'openai' : 'gemini';
      res.setHeader('X-Provider-Used', fbName);
      return fallback.streamChat(params, res);
    }
    throw err;
  }
}

// ── Provider settings CRUD ────────────────────────────────────────────────────

async function getSettings() {
  try {
    const { rows } = await pool.query(
      `SELECT id, mode, updated_at FROM ai_provider_settings WHERE id = 'singleton'`
    );
    const row = rows[0] || { id: 'singleton', mode: 'auto' };
    return {
      ...row,
      openai_configured: openai.isConfigured(),
      gemini_configured: gemini.isConfigured(),
    };
  } catch {
    return {
      id: 'singleton', mode: 'auto',
      openai_configured: openai.isConfigured(),
      gemini_configured: gemini.isConfigured(),
    };
  }
}

async function updateSettings(mode) {
  if (!VALID_MODES.includes(mode)) throw Object.assign(new Error('Invalid mode'), { status: 400 });
  await pool.query(
    `UPDATE ai_provider_settings SET mode = $1, updated_at = NOW() WHERE id = 'singleton'`,
    [mode]
  );
  invalidateCache();
}

// ── Per-provider usage stats (last 30 days) ───────────────────────────────────

async function getStats() {
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
    openai: { configured: openai.isConfigured(), model: 'gpt-4o',          ...oaiRes.rows[0] },
    gemini: { configured: gemini.isConfigured(), model: 'gemini-1.5-pro',  ...gemRes.rows[0] },
  };
}

// ── Test a provider's API key ─────────────────────────────────────────────────

async function testProvider(provider) {
  if (provider === 'openai') {
    if (!openai.isConfigured()) return { success: false, message: 'OPENAI_API_KEY is not set' };
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      await client.models.retrieve('gpt-4o');
      return { success: true, message: 'OpenAI connected — gpt-4o available' };
    } catch (err) {
      return { success: false, message: err.message || 'OpenAI connection failed' };
    }
  }

  if (provider === 'gemini') {
    if (!gemini.isConfigured()) return { success: false, message: 'GEMINI_API_KEY is not set' };
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
      await model.generateContent('ping');
      return { success: true, message: 'Gemini connected — gemini-1.5-pro available' };
    } catch (err) {
      return { success: false, message: err.message || 'Gemini connection failed' };
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
};

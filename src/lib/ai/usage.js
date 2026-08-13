'use strict';
const pool   = require('../../db/pool');
const logger = require('../logger');

/**
 * Log a completed AI request to the usage_log table.
 * Never throws — logging failures must not break the response.
 */
async function logUsage({
  user_id, conversation_id, model, provider = 'openrouter',
  intent_type = 'fitness', tokens_prompt = 0, tokens_completion = 0,
  latency_ms = 0, used_fallback = false,
}) {
  try {
    await pool.query(
      `INSERT INTO ai_usage_log
         (user_id, conversation_id, model, provider, intent_type,
          tokens_prompt, tokens_completion, tokens_total,
          latency_ms, used_fallback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        user_id,
        conversation_id || null,
        model,
        provider,
        intent_type,
        tokens_prompt,
        tokens_completion,
        tokens_prompt + tokens_completion,
        latency_ms,
        used_fallback,
      ]
    );
  } catch (err) {
    logger.error({ err: err.message }, 'ai_usage_log_insert_failed');
  }
}

/**
 * Get usage totals for a single user.
 */
async function getUserUsage(user_id) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)         FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour')  AS requests_this_hour,
       COUNT(*)         FILTER (WHERE created_at >= CURRENT_DATE)               AS requests_today,
       COALESCE(SUM(tokens_total)   FILTER (WHERE created_at >= CURRENT_DATE), 0) AS tokens_today,
       COUNT(*)         FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS requests_30d,
       COALESCE(SUM(tokens_total)   FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0) AS tokens_30d,
       COUNT(*)         FILTER (WHERE used_fallback AND created_at >= NOW() - INTERVAL '30 days') AS fallback_count_30d
     FROM ai_usage_log
     WHERE user_id = $1`,
    [user_id]
  );
  return rows[0];
}

// getModelStats() was here — an unfiltered aggregate over the whole of
// ai_usage_log, served to tenant studio owners by GET /api/ai/model-stats.
//
// Both are gone. The query could not be made tenant-safe in place: ai_usage_log
// has no organization_id column, so a per-studio figure has to join through
// users, and the platform console already does exactly that in
// modules/platform/super-admin/ai.js behind requireSuperAdmin.
//
// If a per-studio AI usage figure is ever wanted on the TENANT side, it needs a
// new function here that joins ai_usage_log -> users and filters on the caller's
// own organization_id. Do not resurrect this one: an aggregate with no org
// predicate is a cross-tenant read whatever route it is mounted on.

module.exports = { logUsage, getUserUsage };

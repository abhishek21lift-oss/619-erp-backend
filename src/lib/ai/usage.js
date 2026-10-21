'use strict';
const pool   = require('../../db/pool');
const aiConfig = require('./config');
const logger = require('../logger');

/**
 * The provider column names what the ERP actually points every request at,
 * not what it wished it were. Hardcoded 'openrouter' was a lie the moment a
 * gateway took AI_BASE_URL's place: the column existed to answer "who served
 * this" and could not. Derived from the configured base — the one fact that
 * is checkable at insert time without a network probe (AI_BASE_URL is the
 * host lib/ai/openrouter.js calls). What the gateway says answered rides in
 * routed_via instead; the two are different questions.
 */
function providerFromBase() {
  let host = '';
  try {
    host = new URL(aiConfig.baseUrl()).host + '/';
  } catch {
    return 'openai_compatible';
  }
  return /(^|\.)openrouter\.ai(\/|$)/.test(host) ? 'openrouter' : 'openai_compatible';
}

/**
 * Log a completed AI request to the usage_log table.
 * Never throws — logging failures must not break the response.
 *
 * @returns {Promise<{inserted: boolean} | null>}
 *   {inserted:true}  a new row was written;
 *   {inserted:false} this request_id + user_id is already in the ledger and
 *                    was deliberately NOT counted twice (phase-4 idempotency);
 *   null             the ledger could not be written — callers that must not
 *                    silently accept a bookkeeping hole answer for themselves.
 */
async function logUsage({
  user_id, conversation_id, model, organization_id = null, provider,
  intent_type = 'fitness', tokens_prompt = 0, tokens_completion = 0,
  latency_ms = 0, used_fallback = false, cost_inr = null, usage_source = null,
  request_id = null, routed_via = null,
}) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO ai_usage_log
         (user_id, conversation_id, model, provider, intent_type,
          organization_id, routed_via,
          tokens_prompt, tokens_completion, tokens_total,
          latency_ms, used_fallback, cost_inr, usage_source, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (request_id, user_id) WHERE request_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        user_id,
        conversation_id || null,
        model,
        provider || providerFromBase(),
        intent_type,
        organization_id || null,
        routed_via || null,
        tokens_prompt,
        tokens_completion,
        tokens_prompt + tokens_completion,
        Math.round(Number(latency_ms) || 0),
        used_fallback,
        cost_inr,
        usage_source,
        request_id,
      ]
    );
    return { inserted: rows.length > 0 };
  } catch (err) {
    logger.error({ err: err.message }, 'ai_usage_log_insert_failed');
    return null;
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

/**
 * Per-model breakdown for the last 30 days (admin view).
 */
/**
 * One studio's AI usage by model over the last 30 days.
 *
 * New rows carry organization_id, resolved from the authenticated context at
 * write time. Older rows do not: the studio for those is still reached
 * through the user who made each call, so the query prefers the stored org
 * and falls back to the join. The fallback keeps the deploy-month's legacy
 * rows in the count — and it also keeps the ONE documented legacy wart: an
 * old row by a trainer who moved studios keeps attributing to whichever
 * studio that trainer belongs to NOW. New rows are immune to that; the last
 * of them ages out after 30 days.
 */
async function getModelStats(orgId) {
  const { rows } = await pool.query(
    `SELECT
       l.model,
       l.provider,
       l.intent_type,
       COUNT(*)                                                   AS requests,
       COALESCE(SUM(l.tokens_total),0)                           AS tokens_total,
       COALESCE(SUM(l.tokens_prompt),0)                          AS tokens_prompt,
       COALESCE(SUM(l.tokens_completion),0)                      AS tokens_completion,
       COUNT(*) FILTER (WHERE l.created_at >= CURRENT_DATE)      AS requests_today,
       AVG(l.latency_ms)::INTEGER                                AS avg_latency_ms,
       COUNT(*) FILTER (WHERE l.used_fallback)                   AS fallback_count
     FROM ai_usage_log l
     JOIN users u ON u.id = l.user_id
     WHERE l.created_at >= NOW() - INTERVAL '30 days'
       AND COALESCE(l.organization_id, u.organization_id) = $1
     GROUP BY l.model, l.provider, l.intent_type
     ORDER BY requests DESC`,
    [orgId]
  );
  return rows;
}

module.exports = {
  logUsage, getUserUsage, getModelStats };

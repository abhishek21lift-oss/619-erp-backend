// src/modules/command-center/collectors/ai.collector.js
//
// AI operations: routing, volume, latency, fallback rate, tokens, cost — and
// whether what is CONFIGURED matches what is actually HAPPENING.
//
// One honesty note that shapes this whole file. The brief asks for "Success
// Rate / Failure Rate", and `ai_usage_log` has no success column — its inserts
// carry model, provider, intent, tokens, latency and `used_fallback`
// (src/lib/ai/usage.js). Only calls that RETURNED are logged at all, so a
// literal success rate would be 100% by construction and would stay 100%
// through a total outage. What the table can honestly report is the FALLBACK
// rate: the share of requests where the primary model did not answer and a
// lower tier had to. That is the real degradation signal, so it is what this
// card grades on, named for what it is. Failures are seen only by the client
// that made the call (lib/ai/observations.js), and are labelled as such.
//
// ── Four sources, never blended ────────────────────────────────────────────
//
//   A  platform_ai_settings      the operator's override, per tier
//   B  environment / defaults    what a tier falls back to without one
//   C  ai_usage_log              what actually served returned requests
//   D  the gateway (FreeLLMAPI)  what it says it can serve right now
//
// The routing a request uses is A over B (lib/ai/models.js). This card used to
// read A alone, so on the normal deploy — no override set — it reported "No AI
// routing configured" while every request routed fine on B. `routing` is now
// the EFFECTIVE model per tier, with `sources` saying where each came from.
//
// "Configured" is never presented as "active". `active_model` is the model
// that served the most recent returned request (C), whenever that was.
//
// Cost uses the same COST_SQL join as super-admin/ai.js rather than a second
// formula. Two places computing money differently is how a dashboard and an
// invoice end up disagreeing.
'use strict';

const { STATUS, result, unavailable } = require('../registry');
const pool = require('../../../db/pool');
const aiConfig = require('../../../lib/ai/config');
const aiSettings = require('../../../lib/ai/settings');
const { models: aiModels } = require('../../../lib/ai/models');
const gateway = require('../../../lib/ai/gateway');
const observations = require('../../../lib/ai/observations');
const { configuredInCatalog } = require('./freellmapi.collector');

const NAME = 'ai';

const LATENCY_WARN_MS = Number(process.env.CC_AI_LATENCY_WARN_MS) || 4000;
const LATENCY_CRIT_MS = Number(process.env.CC_AI_LATENCY_CRIT_MS) || 12000;
const FALLBACK_WARN = 0.10;
const FALLBACK_CRIT = 0.30;
/** Consecutive failed calls, with no success since, that mean "AI is down". */
const FAILURE_STREAK = 3;
const FAILURE_RECENCY_MS = 15 * 60 * 1000;

const TIERS = ['primary', 'secondary', 'fallback'];

// Identical to super-admin/ai.js. An unpriced model contributes tokens but
// zero cost rather than dropping the row to NULL — which is why the card also
// reports `cost_is_floor`.
const COST_SQL = `
  (COALESCE(r.prompt_per_1k_inr, 0)     * l.tokens_prompt     / 1000.0
 + COALESCE(r.completion_per_1k_inr, 0) * l.tokens_completion / 1000.0)`;

const GATEWAY_WAIT_MS = 3000;

/** Resolve to null rather than wait past `ms`. The work itself carries on. */
function withTimeout(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise.catch(() => null), deadline]).finally(() => clearTimeout(timer));
}

async function optional(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

const int = (v) => (v === null || v === undefined ? null : Number(v));

/** Where each tier's effective model comes from. Mirrors lib/ai/models.js. */
function effectiveRouting(overrideRow) {
  const out = { sources: {}, override: {}, from_env: {} };
  for (const tier of TIERS) {
    out[tier] = aiModels[tier] ?? null;
    const envName = `AI_${tier.toUpperCase()}_MODEL`;
    out.override[tier] = overrideRow?.[`${tier}_model`] ?? null;
    out.from_env[tier] = process.env[envName] || null;
    out.sources[tier] = aiSettings.override(tier) ? 'override' : (process.env[envName] ? 'env' : 'default');
  }
  out.updated_at = overrideRow?.updated_at ?? null;
  return out;
}

/**
 * Configuration versus reality. Pure: every input is passed in.
 *
 * @returns {{ state: 'consistent'|'mismatch'|'runtime_failure'|'not_verified',
 *             findings: Array<{code, severity, message, source}>,
 *             verified: { catalog: boolean, traffic: boolean, gateway: boolean } }}
 */
function reconcile({ routing, served24h, probe, verdict, obs, now = Date.now() }) {
  const findings = [];
  const add = (code, severity, message, source) => findings.push({ code, severity, message, source });

  // ── D: the gateway itself ────────────────────────────────────────────────
  if (verdict?.status === STATUS.CRITICAL) {
    add('gateway_failure', 'critical', verdict.reason, 'FreeLLMAPI status (/livez, /readyz, /v1/providers)');
  }

  // ── The client's own calls ───────────────────────────────────────────────
  const lf = obs?.last_failure;
  const ls = obs?.last_success;
  if (obs && obs.consecutive_failures >= FAILURE_STREAK && lf
      && now - Date.parse(lf.at) <= FAILURE_RECENCY_MS
      && (!ls || Date.parse(ls.at) < Date.parse(lf.at))) {
    add('recent_calls_failing', 'critical',
      `The last ${obs.consecutive_failures} AI calls from this API process failed (latest: ${lf.error_class}${lf.http_status ? ` ${lf.http_status}` : ''}) and none has succeeded since`,
      'this API process (lib/ai/observations)');
  }

  // ── A/B against D: is each configured model in the catalog, and available? ─
  const catalogReadable = probe?.kind === 'freellmapi' && Array.isArray(probe?.catalog?.models);
  if (catalogReadable) {
    const seen = new Set();
    for (const c of configuredInCatalog(probe.catalog)) {
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.in_catalog === false) {
        add('configured_model_missing', 'warning',
          `Configured ${c.tier} model "${c.id}" is not in FreeLLMAPI's catalog, so requests for it cannot be routed`,
          'routing vs GET /v1/models');
      } else if (c.available === false) {
        add('configured_model_unavailable', 'warning',
          `Configured ${c.tier} model "${c.id}" is in FreeLLMAPI's catalog but unavailable (${c.unavailable_reason ?? 'no reason given'})`,
          'routing vs GET /v1/models');
      }
    }
  }

  // ── A/B against C: does traffic go where routing says? ───────────────────
  // Only meaningful when every tier names a concrete model. A router id
  // ("auto") serves a different underlying model per request BY DESIGN, so a
  // served model that differs from it is the router working, not drift.
  const configured = TIERS.map((t) => routing?.[t]).filter(Boolean);
  const anyRouter = configured.some((id) => gateway.isRouterModel(id));
  const served = Array.isArray(served24h) ? served24h : [];
  if (served.length && configured.length && !anyRouter) {
    const set = new Set(configured);
    if (!served.some((s) => set.has(s.model))) {
      add('serving_unconfigured_model', 'warning',
        `Routing names ${[...set].join(', ')}, but the last 24h was served by ${served.slice(0, 3).map((s) => s.model).join(', ')}`,
        'routing vs ai_usage_log');
    }
  }

  // ── Informational: an override is shadowing the environment ──────────────
  for (const t of TIERS) {
    const o = routing?.override?.[t];
    const e = routing?.from_env?.[t];
    if (routing?.sources?.[t] === 'override' && e && o && o !== e) {
      add('override_shadows_env', 'info',
        `The ${t} tier follows the Control Centre override "${o}", not ${`AI_${t.toUpperCase()}_MODEL`}="${e}"`,
        'platform_ai_settings vs environment');
    }
  }

  const verified = {
    catalog: catalogReadable,
    traffic: served.length > 0,
    gateway: probe?.kind === 'freellmapi'
      && [STATUS.HEALTHY, STATUS.DEGRADED, STATUS.WARNING].includes(verdict?.status),
  };

  let state = 'not_verified';
  if (findings.some((f) => f.severity === 'critical')) state = 'runtime_failure';
  else if (findings.some((f) => f.severity === 'warning')) state = 'mismatch';
  else if (verified.catalog || verified.traffic) state = 'consistent';

  return { state, findings, verified };
}

async function collect() {
  if (!aiConfig.isConfigured()) {
    // `expected: true` — the probe answered. There is no provider key, so no AI
    // request can be made: a capability this deployment has not wired up, not
    // a blind spot. See snapshot.service.js observabilityOf().
    return unavailable(NAME, `No AI provider is configured. ${aiConfig.configurationProblem()}`, true);
  }

  const [today, overrideRow, recent, last, served24h, probe] = await Promise.all([
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT count(*)::int                                          AS requests,
               ROUND(AVG(NULLIF(l.latency_ms, 0)))::int               AS avg_latency_ms,
               MAX(NULLIF(l.latency_ms, 0))::int                      AS max_latency_ms,
               (percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)
                  FILTER (WHERE l.latency_ms > 0))::int               AS p95_latency_ms,
               COALESCE(SUM(l.tokens_total), 0)::bigint                AS tokens,
               count(*) FILTER (WHERE l.used_fallback)::int            AS fallbacks,
               count(DISTINCT l.model)::int                            AS models_used,
               COALESCE(SUM(${COST_SQL}), 0)::numeric                  AS cost_inr,
               count(DISTINCT l.model) FILTER (WHERE r.model IS NULL)::int AS unpriced_models
          FROM ai_usage_log l
          LEFT JOIN ai_model_rates r ON r.model = l.model
         WHERE l.created_at >= date_trunc('day', now())`);
      const r = rows[0];
      const requests = r.requests;
      return {
        requests,
        // With no request there is nothing to time: null, never 0ms.
        avg_latency_ms: requests ? int(r.avg_latency_ms) : null,
        max_latency_ms: requests ? int(r.max_latency_ms) : null,
        p95_latency_ms: requests ? int(r.p95_latency_ms) : null,
        tokens: Number(r.tokens),
        fallbacks: r.fallbacks,
        fallback_rate: requests ? Math.round((r.fallbacks / requests) * 1000) / 1000 : null,
        models_used: r.models_used,
        cost_inr: Number(r.cost_inr),
        // Unpriced models contribute tokens but no cost, so the figure is a floor.
        cost_is_floor: r.unpriced_models > 0,
      };
    }),
    optional(async () => {
      const { rows } = await pool.query(
        `SELECT primary_model, secondary_model, fallback_model, updated_at
           FROM platform_ai_settings WHERE id = 'singleton'`);
      return rows[0] || {};
    }),
    // The last hour separately: a daily average hides an outage that started
    // twenty minutes ago, which is exactly the window an operator is looking at.
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT count(*)::int                                        AS requests,
               ROUND(AVG(NULLIF(latency_ms, 0)))::int                AS avg_latency_ms,
               MAX(NULLIF(latency_ms, 0))::int                       AS max_latency_ms,
               count(*) FILTER (WHERE used_fallback)::int            AS fallbacks
          FROM ai_usage_log
         WHERE created_at >= now() - interval '1 hour'`);
      return rows[0];
    }),
    // The most recent RETURNED request, however long ago. ai_usage_log only
    // records calls that came back, so this is the last successful one.
    optional(async () => {
      const { rows } = await pool.query(
        `SELECT model, provider, used_fallback, created_at
           FROM ai_usage_log ORDER BY created_at DESC LIMIT 1`);
      return rows[0] || null;
    }),
    optional(async () => {
      const { rows } = await pool.query(`
        SELECT model, count(*)::int AS requests, max(created_at) AS last_at
          FROM ai_usage_log
         WHERE created_at >= now() - interval '24 hours'
         GROUP BY model
         ORDER BY count(*) DESC
         LIMIT 10`);
      return rows.map((r) => ({ model: r.model, requests: r.requests, last_at: r.last_at }));
    }),
    // Capped well inside this card's own 5s deadline. A gateway that is
    // black-holed must cost the AI card its gateway half, not the whole card —
    // the freellmapi card reports the hang itself.
    withTimeout(gateway.probe(), GATEWAY_WAIT_MS),
  ]);

  const routing = effectiveRouting(overrideRow);
  const verdict = probe
    ? gateway.grade(probe)
    : { status: STATUS.UNAVAILABLE, reason: `The gateway probe did not finish within ${GATEWAY_WAIT_MS}ms` };
  const obs = observations.summary();

  const hourRequests = recent?.requests ?? null;
  const hourFallbackRate = hourRequests ? (recent.fallbacks ?? 0) / hourRequests : null;
  const hourLatency = hourRequests ? int(recent.avg_latency_ms) : null;

  const reconciliation = reconcile({ routing, served24h, probe, verdict, obs });

  const data = {
    routing,
    // Which model actually served the most recent returned request — never
    // the configured one. Null when nothing has ever been served.
    active_model: last?.model ?? null,
    active_model_at: last?.created_at ?? null,
    active_used_fallback: last ? Boolean(last.used_fallback) : null,
    last_request_at: last?.created_at ?? null,
    today,
    last_hour: recent ? {
      requests: hourRequests,
      avg_latency_ms: hourLatency,
      max_latency_ms: hourRequests ? int(recent.max_latency_ms) : null,
      fallbacks: recent.fallbacks ?? 0,
      fallback_rate: hourFallbackRate == null ? null : Math.round(hourFallbackRate * 1000) / 1000,
    } : null,
    served_models_24h: served24h,
    gateway: {
      kind: probe?.kind ?? null,
      endpoint: probe?.endpoint ?? null,
      status: verdict.status,
      reason: verdict.reason,
    },
    // What this API process saw its own calls do, including failures the
    // usage log never records. Process-scoped and labelled as such.
    observed: {
      scope: obs.scope,
      since: obs.since,
      calls_15m: obs.calls,
      failures_15m: obs.failures,
      consecutive_failures: obs.consecutive_failures,
      latency_ms: obs.latency_ms,
      last_success: obs.last_success,
      last_failure: obs.last_failure,
    },
    reconciliation,
    usage_readable: today !== null && recent !== null,
    // Stated so nobody reads the absence of a failure count as zero failures.
    note: 'ai_usage_log records returned calls only; fallback rate is the degradation signal, not a success rate. '
      + 'Failures are observed per process.',
  };

  let status = STATUS.HEALTHY;
  let reason = null;

  if (!hourRequests) {
    // Idle is not unhealthy. Overnight there is simply no traffic, and an
    // amber card every night is a card nobody looks at by the weekend.
  } else if (hourFallbackRate != null && hourFallbackRate >= FALLBACK_CRIT) {
    status = STATUS.CRITICAL;
    reason = `${Math.round(hourFallbackRate * 100)}% of AI calls fell back off ${routing.primary} in the last hour`;
  } else if (hourLatency != null && hourLatency >= LATENCY_CRIT_MS) {
    status = STATUS.CRITICAL;
    reason = `AI average latency ${hourLatency}ms in the last hour`;
  } else if (hourFallbackRate != null && hourFallbackRate >= FALLBACK_WARN) {
    status = STATUS.WARNING;
    reason = `${Math.round(hourFallbackRate * 100)}% fallback rate in the last hour`;
  } else if (hourLatency != null && hourLatency >= LATENCY_WARN_MS) {
    status = STATUS.WARNING;
    reason = `AI average latency ${hourLatency}ms in the last hour`;
  }

  // Reconciliation can only raise the grade, never lower one the traffic set.
  const firstOf = (sev) => reconciliation.findings.find((f) => f.severity === sev)?.message ?? null;
  if (reconciliation.state === 'runtime_failure' && status !== STATUS.CRITICAL) {
    status = STATUS.CRITICAL;
    reason = firstOf('critical');
  } else if (reconciliation.state === 'mismatch' && status === STATUS.HEALTHY) {
    status = STATUS.WARNING;
    reason = `Configuration mismatch: ${firstOf('warning')}`;
  }

  // The usage log could not be read: the traffic half of this card is blind.
  // Degraded rather than alarming — AI may be fine; we simply cannot see.
  if (!data.usage_readable && status === STATUS.HEALTHY) {
    status = STATUS.DEGRADED;
    reason = 'ai_usage_log could not be read, so traffic, latency and cost are unavailable';
  }

  return result(NAME, { status, data, reason });
}

module.exports = {
  NAME, collect, reconcile, effectiveRouting, COST_SQL,
  LATENCY_WARN_MS, LATENCY_CRIT_MS, FALLBACK_WARN, FALLBACK_CRIT, FAILURE_STREAK,
};

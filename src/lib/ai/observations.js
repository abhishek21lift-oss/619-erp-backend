'use strict';
// src/lib/ai/observations.js
//
// What THIS process has seen the AI gateway do, recently.
//
// ── Why this exists when ai_usage_log already does ─────────────────────────
//
// ai_usage_log is the platform's record of AI traffic and stays the authority
// for volume, tokens, cost and which model served a request. But it is written
// by the route AFTER a call returns, so it has two blind spots that matter to
// an operator:
//
//   1. FAILURES. A call that threw is never logged. The table cannot tell an
//      outage from a quiet hour — both are an absence of rows.
//   2. WHICH UPSTREAM. The gateway may answer from any provider. FreeLLMAPI
//      says which in an `X-Routed-Via: <platform>/<model>` header, and the
//      body only carries the model.
//
// The client sees both, so it records them here: a small ring of the last
// calls, outcome and all. Nothing is persisted and nothing secret is kept —
// error text goes through secretScrub before it is stored.
//
// ── What this is NOT ──────────────────────────────────────────────────────
//
// It is per-process. AI work also runs in the worker container, and a second
// API replica has its own ring. Every summary says so (`scope: 'process'`,
// `since`), so a green "no recent failures" is read as the narrow claim it is.

const { scrubBounded } = require('../secretScrub');

const LIMIT = 200;
const ring = [];
const startedAt = new Date().toISOString();

/**
 * Classify a failed gateway call into something an operator can act on.
 * Never inspects or returns the request, only the error.
 */
function classify(err) {
  const status = Number(err?.status) || null;
  if (err?.code === 'NOT_CONFIGURED') return { error_class: 'not_configured', http_status: null };
  if (err?.code === 'TIMEOUT') return { error_class: 'timeout', http_status: null };
  if (status === 401 || status === 403) return { error_class: 'auth_rejected', http_status: status };
  if (status === 404) return { error_class: 'model_not_found', http_status: status };
  if (status === 429) return { error_class: 'rate_limited', http_status: status };
  if (status && status >= 500) return { error_class: 'upstream_error', http_status: status };
  if (status && status >= 400) return { error_class: 'request_rejected', http_status: status };
  // fetch() rejects with a TypeError whose cause carries the socket error.
  const cause = err?.cause?.code || err?.code;
  if (cause && /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|UND_ERR_)/.test(String(cause))) {
    return { error_class: 'unreachable', http_status: null };
  }
  return { error_class: 'unknown', http_status: status };
}

/**
 * Parse FreeLLMAPI's `X-Routed-Via: <platform>/<model>` header.
 * The platform is everything before the FIRST slash; model ids contain slashes.
 */
function parseRoutedVia(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (v === 'cache') return { provider: 'cache', model: null };
  const i = v.indexOf('/');
  if (i <= 0) return { provider: v.slice(0, 80), model: null };
  return { provider: v.slice(0, i).slice(0, 80), model: v.slice(i + 1).slice(0, 200) || null };
}

/** Read the routing headers a gateway may set. Absent headers stay null. */
function routingHeaders(headers) {
  const get = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
  const routed = parseRoutedVia(get('x-routed-via'));
  const attempts = Number(get('x-fallback-attempts'));
  return {
    routed_via: routed,
    gateway_fallback_attempts: Number.isFinite(attempts) && attempts >= 0 ? attempts : null,
  };
}

function push(entry) {
  ring.push(entry);
  if (ring.length > LIMIT) ring.shift();
}

/** A call that returned. */
function recordSuccess({ requested_model, served_model, routed_via, gateway_fallback_attempts, latency_ms, stream }) {
  push({
    at: Date.now(),
    ok: true,
    stream: Boolean(stream),
    requested_model: requested_model ?? null,
    served_model: served_model ?? null,
    provider: routed_via?.provider ?? null,
    gateway_fallback_attempts: gateway_fallback_attempts ?? null,
    latency_ms: Number.isFinite(latency_ms) ? Math.round(latency_ms) : null,
  });
}

/** A call that threw. The message is scrubbed and bounded before it is kept. */
function recordFailure({ requested_model, err, latency_ms, stream, secrets = [] }) {
  const { error_class, http_status } = classify(err);
  push({
    at: Date.now(),
    ok: false,
    stream: Boolean(stream),
    requested_model: requested_model ?? null,
    served_model: null,
    provider: null,
    error_class,
    http_status,
    error: scrubBounded(err?.message ?? 'unknown error', { secrets, max: 200 }),
    latency_ms: Number.isFinite(latency_ms) ? Math.round(latency_ms) : null,
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * What this process has seen, over a window.
 *
 * Every number is null when there is nothing to compute it from — no call is
 * not a zero-latency call, and no failure in an empty window is not a 0%
 * failure rate.
 */
function summary({ windowMs = 15 * 60 * 1000, now = Date.now() } = {}) {
  const since = now - windowMs;
  const inWindow = ring.filter((e) => e.at >= since);
  const ok = inWindow.filter((e) => e.ok);
  const failed = inWindow.filter((e) => !e.ok);
  const lat = ok.map((e) => e.latency_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  const lastSuccess = [...ring].reverse().find((e) => e.ok) || null;
  const lastFailure = [...ring].reverse().find((e) => !e.ok) || null;

  let consecutiveFailures = 0;
  for (let i = ring.length - 1; i >= 0 && !ring[i].ok; i -= 1) consecutiveFailures += 1;

  const byProvider = {};
  for (const e of ok) {
    if (!e.provider) continue;
    const p = (byProvider[e.provider] ||= { provider: e.provider, calls: 0, latencies: [] });
    p.calls += 1;
    if (Number.isFinite(e.latency_ms)) p.latencies.push(e.latency_ms);
  }

  return {
    scope: 'process',
    since: startedAt,
    window_ms: windowMs,
    calls: inWindow.length,
    failures: failed.length,
    failure_rate: inWindow.length ? Math.round((failed.length / inWindow.length) * 1000) / 1000 : null,
    consecutive_failures: consecutiveFailures,
    latency_ms: lat.length
      ? {
        avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length),
        p95: percentile(lat, 0.95),
        max: lat[lat.length - 1],
        samples: lat.length,
      }
      : null,
    last_success: lastSuccess && {
      at: new Date(lastSuccess.at).toISOString(),
      requested_model: lastSuccess.requested_model,
      served_model: lastSuccess.served_model,
      provider: lastSuccess.provider,
      latency_ms: lastSuccess.latency_ms,
    },
    last_failure: lastFailure && {
      at: new Date(lastFailure.at).toISOString(),
      requested_model: lastFailure.requested_model,
      error_class: lastFailure.error_class,
      http_status: lastFailure.http_status,
      error: lastFailure.error,
    },
    providers: Object.values(byProvider).map((p) => {
      const s = p.latencies.sort((a, b) => a - b);
      return {
        provider: p.provider,
        calls: p.calls,
        avg_latency_ms: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null,
      };
    }),
  };
}

/** Tests only. */
function _reset() { ring.length = 0; }

module.exports = {
  recordSuccess, recordFailure, summary, classify, parseRoutedVia, routingHeaders, _reset, LIMIT,
};

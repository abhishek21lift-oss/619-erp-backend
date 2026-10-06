'use strict';
// src/lib/ai/gateway.js
//
// What the AI gateway at AI_BASE_URL says about itself.
//
// ── The one gateway, read the one way ──────────────────────────────────────
//
// Every AI request in this codebase goes to aiConfig.baseUrl() with
// aiConfig.apiKey() as a bearer token (lib/ai/openrouter.js). That is either
// OpenRouter or — in production — a FreeLLMAPI instance on the compose network,
// an OpenAI-compatible router that stacks the free tiers of many providers
// behind one /v1 endpoint. This module does not add a second configuration: it
// reads the same two values and asks the same host about its own state.
//
// ── What FreeLLMAPI exposes, and what it does not ─────────────────────────
//
// Read from its source (server/src/routes/status.ts, proxy.ts), not assumed:
//
//   GET /livez          no auth   { status, version, uptime_s } | 503 + checks
//   GET /readyz         no auth   { status, ready_upstreams } | 503 + reason
//   GET /v1/providers   unified key   per-provider status, enabled key count,
//                                    cooldown resume time, last probe error.
//                                    "no key material and no PII" by design.
//   GET /v1/models      unified key   the catalog, each with `available`,
//                                    `unavailable_reason`, `owned_by`.
//
// Per-KEY health lives at /api/health behind FreeLLMAPI's dashboard session.
// That session can also export every stored provider key, so the ERP must
// never hold it. Per-key health is therefore reported as unavailable, with
// that reason, rather than reconstructed from anything.
//
// ── Safety properties ─────────────────────────────────────────────────────
//
//   * No caller-supplied URL. Every probe is a fixed path on the configured
//     base; there is nothing an operator can type that changes the host.
//   * Redirects are refused, so a misbehaving gateway cannot bounce the bearer
//     token to another host.
//   * The bearer goes only to the /v1 paths, which already receive it on every
//     chat request. /livez and /readyz are probed without it.
//   * Bodies are size-capped and parsed defensively; every string that came
//     from the gateway is scrubbed and length-bounded before it is returned.
//   * The endpoint is reported as scheme://host:port/path — never userinfo,
//     never a query string.

const aiConfig = require('./config');
const { scrubBounded } = require('../secretScrub');

// Per request. /livez runs first, then the other three in parallel, so a
// black-holed gateway costs at most 2x this — inside the 5s collector deadline
// every other card already uses.
const PROBE_TIMEOUT_MS = Number(process.env.CC_AI_GATEWAY_TIMEOUT_MS) || 2500;
const MAX_BODY_BYTES = 1024 * 1024;
/** Two collectors read this; one probe serves both. */
const MEMO_MS = 10_000;

const PROVIDER_STATUSES = new Set(['healthy', 'rate_limited', 'invalid', 'unknown']);

/** Ids that name a router rather than a model: what serves them varies by design. */
function isRouterModel(id) {
  if (typeof id !== 'string') return false;
  return id === 'auto' || id.startsWith('auto:') || id === 'fusion' || id === 'openrouter/auto';
}

/**
 * The configured base, described without anything secret.
 * @returns {{ ok: true, url: URL, endpoint: string, root: string, isOpenRouter: boolean } | { ok: false, reason: string }}
 */
function describeBase(base = aiConfig.baseUrl()) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return { ok: false, reason: 'AI_BASE_URL is not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `AI_BASE_URL uses an unsupported scheme (${url.protocol.replace(':', '')})` };
  }
  const path = url.pathname.replace(/\/+$/, '');
  return {
    ok: true,
    url,
    // Deliberately rebuilt from parts: url.href would carry userinfo.
    endpoint: `${url.protocol}//${url.host}${path}`,
    // Where /livez and /readyz live: the base with its trailing /v1 removed.
    root: `${url.protocol}//${url.host}${path.replace(/\/v1$/, '')}`,
    v1: `${url.protocol}//${url.host}${path}`,
    isOpenRouter: /(^|\.)openrouter\.ai$/i.test(url.hostname),
  };
}

/** Read a response body, refusing to buffer more than the cap. */
async function readCapped(res) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return text.length > MAX_BODY_BYTES ? null : text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * GET one fixed path. Never throws.
 * @returns {Promise<{ reachable: boolean, status: number|null, json: any, latency_ms: number, error_class?: string, error?: string }>}
 */
async function getJson(url, { auth = false, signal } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  const key = auth ? aiConfig.apiKey() : null;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        reachable: true, status: res.status, json: null, latency_ms: Date.now() - started,
        error_class: 'redirect_refused', error: 'The gateway answered with a redirect, which is not followed',
      };
    }
    const text = await readCapped(res);
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    return { reachable: true, status: res.status, json, latency_ms: Date.now() - started };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const cause = err?.cause?.code || err?.code || null;
    return {
      reachable: false,
      status: null,
      json: null,
      latency_ms: Date.now() - started,
      error_class: aborted ? 'timeout' : 'unreachable',
      error: scrubBounded(aborted ? `No answer within ${PROBE_TIMEOUT_MS}ms` : (cause || err?.message || 'connection failed'),
        { secrets: [aiConfig.apiKey()], max: 160 }),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v) => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** FreeLLMAPI's /v1/providers entries, reduced to known fields and scrubbed. */
function normaliseProviders(json) {
  const raw = Array.isArray(json?.providers) ? json.providers : null;
  if (!raw) return null;
  return raw.slice(0, 100).map((p) => {
    const status = PROVIDER_STATUSES.has(p?.status) ? p.status : 'unknown';
    return {
      id: str(p?.platform, 60) ?? 'unknown',
      name: str(p?.name, 80) ?? str(p?.platform, 60) ?? 'unknown',
      status,
      enabled_keys: num(p?.keys),
      resume_at: iso(p?.resume_at),
      last_error: p?.last_error ? scrubBounded(p.last_error, { secrets: [aiConfig.apiKey()], max: 200 }) : null,
      requests_remaining_pct: num(p?.requests_remaining_pct),
    };
  });
}

/** FreeLLMAPI's /v1/models, split into real models and router entries. */
function normaliseModels(json) {
  const raw = Array.isArray(json?.data) ? json.data : null;
  if (!raw) return null;
  const models = [];
  const routers = [];
  for (const m of raw.slice(0, 5000)) {
    const id = str(m?.id, 200);
    if (!id) continue;
    const entry = {
      id,
      provider: str(m?.owned_by, 60),
      // `available` is FreeLLMAPI's own field. Absent means the gateway did not
      // say — null, never assumed true.
      available: typeof m?.available === 'boolean' ? m.available : null,
      unavailable_reason: str(m?.unavailable_reason, 40),
    };
    if (entry.provider === 'freellmapi' || isRouterModel(id)) routers.push(entry);
    else models.push(entry);
  }
  return { models, routers };
}

/**
 * Probe the gateway once. Never throws.
 *
 * `kind` is the answer to "what is at AI_BASE_URL":
 *   not_configured   no API key, so nothing calls it
 *   invalid          AI_BASE_URL does not parse
 *   openrouter       OpenRouter — FreeLLMAPI is not in the request path
 *   freellmapi       /livez answered in FreeLLMAPI's shape
 *   openai_compatible  reachable, but not FreeLLMAPI: no status surface to read
 *   unreachable      nothing answered; cannot tell what it is
 */
async function probeOnce({ signal } = {}) {
  const checkedAt = new Date().toISOString();
  if (!aiConfig.isConfigured()) {
    return { kind: 'not_configured', checked_at: checkedAt, reason: aiConfig.configurationProblem() };
  }
  const base = describeBase();
  if (!base.ok) return { kind: 'invalid', checked_at: checkedAt, reason: base.reason };
  if (base.isOpenRouter) return { kind: 'openrouter', checked_at: checkedAt, endpoint: base.endpoint };

  const livez = await getJson(`${base.root}/livez`, { signal });
  const lj = livez.json;
  const identified = Boolean(lj && typeof lj === 'object' && 'uptime_s' in lj && 'version' in lj);

  const service = {
    reachable: livez.reachable,
    live: identified ? livez.status === 200 : null,
    version: identified ? str(lj.version, 40) : null,
    uptime_s: identified ? num(lj.uptime_s) : null,
    checks: identified && lj.checks && typeof lj.checks === 'object'
      ? { db: lj.checks.db ?? null, encryption_key: lj.checks.encryption_key ?? null }
      : null,
    latency_ms: livez.latency_ms,
    http_status: livez.status,
    error_class: livez.error_class ?? null,
    error: livez.error ?? null,
  };

  if (!livez.reachable) {
    return { kind: 'unreachable', checked_at: checkedAt, endpoint: base.endpoint, service };
  }
  if (!identified) {
    return { kind: 'openai_compatible', checked_at: checkedAt, endpoint: base.endpoint, service };
  }

  const [readyz, providersRes, modelsRes] = await Promise.all([
    getJson(`${base.root}/readyz`, { signal }),
    getJson(`${base.v1}/providers`, { auth: true, signal }),
    getJson(`${base.v1}/models`, { auth: true, signal }),
  ]);

  const rj = readyz.json || {};
  const readiness = {
    ready: readyz.reachable ? readyz.status === 200 : null,
    ready_upstreams: num(rj.ready_upstreams),
    reason: str(rj.reason, 60),
    http_status: readyz.status,
  };

  const surface = (res, label) => {
    if (!res.reachable) return { exposed: null, reason: `${label} did not answer (${res.error_class})` };
    if (res.status === 401 || res.status === 403) return { exposed: false, auth_rejected: true, reason: `${label} rejected the ERP's API key (HTTP ${res.status})` };
    if (res.status === 404) return { exposed: false, reason: `${label} is not exposed by this FreeLLMAPI version` };
    if (res.status !== 200) return { exposed: false, reason: `${label} answered HTTP ${res.status}` };
    return { exposed: true, reason: null };
  };

  const providersSurface = surface(providersRes, 'GET /v1/providers');
  const modelsSurface = surface(modelsRes, 'GET /v1/models');
  const providers = providersSurface.exposed ? normaliseProviders(providersRes.json) : null;
  const catalog = modelsSurface.exposed ? normaliseModels(modelsRes.json) : null;

  return {
    kind: 'freellmapi',
    checked_at: checkedAt,
    endpoint: base.endpoint,
    service,
    readiness,
    providers: {
      source: 'GET /v1/providers',
      ...providersSurface,
      ...(providersSurface.exposed && !providers ? { exposed: false, reason: 'GET /v1/providers returned an unrecognised shape' } : {}),
      items: providers,
    },
    catalog: {
      source: 'GET /v1/models',
      ...modelsSurface,
      ...(modelsSurface.exposed && !catalog ? { exposed: false, reason: 'GET /v1/models returned an unrecognised shape' } : {}),
      models: catalog?.models ?? null,
      routers: catalog?.routers ?? null,
    },
  };
}

// ── Coalescing ───────────────────────────────────────────────────────────────
// The ai and freellmapi collectors, the alert tick and an operator's re-probe
// can all ask within the same second. One probe answers all of them.
let memo = null;     // { at, value }
let inflight = null; // Promise

// No caller's AbortSignal is threaded into the shared probe: it serves several
// callers, and one collector hitting its own deadline must not cancel the read
// for the others. Each request carries PROBE_TIMEOUT_MS of its own, so the
// work is bounded regardless (livez, then the other three in parallel).
async function probe({ fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memo.at < MEMO_MS) return memo.value;
  if (inflight) return inflight;
  inflight = probeOnce()
    .then((value) => { memo = { at: Date.now(), value }; return value; })
    .finally(() => { inflight = null; });
  return inflight;
}

// ── Grading ──────────────────────────────────────────────────────────────────

/**
 * One verdict for "is the gateway working", shared by every surface that
 * shows it so the ai card and the freellmapi card cannot disagree.
 *
 * @returns {{ status: string, reason: string|null, expected?: boolean }}
 */
function grade(p) {
  switch (p?.kind) {
    case 'not_configured':
      return { status: 'unavailable', expected: true, reason: p.reason || 'The AI provider key is not configured' };
    case 'invalid':
      return { status: 'critical', reason: p.reason };
    case 'openrouter':
      return { status: 'unavailable', expected: true, reason: 'AI_BASE_URL points at OpenRouter; FreeLLMAPI is not in the request path' };
    case 'openai_compatible':
      return {
        status: 'unavailable', expected: true,
        reason: `The gateway at ${p.endpoint} is not FreeLLMAPI (no /livez status), so its providers, models and keys cannot be inspected`,
      };
    case 'unreachable':
      return {
        status: 'critical',
        reason: `The AI gateway at ${p.endpoint} is unreachable (${p.service?.error_class ?? 'no answer'}); every AI request goes there`,
      };
    case 'freellmapi':
      break;
    default:
      return { status: 'unavailable', reason: 'The gateway has not been probed' };
  }

  if (p.service?.live === false) {
    const failed = Object.entries(p.service.checks || {}).filter(([, ok]) => ok === false).map(([k]) => k);
    return { status: 'critical', reason: `FreeLLMAPI is up but not live${failed.length ? ` (failed: ${failed.join(', ')})` : ''}` };
  }
  if (p.providers?.auth_rejected || p.catalog?.auth_rejected) {
    return { status: 'critical', reason: 'FreeLLMAPI rejected the ERP\'s API key, so every AI request will be refused' };
  }
  if (p.readiness?.ready === false) {
    const why = p.readiness.reason;
    if (why === 'all_upstreams_rate_limited') {
      return { status: 'warning', reason: 'Every FreeLLMAPI upstream is rate-limited right now; requests will wait or fail until a cooldown ends' };
    }
    return {
      status: 'critical',
      reason: why === 'no_upstreams_configured'
        ? 'FreeLLMAPI has no enabled provider key, so it cannot serve any request'
        : `FreeLLMAPI reports no serviceable upstream (${why ?? 'not ready'})`,
    };
  }

  const items = p.providers?.items;
  if (Array.isArray(items) && items.length) {
    const invalid = items.filter((x) => x.status === 'invalid');
    const limited = items.filter((x) => x.status === 'rate_limited');
    if (invalid.length) {
      return {
        status: 'warning',
        reason: `${invalid.length} of ${items.length} FreeLLMAPI provider${items.length === 1 ? '' : 's'} failing: ${invalid.map((x) => x.name).join(', ')}`,
      };
    }
    if (limited.length) {
      return {
        status: 'degraded',
        reason: `${limited.length} of ${items.length} provider${items.length === 1 ? '' : 's'} cooling down after rate limits: ${limited.map((x) => x.name).join(', ')}`,
      };
    }
  }

  const avail = p.catalog?.models;
  if (Array.isArray(avail) && avail.length && !avail.some((m) => m.available === true)) {
    return { status: 'critical', reason: 'FreeLLMAPI lists models but none is available to serve a request' };
  }

  return { status: 'healthy', reason: null };
}

/** Tests only. */
function _reset() { memo = null; inflight = null; }

module.exports = {
  probe, grade, describeBase, isRouterModel, normaliseProviders, normaliseModels,
  PROBE_TIMEOUT_MS, MEMO_MS, _reset,
};

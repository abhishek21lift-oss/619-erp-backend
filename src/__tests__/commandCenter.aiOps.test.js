// AI Operations in the Command Center: FreeLLMAPI health, providers, models,
// keys, configuration-versus-reality, and the AI commands.
//
// The network boundary is the only thing faked: global fetch answers as
// FreeLLMAPI does (shapes copied from its server/src/routes/status.ts and
// proxy.ts), and the pool answers as ai_usage_log would. Everything between —
// the gateway probe, the grading, both collectors, the commands and the route
// guards — is the real code.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const BASE = 'http://freellmapi:3001/v1';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(),
}));

const mockLogActivity = jest.fn(async () => {});
jest.mock('../lib/activityLog', () => ({ logActivity: (...a) => mockLogActivity(...a) }));

// ── The usage log, as configurable fixtures ──────────────────────────────────
const usage = {
  today: { requests: 0, avg_latency_ms: null, max_latency_ms: null, p95_latency_ms: null, tokens: 0, fallbacks: 0, models_used: 0, cost_inr: 0, unpriced_models: 0 },
  hour: { requests: 0, avg_latency_ms: null, max_latency_ms: null, fallbacks: 0 },
  last: null,
  served: [],
  inventory: [],
  override: {},
  mfa: true,
  fail: false,
};
jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql) => {
    const flat = String(sql).replace(/\s+/g, ' ');
    if (usage.fail && /ai_usage_log/.test(flat)) throw new Error('relation does not exist');
    if (/FROM user_profiles/.test(flat)) return { rows: [{ mfa_enabled: usage.mfa }] };
    if (/platform_ai_settings/.test(flat)) return { rows: [usage.override] };
    if (/percentile_cont/.test(flat)) return { rows: [usage.today] };
    if (/interval '1 hour'/.test(flat)) return { rows: [usage.hour] };
    if (/ORDER BY created_at DESC LIMIT 1/.test(flat)) return { rows: usage.last ? [usage.last] : [] };
    if (/interval '24 hours'/.test(flat)) return { rows: usage.served };
    if (/interval '30 days'/.test(flat)) return { rows: usage.inventory };
    return { rows: [] };
  }),
  totalCount: 1, idleCount: 1, waitingCount: 0,
}));

const gateway = require('../lib/ai/gateway');
const observations = require('../lib/ai/observations');
const aiSettings = require('../lib/ai/settings');
const { STATUS } = require('../modules/command-center/registry');

// ── FreeLLMAPI, as fixtures ──────────────────────────────────────────────────
const live = () => ({ status: 200, body: { status: 'ok', version: '1.42.0', uptime_s: 3600 } });
const ready = () => ({ status: 200, body: { status: 'ok', ready_upstreams: 2 } });
const providersOk = () => ({
  status: 200,
  body: {
    providers: [
      { platform: 'google', name: 'Google', status: 'healthy', keys: 2 },
      { platform: 'nvidia', name: 'NVIDIA', status: 'healthy', keys: 1, requests_remaining_pct: 80 },
    ],
    counts: { healthy: 2, rate_limited: 0, invalid: 0, unknown: 0 },
  },
});
const modelsOk = () => ({
  status: 200,
  body: {
    object: 'list',
    data: [
      { id: 'auto', owned_by: 'freellmapi', available: true, unavailable_reason: null },
      { id: 'gemini-2.5-flash', owned_by: 'google', available: true, unavailable_reason: null },
      { id: 'nvidia/llama-3.3-70b', owned_by: 'nvidia', available: true, unavailable_reason: null },
      { id: 'groq/old-model', owned_by: 'groq', available: false, unavailable_reason: 'no_key' },
    ],
  },
});

let routes;
let fetchCalls;
function respond(spec) {
  if (spec instanceof Error) return Promise.reject(spec);
  if (spec === 'hang') {
    return new Promise((_resolve, reject) => {
      // Rejects only when the probe aborts it, exactly as fetch does.
      reject.hang = true;
      respond.pending.push(reject);
    });
  }
  return Promise.resolve(new Response(
    typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body),
    { status: spec.status, headers: { 'content-type': 'application/json', ...(spec.headers || {}) } },
  ));
}
respond.pending = [];

function installFetch() {
  fetchCalls = [];
  global.fetch = jest.fn((url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    const spec = routes[path];
    if (!spec) return Promise.resolve(new Response('not found', { status: 404 }));
    if (spec === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('This operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    return respond(typeof spec === 'function' ? spec() : spec);
  });
}

const realFetch = global.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...savedEnv, AI_API_KEY: KEY, AI_BASE_URL: BASE };
  delete process.env.OPENROUTER_API_KEY;
  process.env.AI_PRIMARY_MODEL = 'gemini-2.5-flash';
  process.env.AI_SECONDARY_MODEL = 'nvidia/llama-3.3-70b';
  process.env.AI_FALLBACK_MODEL = 'nvidia/llama-3.3-70b';
  aiSettings._setCache(null);
  routes = {
    '/livez': live(), '/readyz': ready(), '/v1/providers': providersOk(), '/v1/models': modelsOk(),
  };
  Object.assign(usage, {
    today: { requests: 0, avg_latency_ms: null, max_latency_ms: null, p95_latency_ms: null, tokens: 0, fallbacks: 0, models_used: 0, cost_inr: 0, unpriced_models: 0 },
    hour: { requests: 0, avg_latency_ms: null, max_latency_ms: null, fallbacks: 0 },
    last: null, served: [], inventory: [], override: {}, mfa: true, fail: false,
  });
  installFetch();
  gateway._reset();
  observations._reset();
  mockLogActivity.mockClear();
});

afterAll(() => { global.fetch = realFetch; process.env = savedEnv; });

const freellmapi = () => require('../modules/command-center/collectors/freellmapi.collector');
const ai = () => require('../modules/command-center/collectors/ai.collector');

// ═════════════════════════════════════════════════════════════════════════════
describe('FreeLLMAPI card', () => {
  it('healthy: every surface answers, and the card says so with counts from the gateway', async () => {
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.gateway).toMatchObject({ kind: 'freellmapi', endpoint: BASE });
    expect(card.data.service).toMatchObject({ live: true, version: '1.42.0', uptime_s: 3600 });
    expect(card.data.readiness).toMatchObject({ ready: true, ready_upstreams: 2 });
    expect(card.data.providers).toMatchObject({ total: 2, healthy: 2, invalid: 0, rate_limited: 0 });
    // Model counts joined from the catalog, per provider.
    const google = card.data.providers.items.find((p) => p.id === 'google');
    expect(google).toMatchObject({ name: 'Google', models_total: 1, models_available: 1, enabled_keys: 2 });
    // Router entries are not counted as models.
    expect(card.data.models).toMatchObject({ total: 3, available: 2, unavailable: 1 });
    expect(card.data.models.routers.map((r) => r.id)).toEqual(['auto']);
  });

  it('reads only fixed paths on the configured host, and sends the key only to /v1', async () => {
    await freellmapi().collect();
    const paths = fetchCalls.map((c) => new URL(c.url).pathname).sort();
    expect(paths).toEqual(['/livez', '/readyz', '/v1/models', '/v1/providers']);
    for (const c of fetchCalls) {
      expect(new URL(c.url).host).toBe('freellmapi:3001');
      expect(c.init.redirect).toBe('manual');
      const auth = c.init.headers?.Authorization;
      if (new URL(c.url).pathname.startsWith('/v1/')) expect(auth).toBe(`Bearer ${KEY}`);
      else expect(auth).toBeUndefined();
    }
  });

  it('unreachable: a refused connection is critical, and names the gateway rather than the models', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    routes = { '/livez': refused };
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/unreachable/);
    expect(card.data.service).toMatchObject({ reachable: false, error_class: 'unreachable' });
    // Nothing else was attempted against a host that is not there.
    expect(fetchCalls).toHaveLength(1);
  });

  it('timeout: a gateway that never answers is cut off and reported as a timeout', async () => {
    // A private copy of the module, so the short timeout (read at load) does
    // not leak into the shared instance every other test resets.
    process.env.CC_AI_GATEWAY_TIMEOUT_MS = '50';
    let gw;
    jest.isolateModules(() => { gw = require('../lib/ai/gateway'); });
    delete process.env.CC_AI_GATEWAY_TIMEOUT_MS;
    routes = { '/livez': 'hang' };
    const p = await gw.probe({ fresh: true });
    expect(p.kind).toBe('unreachable');
    expect(p.service.error_class).toBe('timeout');
    expect(gw.grade(p).status).toBe('critical');
  });

  it('not live: /livez 503 with a failed check is critical and names the check', async () => {
    routes['/livez'] = { status: 503, body: { status: 'unavailable', version: '1.42.0', uptime_s: 5, checks: { db: true, encryption_key: false } } };
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/encryption_key/);
  });

  it('not ready: every upstream cooling down is a warning, no upstream at all is critical', async () => {
    routes['/readyz'] = { status: 503, body: { status: 'unavailable', reason: 'all_upstreams_rate_limited' } };
    expect((await freellmapi().collect()).status).toBe(STATUS.WARNING);
    gateway._reset();
    routes['/readyz'] = { status: 503, body: { status: 'unavailable', reason: 'no_upstreams_configured' } };
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/no enabled provider key/);
  });

  it('provider degraded: one failing provider is a warning that names it', async () => {
    routes['/v1/providers'] = {
      status: 200,
      body: { providers: [
        { platform: 'google', name: 'Google', status: 'healthy', keys: 2 },
        { platform: 'nvidia', name: 'NVIDIA', status: 'invalid', keys: 1, last_error: 'HTTP 401 invalid key' },
      ] },
    };
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.WARNING);
    expect(card.reason).toMatch(/1 of 2 .*NVIDIA/);
    expect(card.data.providers.invalid).toBe(1);
  });

  it('a provider only cooling down is DEGRADED — working, not alerting', async () => {
    routes['/v1/providers'] = {
      status: 200,
      body: { providers: [
        { platform: 'google', name: 'Google', status: 'healthy', keys: 2 },
        { platform: 'nvidia', name: 'NVIDIA', status: 'rate_limited', keys: 1, resume_at: '2026-10-06T10:00:00.000Z' },
      ] },
    };
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.DEGRADED);
    expect(card.data.providers.items.find((p) => p.id === 'nvidia').resume_at).toBe('2026-10-06T10:00:00.000Z');
  });

  it('a rejected API key on /v1 is critical: chat would be refused with the same key', async () => {
    routes['/v1/providers'] = { status: 401, body: { error: { message: 'Invalid API key' } } };
    routes['/v1/models'] = { status: 401, body: { error: { message: 'Invalid API key' } } };
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.reason).toMatch(/rejected the ERP's API key/);
  });

  it('key health: per-key status is unavailable from the provider, never inferred', async () => {
    const card = await freellmapi().collect();
    expect(card.data.keys.healthy).toBeNull();
    expect(card.data.keys.per_key).toBeNull();
    expect(card.data.keys.healthy_unavailable_reason).toMatch(/Key health unavailable from provider/);
    // What IS exposed — the enabled-key count — is reported, with its source.
    expect(card.data.keys.total).toBe(3);
    expect(card.data.keys.source).toBe('GET /v1/providers');
  });

  it('an older FreeLLMAPI without /v1/providers: providers "not exposed", not zero', async () => {
    delete routes['/v1/providers'];
    const card = await freellmapi().collect();
    expect(card.data.providers.exposed).toBe(false);
    expect(card.data.providers.total).toBeNull();
    expect(card.data.providers.reason).toMatch(/not exposed/);
    expect(card.data.keys.total).toBeNull();
  });

  it('OpenRouter as the base: expected-unavailable, and the gateway is never probed', async () => {
    process.env.AI_BASE_URL = 'https://openrouter.ai/api/v1';
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.UNAVAILABLE);
    expect(card.expected).toBe(true);
    expect(card.reason).toMatch(/OpenRouter/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('a gateway that is not FreeLLMAPI: expected-unavailable, says it cannot be inspected', async () => {
    routes = {};
    const card = await freellmapi().collect();
    expect(card.status).toBe(STATUS.UNAVAILABLE);
    expect(card.expected).toBe(true);
    expect(card.reason).toMatch(/not FreeLLMAPI/);
  });

  it('a redirect is refused, never followed to another host with the key', async () => {
    routes['/livez'] = { status: 302, body: '', headers: { location: 'http://evil.example/' } };
    const p = await gateway.probe({ fresh: true });
    expect(p.kind).toBe('openai_compatible');
    expect(fetchCalls.every((c) => new URL(c.url).host === 'freellmapi:3001')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('secrets never leave', () => {
  it('scrubs provider errors, the literal key, and userinfo in the endpoint', async () => {
    process.env.AI_BASE_URL = 'http://admin:hunter2-password@freellmapi:3001/v1?token=abc123def456';
    routes['/v1/providers'] = {
      status: 200,
      body: { providers: [{
        platform: 'google', name: 'Google', status: 'invalid', keys: 1,
        last_error: `401 from upstream: key AIzaSyA1234567890abcdefghijklmnopqrs rejected; Bearer ${KEY}; nvapi-abcdefghijklmnopqrstuvwx`,
      }] },
    };
    const card = await freellmapi().collect();
    const wire = JSON.stringify(card);
    expect(wire).not.toContain(KEY);
    expect(wire).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrs');
    expect(wire).not.toContain('nvapi-abcdefghijklmnopqrstuvwx');
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('token=abc123');
    expect(card.data.gateway.endpoint).toBe('http://freellmapi:3001/v1');
    expect(card.data.providers.items[0].last_error).toMatch(/REDACTED/);
  });

  it('the ai card carries no key material either', async () => {
    usage.last = { model: 'gemini-2.5-flash', created_at: new Date().toISOString(), used_fallback: false };
    const card = await ai().collect();
    expect(JSON.stringify(card)).not.toContain(KEY);
  });

  it('observations scrub failures before keeping them', () => {
    const err = Object.assign(new Error(`OpenRouter 401: invalid key ${KEY}`), { status: 401 });
    observations.recordFailure({ requested_model: 'm', err, latency_ms: 10, secrets: [KEY] });
    const s = observations.summary();
    expect(s.last_failure.error_class).toBe('auth_rejected');
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('AI card: configured is not active, missing is not zero', () => {
  it('active model is the model that SERVED the last request, not the configured one', async () => {
    usage.last = { model: 'nvidia/llama-3.3-70b', created_at: '2026-10-06T09:00:00.000Z', used_fallback: true };
    usage.served = [{ model: 'nvidia/llama-3.3-70b', requests: 4, last_at: '2026-10-06T09:00:00.000Z' }];
    const card = await ai().collect();
    expect(card.data.routing.primary).toBe('gemini-2.5-flash');
    expect(card.data.active_model).toBe('nvidia/llama-3.3-70b');
    expect(card.data.active_used_fallback).toBe(true);
  });

  it('the active model survives an idle hour (it is the last served, whenever that was)', async () => {
    usage.last = { model: 'gemini-2.5-flash', created_at: '2026-09-01T00:00:00.000Z', used_fallback: false };
    const card = await ai().collect();
    expect(card.data.active_model).toBe('gemini-2.5-flash');
    expect(card.data.last_hour.requests).toBe(0);
  });

  it('no traffic is not failure: healthy, latency null (never 0ms), no runtime finding', async () => {
    const card = await ai().collect();
    expect(card.status).toBe(STATUS.HEALTHY);
    expect(card.data.active_model).toBeNull();
    expect(card.data.today.avg_latency_ms).toBeNull();
    expect(card.data.today.max_latency_ms).toBeNull();
    expect(card.data.today.fallback_rate).toBeNull();
    expect(card.data.last_hour.avg_latency_ms).toBeNull();
    expect(card.data.reconciliation.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    // The catalog verified routing, so the state is consistent even with no traffic.
    expect(card.data.reconciliation.state).toBe('consistent');
  });

  it('routing reports where each tier comes from', async () => {
    aiSettings._setCache({ primary_model: 'override/model', secondary_model: null, fallback_model: null });
    usage.override = { primary_model: 'override/model' };
    const card = await ai().collect();
    expect(card.data.routing.primary).toBe('override/model');
    expect(card.data.routing.sources).toMatchObject({ primary: 'override', secondary: 'env', fallback: 'env' });
    expect(card.data.reconciliation.findings.some((f) => f.code === 'override_shadows_env' && f.severity === 'info')).toBe(true);
  });

  it('fallback rate over the critical threshold is critical (unchanged grading)', async () => {
    usage.hour = { requests: 10, avg_latency_ms: 900, max_latency_ms: 2000, fallbacks: 4 };
    const card = await ai().collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.data.last_hour.fallback_rate).toBe(0.4);
  });

  it('an unreadable usage log degrades the card instead of reporting zeros', async () => {
    usage.fail = true;
    const card = await ai().collect();
    expect(card.status).toBe(STATUS.DEGRADED);
    expect(card.data.today).toBeNull();
    expect(card.data.usage_readable).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('configuration versus reality', () => {
  it('configured model unavailable in the catalog → mismatch, warning, with the reason', async () => {
    process.env.AI_SECONDARY_MODEL = 'groq/old-model';
    const card = await ai().collect();
    expect(card.status).toBe(STATUS.WARNING);
    expect(card.data.reconciliation.state).toBe('mismatch');
    const f = card.data.reconciliation.findings.find((x) => x.code === 'configured_model_unavailable');
    expect(f.message).toMatch(/groq\/old-model.*no_key/);
  });

  it('configured model missing from the catalog → mismatch', async () => {
    process.env.AI_PRIMARY_MODEL = 'vendor/does-not-exist';
    const card = await ai().collect();
    expect(card.data.reconciliation.findings.map((x) => x.code)).toContain('configured_model_missing');
  });

  it('traffic served by a model no tier names → mismatch', async () => {
    usage.served = [{ model: 'someone/else', requests: 12, last_at: new Date().toISOString() }];
    const card = await ai().collect();
    const f = card.data.reconciliation.findings.find((x) => x.code === 'serving_unconfigured_model');
    expect(f).toBeDefined();
    expect(f.message).toMatch(/someone\/else/);
  });

  it('a router id ("auto") serving different models is the router working, not drift', async () => {
    process.env.AI_PRIMARY_MODEL = 'auto';
    process.env.AI_SECONDARY_MODEL = 'auto';
    process.env.AI_FALLBACK_MODEL = 'auto';
    usage.served = [{ model: 'gemini-2.5-flash', requests: 12, last_at: new Date().toISOString() }];
    const card = await ai().collect();
    expect(card.data.reconciliation.findings.map((x) => x.code)).not.toContain('serving_unconfigured_model');
    expect(card.data.reconciliation.state).toBe('consistent');
  });

  it('gateway down → runtime failure, critical, explained', async () => {
    routes = { '/livez': Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) };
    const card = await ai().collect();
    expect(card.status).toBe(STATUS.CRITICAL);
    expect(card.data.reconciliation.state).toBe('runtime_failure');
    expect(card.reason).toMatch(/unreachable/);
  });

  it('repeated failed calls from this process → runtime failure even if the gateway looks up', async () => {
    for (let i = 0; i < 3; i += 1) {
      observations.recordFailure({ requested_model: 'gemini-2.5-flash', err: Object.assign(new Error('OpenRouter 502: bad gateway'), { status: 502 }), latency_ms: 50 });
    }
    const card = await ai().collect();
    expect(card.data.reconciliation.state).toBe('runtime_failure');
    expect(card.data.reconciliation.findings.find((f) => f.code === 'recent_calls_failing').message).toMatch(/upstream_error 502/);
  });

  it('nothing to verify against → not_verified, never "consistent"', () => {
    const out = ai().reconcile({
      routing: { primary: 'a/b', secondary: 'a/b', fallback: 'a/b', sources: {}, override: {}, from_env: {} },
      served24h: [], probe: { kind: 'openrouter' }, verdict: { status: 'unavailable' }, obs: observations.summary(),
    });
    expect(out.state).toBe('not_verified');
    expect(out.verified).toEqual({ catalog: false, traffic: false, gateway: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('commands', () => {
  const commands = () => require('../modules/command-center/commands.service');
  const req = { id: 'req-1', user: { id: 'sa1', name: 'Op', email: 'op@example.com' } };

  beforeEach(() => { commands()._resetCooldowns(); });

  it('ai.test reports the requested model, the served model and the provider that answered', async () => {
    routes['/v1/chat/completions'] = {
      status: 200,
      headers: { 'x-routed-via': 'nvidia/nvidia/llama-3.3-70b', 'x-fallback-attempts': '1' },
      body: { model: 'nvidia/llama-3.3-70b', choices: [{ message: { content: 'ready' } }], usage: { total_tokens: 3 } },
    };
    jest.isolateModules(() => {});
    const out = await commands().run('ai.test', { req });
    expect(out.output).toMatchObject({
      ok: true,
      requested_model: 'gemini-2.5-flash',
      requested_tier: 'primary',
      model: 'nvidia/llama-3.3-70b',
      provider: 'nvidia',
      gateway_fallback_attempts: 1,
      reply: 'ready',
    });
    expect(out.output.latency_ms).toEqual(expect.any(Number));
    // Audited, with the actor.
    expect(mockLogActivity).toHaveBeenCalledWith(req, 'command_center.ai.test', 'command_center', 'ai.test',
      expect.objectContaining({ outcome: 'ok', actor: expect.objectContaining({ id: 'sa1' }) }));
  });

  it('ai.test failing returns a precise, scrubbed diagnosis, and audits the summary only', async () => {
    routes['/v1/chat/completions'] = { status: 401, body: { error: { message: `No auth credentials found for ${KEY}` } } };
    let caught;
    try { await commands().run('ai.test', { req }); } catch (e) { caught = e; }
    expect(caught.status).toBe(500);
    expect(caught.output.ok).toBe(false);
    expect(caught.output.attempts[0]).toMatchObject({ error_class: 'auth_rejected', http_status: 401 });
    expect(JSON.stringify(caught.output)).not.toContain(KEY);
    expect(caught.message).not.toContain(KEY);
    const audit = mockLogActivity.mock.calls.find((c) => c[1] === 'command_center.ai.test');
    expect(audit[4].outcome).toBe('error');
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });

  it('ai.test with no provider key is unavailable (503) and does not burn the cooldown', async () => {
    delete process.env.AI_API_KEY;
    await expect(commands().run('ai.test', { req })).rejects.toMatchObject({ status: 503, code: 'COMMAND_UNAVAILABLE' });
    process.env.AI_API_KEY = KEY;
    routes['/v1/chat/completions'] = { status: 200, body: { model: 'x', choices: [{ message: { content: 'ready' } }] } };
    await expect(commands().run('ai.test', { req })).resolves.toMatchObject({ outcome: 'ok' });
  });

  it('ai.test respects its cooldown', async () => {
    routes['/v1/chat/completions'] = { status: 200, body: { model: 'x', choices: [{ message: { content: 'ready' } }] } };
    await commands().run('ai.test', { req });
    await expect(commands().run('ai.test', { req })).rejects.toMatchObject({ status: 429, code: 'COOLDOWN' });
  });

  it('ai.gateway.check re-reads FreeLLMAPI fresh and returns no secret', async () => {
    await gateway.probe(); // warm the memo
    const before = fetchCalls.length;
    const out = await commands().run('ai.gateway.check', { req });
    expect(fetchCalls.length).toBe(before + 4);
    expect(out.output.status).toBe('healthy');
    expect(out.output.keys.healthy).toBeNull();
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(mockLogActivity).toHaveBeenCalledWith(req, 'command_center.ai.gateway.check', 'command_center', 'ai.gateway.check', expect.any(Object));
  });

  it('ai.gateway.check is unavailable when the base is OpenRouter', async () => {
    process.env.AI_BASE_URL = 'https://openrouter.ai/api/v1';
    await expect(commands().run('ai.gateway.check', { req })).rejects.toMatchObject({ status: 503 });
  });

  it('both are listed by the allow-list, neither is destructive, neither accepts input', () => {
    const list = commands().list();
    for (const name of ['ai.test', 'ai.gateway.check']) {
      const c = list.find((x) => x.name === name);
      expect(c).toBeDefined();
      expect(c.destructive).toBe(false);
      expect(c.accepts_queue).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('authorization', () => {
  const express = require('express');
  const request = require('supertest');
  const { requireSuperAdmin, requireSuperAdminMfa } = require('../middleware/tenant');

  function app(user) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use('/api/platform', requireSuperAdmin, requireSuperAdminMfa,
      require('../modules/command-center/command-center.routes'));
    a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    return a;
  }

  it.each([
    ['GET', '/api/platform/command-center/ai/models'],
    ['POST', '/api/platform/command-center/commands/ai.gateway.check'],
    ['POST', '/api/platform/command-center/commands/ai.test'],
  ])('%s %s refuses a studio trainer', async (method, url) => {
    const res = await request(app({ id: 't1', role: 'trainer', organization_id: 'o1' }))[method.toLowerCase()](url);
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it('refuses a super admin without MFA', async () => {
    usage.mfa = false;
    const res = await request(app({ id: 'sa1', role: 'super_admin' })).get('/api/platform/command-center/ai/models');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('serves the model inventory to a super admin with MFA, joined to routing and usage', async () => {
    usage.inventory = [
      { model: 'gemini-2.5-flash', last_used_at: '2026-10-06T08:00:00.000Z', requests_30d: 40 },
      { model: 'retired/model', last_used_at: '2026-09-20T08:00:00.000Z', requests_30d: 3 },
    ];
    const res = await request(app({ id: 'sa1', role: 'super_admin' })).get('/api/platform/command-center/ai/models');
    expect(res.status).toBe(200);
    const d = res.body.data;
    const gem = d.models.find((m) => m.id === 'gemini-2.5-flash');
    expect(gem).toMatchObject({ provider: 'google', available: true, configured_tiers: ['primary'], requests_30d: 40 });
    const old = d.models.find((m) => m.id === 'groq/old-model');
    expect(old).toMatchObject({ available: false, unavailable_reason: 'no_key', configured_tiers: [], requests_30d: 0 });
    expect(d.served_not_in_catalog).toEqual([expect.objectContaining({ id: 'retired/model' })]);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('?fresh=1 cannot be used to hammer the gateway: one fresh read per 5s, the memo otherwise', async () => {
    const { modelInventory } = require('../modules/command-center/ai-inventory.service');
    const t0 = 10_000_000_000;
    await modelInventory({ fresh: true, now: t0 });
    const afterFirst = fetchCalls.length;
    expect(afterFirst).toBe(4); // livez, readyz, providers, models
    await modelInventory({ fresh: true, now: t0 + 1000 });
    await modelInventory({ fresh: true, now: t0 + 4000 });
    expect(fetchCalls.length).toBe(afterFirst);
    await modelInventory({ fresh: true, now: t0 + 5000 });
    expect(fetchCalls.length).toBe(afterFirst + 4);
  });

  it('the production mount puts this router behind the full platform guard', () => {
    const fs = require('fs');
    const path = require('path');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(server).toMatch(/const PLATFORM_GUARD = \[auth, requireSuperAdmin, requireSuperAdminMfa, requirePlatformOwner\]/);
    expect(server).toMatch(/app\.use\('\/api\/platform',\s+\.\.\.PLATFORM_GUARD, platformRoutes\)/);
    expect(server).toMatch(/app\.use\('\/api\/super-admin',\s+\.\.\.PLATFORM_GUARD, platformRoutes\)/);
    const sa = fs.readFileSync(path.join(__dirname, '..', 'modules', 'platform', 'super-admin.routes.js'), 'utf8');
    expect(sa).toMatch(/require\('\.\.\/command-center\/command-center\.routes'\)/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Guardian', () => {
  const { applyRule } = require('../modules/command-center/guardian.service');
  const { RULES } = require('../modules/command-center/guardian.rules');
  const rule = (id) => RULES.find((r) => r.id === id);

  it('every AI rule recommends only commands that exist', () => {
    const { COMMANDS } = require('../modules/command-center/commands.service');
    for (const r of RULES.filter((x) => x.id.startsWith('ai.'))) {
      for (const name of r.recommend) expect(COMMANDS[name]).toBeDefined();
    }
  });

  it('ai.gateway_down fires only when the gateway AND the AI card both fail', () => {
    const cards = {
      freellmapi: { name: 'freellmapi', status: 'critical', reason: 'unreachable', data: {} },
      ai: { name: 'ai', status: 'critical', data: { reconciliation: { state: 'runtime_failure', findings: [] }, observed: { consecutive_failures: 3 } } },
      database: { name: 'database', status: 'healthy', data: {} },
    };
    expect(applyRule(rule('ai.gateway_down'), cards)).toBeTruthy();
    cards.ai.data.reconciliation.state = 'consistent';
    expect(applyRule(rule('ai.gateway_down'), cards)).toBeFalsy();
  });

  it('ai.configured_model_unavailable needs the gateway to be serving', () => {
    const cards = {
      freellmapi: { name: 'freellmapi', status: 'healthy', data: {} },
      ai: { name: 'ai', status: 'warning', data: { reconciliation: { state: 'mismatch', findings: [{ code: 'configured_model_unavailable', severity: 'warning', message: 'x' }] }, last_hour: { fallback_rate: 0.2 } } },
    };
    expect(applyRule(rule('ai.configured_model_unavailable'), cards)).toBeTruthy();
    cards.freellmapi.status = 'critical';
    expect(applyRule(rule('ai.configured_model_unavailable'), cards)).toBeFalsy();
  });

  it('an unavailable gateway card leaves AI rules unknown, not fired', () => {
    const cards = {
      freellmapi: { name: 'freellmapi', status: 'unavailable', expected: true, data: null },
      ai: { name: 'ai', status: 'healthy', data: { reconciliation: { state: 'not_verified', findings: [] } } },
    };
    expect(applyRule(rule('ai.gateway_down'), cards)).toBeFalsy();
    expect(applyRule(rule('ai.configured_model_unavailable'), cards)).toBeFalsy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('alerts', () => {
  it('a FreeLLMAPI alert has its own title', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'command-center', 'alerts.service.js'), 'utf8');
    expect(src).toMatch(/freellmapi: 'FreeLLMAPI gateway problem'/);
  });

  it('an expected-unavailable gateway never alerts (UNAVAILABLE is not an alerting state)', async () => {
    process.env.AI_BASE_URL = 'https://openrouter.ai/api/v1';
    const card = await freellmapi().collect();
    expect(['warning', 'timeout', 'critical']).not.toContain(card.status);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('observations', () => {
  it('summary is honest when empty: nulls, not zeros', () => {
    const s = observations.summary();
    expect(s).toMatchObject({ scope: 'process', calls: 0, failures: 0, failure_rate: null, latency_ms: null, last_success: null, last_failure: null });
  });

  it('parses X-Routed-Via with slashes in the model id', () => {
    expect(observations.parseRoutedVia('nvidia/meta/llama-3.3-70b')).toEqual({ provider: 'nvidia', model: 'meta/llama-3.3-70b' });
    expect(observations.parseRoutedVia('cache')).toEqual({ provider: 'cache', model: null });
    expect(observations.parseRoutedVia(null)).toBeNull();
  });

  it.each([
    [{ status: 401 }, 'auth_rejected'],
    [{ status: 429 }, 'rate_limited'],
    [{ status: 404 }, 'model_not_found'],
    [{ status: 503 }, 'upstream_error'],
    [{ code: 'TIMEOUT' }, 'timeout'],
    [{ cause: { code: 'ECONNREFUSED' } }, 'unreachable'],
    [{}, 'unknown'],
  ])('classifies %o as %s', (err, cls) => {
    expect(observations.classify(err).error_class).toBe(cls);
  });

  it('keeps a bounded ring', () => {
    for (let i = 0; i < observations.LIMIT + 50; i += 1) observations.recordSuccess({ requested_model: 'm', served_model: 'm', latency_ms: i });
    expect(observations.summary({ windowMs: 1e9 }).calls).toBe(observations.LIMIT);
  });
});

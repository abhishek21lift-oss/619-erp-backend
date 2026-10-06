// An unconfigured capability is not a blind spot.
//
// The Command Centre reports two numbers that look like they measure the same
// thing and do not:
//
//   coverage  "Share of probes that actually returned a reading."
//   blind     "Probes that should have run and did not. These are gaps, not
//              readings."  (MissionControl/ObservabilityBar.tsx)
//
// The AI collector answered. It queried platform_ai_settings, got a row back,
// and learned that no provider is configured. That is a reading. But it
// returned `unavailable(...)` without `expected: true`, so observabilityOf()
// filed it under `unexpected` — the same bucket as a probe that threw — and the
// snapshot reported blind: 1 and coverage 88% on a platform where eight of
// eight probes answered.
//
// The backend states the rule itself in snapshot.service.js: "`not_configured`
// is excluded from the denominator — a capability that does not exist here is
// not something we failed to see." The frontend states it in the coverage
// chip's tooltip. The collector was the only thing disagreeing.
//
// ── What "unconfigured" means now ───────────────────────────────────────────
//
// This card used to call AI unconfigured whenever platform_ai_settings held no
// override. But an empty override is the NORMAL state: every tier then routes
// on AI_*_MODEL or the built-in default (lib/ai/models.js), and AI works. The
// card was reporting "No AI routing configured" on a platform serving AI.
//
// Routing always resolves to something. What can genuinely be absent is the
// provider KEY — without it no request can be made — so that is now the
// expected-unavailable condition, and an empty override row is not.
'use strict';

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { STATUS } = require('../modules/command-center/registry');
const { observabilityOf } = require('../modules/command-center/snapshot.service');

/** The AI collector with NO provider key, against a working database. */
function loadUnconfigured() {
  jest.resetModules();
  delete process.env.AI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  jest.doMock('../db/pool', () => ({
    // Every query resolves; the routing one comes back empty. That is the
    // whole point — the probe WORKED.
    query: jest.fn(async (sql) => {
      if (/platform_ai_settings/.test(sql)) return { rows: [] };
      return { rows: [{ requests: 0, avg_latency_ms: 0, max_latency_ms: 0, tokens: 0, fallbacks: 0, models_used: 0, cost_inr: 0 }] };
    }),
  }));
  return require('../modules/command-center/collectors/ai.collector');
}

describe('ai collector — unconfigured routing', () => {
  afterEach(() => { jest.resetModules(); jest.dontMock('../db/pool'); });

  test('is reported as unconfigured, and flags itself as expected', async () => {
    const card = await loadUnconfigured().collect();

    expect(card.status).toBe(STATUS.UNAVAILABLE);
    expect(card.reason).toMatch(/No AI provider is configured/);
    // The whole finding: this is a deployment choice, not a gap in observation.
    expect(card.expected).toBe(true);
  });

  test('does not count as a blind spot, and does not depress coverage', async () => {
    const card = await loadUnconfigured().collect();

    // The same seven other probes, all healthy, as a full snapshot would hold.
    const others = ['runtime', 'redis', 'queues', 'database', 'http', 'security', 'smtp']
      .map((name) => ({ name, status: STATUS.HEALTHY }));
    const obs = observabilityOf([...others, card]);

    expect(obs.blind).toBeUndefined();
    expect(obs.unavailable).toBe(0);
    expect(obs.not_configured).toBe(1);
    expect(obs.coverage).toBe(1);
  });

  test('the reason names both key variables, so the operator knows what to set', async () => {
    const card = await loadUnconfigured().collect();
    expect(card.reason).toContain('AI_API_KEY');
    expect(card.reason).toContain('OPENROUTER_API_KEY');
  });
});

describe('ai collector — an empty override is not "unconfigured"', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.resetModules();
    jest.dontMock('../db/pool');
    jest.dontMock('../lib/ai/gateway');
  });

  test('with a key and no override row, it reports the EFFECTIVE routing and is not unavailable', async () => {
    jest.resetModules();
    process.env.AI_API_KEY = 'test-key-not-real-0000';
    process.env.AI_PRIMARY_MODEL = 'vendor/primary-from-env';
    jest.doMock('../db/pool', () => ({
      query: jest.fn(async (sql) => {
        if (/platform_ai_settings/.test(sql)) return { rows: [] };
        if (/ORDER BY created_at DESC LIMIT 1/.test(sql)) return { rows: [] };
        if (/GROUP BY model/.test(sql)) return { rows: [] };
        return { rows: [{ requests: 0, fallbacks: 0, tokens: 0, models_used: 0, cost_inr: 0, unpriced_models: 0 }] };
      }),
    }));
    jest.doMock('../lib/ai/gateway', () => ({
      ...jest.requireActual('../lib/ai/gateway'),
      probe: jest.fn(async () => ({ kind: 'openrouter', checked_at: new Date().toISOString(), endpoint: 'https://openrouter.ai/api/v1' })),
    }));
    const card = await require('../modules/command-center/collectors/ai.collector').collect();

    expect(card.status).not.toBe(STATUS.UNAVAILABLE);
    expect(card.data.routing.primary).toBe('vendor/primary-from-env');
    expect(card.data.routing.sources.primary).toBe('env');
    expect(card.data.routing.sources.secondary).toMatch(/^(env|default)$/);
  });
});

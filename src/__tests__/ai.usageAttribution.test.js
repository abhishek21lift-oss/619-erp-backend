'use strict';
// Phase-4 remediation (AI audit S-4/S-5):
//
//   S-5  the usage ledger records the CONFIGURED gateway honestly, and the
//        upstream the gateway itself named (routed_via) when it says so —
//        never a hardcoded 'openrouter' while every request actually goes to
//        the gateway at AI_BASE_URL, whatever that is.
//   S-4  every new usage row carries the organization resolved from the
//        authenticated context; historical rows stay NULL and are read
//        through the user join, so attribution for a transferred trainer's
//        past is not rewritten by that trainer's current studio.
//   4E   one request_id + one user is one ledger row: re-ingestion is a
//        no-op, not a second count.

const fs = require('fs');
const path = require('path');

const captured = { sql: '', params: [] };

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql, params) => {
    captured.sql = String(sql).replace(/\s+/g, ' ').trim();
    captured.params = params || [];
    return { rows: [{ id: 'row-1' }], rowCount: 1 };
  }),
}));

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  jest.resetModules();
  jest.clearAllMocks();
  captured.sql = '';
  captured.params = [];
});

function loadUsage() {
  jest.resetModules();
  return require('../lib/ai/usage');
}

// ── S-5: provider attribution ────────────────────────────────────────────────

describe('S-5: the provider column names the configured gateway, not a wish', () => {
  test("OpenRouter's own endpoint records 'openrouter'", async () => {
    process.env.AI_API_KEY = 'k';
    delete process.env.AI_BASE_URL;
    const { logUsage } = loadUsage();
    await logUsage({ user_id: 'u1', model: 'm' });
    expect(captured.sql).toMatch(/VALUES \(\$1,\$2,\$3,\$4/);
    expect(captured.params[3]).toBe('openrouter');
  });

  test("an alternate gateway records 'openai_compatible', never 'openrouter'", async () => {
    process.env.AI_API_KEY = 'k';
    process.env.AI_BASE_URL = 'https://gw.internal:8787/v1';
    const { logUsage } = loadUsage();
    await logUsage({ user_id: 'u1', model: 'm' });
    expect(captured.params[3]).toBe('openai_compatible');
  });

  test('the gateway-named upstream lands in routed_via; absent stays NULL', async () => {
    process.env.AI_API_KEY = 'k';
    const { logUsage } = loadUsage();
    await logUsage({ user_id: 'u1', model: 'm', routed_via: 'deepinfra/m-1' });
    expect(captured.sql).toMatch(/routed_via/);
    expect(captured.params).toContain('deepinfra/m-1');

    captured.params = [];
    await logUsage({ user_id: 'u1', model: 'm' });
    expect(captured.sql).toMatch(/routed_via/);
    const viaIdx = captured.sql.split(',').findIndex((c) => /routed_via/.test(c));
    expect(captured.params[viaIdx]).toBeNull();
  });
});

// ── S-4: organization attribution ────────────────────────────────────────────

describe('S-4: the resolved studio rides on every new row', () => {
  test('logUsage stores organization_id from authenticated context', async () => {
    const { logUsage } = loadUsage();
    await logUsage({ user_id: 'u1', model: 'm', organization_id: 'org-uuid-1' });
    expect(captured.sql).toMatch(/organization_id/);
    expect(captured.params).toContain('org-uuid-1');
  });

  test('no tenant context is stored as explicit NULL — unknown, not guessed', async () => {
    const { logUsage } = loadUsage();
    await logUsage({ user_id: 'u1', model: 'm', organization_id: undefined });
    expect(captured.sql).toMatch(/organization_id/);
    // $2 = user_id, $3 = conversation, $4 = model ⇒ $5 = provider, $6 = org.
    expect(captured.params[5]).toBeNull();
  });

  test('usedThisMonth prefers the stored organization_id over the historical user join', async () => {
    jest.resetModules();
    const { usedThisMonth } = require('../lib/aiQuota');
    await usedThisMonth('org-uuid-1');
    expect(captured.sql).toMatch(/COALESCE\(l\.organization_id, u\.organization_id\) = \$1/);
  });

  test('getModelStats prefers the stored organization_id too', async () => {
    const { getModelStats } = loadUsage();
    await getModelStats('org-uuid-1');
    expect(captured.sql).toMatch(/COALESCE\(l\.organization_id, u\.organization_id\) = \$1/);
  });

  test('meteredChat stamps the org and the upstream from the same chat result', async () => {
    jest.resetModules();
    // Real metering, mocked ledger — mirroring the privacyAndMetering suite.
    jest.doMock('../lib/ai/usage', () => ({ logUsage: jest.fn(async () => ({ inserted: true })) }));
    const { meteredChat } = require('../lib/ai/metering');
    const { logUsage } = require('../lib/ai/usage');
    const chat = jest.fn(async () => ({
      content: 'ok', model: 'm',
      usage: { prompt_tokens: 10, completion_tokens: 2 },
      latency_ms: 42, routed_via: 'together/m-2',
    }));
    await meteredChat({ user: { id: 'u1', organization_id: 'org-uuid-1' } }, 'coach', chat)({});
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-uuid-1',
      routed_via: 'together/m-2',
    }));
  });

  test('migration 234 exists and declares org, upstream and idempotency', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '234_ai_usage_organization_and_upstream.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations\(id\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS routed_via TEXT/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS ai_usage_org_idx/);
    // Idempotent re-ingestion: one request_id + one user, one row.
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_request_key/);
    expect(sql).toMatch(/ON ai_usage_log\(request_id, user_id\)/);
    expect(sql).toMatch(/WHERE request_id IS NOT NULL/);
  });
});

// ── 4E: ingestion idempotency ────────────────────────────────────────────────

describe('4E: a repeated ingest is not a second count', () => {
  beforeEach(() => {
    // The meteredChat test above do-mocks the ledger for real metering; these
    // tests need the REAL logUsage against the captured pool again.
    jest.dontMock('../lib/ai/usage');
  });

  test('the INSERT is conflict-safe on (request_id, user_id) and reports what happened', async () => {
    const { logUsage } = loadUsage();
    await logUsage({ user_id: 'u1', model: 'm', request_id: 'req-7' });
    expect(captured.sql).toMatch(/ON CONFLICT \(request_id, user_id\) WHERE request_id IS NOT NULL DO NOTHING/);
    expect(captured.sql).toMatch(/RETURNING id/);
  });

  test('logUsage resolves to inserted:false on a duplicate and stays silent-safe',
    async () => {
      const { logUsage } = loadUsage();
      const pool = require('../db/pool');
      // Conflict target matched, DO NOTHING took, RETURNING gave no row.
      pool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
      const out = await logUsage({ user_id: 'u1', model: 'm', request_id: 'dup-1' });
      expect(out).toEqual({ inserted: false });
    });

  test('logUsage resolves to null when logging failed — callers can degrade honestly',
    async () => {
      const { logUsage } = loadUsage();
      const pool = require('../db/pool');
      pool.query.mockImplementationOnce(async () => { throw new Error('db down'); });
      const out = await logUsage({ user_id: 'u1', model: 'm' });
      expect(out).toBeNull();
    });
});

// ── Phase 5A: one request id is one logical operation ───────────────────────

describe('5A: the request key counts logical turns, not transport attempts', () => {
  test('the key is the composite, not the id: the same request_id under a different user never collides',
    async () => {
      const { logUsage } = loadUsage();
      const a = await logUsage({ user_id: 'u1', model: 'm', request_id: 'turn-a' });
      const b = await logUsage({ user_id: 'u2', model: 'm', request_id: 'turn-a' });
      const c = await logUsage({ user_id: 'u1', model: 'm', request_id: 'turn-b' });
      expect(a).toEqual({ inserted: true });
      expect(b).toEqual({ inserted: true });
      expect(c).toEqual({ inserted: true });
    });

  test('a fallback-completed chat is ONE completed call — metering writes exactly one ledger row',
    async () => {
      jest.resetModules();
      // Real metering, mocked ledger — counting happens at the completed-call boundary.
      jest.doMock('../lib/ai/usage', () => ({ logUsage: jest.fn(async () => ({ inserted: true })) }));
      const { meteredChat } = require('../lib/ai/metering');
      const { logUsage } = require('../lib/ai/usage');
      const chat = jest.fn(async () => ({
        content: 'ok', model: 'fb-model',
        usage: { prompt_tokens: 7, completion_tokens: 3 },
        latency_ms: 30, used_fallback: true,
      }));
      await meteredChat({ user: { id: 'u1', organization_id: 'org-1' } }, 'coach', chat)({});
      expect(chat).toHaveBeenCalledTimes(1);
      expect(logUsage).toHaveBeenCalledTimes(1);
      expect(logUsage.mock.calls[0][0]).toMatchObject({
        user_id: 'u1', organization_id: 'org-1', used_fallback: true, model: 'fb-model',
      });
    });
});

// ── Phase 5E: a failed ledger write is loud, minimal, and carries no row data ─

describe('5E: the ledger-write failure is logged without row content', () => {
  beforeEach(() => {
    jest.dontMock('../lib/ai/usage'); // back to the real module beyond the doMock above
    jest.doMock('../lib/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
  });
  afterEach(() => { jest.dontMock('../lib/logger'); });

  test('the error names the event and the error message only — no rows, no params, no ids', async () => {
    const { logUsage } = loadUsage();
    const pool = require('../db/pool');
    const logger = require('../lib/logger');
    pool.query.mockImplementationOnce(async () => { throw new Error('connection reset'); });
    const out = await logUsage({ user_id: 'u1', model: 'm', request_id: 'req-5e' });
    expect(out).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, event] = logger.error.mock.calls[0];
    expect(event).toBe('ai_usage_log_insert_failed');
    expect(Object.keys(payload)).toEqual(['err']);
    expect(payload.err).toBe('connection reset');
    expect(JSON.stringify(payload)).not.toContain('u1');
    expect(JSON.stringify(payload)).not.toContain('req-5e');
  });
});

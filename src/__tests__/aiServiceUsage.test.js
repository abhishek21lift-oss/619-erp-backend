'use strict';
// /api/ai/usage/service — the mps-ai assistant's metering surface (round 2).
//
// What these tests own:
//   * requireServiceAuth on BOTH endpoints (absent, wrong, correct, unset secret);
//   * identity is resolved from the auth-resolved user, NEVER from the body;
//   * exact numbers are believed only when well-formed, partial/absent usage
//     is labelled estimate (never a silent zero);
//   * the quota probe answers with the shared statusFor shape or a typed 503.

const express = require('express');
const request = require('supertest');

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockLogUsage = jest.fn().mockResolvedValue({ inserted: true });
jest.mock('../lib/ai/usage', () => ({
  logUsage: mockLogUsage,
}));

jest.mock('../lib/ai/metering', () => ({
  // The REAL usageFields stays — it IS the shared convention under test.
  usageFields: jest.requireActual('../lib/ai/metering').usageFields,
  usdToInr: () => 88,
  meteredChat: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  auth: (req, res, next) => { req.user = mockAuthFixture.user; next(); },
  requireTrainer: (req, res, next) => {
    if (mockAuthFixture.role !== 'trainer') return res.status(403).json({ error: { code: 'FORBIDDEN' } });
    next();
  },
}));

jest.mock('../lib/aiQuota', () => ({
  statusFor: jest.fn(),
}));

const { statusFor } = require('../lib/aiQuota');
const route = require('../routes/aiServiceUsage');

const SECRET = 'b'.repeat(48);
const mockAuthFixture = { user: { id: 'u-1', organization_id: 'org-1' }, role: 'trainer' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/ai/usage/service', route);
  return a;
}

let originalSecret;
beforeEach(() => {
  originalSecret = process.env.SERVICE_AUTH_SECRET;
  process.env.SERVICE_AUTH_SECRET = SECRET;
  mockAuthFixture.user = { id: 'u-1', organization_id: 'org-1' };
  mockAuthFixture.role = 'trainer';
  mockLogUsage.mockClear();
  statusFor.mockReset();
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.SERVICE_AUTH_SECRET;
  else process.env.SERVICE_AUTH_SECRET = originalSecret;
});

const ingest = (a, body, hdr = {}) =>
  request(a).post('/api/ai/usage/service/ingest').send(body).set(hdr);
const probe = (a, hdr = {}) =>
  request(a).get('/api/ai/usage/service/quota').set(hdr);
const VALID = {
  requestId: 'req-abc-123',
  model: 'openai/gpt-oss-120b:free',
  outcome: 'ok',
  latencyMs: 1234,
  usedFallback: false,
  promptTokens: 45,
  completionTokens: 700,
  replyChars: 2800,
};

describe('service credential is required on both endpoints', () => {
  test('absent header → 401, nothing logged', async () => {
    expect((await ingest(app(), VALID)).status).toBe(401);
    expect((await probe(app())).status).toBe(401);
    expect(mockLogUsage).not.toHaveBeenCalled();
  });

  test('wrong header → 401 SERVICE_AUTH_INVALID', async () => {
    const res = await ingest(app(), VALID, { 'X-Service-Auth': 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SERVICE_AUTH_INVALID');
  });

  test('header set but server secret unconfigured → 503 fail-closed', async () => {
    delete process.env.SERVICE_AUTH_SECRET;
    const res = await probe(app(), { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_AUTH_NOT_CONFIGURED');
  });

  test('valid header + valid user token is the only path through', async () => {
    statusFor.mockResolvedValue({ over: false, enforcement_enabled: true });
    const res = await probe(app(), { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(200);
  });

  test('member-role token is refused by requireTrainer', async () => {
    mockAuthFixture.role = 'client';
    const res = await ingest(app(), VALID, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(403);
    expect(mockLogUsage).not.toHaveBeenCalled();
  });
});

describe('GET /quota', () => {
  test('mirrors the shared statusFor shape', async () => {
    statusFor.mockResolvedValue({
      tokens_used: 10_000, requests: 40, limit: 500_000, limit_source: 'studio',
      used_pct: 2, over: false, warn: false, enforcement_enabled: true,
    });
    const res = await probe(app(), { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(200);
    expect(res.body.over).toBe(false);
    expect(res.body.enforcement_enabled).toBe(true);
    expect(res.body.limit).toBe(500_000);
    expect(statusFor).toHaveBeenCalledWith('org-1');
  });

  test('no studio on the token → 403, not a lookup crash', async () => {
    mockAuthFixture.user = { id: 'u-1', organization_id: null };
    const res = await probe(app(), { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_STUDIO');
  });

  test('a failing evaluation is a typed 503 the caller can fail-closed on', async () => {
    statusFor.mockRejectedValue(new Error('db down'));
    const res = await probe(app(), { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('QUOTA_UNAVAILABLE');
  });
});

describe('POST /ingest', () => {
  test('exact tokens are believed and the actor comes from the token, not the body', async () => {
    const res = await ingest(app(), { ...VALID, impersonateUserId: 'someone-else' }, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(202);
    expect(res.body.usage_source).toBe('provider');
    expect(mockLogUsage).toHaveBeenCalledTimes(1);
    const row = mockLogUsage.mock.calls[0][0];
    expect(row.user_id).toBe('u-1');
    expect(row.intent_type).toBe('client_agent');
    expect(row.tokens_prompt).toBe(45);
    expect(row.tokens_completion).toBe(700);
    expect(row.usage_source).toBe('provider');
    expect(row.request_id).toBe('req-abc-123');
    // No untrusted body identity, no content:
    const raw = JSON.stringify(row);
    expect(raw).not.toContain('someone-else');
  });

  test('unknown usage is estimated from replyChars and LABELLED estimated, never zero', async () => {
    const res = await ingest(app(), {
      requestId: 'req-2', model: 'm:free', outcome: 'ok', latencyMs: 10, replyChars: 2050,
    }, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(202);
    const row = mockLogUsage.mock.calls[0][0];
    expect(row.tokens_prompt).toBe(0);
    expect(row.tokens_completion).toBe(Math.ceil(2050 / 4));
    expect(row.usage_source).toBe('estimated');
  });

  test('partial usage (only prompt known) still falls back to the estimate', async () => {
    const res = await ingest(app(), {
      ...VALID, completionTokens: undefined,
    }, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(202);
    const row = mockLogUsage.mock.calls[0][0];
    expect(row.usage_source).toBe('estimated');
    expect(row.tokens_prompt).toBe(0);
  });

  test('bad models/outcome/ids are refused with 400 and log nothing', async () => {
    const a = app();
    expect((await ingest(a, { ...VALID, model: 'DROP TABLE' }, { 'X-Service-Auth': SECRET })).status).toBe(400);
    expect((await ingest(a, { ...VALID, outcome: 'weird' }, { 'X-Service-Auth': SECRET })).status).toBe(400);
    expect((await ingest(a, { ...VALID, requestId: undefined }, { 'X-Service-Auth': SECRET })).status).toBe(400);
    expect(mockLogUsage).not.toHaveBeenCalled();
  });

  test('out-of-range numbers are clamped out of the row, not trusted', async () => {
    const res = await ingest(app(), { ...VALID, latencyMs: 10 ** 12, completionTokens: 10 ** 12 }, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(202);
    const row = mockLogUsage.mock.calls[0][0];
    expect(row.latency_ms).toBe(0);
    expect(row.usage_source).toBe('estimated');
  });

  // ── Phase 4C: organisation attribution from the token, not the body ──────
  test('the studio on the ledger row comes from the resolved user, never the body', async () => {
    const res = await ingest(app(), { ...VALID, organization_id: 'forged-org' }, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(202);
    const row = mockLogUsage.mock.calls[0][0];
    expect(row.organization_id).toBe('org-1');
    expect(JSON.stringify(row)).not.toContain('forged-org');
  });

  test('a token with no studio stores explicit NULL, the unknown-attribution mark', async () => {
    mockAuthFixture.user = { id: 'u-1', organization_id: null };
    const res = await ingest(app(), VALID, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(202);
    expect(mockLogUsage.mock.calls[0][0].organization_id).toBeNull();
  });

  // ── Phase 4E: idempotency and honest failure ─────────────────────────────
  test('a first ingest reports inserted and carries no duplicate flag', async () => {
    mockLogUsage.mockResolvedValueOnce({ inserted: true });
    const res = await ingest(app(), VALID, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.duplicate).toBeUndefined();
  });

  test('a re-ingest of the same turn answers 202 duplicate, having logged nothing new', async () => {
    mockLogUsage.mockResolvedValueOnce({ inserted: true });
    expect((await ingest(app(), VALID, { 'X-Service-Auth': SECRET })).status).toBe(202);
    mockLogUsage.mockClear();
    mockLogUsage.mockResolvedValueOnce({ inserted: false }); // conflict → DO NOTHING
    const res = await ingest(app(), VALID, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    // The duplicate is not re-counted anywhere else either.
    expect(mockLogUsage).toHaveBeenCalledTimes(1);
  });

  test('a ledger write failure is a typed 503, so it is observable upstream', async () => {
    mockLogUsage.mockResolvedValueOnce(null); // logUsage never throws; failure is null
    const res = await ingest(app(), VALID, { 'X-Service-Auth': SECRET });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('USAGE_LOG_UNAVAILABLE');
  });

  // ── Phase 5B: a failed ingest recovers by plain re-delivery, same request id ─
  test('transient ledger failure: the SAME turn re-delivered is accepted once, with identical attribution',
    async () => {
      const a = app();
      mockLogUsage.mockResolvedValueOnce(null); // first attempt: ledger write fails
      const bad = await ingest(a, VALID, { 'X-Service-Auth': SECRET });
      expect(bad.status).toBe(503);

      mockLogUsage.mockResolvedValueOnce({ inserted: true });
      const retried = await ingest(a, VALID, { 'X-Service-Auth': SECRET });
      expect(retried.status).toBe(202);
      expect(retried.body.ok).toBe(true);

      // Recovery cannot re-tenant the row: every attempt resolves identity the
      // same auth-resolved way, so both rows would carry identical attribution.
      expect(mockLogUsage).toHaveBeenCalledTimes(2);
      const [firstRow, secondRow] = mockLogUsage.mock.calls.map((c) => c[0]);
      for (const k of ['user_id', 'organization_id', 'request_id', 'model', 'usage_source']) {
        expect(secondRow[k]).toBe(firstRow[k]);
      }
      expect(secondRow.request_id).toBe('req-abc-123');
      expect(secondRow.organization_id).toBe('org-1');
    });

  test('a persistently failing ledger keeps answering with the same typed 503, each attempt one write try',
    async () => {
      const a = app();
      mockLogUsage.mockResolvedValueOnce(null);
      mockLogUsage.mockResolvedValueOnce(null);
      const r1 = await ingest(a, VALID, { 'X-Service-Auth': SECRET });
      const r2 = await ingest(a, VALID, { 'X-Service-Auth': SECRET });
      expect(r1.status).toBe(503);
      expect(r2.status).toBe(503);
      expect(r1.body.error.code).toBe('USAGE_LOG_UNAVAILABLE');
      expect(r2.body.error.code).toBe('USAGE_LOG_UNAVAILABLE');
      expect(mockLogUsage).toHaveBeenCalledTimes(2); // no route-level retry loop
    });
});

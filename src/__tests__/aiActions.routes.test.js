// Propose → confirm → execute.
//
// The registry test covers who gets resolved. This one covers the lifecycle,
// where the dangerous failures live: running a plan twice, running a plan
// whose recipient list moved since it was read, running somebody else's plan.
// Every one of them ends with real WhatsApp messages reaching real clients,
// and none of them throws on the way.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn() }));

let mockUser = { id: 'u1', role: 'admin', organization_id: 'org-1' };
jest.mock('../middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = mockUser; next(); },
  adminOnly: (_req, _res, next) => next(),
  adminOrManager: (_req, _res, next) => next(),
}));

const mockSendText = jest.fn();
jest.mock('../services/whatsappDelivery', () => ({
  sendText: (...a) => mockSendText(...a),
  sendTemplate: jest.fn(),
  twilioWhatsappConfigured: () => true,
}));

const request = require('supertest');
const express = require('express');
const pool = require('../db/pool');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/ai', require('../modules/ai-actions/ai-actions.routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

const CLIENT = (i) => ({
  id: `c${i}`, name: `Client ${i}`, mobile: `99900000${i}`,
  balance_amount: 1000 * i, pt_end_date: '2026-09-01', days_left: 3,
});

/** Queries in order: resolve → insert plan. */
function mockPlanFlow(clients) {
  pool.query
    .mockResolvedValueOnce({ rows: clients })
    .mockResolvedValueOnce({ rows: [{ id: 'plan-1', expires_at: new Date(Date.now() + 300000) }] });
}

const future = () => new Date(Date.now() + 300000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

beforeEach(() => {
  pool.query.mockReset();
  mockSendText.mockReset();
  mockSendText.mockResolvedValue({ status: 'sent' });
  mockUser = { id: 'u1', role: 'admin', organization_id: 'org-1' };
});

describe('planning', () => {
  test('describes the run without sending anything', async () => {
    mockPlanFlow([CLIENT(1), CLIENT(2)]);
    const res = await request(app()).post('/api/ai/actions/dues_reminders/plan').send({});

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    expect(res.body.data.plan_id).toBe('plan-1');
    expect(res.body.data.outward).toBe(true);
    expect(res.body.data.sample_message).toContain('Client 1');
    // The whole point: planning is read-only.
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('a trainer is refused', async () => {
    mockUser = { id: 'u2', role: 'trainer', organization_id: 'org-1' };
    const res = await request(app()).post('/api/ai/actions/dues_reminders/plan').send({});
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('an unknown action is a 404, not a crash', async () => {
    const res = await request(app()).post('/api/ai/actions/drop_everything/plan').send({});
    expect(res.status).toBe(404);
  });

  test('the stored plan is stamped with the caller and their org', async () => {
    mockPlanFlow([CLIENT(1)]);
    await request(app()).post('/api/ai/actions/dues_reminders/plan').send({});
    const insert = pool.query.mock.calls.find(([sql]) => /INSERT INTO ai_action_plans/.test(sql));
    expect(insert[1][0]).toBe('org-1');
    expect(insert[1][1]).toBe('u1');
  });
});

describe('executing', () => {
  const planRow = (over = {}) => ({
    rows: [{
      id: 'plan-1',
      action_id: 'dues_reminders',
      // sha256 over `${id}:${body}` lines, sorted — recomputed by the route.
      fingerprint: 'WILL-BE-SET',
      params: { min_balance: 1 },
      consumed_at: null,
      expires_at: future(),
      ...over,
    }],
  });

  /** Run a plan, then execute it, so the fingerprint is the real one. */
  async function planThenExecute({ executeClients, planOver = {}, claimRows = 1 } = {}) {
    const a = app();
    mockPlanFlow([CLIENT(1), CLIENT(2)]);
    const planned = await request(a).post('/api/ai/actions/dues_reminders/plan').send({});
    const storedFingerprint = pool.query.mock.calls
      .find(([sql]) => /INSERT INTO ai_action_plans/.test(sql))[1][3];

    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce(planRow({ fingerprint: storedFingerprint, ...planOver }))
      .mockResolvedValueOnce({ rows: executeClients })   // re-resolve
      .mockResolvedValueOnce({ rowCount: claimRows })     // atomic claim
      .mockResolvedValueOnce({ rows: [] });               // store result

    const res = await request(a)
      .post('/api/ai/actions/dues_reminders/execute')
      .send({ plan_id: planned.body.data.plan_id });
    return res;
  }

  test('sends when the world has not moved', async () => {
    const res = await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)] });
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(2);
    expect(mockSendText).toHaveBeenCalledTimes(2);
  });

  // The one that matters most. A client enrolled between reading and
  // confirming: executing the fresh list would message somebody the operator
  // never saw. Refusing is the only honest answer.
  test('refuses when the recipient list changed since it was read', async () => {
    const res = await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2), CLIENT(3)] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('plan_stale');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('refuses when somebody dropped out of the list', async () => {
    const res = await planThenExecute({ executeClients: [CLIENT(1)] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('plan_stale');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  // Two taps on Confirm. The claim UPDATE matches no row the second time.
  test('refuses a second run of the same plan', async () => {
    const res = await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)], claimRows: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_run');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('refuses a plan already marked consumed', async () => {
    const res = await planThenExecute({
      executeClients: [CLIENT(1), CLIENT(2)],
      planOver: { consumed_at: new Date().toISOString() },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_run');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('refuses an expired plan', async () => {
    const res = await planThenExecute({
      executeClients: [CLIENT(1), CLIENT(2)],
      planOver: { expires_at: past() },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('expired');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('the claim is conditional on not already being consumed', async () => {
    await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)] });
    const claim = pool.query.mock.calls.find(([sql]) => /UPDATE ai_action_plans SET consumed_at/.test(sql));
    expect(String(claim[0])).toMatch(/WHERE id = \$1 AND consumed_at IS NULL/);
  });

  test('a plan is looked up by its owner, not just by id', async () => {
    await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)] });
    const lookup = pool.query.mock.calls.find(([sql]) => /FROM ai_action_plans/.test(sql));
    expect(String(lookup[0])).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(lookup[1][1]).toBe('u1');
  });

  test('someone else\'s plan is not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app())
      .post('/api/ai/actions/dues_reminders/execute')
      .send({ plan_id: 'plan-x' });
    expect(res.status).toBe(404);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('a plan cannot be redirected at a different action', async () => {
    pool.query.mockResolvedValueOnce(planRow({ action_id: 'renewal_reminders' }));
    const res = await request(app())
      .post('/api/ai/actions/dues_reminders/execute')
      .send({ plan_id: 'plan-1' });
    expect(res.status).toBe(400);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('a trainer cannot execute even with a valid plan id', async () => {
    mockUser = { id: 'u2', role: 'trainer', organization_id: 'org-1' };
    const res = await request(app())
      .post('/api/ai/actions/dues_reminders/execute')
      .send({ plan_id: 'plan-1' });
    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('execute requires a plan — there is no unconfirmed path', async () => {
    const res = await request(app()).post('/api/ai/actions/dues_reminders/execute').send({});
    expect(res.status).toBe(400);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('reports not_configured honestly instead of counting it as sent', async () => {
    mockSendText.mockResolvedValue({ status: 'not_configured' });
    const res = await planThenExecute({ executeClients: [CLIENT(1), CLIENT(2)] });
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(0);
    expect(res.body.data.tally.not_configured).toBe(2);
  });
});

// renewal_reminders is model-backed (usesModel: true): its plan/execute path
// freezes AI-drafted text at plan time rather than re-deriving it at execute
// (see registry.js's draft() and this route's own comments for why — model
// output is not deterministic, so re-drafting at execute would fail the
// fingerprint check on a perfectly good plan almost every time). These tests
// exercise that freeze directly rather than through the real model.
describe('a model-backed action freezes its drafted text', () => {
  const mockRoutedChat = jest.fn();
  jest.doMock('../lib/ai/router', () => ({ routedChat: (...a) => mockRoutedChat(...a) }));

  function freshApp() {
    jest.resetModules();
    jest.doMock('../db/pool', () => ({ query: (...a) => pool.query(...a) }));
    jest.doMock('../middleware/auth', () => ({
      auth: (req, _res, next) => { req.user = mockUser; next(); },
      adminOnly: (_req, _res, next) => next(),
      adminOrManager: (_req, _res, next) => next(),
    }));
    jest.doMock('../services/whatsappDelivery', () => ({
      sendText: (...a) => mockSendText(...a), sendTemplate: jest.fn(), twilioWhatsappConfigured: () => true,
    }));
    jest.doMock('../lib/ai/router', () => ({ routedChat: (...a) => mockRoutedChat(...a) }));
    // Quota enforcement itself (parallel-query resolution, over/under-limit
    // math) is aiQuota.test.js's job — mocked to a pass-through here so
    // these tests exercise the freeze/staleness logic in isolation. The
    // separate "never gated" test below swaps this for a spy instead.
    jest.doMock('../lib/aiQuota', () => ({ requireAiQuota: () => (_req, _res, next) => next() }));
    const a = express();
    a.use(express.json());
    a.use('/api/ai', require('../modules/ai-actions/ai-actions.routes'));
    a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    return a;
  }

  const RENEWAL = (i, days) => ({
    id: `c${i}`, name: `Client ${i}`, mobile: `99900000${i}`,
    pt_end_date: '2026-09-01', days_left: days,
  });

  beforeEach(() => {
    mockRoutedChat.mockReset();
    pool.query.mockReset();
  });

  test('the text sent is exactly the text drafted at plan time, not re-drafted at execute', async () => {
    const a = freshApp();
    mockRoutedChat.mockResolvedValue({
      content: JSON.stringify({ drafts: [{ id: 'c1', body: 'DRAFTED: hi Client 1, 3 days left!' }] }),
      model: 'test-model', usage: {}, latency_ms: 5, used_fallback: false,
    });

    pool.query
      .mockResolvedValueOnce({ rows: [RENEWAL(1, 3)] })                  // resolve (plan)
      .mockResolvedValueOnce({ rows: [] })                               // draft()'s logUsage insert
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', expires_at: future() }] }); // insert plan

    const planned = await request(a).post('/api/ai/actions/renewal_reminders/plan').send({ days: 7 });
    expect(planned.status).toBe(200);
    expect(planned.body.data.sample_message).toBe('DRAFTED: hi Client 1, 3 days left!');
    expect(mockRoutedChat).toHaveBeenCalledTimes(1); // one call for the whole batch

    const insertCall = pool.query.mock.calls.find(([sql]) => /INSERT INTO ai_action_plans/.test(sql));
    const [storedFingerprint, , , storedResolved] = insertCall[1].slice(3);
    const resolvedRecipients = JSON.parse(storedResolved);
    expect(resolvedRecipients).toEqual([{ id: 'c1', body: 'DRAFTED: hi Client 1, 3 days left!' }]);

    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'plan-1', action_id: 'renewal_reminders', fingerprint: storedFingerprint,
          params: { days: 7 }, resolved_recipients: resolvedRecipients,
          consumed_at: null, expires_at: future(),
        }],
      })
      .mockResolvedValueOnce({ rows: [RENEWAL(1, 3)] }) // resolve (execute) — eligibility unchanged
      .mockResolvedValueOnce({ rowCount: 1 })            // claim
      .mockResolvedValueOnce({ rows: [] });              // store result

    const executed = await request(a)
      .post('/api/ai/actions/renewal_reminders/execute')
      .send({ plan_id: planned.body.data.plan_id });

    expect(executed.status).toBe(200);
    expect(executed.body.data.sent).toBe(1);
    // routedChat was NOT called again — execute never re-drafts.
    expect(mockRoutedChat).toHaveBeenCalledTimes(1);
    expect(mockSendText).toHaveBeenCalledWith({ to: '999000001', body: 'DRAFTED: hi Client 1, 3 days left!' });
  });

  test('refuses as stale when eligibility changed, without ever re-drafting', async () => {
    const a = freshApp();
    mockRoutedChat.mockResolvedValue({
      content: JSON.stringify({ drafts: [{ id: 'c1', body: 'DRAFTED for c1' }] }),
      model: 'test-model', usage: {}, latency_ms: 5, used_fallback: false,
    });

    pool.query
      .mockResolvedValueOnce({ rows: [RENEWAL(1, 3)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', expires_at: future() }] });

    const planned = await request(a).post('/api/ai/actions/renewal_reminders/plan').send({ days: 7 });
    const insertCall = pool.query.mock.calls.find(([sql]) => /INSERT INTO ai_action_plans/.test(sql));
    const [storedFingerprint, , , storedResolved] = insertCall[1].slice(3);

    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'plan-1', action_id: 'renewal_reminders', fingerprint: storedFingerprint,
          params: { days: 7 }, resolved_recipients: JSON.parse(storedResolved),
          consumed_at: null, expires_at: future(),
        }],
      })
      // c1 renewed already (dropped) and c2 is now newly eligible instead.
      .mockResolvedValueOnce({ rows: [RENEWAL(2, 5)] });

    const executed = await request(a)
      .post('/api/ai/actions/renewal_reminders/execute')
      .send({ plan_id: planned.body.data.plan_id });

    expect(executed.status).toBe(409);
    expect(executed.body.code).toBe('plan_stale');
    expect(mockSendText).not.toHaveBeenCalled();
    // Refused on the id-set check alone — never asked the model to re-draft.
    expect(mockRoutedChat).toHaveBeenCalledTimes(1);
  });

  test('refuses if the stored drafted text was tampered with after planning', async () => {
    const a = freshApp();
    mockRoutedChat.mockResolvedValue({
      content: JSON.stringify({ drafts: [{ id: 'c1', body: 'DRAFTED for c1' }] }),
      model: 'test-model', usage: {}, latency_ms: 5, used_fallback: false,
    });

    pool.query
      .mockResolvedValueOnce({ rows: [RENEWAL(1, 3)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', expires_at: future() }] });

    const planned = await request(a).post('/api/ai/actions/renewal_reminders/plan').send({ days: 7 });
    const insertCall = pool.query.mock.calls.find(([sql]) => /INSERT INTO ai_action_plans/.test(sql));
    const [storedFingerprint] = insertCall[1].slice(3);

    // Same recipient, same id set — but the stored body was altered after
    // the operator approved it (simulating row corruption/tampering).
    const tampered = [{ id: 'c1', body: 'TAMPERED — not what was reviewed' }];

    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'plan-1', action_id: 'renewal_reminders', fingerprint: storedFingerprint,
          params: { days: 7 }, resolved_recipients: tampered,
          consumed_at: null, expires_at: future(),
        }],
      })
      .mockResolvedValueOnce({ rows: [RENEWAL(1, 3)] }); // same eligibility as plan time

    const executed = await request(a)
      .post('/api/ai/actions/renewal_reminders/execute')
      .send({ plan_id: planned.body.data.plan_id });

    expect(executed.status).toBe(409);
    expect(executed.body.code).toBe('plan_stale');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  // Not a repeat of the renewal_reminders proof above for its own sake — this
  // is what proves the freeze/quota mechanism is a general property of
  // `usesModel` actions, not something special-cased for one of them.
  test('a second model-backed action (lead_followup) gets the same freeze-and-send treatment', async () => {
    const a = freshApp();
    mockRoutedChat.mockResolvedValue({
      content: JSON.stringify({ drafts: [{ id: 'l1', body: 'DRAFTED: hi Priya, still interested?' }] }),
      model: 'test-model', usage: {}, latency_ms: 5, used_fallback: false,
    });

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'l1', name: 'Priya', mobile: '9990000001', source: 'walk_in', status: 'new', interested_package: null, follow_up_date: '2026-09-01' }] })
      .mockResolvedValueOnce({ rows: [] }) // draft()'s logUsage insert
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', expires_at: future() }] });

    const planned = await request(a).post('/api/ai/actions/lead_followup/plan').send({ days: 7 });
    expect(planned.status).toBe(200);
    expect(planned.body.data.sample_message).toBe('DRAFTED: hi Priya, still interested?');

    const insertCall = pool.query.mock.calls.find(([sql]) => /INSERT INTO ai_action_plans/.test(sql));
    const [storedFingerprint, , , storedResolved] = insertCall[1].slice(3);

    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'plan-1', action_id: 'lead_followup', fingerprint: storedFingerprint,
          params: { days: 7 }, resolved_recipients: JSON.parse(storedResolved),
          consumed_at: null, expires_at: future(),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'l1', name: 'Priya', mobile: '9990000001', source: 'walk_in', status: 'new', interested_package: null, follow_up_date: '2026-09-01' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const executed = await request(a)
      .post('/api/ai/actions/lead_followup/execute')
      .send({ plan_id: planned.body.data.plan_id });

    expect(executed.status).toBe(200);
    expect(executed.body.data.sent).toBe(1);
    expect(mockRoutedChat).toHaveBeenCalledTimes(1); // never re-drafted at execute
    expect(mockSendText).toHaveBeenCalledWith({ to: '9990000001', body: 'DRAFTED: hi Priya, still interested?' });
  });
});

// Separate describe: needs to observe the quota guard being called or not,
// so it uses a spy instead of the blanket pass-through above.
describe('the quota gate applies only to model-backed actions', () => {
  test('dues_reminders (usesModel: false) never invokes the quota guard; renewal_reminders (usesModel: true) does', async () => {
    jest.resetModules();
    const quotaGuardSpy = jest.fn((_req, _res, next) => next());
    jest.doMock('../db/pool', () => ({ query: (...a) => pool.query(...a) }));
    jest.doMock('../middleware/auth', () => ({
      auth: (req, _res, next) => { req.user = mockUser; next(); },
      adminOnly: (_req, _res, next) => next(),
      adminOrManager: (_req, _res, next) => next(),
    }));
    jest.doMock('../services/whatsappDelivery', () => ({
      sendText: (...a) => mockSendText(...a), sendTemplate: jest.fn(), twilioWhatsappConfigured: () => true,
    }));
    jest.doMock('../lib/ai/router', () => ({
      routedChat: jest.fn().mockResolvedValue({
        content: JSON.stringify({ drafts: [{ id: 'c1', body: 'drafted' }] }),
        model: 'm', usage: {}, latency_ms: 1, used_fallback: false,
      }),
    }));
    jest.doMock('../lib/aiQuota', () => ({ requireAiQuota: () => quotaGuardSpy }));
    const a = express();
    a.use(express.json());
    a.use('/api/ai', require('../modules/ai-actions/ai-actions.routes'));
    a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce({ rows: [CLIENT(1)] })
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', expires_at: future() }] });
    const duesRes = await request(a).post('/api/ai/actions/dues_reminders/plan').send({});
    expect(duesRes.status).toBe(200);
    expect(quotaGuardSpy).not.toHaveBeenCalled();

    pool.query.mockReset();
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'A', mobile: '999', pt_end_date: '2026-09-01', days_left: 3 }] })
      .mockResolvedValueOnce({ rows: [] }) // draft()'s logUsage insert
      .mockResolvedValueOnce({ rows: [{ id: 'plan-2', expires_at: future() }] });
    const renewalRes = await request(a).post('/api/ai/actions/renewal_reminders/plan').send({ days: 7 });
    expect(renewalRes.status).toBe(200);
    expect(quotaGuardSpy).toHaveBeenCalledTimes(1);
  });
});

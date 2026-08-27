// The assistant is not in the write path, and this is where that is enforced.
//
// Everything asserted here is a property that fails silently if it breaks.
// Nothing throws when an action messages one client too many, or messages the
// same twelve people twice, or reports "sent" for a run where nothing left the
// building. You find out from a client, later.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));

const mockSendText = jest.fn();
const mockConfigured = jest.fn(() => true);
jest.mock('../services/whatsappDelivery', () => ({
  sendText: (...a) => mockSendText(...a),
  sendTemplate: jest.fn(),
  twilioWhatsappConfigured: () => mockConfigured(),
}));

const { findAction, canRun, listFor, deliver, clampInt, MAX_RECIPIENTS } =
  require('../modules/ai-actions/registry');

const admin = { id: 'u1', role: 'admin', organization_id: 'org-1' };
const trainer = { id: 'u2', role: 'trainer', organization_id: 'org-1' };
const reqAs = (user, body = {}) => ({ user, body, headers: {} });

beforeEach(() => {
  mockQuery.mockReset();
  mockSendText.mockReset();
  mockConfigured.mockReturnValue(true);
});

describe('who may run an action', () => {
  test('a trainer is not offered outward actions, and cannot run one', () => {
    expect(listFor(trainer)).toEqual([]);
    expect(canRun(findAction('renewal_reminders'), trainer)).toBe(false);
  });

  test('an admin is', () => {
    expect(listFor(admin).map((a) => a.id).sort())
      .toEqual(['dues_reminders', 'lead_followup', 'renewal_reminders']);
    expect(canRun(findAction('renewal_reminders'), admin)).toBe(true);
  });

  test('every offered action declares that it leaves the building', () => {
    // The confirmation UI keys off this. An outward action mislabelled as
    // internal is one that sends without the operator being warned.
    for (const a of listFor(admin)) expect(a.outward).toBe(true);
  });
});

describe('parameters are clamped, not trusted', () => {
  test('clampInt bounds and falls back', () => {
    expect(clampInt('3650', { min: 1, max: 90, fallback: 7 })).toBe(90);
    expect(clampInt('0', { min: 1, max: 90, fallback: 7 })).toBe(1);
    expect(clampInt('banana', { min: 1, max: 90, fallback: 7 })).toBe(7);
    expect(clampInt(undefined, { min: 1, max: 90, fallback: 7 })).toBe(7);
  });

  test('a caller cannot widen the renewal window past 90 days', () => {
    expect(findAction('renewal_reminders').normalize({ days: 100000 })).toEqual({ days: 90 });
  });

  test('a caller cannot drop the dues floor below 1', () => {
    expect(findAction('dues_reminders').normalize({ min_balance: -5 })).toEqual({ min_balance: 1 });
  });
});

describe('recipients come from the server, scoped to the org', () => {
  test('a tenant user gets an organization_id filter and their own org id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findAction('renewal_reminders').resolve(reqAs(admin), { days: 7 });

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$2/);
    expect(values).toEqual([7, 'org-1']);
  });

  test('ids in the request body are ignored entirely', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const req = reqAs(admin, { client_ids: ['someone-elses-client'], recipients: ['x'] });
    await findAction('dues_reminders').resolve(req, { min_balance: 1 });

    const [, values] = mockQuery.mock.calls[0];
    // Only the clamped parameter and the org id — nothing caller-supplied.
    expect(values).toEqual([1, 'org-1']);
    expect(JSON.stringify(mockQuery.mock.calls[0])).not.toContain('someone-elses-client');
  });

  test('an org-less tenant user filters on NULL, which matches nobody', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findAction('dues_reminders').resolve(
      reqAs({ id: 'u9', role: 'admin', organization_id: null }), { min_balance: 1 },
    );
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$2/);
    expect(values[1]).toBeNull();
  });

  test('the recipient list is capped', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findAction('renewal_reminders').resolve(reqAs(admin), { days: 7 });
    expect(mockQuery.mock.calls[0][0]).toMatch(new RegExp(`LIMIT ${MAX_RECIPIENTS}\\b`));
  });
});

describe('lead_followup resolves only open leads with a due follow-up', () => {
  test('queries pt_leads, excludes terminal statuses, scoped to the caller\'s org', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await findAction('lead_followup').resolve(reqAs(admin), { days: 7 });

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM pt_leads/);
    expect(sql).toMatch(/status IN \('new', 'contacted', 'trial_scheduled'\)/);
    expect(sql).not.toMatch(/'converted'|'lost'/);
    expect(sql).toMatch(/organization_id = \$2/);
    expect(values).toEqual([7, 'org-1']);
  });

  test('a lead with no mobile number is excluded and counted, same as the client actions', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'l1', name: 'Has Phone', mobile: '9990000001', source: 'walk_in', status: 'new', interested_package: null, follow_up_date: '2026-09-01' },
        { id: 'l2', name: 'No Phone', mobile: null, source: 'referral', status: 'contacted', interested_package: null, follow_up_date: '2026-09-01' },
      ],
    });
    const { recipients, warnings } = await findAction('lead_followup').resolve(reqAs(admin), { days: 7 });
    expect(recipients.map((r) => r.id)).toEqual(['l1']);
    expect(warnings.join(' ')).toMatch(/1 matching lead has no mobile number/);
  });

  test('resolve() alone never computes a final body — it is model-backed', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'l1', name: 'Ajeet', mobile: '9990000001', source: 'instagram', status: 'new', interested_package: 'Gold', follow_up_date: '2026-09-01' }],
    });
    const { recipients } = await findAction('lead_followup').resolve(reqAs(admin), { days: 7 });
    expect(findAction('lead_followup').usesModel).toBe(true);
    expect(recipients[0].body).toBeUndefined();
    expect(recipients[0].templateBody).toContain('Ajeet');
    expect(recipients[0].templateBody).toContain('Gold');
  });
});

describe('lead_followup drafting reuses the same one-call batching as renewal_reminders', () => {
  test('drafts under the lead intent, falls back to templateBody per-recipient on a partial reply', async () => {
    jest.resetModules();
    const mockRoutedChat = jest.fn().mockResolvedValue({
      content: JSON.stringify({ drafts: [{ id: 'l1', body: 'Hey Ajeet, still thinking about Gold membership?' }] }),
      model: 'test-model', usage: {}, latency_ms: 10, used_fallback: false,
    });
    jest.doMock('../lib/ai/router', () => ({ routedChat: mockRoutedChat }));
    jest.doMock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));
    jest.doMock('../services/whatsappDelivery', () => ({
      sendText: (...a) => mockSendText(...a), sendTemplate: jest.fn(), twilioWhatsappConfigured: () => mockConfigured(),
    }));
    const registry = require('../modules/ai-actions/registry');

    const recipients = [
      { id: 'l1', name: 'Ajeet', templateBody: 'TEMPLATE for Ajeet', _draftFacts: { name: 'Ajeet', source: 'instagram', status: 'new', interested_package: 'Gold', follow_up_date: '2026-09-01' } },
      { id: 'l2', name: 'Priya', templateBody: 'TEMPLATE for Priya', _draftFacts: { name: 'Priya', source: 'referral', status: 'contacted', interested_package: null, follow_up_date: '2026-09-02' } },
    ];
    const out = await registry.finalize(registry.findAction('lead_followup'), reqAs(admin), recipients);

    expect(mockRoutedChat).toHaveBeenCalledTimes(1);
    expect(mockRoutedChat.mock.calls[0][0].intent).toBe('lead');
    expect(out.find((r) => r.id === 'l1').body).toBe('Hey Ajeet, still thinking about Gold membership?');
    expect(out.find((r) => r.id === 'l2').body).toBe('TEMPLATE for Priya');
    expect(out.find((r) => r.id === 'l2').ai_drafted).toBe(false);
    jest.dontMock('../lib/ai/router');
    jest.dontMock('../db/pool');
    jest.dontMock('../services/whatsappDelivery');
  });
});

describe('the plan tells the truth before anybody confirms', () => {
  test('an unconfigured channel is a warning on the plan, not a surprise after', async () => {
    // This codebase already shipped one endpoint that answered "sent" whether
    // or not anything left the building. Not twice.
    mockConfigured.mockReturnValue(false);
    mockQuery.mockResolvedValue({ rows: [{ id: 'c1', name: 'A', mobile: '9990000001', balance_amount: 500 }] });

    const { warnings } = await findAction('dues_reminders').resolve(reqAs(admin), { min_balance: 1 });
    expect(warnings.join(' ')).toMatch(/not configured/i);
  });

  test('clients with no mobile number are excluded and counted', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'c1', name: 'Has Phone', mobile: '9990000001', balance_amount: 500 },
        { id: 'c2', name: 'No Phone', mobile: null, balance_amount: 900 },
      ],
    });
    const { recipients, warnings } = await findAction('dues_reminders').resolve(reqAs(admin), { min_balance: 1 });
    expect(recipients.map((r) => r.id)).toEqual(['c1']);
    expect(warnings.join(' ')).toMatch(/1 matching client has no mobile number/);
  });

  test('each recipient carries the exact message that will be sent to them', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'c1', name: 'Ajeet', mobile: '9990000001', balance_amount: 2500 }],
    });
    // dues_reminders has no draft() (usesModel: false), so finalize() copies
    // templateBody straight to body — this IS the message that gets sent.
    const { recipients } = await findAction('dues_reminders').resolve(reqAs(admin), { min_balance: 1 });
    expect(recipients[0].templateBody).toContain('Ajeet');
    expect(recipients[0].templateBody).toContain('₹2,500');
  });
});

describe('the model can draft the words, never who gets messaged or when', () => {
  test('renewal_reminders is model-backed; dues_reminders is not', () => {
    expect(findAction('renewal_reminders').usesModel).toBe(true);
    expect(findAction('dues_reminders').usesModel).toBe(false);
  });

  test('resolve() alone never computes a final body for a model-backed action', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'c1', name: 'Ajeet', mobile: '9990000001', pt_end_date: '2026-09-01', days_left: 3 }],
    });
    const { recipients } = await findAction('renewal_reminders').resolve(reqAs(admin), { days: 7 });
    expect(recipients[0].body).toBeUndefined();
    expect(recipients[0].templateBody).toContain('Ajeet');
  });

  test('finalize() drafts one recipient in one model call, not one call per recipient', async () => {
    jest.resetModules();
    const mockRoutedChat = jest.fn().mockResolvedValue({
      content: JSON.stringify({ drafts: [{ id: 'c1', body: 'Hey Ajeet — 3 days left on your package, want to renew?' }] }),
      model: 'test-model', usage: { prompt_tokens: 10, completion_tokens: 10 }, latency_ms: 50, used_fallback: false,
    });
    jest.doMock('../lib/ai/router', () => ({ routedChat: mockRoutedChat }));
    jest.doMock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));
    jest.doMock('../services/whatsappDelivery', () => ({
      sendText: (...a) => mockSendText(...a), sendTemplate: jest.fn(), twilioWhatsappConfigured: () => mockConfigured(),
    }));
    const registry = require('../modules/ai-actions/registry');

    const recipients = [{
      id: 'c1', name: 'Ajeet', mobile: '9990000001', detail: '3d left',
      templateBody: 'Hi Ajeet, your personal training package ends on 2026-09-01. Reply here to renew and keep your slot.',
      _draftFacts: { name: 'Ajeet', days_left: 3, end_date: '2026-09-01' },
    }];
    const out = await registry.finalize(
      registry.findAction('renewal_reminders'), reqAs(admin), recipients,
    );

    expect(mockRoutedChat).toHaveBeenCalledTimes(1);
    expect(out[0].body).toBe('Hey Ajeet — 3 days left on your package, want to renew?');
    expect(out[0].ai_drafted).toBe(true);
    jest.dontMock('../lib/ai/router');
    jest.dontMock('../db/pool');
    jest.dontMock('../services/whatsappDelivery');
  });

  test('a recipient the model skipped still gets the deterministic fallback, never nothing', async () => {
    jest.resetModules();
    const mockRoutedChat = jest.fn().mockResolvedValue({
      // Only c1 drafted — c2 is missing from the response entirely.
      content: JSON.stringify({ drafts: [{ id: 'c1', body: 'Hi Ajeet, 3 days left!' }] }),
      model: 'test-model', usage: {}, latency_ms: 10, used_fallback: false,
    });
    jest.doMock('../lib/ai/router', () => ({ routedChat: mockRoutedChat }));
    jest.doMock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));
    jest.doMock('../services/whatsappDelivery', () => ({
      sendText: (...a) => mockSendText(...a), sendTemplate: jest.fn(), twilioWhatsappConfigured: () => mockConfigured(),
    }));
    const registry = require('../modules/ai-actions/registry');

    const recipients = [
      { id: 'c1', name: 'Ajeet', templateBody: 'TEMPLATE for Ajeet', _draftFacts: { name: 'Ajeet', days_left: 3, end_date: '2026-09-01' } },
      { id: 'c2', name: 'Priya', templateBody: 'TEMPLATE for Priya', _draftFacts: { name: 'Priya', days_left: 5, end_date: '2026-09-03' } },
    ];
    const out = await registry.finalize(
      registry.findAction('renewal_reminders'), reqAs(admin), recipients,
    );

    expect(out.find((r) => r.id === 'c1').ai_drafted).toBe(true);
    expect(out.find((r) => r.id === 'c2').ai_drafted).toBe(false);
    expect(out.find((r) => r.id === 'c2').body).toBe('TEMPLATE for Priya');
    jest.dontMock('../lib/ai/router');
    jest.dontMock('../db/pool');
    jest.dontMock('../services/whatsappDelivery');
  });

  test('a model failure falls back to the template for everyone, never throws', async () => {
    jest.resetModules();
    const mockRoutedChat = jest.fn().mockRejectedValue(new Error('AI service temporarily unavailable'));
    jest.doMock('../lib/ai/router', () => ({ routedChat: mockRoutedChat }));
    jest.doMock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));
    jest.doMock('../services/whatsappDelivery', () => ({
      sendText: (...a) => mockSendText(...a), sendTemplate: jest.fn(), twilioWhatsappConfigured: () => mockConfigured(),
    }));
    const registry = require('../modules/ai-actions/registry');

    const recipients = [{ id: 'c1', name: 'Ajeet', templateBody: 'TEMPLATE for Ajeet', _draftFacts: { name: 'Ajeet', days_left: 3, end_date: '2026-09-01' } }];
    const out = await registry.finalize(
      registry.findAction('renewal_reminders'), reqAs(admin), recipients,
    );

    expect(out[0].body).toBe('TEMPLATE for Ajeet');
    expect(out[0].ai_drafted).toBe(false);
    jest.dontMock('../lib/ai/router');
    jest.dontMock('../db/pool');
    jest.dontMock('../services/whatsappDelivery');
  });
});

describe('delivery reports what happened', () => {
  test('not_configured is passed through as itself, not as sent and not as failed', async () => {
    mockSendText.mockResolvedValue({ status: 'not_configured', provider_id: null });
    const out = await deliver([{ id: 'c1', name: 'A', mobile: '999', body: 'hi' }]);
    expect(out[0].status).toBe('not_configured');
  });

  test('one failure does not lose the rest of the run', async () => {
    mockSendText
      .mockResolvedValueOnce({ status: 'sent' })
      .mockResolvedValueOnce({ status: 'failed', error: 'bad number' })
      .mockResolvedValueOnce({ status: 'sent' });

    const out = await deliver([
      { id: 'a', name: 'A', mobile: '1', body: 'x' },
      { id: 'b', name: 'B', mobile: '2', body: 'x' },
      { id: 'c', name: 'C', mobile: '3', body: 'x' },
    ]);
    expect(out.map((r) => r.status)).toEqual(['sent', 'failed', 'sent']);
  });

  test('sends to exactly the resolved numbers, once each', async () => {
    mockSendText.mockResolvedValue({ status: 'sent' });
    await deliver([
      { id: 'a', name: 'A', mobile: '9990000001', body: 'one' },
      { id: 'b', name: 'B', mobile: '9990000002', body: 'two' },
    ]);
    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText).toHaveBeenCalledWith({ to: '9990000001', body: 'one' });
    expect(mockSendText).toHaveBeenCalledWith({ to: '9990000002', body: 'two' });
  });
});

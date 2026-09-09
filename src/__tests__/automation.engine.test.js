// The automation engine, attacked rather than read.
//
// ── Why this suite exists in this shape ─────────────────────────────────────
//
// Automated messaging is the one feature in this product where a bug reaches
// somebody who is not a user of it. A wrong row in a report is seen by the
// studio; a wrong message is seen by their client, on their phone, apparently
// from their gym, and cannot be recalled.
//
// So the assertions below are about what does NOT happen at least as much as
// what does. Every skip path asserts that nothing was queued, not merely that
// the function returned a particular string — a check that reports the right
// reason and enqueues anyway is the exact failure this would otherwise ship.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockEnqueue = jest.fn();
jest.mock('../services/whatsapp.service', () => ({
  enqueueWhatsapp: (...a) => mockEnqueue(...a),
}));

const engine = require('../modules/automation/automation.engine');
const { Outcome } = engine;

/**
 * Drive the repository's queries by matching on their SQL.
 *
 * Matching on text rather than call order because the engine's order is
 * exactly what several of these tests are about — a fixture keyed on position
 * would pass whatever order the code ran in, which is the property under test.
 */
function db({ settings, rules = [], client, sendsToday = 0, insertReturns = 'log-1' }) {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM whatsapp_automation_settings/.test(sql)) {
      return { rows: settings ? [settings] : [], rowCount: settings ? 1 : 0 };
    }
    if (/FROM automation_rules/.test(sql)) return { rows: rules, rowCount: rules.length };
    if (/FROM pt_clients/.test(sql)) return { rows: client ? [client] : [], rowCount: client ? 1 : 0 };
    if (/whatsapp_automation_trainer_grants/.test(sql)) {
      return { rows: db.grant ? [{ n: 1 }] : [], rowCount: db.grant ? 1 : 0 };
    }
    if (/COUNT\(\*\)::INT AS n/.test(sql)) return { rows: [{ n: sendsToday }], rowCount: 1 };
    if (/INSERT INTO communication_logs/.test(sql)) {
      return { rows: insertReturns ? [{ id: insertReturns }] : [], rowCount: insertReturns ? 1 : 0 };
    }
    if (/UPDATE automation_rules/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

const ENABLED = { automation_enabled: true, daily_send_limit: 200 };
const RULE = { id: 'rule-1', name: 'Thanks', template: 'Hi {{name}}, we got {{amount}}.', delay_minutes: 0, channel: 'whatsapp' };
const CLIENT = { id: 'client-1', name: 'Asha', phone: '+919876543210', trainer_id: 'trainer-a' };

const emit = (over = {}) => engine.emit({
  orgId: ORG_A, event: 'payment_received', clientId: 'client-1', eventKey: 'pay-1',
  context: { amount: '₹2,500' }, ...over,
});

/** Every INSERT INTO communication_logs this run issued. */
const insertCalls = () =>
  mockQuery.mock.calls.filter(([sql]) => /INSERT INTO communication_logs/.test(sql));

beforeEach(() => {
  mockQuery.mockReset();
  mockEnqueue.mockReset();
  mockEnqueue.mockResolvedValue({ id: 'job-1' });
  db.grant = true;
});

describe('the studio switch', () => {
  test('a studio that has never opened the setting sends nothing', async () => {
    // No settings row at all. The repository defaults it CLOSED, and this is
    // the assertion that the default is not "allowed" — a feature that ships
    // enabled for everyone who never visited its page is how a product
    // messages clients it was never told to message.
    db({ settings: null, rules: [RULE], client: CLIENT });
    const res = await emit();

    expect(res.outcome).toBe(Outcome.AUTOMATION_DISABLED);
    expect(res.queued).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
  });

  test('an explicitly disabled studio sends nothing', async () => {
    db({ settings: { automation_enabled: false, daily_send_limit: 200 }, rules: [RULE], client: CLIENT });
    const res = await emit();
    expect(res.outcome).toBe(Outcome.AUTOMATION_DISABLED);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('the switch is checked before anything else is looked up', async () => {
    // It is the control an owner reaches for when something is wrong. If it
    // were checked last, turning it off would still run every lookup, and a
    // failure in one of those would keep messages flowing.
    db({ settings: { automation_enabled: false, daily_send_limit: 200 }, rules: [RULE], client: CLIENT });
    await emit();
    const touched = mockQuery.mock.calls.map(([sql]) => sql).join(' ');
    expect(touched).not.toMatch(/FROM pt_clients/);
    expect(touched).not.toMatch(/FROM automation_rules/);
  });
});

describe('rules', () => {
  test('no active rule for the event means no work', async () => {
    db({ settings: ENABLED, rules: [], client: CLIENT });
    const res = await emit();
    expect(res.outcome).toBe(Outcome.NO_ACTIVE_RULE);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('the rule lookup is bound to the caller\'s organization and event', async () => {
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    await emit();
    const call = mockQuery.mock.calls.find(([sql]) => /FROM automation_rules/.test(sql));
    expect(call[1]).toEqual([ORG_A, 'payment_received']);
  });

  test('an event the schema does not define is refused', async () => {
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    const res = await emit({ event: 'not_a_real_event' });
    expect(res.outcome).toBe(Outcome.NO_ACTIVE_RULE);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('every event the engine knows is one the database CHECK accepts', () => {
    // The two lists are duplicated deliberately — the constraint is in
    // migration 012 and cannot be imported. A value here the constraint
    // rejects is a rule that can never exist; one in the constraint and not
    // here is a rule a studio can create that nothing will ever fire. Both
    // are silent.
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db/migrations/012_business_flow_complete.sql'), 'utf8',
    );
    const block = sql.match(/trigger_event\s+TEXT\s+NOT NULL\s+CHECK \(trigger_event IN \(([\s\S]*?)\)\)/);
    const inDb = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect([...engine.TRIGGER_EVENTS].sort()).toEqual(inDb);
  });
});

describe('tenant isolation', () => {
  test('an emit with no organization refuses rather than defaulting', async () => {
    // There is no safe default here. The only available one would be "every
    // studio", which is the worst possible answer for a send.
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    const res = await emit({ orgId: null });
    expect(res.outcome).toBe(Outcome.AUTOMATION_DISABLED);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a client the studio does not own resolves to nothing and queues nothing', async () => {
    // The repository scopes the lookup, so another studio's client id returns
    // no row. "Not found" and "not yours" are the same answer on purpose.
    db({ settings: ENABLED, rules: [RULE], client: null });
    const res = await emit();
    expect(res.outcome).toBe(Outcome.RECIPIENT_NOT_FOUND);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(insertCalls()).toHaveLength(0);
  });

  test('the recipient lookup carries the caller\'s org, not the row\'s', async () => {
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    await emit();
    const call = mockQuery.mock.calls.find(([sql]) => /FROM pt_clients/.test(sql));
    expect(call[1]).toEqual(['client-1', ORG_A]);
  });

  test('the queued row is stamped with the caller\'s organization', async () => {
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    await emit();
    expect(insertCalls()[0][1][0]).toBe(ORG_A);
    expect(insertCalls()[0][1]).not.toContain(ORG_B);
  });
});

describe('the trainer permission gate', () => {
  test('a client whose trainer has no grant is not messaged', async () => {
    db.grant = false;
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    const res = await emit();

    expect(res.outcome).toBe(Outcome.TRAINER_NOT_PERMITTED);
    // The assertion that matters: not that it said no, but that no row and no
    // job exist. A skip that still queued would deliver the message anyway.
    expect(insertCalls()).toHaveLength(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('the grant is looked up for the CLIENT\'s trainer, in the caller\'s org', async () => {
    // Not whoever triggered the event. A payment taken by the front desk still
    // produces a message the client reads as coming from their trainer's
    // studio relationship, so it is that trainer's grant that must exist.
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    await emit();
    const call = mockQuery.mock.calls.find(([sql]) => /whatsapp_automation_trainer_grants/.test(sql));
    expect(call[1]).toEqual([ORG_A, 'trainer-a']);
  });

  test('a client with no trainer is a studio-level message and still goes', async () => {
    // There is no individual to attribute it to, the studio switch is the
    // whole authorisation, and requiring a grant that cannot exist would make
    // unassigned clients silently unmessageable.
    db.grant = false;
    db({ settings: ENABLED, rules: [RULE], client: { ...CLIENT, trainer_id: null } });
    const res = await emit();
    expect(res.outcome).toBe(Outcome.QUEUED);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  test('a client with no phone number is not messaged', async () => {
    db({ settings: ENABLED, rules: [RULE], client: { ...CLIENT, phone: null } });
    const res = await emit();
    expect(res.outcome).toBe(Outcome.NO_PHONE);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe('the daily limit', () => {
  test('a studio at its limit queues nothing further', async () => {
    db({ settings: { automation_enabled: true, daily_send_limit: 5 }, rules: [RULE], client: CLIENT, sendsToday: 5 });
    const res = await emit();
    expect(res.outcome).toBe(Outcome.DAILY_LIMIT_REACHED);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a studio below its limit is unaffected', async () => {
    db({ settings: { automation_enabled: true, daily_send_limit: 5 }, rules: [RULE], client: CLIENT, sendsToday: 4 });
    expect((await emit()).outcome).toBe(Outcome.QUEUED);
  });
});

describe('the delay', () => {
  test('a rule with no delay is enqueued for immediate delivery', async () => {
    db({ settings: ENABLED, rules: [{ ...RULE, delay_minutes: 0 }], client: CLIENT });
    await emit();
    expect(mockEnqueue.mock.calls[0][2].delay).toBe(0);
  });

  test('a rule\'s delay_minutes becomes the job\'s delay in milliseconds', async () => {
    // This column has been settable from the settings page since migration 012
    // and has never been read by anything.
    db({ settings: ENABLED, rules: [{ ...RULE, delay_minutes: 90 }], client: CLIENT });
    await emit();
    expect(mockEnqueue.mock.calls[0][2].delay).toBe(90 * 60 * 1000);
  });

  test('a negative delay cannot pull a job into the past', async () => {
    db({ settings: ENABLED, rules: [{ ...RULE, delay_minutes: -30 }], client: CLIENT });
    await emit();
    expect(mockEnqueue.mock.calls[0][2].delay).toBe(0);
  });
});

describe('the queued job', () => {
  test('carries the log row id and the organization, and nothing else it could be fooled by', async () => {
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    await emit();
    const [type, payload] = mockEnqueue.mock.calls[0];
    expect(type).toBe('automation');
    expect(payload).toMatchObject({ logId: 'log-1', orgId: ORG_A });
    // No phone number and no message text on the job. Both are on the row,
    // which is org-scoped; a payload carrying them could deliver to a number
    // the row does not name if it were ever edited.
    expect(payload).not.toHaveProperty('to');
    expect(payload).not.toHaveProperty('message');
  });

  test('uses the log row id as the BullMQ job id, so a repeated emit cannot double-queue', async () => {
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    await emit();
    expect(mockEnqueue.mock.calls[0][2].jobId).toBe('wa-auto-log-1');
  });

  test('the row is written BEFORE the job is enqueued', async () => {
    // A row with no job is a message that visibly never went out and can be
    // re-driven. A job with no row is a message a client receives that this
    // system has no record of.
    const order = [];
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    const inner = mockQuery.getMockImplementation();
    mockQuery.mockImplementation(async (sql, params) => {
      if (/INSERT INTO communication_logs/.test(sql)) order.push('row');
      return inner(sql, params);
    });
    mockEnqueue.mockImplementation(async () => { order.push('job'); return { id: 'job-1' }; });

    await emit();
    expect(order).toEqual(['row', 'job']);
  });

  test('a queue outage leaves the row queued rather than marking it failed', async () => {
    // Redis is down. The row is a true statement and the state an operator can
    // re-drive from; marking it failed would throw away a message the studio
    // still wants sent.
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    mockEnqueue.mockResolvedValue(null);

    const res = await emit();
    expect(res.outcome).toBe(Outcome.NOT_ENQUEUED);
    expect(mockQuery.mock.calls.some(([sql]) => /status = 'failed'/.test(sql))).toBe(false);
  });
});

describe('duplicate business events', () => {
  test('an event that already produced a message queues nothing more', async () => {
    // The INSERT returns no row because the partial unique index on
    // (organization_id, automation_dedupe_key) rejected it. A redelivered
    // webhook or an overlapping sweep is normal, not an error.
    db({ settings: ENABLED, rules: [RULE], client: CLIENT, insertReturns: null });
    const res = await emit();

    expect(res.results[0].outcome).toBe(Outcome.DUPLICATE_EVENT);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('the dedupe key names the rule as well as the event', async () => {
    // Two different rules on one payment must both fire; the same rule on a
    // redelivered payment must not.
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    await emit();
    expect(insertCalls()[0][1]).toContain('payment_received:rule-1:pay-1');
  });

  test('two rules on one event produce two distinct keys', async () => {
    const second = { ...RULE, id: 'rule-2', name: 'Follow up' };
    db({ settings: ENABLED, rules: [RULE, second], client: CLIENT });
    await emit();
    const keys = insertCalls().map(([, params]) => params[params.length - 1]);
    expect(keys).toEqual(['payment_received:rule-1:pay-1', 'payment_received:rule-2:pay-1']);
  });
});

describe('rendering', () => {
  test('fills placeholders from the event context and the recipient', async () => {
    db({ settings: ENABLED, rules: [RULE], client: CLIENT });
    await emit();
    expect(insertCalls()[0][1]).toContain('Hi Asha, we got ₹2,500.');
  });

  test('leaves an unknown placeholder standing rather than writing "undefined"', () => {
    // A client receiving `Hi {{nickname}}` is a visible bug the studio will
    // report. `Hi undefined` reads like the product is broken, and `Hi ` reads
    // like nothing is wrong at all.
    expect(engine.render('Hi {{nickname}}', { name: 'Asha' })).toBe('Hi {{nickname}}');
    expect(engine.render('Hi {{name}}', { name: '' })).toBe('Hi {{name}}');
  });

  test('is not a template language', () => {
    // Anything with control flow in it can loop, throw, or read something it
    // should not — inside a message to a real client.
    expect(engine.render('{{#each clients}}{{/each}}', {})).toBe('{{#each clients}}{{/each}}');
    expect(engine.render('${process.env.JWT_SECRET}', {})).toBe('${process.env.JWT_SECRET}');
  });
});

describe('failure containment', () => {
  test('a database failure does not propagate into the business transaction', async () => {
    // emit() is called from inside recording a payment. An automation failure
    // must never roll one back.
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    await expect(emit()).resolves.toMatchObject({ outcome: Outcome.NOT_ENQUEUED });
  });
});

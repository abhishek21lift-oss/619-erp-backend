'use strict';
// The named business events, and the idempotency key each one derives.
//
// ── Why the keys get their own suite ────────────────────────────────────────
//
// The dedupe key is the only thing standing between a retried request and a
// second WhatsApp message to a real person's phone. Every other guard in this
// system — the studio switch, the trainer grant, the daily limit — answers
// "may we send at all". The key answers "is this the same event we already
// sent", and it is the only guard whose failure is invisible: nothing errors,
// nothing is logged as refused, the client simply gets told twice.
//
// So each trigger's key is asserted on directly rather than inferred from
// behaviour, and each assertion says which two situations the key has to tell
// apart. Getting that backwards in either direction is a bug: a key too
// specific sends duplicates, a key too general silences a legitimate second
// event forever.

jest.mock('../modules/automation/automation.engine', () => ({
  emit: jest.fn(async () => ({ outcome: 'queued', queued: 1, results: [] })),
}));

const engine = require('../modules/automation/automation.engine');
const triggers = require('../modules/automation/automation.triggers');

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const req = { id: 'req-1', user: { organization_id: ORG_A } };

const lastEmit = () => engine.emit.mock.calls.at(-1)[0];

beforeEach(() => {
  jest.clearAllMocks();
  engine.emit.mockResolvedValue({ outcome: 'queued', queued: 1, results: [] });
  delete process.env.AUTOMATION_SESSION_LOW_THRESHOLD;
});

describe('the org always comes from the request, never from the caller', () => {
  test.each([
    ['paymentReceived', () => triggers.paymentReceived(req, { clientId: 'c-1', amount: 2500, eventKey: 'pay-1' })],
    ['memberCreated', () => triggers.memberCreated(req, { clientId: 'c-1' })],
    ['leadCreated', () => triggers.leadCreated(req, { leadId: 'l-1' })],
    ['trialScheduled', () => triggers.trialScheduled(req, { leadId: 'l-1' })],
  ])('%s', async (_name, call) => {
    // orgIdOf(req) rather than anything in the payload. A trigger that took an
    // org from its caller would let a handler that resolved the wrong studio
    // message that studio's clients — and the handlers are where a tenant bug
    // is most likely to be, which is why this is not their decision.
    await call();
    expect(lastEmit().orgId).toBe(ORG_A);
  });
});

describe('lead_created', () => {
  test('names a lead, keyed on the lead itself', async () => {
    await triggers.leadCreated(req, {
      leadId: 'l-1', source: 'instagram', interestedPackage: 'Transformation',
    });

    expect(lastEmit()).toMatchObject({
      event: 'lead_created',
      recipientType: 'lead',
      subjectId: 'l-1',
      // A lead is captured once. A retried POST that produced a second row is
      // a second lead, with its own id, and should be greeted.
      eventKey: 'l-1',
    });
    expect(lastEmit().context).toEqual({ source: 'instagram', package: 'Transformation' });
  });

  test('a missing source or package becomes an empty placeholder, not "undefined"', async () => {
    await triggers.leadCreated(req, { leadId: 'l-2' });
    // The engine leaves an empty value's placeholder standing, so the studio
    // sees `{{source}}` in the message and reports it. "Hi, thanks for your
    // undefined enquiry" is what this exists to prevent.
    expect(lastEmit().context).toEqual({ source: '', package: '' });
  });
});

describe('trial_scheduled', () => {
  test('names a lead and keys on the lead itself', async () => {
    await triggers.trialScheduled(req, { leadId: 'l-1' });

    expect(lastEmit()).toMatchObject({
      event: 'trial_scheduled',
      recipientType: 'lead',
      subjectId: 'l-1',
      eventKey: 'l-1',
    });
  });

  test('every later edit to the same lead produces the same key', async () => {
    // The handler calls this on any PATCH that leaves the lead in
    // trial_scheduled, including one that only changed the notes. That is
    // deliberate — it saves a previous-status lookup — and it works only
    // because the key is stable, so the dedupe index refuses the repeat.
    await triggers.trialScheduled(req, { leadId: 'l-1' });
    await triggers.trialScheduled(req, { leadId: 'l-1' });
    const keys = engine.emit.mock.calls.map(([a]) => a.eventKey);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe('session_low', () => {
  test('a healthy balance emits nothing at all', async () => {
    const res = await triggers.sessionLow(req, { clientId: 'c-1', remaining: 9 });

    expect(engine.emit).not.toHaveBeenCalled();
    expect(res).toMatchObject({ outcome: 'not_low', queued: 0 });
  });

  test('the threshold is inclusive, and it is three', async () => {
    // Three is what migration 012's partial index `sb_low_idx` has always
    // called low. A second definition here that disagreed with the index would
    // be the kind of drift nobody finds until a studio asks why the warning
    // came a session late.
    expect(triggers.sessionLowThreshold()).toBe(3);
    await triggers.sessionLow(req, { clientId: 'c-1', remaining: 3 });
    expect(engine.emit).toHaveBeenCalledTimes(1);
  });

  test('the count is in the key, so 3 → 2 → 1 is three events', async () => {
    for (const remaining of [3, 2, 1]) {
      await triggers.sessionLow(req, { clientId: 'c-1', remaining });
    }
    const keys = engine.emit.mock.calls.map(([a]) => a.eventKey);
    expect(keys).toEqual(['c-1:3', 'c-1:2', 'c-1:1']);
  });

  test('but two reads at the same count are one event', async () => {
    // A double-submitted "use a session" that only decremented once must not
    // produce two warnings. Same balance, same key, and the dedupe index
    // refuses the second row.
    await triggers.sessionLow(req, { clientId: 'c-1', remaining: 2 });
    await triggers.sessionLow(req, { clientId: 'c-1', remaining: 2 });
    const keys = engine.emit.mock.calls.map(([a]) => a.eventKey);
    expect(keys[0]).toBe(keys[1]);
  });

  test('a balance that is not a number is not a low balance', async () => {
    // RETURNING * hands back whatever the column holds. `undefined > 3` is
    // false, so a naive comparison would treat a missing balance as low and
    // warn every client the studio has.
    await triggers.sessionLow(req, { clientId: 'c-1', remaining: undefined });
    await triggers.sessionLow(req, { clientId: 'c-1', remaining: null });
    await triggers.sessionLow(req, { clientId: 'c-1', remaining: 'plenty' });
    expect(engine.emit).not.toHaveBeenCalled();
  });

  test('the threshold is configurable', async () => {
    process.env.AUTOMATION_SESSION_LOW_THRESHOLD = '5';
    expect(triggers.sessionLowThreshold()).toBe(5);
    await triggers.sessionLow(req, { clientId: 'c-1', remaining: 5 });
    expect(engine.emit).toHaveBeenCalledTimes(1);

    process.env.AUTOMATION_SESSION_LOW_THRESHOLD = 'low-ish';
    expect(triggers.sessionLowThreshold()).toBe(3);
  });
});

describe('the sweep-driven triggers take an org, not a request', () => {
  test.each([
    ['membershipExpiring', () => triggers.membershipExpiring(ORG_A, { clientId: 'c-1', endDate: '2026-09-16', daysRemaining: 7 })],
    ['membershipExpired', () => triggers.membershipExpired(ORG_A, { clientId: 'c-1', endDate: '2026-09-08' })],
    ['birthday', () => triggers.birthday(ORG_A, { clientId: 'c-1', today: '2026-09-09' })],
    ['anniversary', () => triggers.anniversary(ORG_A, { clientId: 'c-1', years: 2, today: '2026-09-09' })],
    ['attendanceMissed', () => triggers.attendanceMissed(ORG_A, { clientId: 'c-1', lastVisit: '2026-08-01', daysSince: 39 })],
    ['followupDue', () => triggers.followupDue(ORG_A, { leadId: 'l-1', followUpDate: '2026-09-01' })],
  ])('%s', async (_name, call) => {
    // These run in a worker where there is no request at all. A signature that
    // accepted one would invite the next person to reach for req.user in a
    // context that has none — and get undefined, which orgIdOf would turn into
    // an org-less emit.
    await call();
    expect(lastEmit().orgId).toBe(ORG_A);
    expect(lastEmit().requestId).toBeUndefined();
  });
});

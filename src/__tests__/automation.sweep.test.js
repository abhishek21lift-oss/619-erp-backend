'use strict';
// The daily sweep: which studios it visits, which questions it asks them, and
// what it puts in an idempotency key.
//
// ── What this file can and cannot prove ─────────────────────────────────────
//
// The repository is mocked, so every assertion here is about the sweep's
// CONTROL FLOW — that it loops studios rather than joining across them, that
// it asks only about events a studio has a rule for, that one studio's failure
// does not end the run, and that the dedupe key it derives from a row is
// anchored to a date the row owns rather than to the clock.
//
// It cannot prove the SQL is right. Whether `attendanceMissedFor` actually
// excludes another studio's clients is a question about a WHERE clause, and a
// mock returns whatever it was told to regardless of the WHERE clause — that
// is exactly how a missing tenant predicate survived a full mocked suite
// earlier in this work. Those live in automation.tenancy.integration.test.js,
// against real PostgreSQL.

jest.mock('../modules/automation/automation.repository', () => ({
  orgsWithAutomationOn: jest.fn(),
  activeTriggerEventsFor: jest.fn(),
  membershipExpiringIn: jest.fn(),
  membershipExpiredYesterday: jest.fn(),
  birthdaysToday: jest.fn(),
  anniversariesToday: jest.fn(),
  attendanceMissedFor: jest.fn(),
  followupsDue: jest.fn(),
}));

jest.mock('../modules/automation/automation.engine', () => ({
  emit: jest.fn(async () => ({ outcome: 'queued', queued: 1, results: [] })),
  Outcome: {
    QUEUED: 'queued',
    AUTOMATION_DISABLED: 'automation_disabled',
    NO_ACTIVE_RULE: 'no_active_rule',
    RECIPIENT_NOT_FOUND: 'recipient_not_found',
    NO_PHONE: 'no_phone',
    TRAINER_NOT_PERMITTED: 'trainer_not_permitted',
    DAILY_LIMIT_REACHED: 'daily_limit_reached',
    DUPLICATE_EVENT: 'duplicate_event',
    NOT_ENQUEUED: 'not_enqueued',
  },
}));

const repo = require('../modules/automation/automation.repository');
const engine = require('../modules/automation/automation.engine');
const sweep = require('../modules/automation/automation.sweep');

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ALL_EVENTS = [
  'membership_expiring', 'membership_expired', 'birthday',
  'anniversary', 'attendance_missed', 'followup_due',
];

/** Every emit() the sweep made, in order. */
const emitted = () => engine.emit.mock.calls.map(([args]) => args);
const emittedFor = (event) => emitted().filter((a) => a.event === event);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTOMATION_EXPIRY_REMINDER_DAYS;
  delete process.env.AUTOMATION_ABSENCE_DAYS;

  // Every query answers empty by default, so a test that wants rows says so
  // and a test that does not is asserting on silence rather than on leftovers.
  repo.orgsWithAutomationOn.mockResolvedValue([]);
  repo.activeTriggerEventsFor.mockResolvedValue([]);
  repo.membershipExpiringIn.mockResolvedValue([]);
  repo.membershipExpiredYesterday.mockResolvedValue([]);
  repo.birthdaysToday.mockResolvedValue([]);
  repo.anniversariesToday.mockResolvedValue([]);
  repo.attendanceMissedFor.mockResolvedValue([]);
  repo.followupsDue.mockResolvedValue([]);
  engine.emit.mockResolvedValue({ outcome: 'queued', queued: 1, results: [] });
});

describe('which studios the sweep visits', () => {
  test('only the studios that have switched automation on', async () => {
    // The kill switch has to work here too. A studio that turned automation
    // off is not visited at all — not visited and then filtered by the engine,
    // which would still have run six queries against its data first.
    repo.orgsWithAutomationOn.mockResolvedValue([]);
    const summary = await sweep.runSweep();

    expect(summary.orgs).toBe(0);
    expect(repo.activeTriggerEventsFor).not.toHaveBeenCalled();
    expect(engine.emit).not.toHaveBeenCalled();
  });

  test('a studio with automation on but no sweep rules is not queried', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A]);
    repo.activeTriggerEventsFor.mockResolvedValue([]);

    const summary = await sweep.runSweep();

    expect(repo.activeTriggerEventsFor).toHaveBeenCalledWith(ORG_A);
    expect(summary.orgs).toBe(0);
    expect(repo.birthdaysToday).not.toHaveBeenCalled();
    expect(repo.attendanceMissedFor).not.toHaveBeenCalled();
  });

  test("a studio's request-driven rules do not make it a sweep candidate", async () => {
    // payment_received and member_created are emitted from their handlers. A
    // studio whose only rules are those must not be swept — and, critically,
    // must not have its roster scanned for events it has no rule for.
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A]);
    repo.activeTriggerEventsFor.mockResolvedValue(['payment_received', 'member_created']);

    const summary = await sweep.runSweep();

    expect(summary.orgs).toBe(0);
    expect(engine.emit).not.toHaveBeenCalled();
  });

  test('each studio is queried with its own id and nothing else', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A, ORG_B]);
    repo.activeTriggerEventsFor.mockResolvedValue(['birthday']);

    await sweep.runSweep();

    // The tenant boundary in this design is the loop variable. If a query ever
    // ran without one, or with both, this is what would notice.
    expect(repo.birthdaysToday.mock.calls).toEqual([[ORG_A], [ORG_B]]);
  });

  test('one studio failing does not end the run', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A, ORG_B]);
    repo.activeTriggerEventsFor.mockResolvedValue(['birthday']);
    repo.birthdaysToday.mockRejectedValueOnce(new Error('boom'));
    repo.birthdaysToday.mockResolvedValue([{ id: 'c-b', today: '2026-09-09' }]);

    const summary = await sweep.runSweep();

    expect(summary.skipped).toBe(1);
    expect(emittedFor('birthday')).toHaveLength(1);
    expect(emittedFor('birthday')[0].orgId).toBe(ORG_B);
  });
});

describe('only the events a studio has rules for', () => {
  test('one rule means one query', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A]);
    repo.activeTriggerEventsFor.mockResolvedValue(['followup_due']);

    await sweep.runSweep();

    expect(repo.followupsDue).toHaveBeenCalledWith(ORG_A);
    expect(repo.birthdaysToday).not.toHaveBeenCalled();
    expect(repo.membershipExpiringIn).not.toHaveBeenCalled();
    expect(repo.membershipExpiredYesterday).not.toHaveBeenCalled();
    expect(repo.anniversariesToday).not.toHaveBeenCalled();
    expect(repo.attendanceMissedFor).not.toHaveBeenCalled();
  });

  test('all six run when all six are active', async () => {
    await sweep.sweepOrg(ORG_A, ALL_EVENTS);

    expect(repo.membershipExpiringIn).toHaveBeenCalled();
    expect(repo.membershipExpiredYesterday).toHaveBeenCalledWith(ORG_A);
    expect(repo.birthdaysToday).toHaveBeenCalledWith(ORG_A);
    expect(repo.anniversariesToday).toHaveBeenCalledWith(ORG_A);
    expect(repo.attendanceMissedFor).toHaveBeenCalledWith(ORG_A, 14);
    expect(repo.followupsDue).toHaveBeenCalledWith(ORG_A);
  });

  test('SWEEP_EVENTS is exactly the set this file handles', () => {
    // A value added to SWEEP_EVENTS without a branch in sweepOrg is an event
    // the sweep claims to produce and never does — silent, and the studio's
    // rule sits there looking active.
    expect([...sweep.SWEEP_EVENTS].sort()).toEqual([...ALL_EVENTS].sort());
  });
});

describe('the expiry reminder buckets', () => {
  test('7, 3 and 1 days out, each as its own query', async () => {
    await sweep.sweepOrg(ORG_A, ['membership_expiring']);

    expect(repo.membershipExpiringIn.mock.calls).toEqual([
      [ORG_A, 7], [ORG_A, 3], [ORG_A, 1],
    ]);
  });

  test('the buckets are configurable, and rubbish falls back to the default', async () => {
    process.env.AUTOMATION_EXPIRY_REMINDER_DAYS = '10, 2';
    expect(sweep.reminderDays()).toEqual([10, 2]);

    process.env.AUTOMATION_EXPIRY_REMINDER_DAYS = 'soon, -4, 0';
    expect(sweep.reminderDays()).toEqual([7, 3, 1]);
  });

  test('the absence window is configurable, and rubbish falls back to 14', () => {
    process.env.AUTOMATION_ABSENCE_DAYS = '21';
    expect(sweep.absenceDays()).toBe(21);

    process.env.AUTOMATION_ABSENCE_DAYS = 'a fortnight';
    expect(sweep.absenceDays()).toBe(14);
  });
});

describe('the idempotency key each event derives', () => {
  test('membership_expiring keys on the client, the expiry date AND the bucket', async () => {
    repo.membershipExpiringIn.mockResolvedValue([
      { id: 'c-1', name: 'Asha', end_date: '2026-09-16', days_remaining: 7 },
    ]);

    await sweep.sweepOrg(ORG_A, ['membership_expiring']);

    const keys = emittedFor('membership_expiring').map((a) => a.eventKey);
    // The expiry date is in the key so that a client who renews and later
    // approaches a NEW expiry fires again; the bucket is in it so 7-days-out
    // and 3-days-out are two events rather than one.
    expect(keys).toContain('c-1:2026-09-16:7');
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('attendance_missed keys on the LAST VISIT, not the day count', async () => {
    // The day count climbs every morning the client stays away, so keying on
    // it would send one message per day of absence. The last visit does not
    // change until they come back — which is exactly when the next absence
    // should be allowed to fire.
    repo.attendanceMissedFor.mockResolvedValue([
      { id: 'c-1', name: 'Asha', last_visit: '2026-08-20', days_since: 20 },
    ]);
    await sweep.sweepOrg(ORG_A, ['attendance_missed']);
    const first = emittedFor('attendance_missed')[0];

    jest.clearAllMocks();
    repo.attendanceMissedFor.mockResolvedValue([
      { id: 'c-1', name: 'Asha', last_visit: '2026-08-20', days_since: 21 },
    ]);
    await sweep.sweepOrg(ORG_A, ['attendance_missed']);
    const nextDay = emittedFor('attendance_missed')[0];

    expect(nextDay.eventKey).toBe(first.eventKey);
    expect(nextDay.eventKey).toBe('c-1:2026-08-20');
    // The day count still reaches the template, it just is not identity.
    expect(nextDay.context.days).toBe('21');
  });

  test('birthday and anniversary key on the year, so next year fires again', async () => {
    repo.birthdaysToday.mockResolvedValue([{ id: 'c-1', today: '2026-09-09' }]);
    repo.anniversariesToday.mockResolvedValue([{ id: 'c-1', today: '2026-09-09', years: 2 }]);

    await sweep.sweepOrg(ORG_A, ['birthday', 'anniversary']);

    expect(emittedFor('birthday')[0].eventKey).toBe('c-1:2026');
    expect(emittedFor('anniversary')[0].eventKey).toBe('c-1:2026');
    expect(emittedFor('anniversary')[0].context.years).toBe('2');
  });

  test('followup_due keys on the follow-up date, so moving it chases again', async () => {
    repo.followupsDue.mockResolvedValue([
      { id: 'l-1', name: 'Priya', follow_up_date: '2026-09-01', interested_package: 'Transformation' },
    ]);

    await sweep.sweepOrg(ORG_A, ['followup_due']);
    const call = emittedFor('followup_due')[0];

    expect(call.eventKey).toBe('l-1:2026-09-01');
    expect(call.context.package).toBe('Transformation');
  });

  test('no key contains a timestamp', async () => {
    // The whole point. A key with the run time in it makes every re-run a new
    // business event, and the dedupe index — which is the only thing standing
    // between a retried sweep and a second message to a real person — has
    // never seen it.
    repo.membershipExpiringIn.mockResolvedValue([{ id: 'c-1', end_date: '2026-09-16' }]);
    repo.membershipExpiredYesterday.mockResolvedValue([{ id: 'c-2', end_date: '2026-09-08' }]);
    repo.birthdaysToday.mockResolvedValue([{ id: 'c-3', today: '2026-09-09' }]);
    repo.anniversariesToday.mockResolvedValue([{ id: 'c-4', today: '2026-09-09', years: 1 }]);
    repo.attendanceMissedFor.mockResolvedValue([{ id: 'c-5', last_visit: '2026-08-01', days_since: 39 }]);
    repo.followupsDue.mockResolvedValue([{ id: 'l-1', follow_up_date: '2026-09-01' }]);

    await sweep.sweepOrg(ORG_A, ALL_EVENTS);

    const keys = emitted().map((a) => a.eventKey);
    // Eight, not six: the expiring row is returned for all three reminder
    // buckets, which is the fixture being lazy rather than the sweep being
    // wrong — and the three keys it produces differ only in the bucket, which
    // is the point of putting the bucket in them.
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
    for (const key of keys) {
      expect(key).not.toMatch(/T\d{2}:\d{2}/);       // an ISO timestamp
      expect(key).not.toMatch(/\b1[6-9]\d{11}\b/);   // epoch milliseconds
    }
  });
});

describe('the lead-shaped events name a lead, not a client', () => {
  test('followup_due asks the engine for a lead recipient', async () => {
    repo.followupsDue.mockResolvedValue([{ id: 'l-1', follow_up_date: '2026-09-01' }]);
    await sweep.sweepOrg(ORG_A, ['followup_due']);

    // pt_leads is a separate table from pt_clients until conversion. Without
    // this, the recipient lookup finds nothing and the event silently never
    // fires — which is the exact failure this whole change exists to end.
    expect(emittedFor('followup_due')[0].recipientType).toBe('lead');
  });

  test('the client-shaped events do not', async () => {
    repo.birthdaysToday.mockResolvedValue([{ id: 'c-1', today: '2026-09-09' }]);
    await sweep.sweepOrg(ORG_A, ['birthday']);

    expect(emittedFor('birthday')[0].recipientType).toBeUndefined();
  });
});

describe('what the sweep reports', () => {
  test('a queued message is counted, and a refused one is counted by reason', async () => {
    repo.orgsWithAutomationOn.mockResolvedValue([ORG_A]);
    repo.activeTriggerEventsFor.mockResolvedValue(['birthday']);
    repo.birthdaysToday.mockResolvedValue([
      { id: 'c-1', today: '2026-09-09' },
      { id: 'c-2', today: '2026-09-09' },
      { id: 'c-3', today: '2026-09-09' },
    ]);
    engine.emit
      .mockResolvedValueOnce({ outcome: 'queued', queued: 1, results: [] })
      .mockResolvedValueOnce({ outcome: 'trainer_not_permitted', queued: 0, results: [] })
      .mockResolvedValueOnce({ outcome: 'duplicate_event', queued: 0, results: [] });

    const summary = await sweep.runSweep();

    // "It sent nothing" and "it sent nothing because no trainer is granted"
    // are different operational situations, and the second is the one a studio
    // rings up about.
    expect(summary.byOrg[ORG_A].birthday).toEqual({
      found: 3,
      queued: 1,
      skipped: { trainer_not_permitted: 1, duplicate_event: 1 },
    });
  });
});

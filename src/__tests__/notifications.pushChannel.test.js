'use strict';
// The push channel is wired to the existing orchestrator, not a parallel path:
// the recipient (and its tenant) comes from the resolver, and a retryable
// provider failure makes the BullMQ job fail so the queue retries it.

const pool = require('../db/pool');
const push = require('../modules/notifications/push.service');
const svc = require('../modules/notifications/notifications.service');

jest.mock('../db/pool', () => ({
  query: jest.fn(async (sql) => {
    if (String(sql).includes('INSERT INTO notifications')) return { rows: [{ id: 'ntf-1' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
}));
jest.mock('../modules/notifications/push.service', () => ({
  sendPush: jest.fn(),
  pruneDeliveries: jest.fn(),
}));
jest.mock('../lib/redis', () => ({ ensureReady: jest.fn(async () => false) }));

const RECIPIENT = { user_id: 'usr-1', organization_id: 'org-1', name: 'Amit' };
const DATA = { name: 'Amit', class_name: 'Yoga', time: '7:00 AM', link: '/member/schedule' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PUSH_ENABLED = 'true';
  delete process.env.PUSH_ALLOWED_ORGS;
});

afterAll(() => {
  delete process.env.PUSH_ENABLED;
  delete process.env.PUSH_ALLOWED_ORGS;
});

describe('push channel', () => {
  it('records push as disabled and sends nothing when the gate is off', async () => {
    process.env.PUSH_ENABLED = 'false';

    const res = await svc.send('class_reminder', RECIPIENT, DATA, ['push']);

    expect(res).toEqual({ push: { status: 'disabled', error: 'push_disabled' } });
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('still delivers the inbox half of an event when push is disabled', async () => {
    process.env.PUSH_ENABLED = 'false';

    const res = await svc.send('class_reminder', RECIPIENT, DATA, ['inapp', 'push']);

    expect(res.push).toEqual({ status: 'disabled', error: 'push_disabled' });
    expect(res.inapp.status).toBe('delivered');
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('runs the retention job from the same queue without touching a channel', async () => {
    push.pruneDeliveries.mockResolvedValue({ deleted: 3, days: 30 });

    const res = await svc.processNotificationJob({ name: 'push-retention', data: {} });

    expect(push.pruneDeliveries).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ deleted: 3, days: 30 });
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('passes the resolver identity and the job dedupe key, never a body-supplied one', async () => {
    push.sendPush.mockResolvedValue({ status: 'sent' });

    await svc.deliverChannel('push', 'class_reminder', RECIPIENT, DATA, { dedupeKey: 'job:42' });

    expect(push.sendPush).toHaveBeenCalledWith({
      recipient: { user_id: 'usr-1', organization_id: 'org-1' },
      type: 'class_reminder',
      // Push uses the lock-screen copy, not the in-app body.
      title: 'Class reminder',
      body: 'A class starts soon. Open My PT Studio for details.',
      link: '/member/schedule',
      dedupeKey: 'job:42',
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO notification_log'), expect.any(Array));
  });

  it('keeps names and payment amounts off the lock screen', async () => {
    push.sendPush.mockResolvedValue({ status: 'sent' });

    await svc.deliverChannel('push', 'payment_received', RECIPIENT, {
      name: 'Amit', amount: '25000', currency: '₹', link: '/member/payments',
    });

    const call = push.sendPush.mock.calls[0][0];
    expect(call.title + ' ' + call.body).not.toMatch(/Amit|25000|₹/);
    expect(call.title).toBe('Payment received');
  });

  it('never puts a name, amount, plan or date on the lock screen, for every template', async () => {
    // One representative payload per template, all carrying the sensitive
    // values the in-app body would show. The push copy must not contain any.
    const cases = [
      ['payment_received', { name: 'Amit', amount: '25000', currency: '₹' }],
      ['membership_expiring', { name: 'Amit', days: 7, plan: 'Gold Annual' }],
      ['assessment_reminder', { name: 'Amit', scheduled_date: '2026-11-20', days: 9 }],
      ['assessment_due', { name: 'Amit', scheduled_date: '2026-11-20' }],
      ['assessment_overdue', { name: 'Amit', scheduled_date: '2026-11-01', days: 10 }],
      ['assessment_trainer_reminder', { name: 'Coach', client_name: 'Priya Sharma', scheduled_date: '2026-11-20', days: 9, state: 'upcoming' }],
      ['churn_digest', { name: 'Coach', count: 3, client_names: 'Priya Sharma, Rahul', more: 1 }],
      ['class_reminder', { name: 'Amit', class_name: 'Power Yoga', time: '7:00 AM' }],
      ['booking_confirmed', { name: 'Amit', class_name: 'Power Yoga', time: '7:00 AM' }],
      ['waitlist_promoted', { name: 'Amit', class_name: 'Power Yoga', time: '7:00 AM' }],
    ];

    for (const [type, data] of cases) {
      push.sendPush.mockClear();
      push.sendPush.mockResolvedValue({ status: 'sent' });
      await svc.deliverChannel('push', type, RECIPIENT, { ...data, link: '/member/notifications' });
      const sent = push.sendPush.mock.calls[0][0];
      const lockScreen = `${sent.title} ${sent.body}`;
      for (const secret of ['Amit', 'Priya', 'Rahul', 'Coach', '25000', '₹', 'Gold', 'Power Yoga', '7:00 AM', '2026-11-']) {
        expect(lockScreen).not.toContain(secret);
      }
    }
  });

  it('fails the job on a retryable provider error', async () => {
    push.sendPush.mockResolvedValue({ status: 'failed', error: 'HTTP_503', retryable: true });

    await expect(svc.processNotificationJob({
      id: '42',
      data: { ch: 'push', type: 'class_reminder', recipient: RECIPIENT, data: DATA },
    })).rejects.toThrow(/retryable/);
  });

  it('completes a non-retryable failure so it is not retried forever', async () => {
    push.sendPush.mockResolvedValue({ status: 'failed', error: 'INVALID_ARGUMENT', retryable: false });

    const res = await svc.processNotificationJob({
      id: '43',
      data: { ch: 'push', type: 'class_reminder', recipient: RECIPIENT, data: DATA },
    });

    expect(res.status).toBe('failed');
    expect(res.retryable).toBe(false);
  });
});

'use strict';

jest.mock('../modules/progress/retests.repo', () => ({
  openSchedulesForSweep: jest.fn(),
  claimReminder: jest.fn(),
  retryableReminders: jest.fn(),
  markReminder: jest.fn(),
  syncStatus: jest.fn(),
}));
jest.mock('../modules/notifications/notifications.service', () => ({
  recipientFromClient: jest.fn(),
  recipientFromTrainer: jest.fn(),
  send: jest.fn(),
}));

const repo = require('../modules/progress/retests.repo');
const notifier = require('../modules/notifications/notifications.service');
const { runProgressSweep, deliveryOutcome, templateFor } = require('../modules/progress/progress.sweep');

const NOW = new Date('2026-10-19T06:00:00Z');
const row = {
  id: 's1', organization_id: 'org-1', client_id: 'c1', client_name: 'Asha', status: 'upcoming',
  scheduled_date: '2026-11-18', reminder_days: [30, 14, 7], timezone: 'Asia/Kolkata',
};

beforeEach(() => {
  jest.clearAllMocks();
  repo.openSchedulesForSweep.mockResolvedValue([row]);
  repo.claimReminder.mockResolvedValue({ id: 1 });
  repo.retryableReminders.mockResolvedValue([]);
  repo.markReminder.mockResolvedValue({ id: 1 });
  repo.syncStatus.mockResolvedValue(undefined);
  notifier.recipientFromClient.mockResolvedValue({
    client_id: 'c1', member_id: 'c1', user_id: 'u1', name: 'Asha', email: 'asha@example.com',
    phone: '+919999999999', organization_id: 'org-1',
  });
  notifier.recipientFromTrainer.mockResolvedValue({
    user_id: 't1', name: 'Coach Meera', email: 'coach@example.com', organization_id: 'org-1',
  });
  notifier.send.mockResolvedValue({ inapp: { status: 'delivered' }, email: { status: 'sent' } });
});

describe('Module 5 reminder sweep', () => {
  it('sends the 30-day reminder to the client and the trainer, once each', async () => {
    const summary = await runProgressSweep({ now: NOW });
    expect(notifier.send).toHaveBeenCalledWith(
      'assessment_reminder',
      expect.objectContaining({ name: 'Asha', user_id: 'u1' }),
      expect.objectContaining({ scheduled_date: '2026-11-18', days: 30 }),
      ['inapp', 'email'],
    );
    expect(notifier.send).toHaveBeenCalledWith(
      'assessment_trainer_reminder',
      expect.objectContaining({ name: 'Coach Meera', user_id: 't1' }),
      expect.objectContaining({
        client_name: 'Asha', scheduled_date: '2026-11-18', days: 30,
        link: '/pt-os/progress?client_id=c1',
      }),
      ['inapp', 'email'],
    );
    expect(repo.claimReminder).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reminder', stageDays: 30, dueDate: '2026-11-18', recipient: 'client',
    }));
    expect(repo.claimReminder).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reminder', stageDays: 30, dueDate: '2026-11-18', recipient: 'trainer',
    }));
    expect(repo.markReminder).toHaveBeenCalledWith(1, { status: 'sent', error: null });
    expect(summary).toMatchObject({ scanned: 1, sent: 2, skipped: 0, failed: 0 });
  });

  it('does not send twice when the ledger already claimed both recipients', async () => {
    repo.claimReminder.mockResolvedValue(null);
    const summary = await runProgressSweep({ now: NOW });
    expect(notifier.send).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sent: 0, skipped: 2 });
  });

  it('marks a failed delivery so the next sweep can retry it', async () => {
    notifier.send.mockResolvedValue({
      inapp: { status: 'failed', error: 'db_down' },
      email: { status: 'failed', error: 'smtp_down' },
    });
    const summary = await runProgressSweep({ now: NOW });
    expect(repo.markReminder).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed' }));
    expect(repo.markReminder.mock.calls[0][1].error).toMatch(/smtp_down/);
    expect(summary.failed).toBe(2);
  });

  it('retries a failed stage on a later sweep even outside the exact stage day', async () => {
    repo.openSchedulesForSweep.mockResolvedValue([{ ...row, scheduled_date: '2026-11-17' }]);
    repo.retryableReminders.mockResolvedValue([{ kind: 'reminder', stage_days: 30 }]);
    await runProgressSweep({ now: NOW });
    expect(repo.claimReminder).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reminder', stageDays: 30, dueDate: '2026-11-17',
    }));
    expect(notifier.send).toHaveBeenCalledWith('assessment_reminder', expect.any(Object), expect.any(Object), expect.any(Array));
  });

  it('does not attempt the same stage twice for the same recipient in one sweep', async () => {
    repo.retryableReminders.mockResolvedValue([{ kind: 'reminder', stage_days: 30, recipient: 'client' }]);
    await runProgressSweep({ now: NOW });
    // One client retry plus the normal client and trainer stage.
    expect(repo.claimReminder).toHaveBeenCalledTimes(2);
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it('uses the overdue template when the scheduled date has passed', async () => {
    repo.openSchedulesForSweep.mockResolvedValue([{ ...row, scheduled_date: '2026-10-01' }]);
    await runProgressSweep({ now: NOW });
    expect(notifier.send).toHaveBeenCalledWith(
      'assessment_overdue',
      expect.any(Object),
      expect.objectContaining({ scheduled_date: '2026-10-01', days: 18, state: 'overdue' }),
      expect.any(Array),
    );
  });

  it('uses the due template on the scheduled day', async () => {
    repo.openSchedulesForSweep.mockResolvedValue([{ ...row, scheduled_date: '2026-10-19' }]);
    await runProgressSweep({ now: NOW });
    expect(notifier.send).toHaveBeenCalledWith(
      'assessment_due', expect.any(Object), expect.objectContaining({ days: 0, state: 'due' }), expect.any(Array),
    );
  });

  it('skips a client with no contact channel but still alerts the trainer', async () => {
    notifier.recipientFromClient.mockResolvedValue({
      client_id: 'c1', name: 'Asha', email: null, phone: null, user_id: null, organization_id: 'org-1',
    });
    const summary = await runProgressSweep({ now: NOW });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send).toHaveBeenCalledWith(
      'assessment_trainer_reminder', expect.objectContaining({ name: 'Coach Meera' }),
      expect.any(Object), ['inapp', 'email'],
    );
    expect(repo.markReminder).toHaveBeenCalledWith(1, { status: 'skipped', error: 'no_contact_channel' });
    expect(summary).toMatchObject({ sent: 1, skipped: 1 });
  });

  it('records a missing trainer without suppressing the client reminder', async () => {
    notifier.recipientFromTrainer.mockResolvedValue(null);
    const summary = await runProgressSweep({ now: NOW });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send).toHaveBeenCalledWith(
      'assessment_reminder', expect.objectContaining({ name: 'Asha' }),
      expect.any(Object), ['inapp', 'email'],
    );
    expect(repo.markReminder).toHaveBeenCalledWith(1, { status: 'skipped', error: 'trainer_not_found' });
    expect(summary).toMatchObject({ sent: 1, skipped: 1 });
  });

  it('uses WhatsApp when a phone exists but there is no email or member login', async () => {
    notifier.recipientFromClient.mockResolvedValue({
      client_id: 'c1', name: 'Asha', email: null, phone: '+919999999999', user_id: null, organization_id: 'org-1',
    });
    await runProgressSweep({ now: NOW });
    expect(notifier.send).toHaveBeenCalledWith(
      'assessment_reminder', expect.any(Object), expect.any(Object), ['whatsapp'],
    );
  });

  it('never counts a suppressed preference as a send', () => {
    expect(deliveryOutcome({ email: { status: 'suppressed' }, inapp: { status: 'suppressed' } }))
      .toEqual({ status: 'skipped', error: 'suppressed_by_preference' });
    expect(deliveryOutcome({ email: { status: 'sent' }, inapp: { status: 'failed' } }))
      .toEqual({ status: 'sent', error: null });
    expect(deliveryOutcome({})).toEqual({ status: 'failed', error: 'no_channel_attempted' });
    expect(templateFor('overdue')).toBe('assessment_overdue');
    expect(templateFor('reminder')).toBe('assessment_reminder');
    expect(templateFor('reminder', 'trainer')).toBe('assessment_trainer_reminder');
  });

  it('keeps processing after one row throws', async () => {
    repo.openSchedulesForSweep.mockResolvedValue([row, { ...row, id: 's2' }]);
    repo.claimReminder
      .mockRejectedValueOnce(new Error('ledger down'))
      .mockResolvedValueOnce({ id: 2 });
    const summary = await runProgressSweep({ now: NOW });
    expect(summary.errors).toBe(1);
    expect(summary.sent).toBe(2);
  });
});

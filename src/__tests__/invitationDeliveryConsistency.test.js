// A delivered invitation must never be recorded as a failed one.
//
// deliverInvitation() wrapped BOTH the send and the status write in one try.
// That reads as tidiness and is actually a data-integrity bug: markSent() is a
// second, independent database round-trip that can fail on its own — pool
// exhaustion, a statement timeout, or a permission denial after the app_tenant
// cutover — and when it does, the catch block runs markSendFailed() and writes
// a `last_error` for an email that was genuinely delivered.
//
// The consequence is not a cosmetic wrong status. The Command Centre's SMTP card
// reads `admin_invitations.last_error` and `sent_at`, and the operator console
// offers Resend on exactly this state. So a bookkeeping failure manufactures the
// apparent symptom of a mail outage and invites the one action that produces a
// genuine duplicate: the studio owner receives the activation link twice.
//
// The fix is to not lie about which step failed. The send and the record of the
// send are separate facts and get separate handlers.
'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

/**
 * Load shared.js with a controllable send, a controllable markSent, and a
 * spy on markSendFailed. Only these three decide the behaviour under test.
 */
function load({ sendImpl, markSentImpl }) {
  jest.resetModules();

  jest.doMock('../lib/email', () => ({
    sendAdminInvitation: jest.fn(sendImpl),
    sendPasswordReset: jest.fn(),
    isConfigured: () => true,
    describeError: (err) => ({
      message: err?.message || 'unknown error',
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.stage ? { stage: err.stage } : {}),
      ...(typeof err?.responseCode === 'number' ? { responseCode: err.responseCode } : {}),
    }),
  }));

  const markSendFailed = jest.fn(async () => {});
  jest.doMock('../lib/invitations', () => ({
    EXPIRY_HOURS: 24,
    markSent: jest.fn(markSentImpl),
    markSendFailed,
  }));

  const shared = require('../modules/platform/super-admin/shared');
  return { shared, markSendFailed };
}

const INVITATION = {
  id: 'inv-1', email: 'owner@studio.com', owner_name: 'Owner',
  studio_name: 'Studio', track_id: 'trk-1',
};

afterEach(() => { jest.resetModules(); jest.dontMock('../lib/email'); jest.dontMock('../lib/invitations'); });

describe('deliverInvitation — the send and the record of the send are separate facts', () => {
  test('a delivered email whose status write fails is reported as sent', async () => {
    // markSent rejects: the mail went out, the bookkeeping did not.
    const { shared, markSendFailed } = load({
      sendImpl: async () => ({ messageId: 'real-message-id' }),
      markSentImpl: async () => { throw new Error('pool exhausted'); },
    });

    const outcome = await shared.deliverInvitation(INVITATION, 'raw-token');

    expect(outcome.sent).toBe(true);
    // The load-bearing assertion: nothing may write a send-failure for a send
    // that succeeded.
    expect(markSendFailed).not.toHaveBeenCalled();
  });

  test('a genuine send failure is still recorded, with its code', async () => {
    const { shared, markSendFailed } = load({
      sendImpl: async () => {
        throw Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', stage: 'CONN' });
      },
      markSentImpl: async () => {},
    });

    const outcome = await shared.deliverInvitation(INVITATION, 'raw-token');

    expect(outcome.sent).toBe(false);
    expect(markSendFailed).toHaveBeenCalledTimes(1);
    const recorded = markSendFailed.mock.calls[0][1];
    expect(recorded).toContain('Connection timeout');
    expect(recorded).toContain('ETIMEDOUT');
    expect(recorded).toContain('CONN');
  });

  test('the happy path marks sent and records no error', async () => {
    const { shared, markSendFailed } = load({
      sendImpl: async () => ({ messageId: 'm1' }),
      markSentImpl: async () => {},
    });

    const outcome = await shared.deliverInvitation(INVITATION, 'raw-token');

    expect(outcome).toEqual({ sent: true, error: null });
    expect(markSendFailed).not.toHaveBeenCalled();
  });

  test('never throws — the caller has already committed a studio', async () => {
    const { shared } = load({
      sendImpl: async () => { throw new Error('boom'); },
      markSentImpl: async () => { throw new Error('also boom'); },
    });
    await expect(shared.deliverInvitation(INVITATION, 'raw-token')).resolves.toMatchObject({ sent: false });
  });
});

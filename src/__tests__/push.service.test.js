'use strict';
// Push transport: tenant-scoped device lookup, multi-device send, dead-token
// revocation and retry idempotency. FCM is mocked; no credential is involved.

const fcm = require('../lib/fcm');
const devices = require('../modules/devices/devices.service');
const pool = require('../db/pool');
const {
  sendPush, safeLink, linkForApp, hashToken, pruneDeliveries, retentionDays,
} = require('../modules/notifications/push.service');

jest.mock('../lib/fcm', () => ({
  isConfigured: jest.fn(),
  sendMessage: jest.fn(),
}));

jest.mock('../modules/devices/devices.service', () => ({
  activeTokens: jest.fn(),
  ownsToken: jest.fn(),
  revokeDead: jest.fn(),
}));

jest.mock('../db/pool', () => ({ query: jest.fn() }));

const RECIPIENT = { user_id: 'usr-1', organization_id: 'org-1' };

function poolResponder({ delivered = [] } = {}) {
  pool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (s.includes('FROM push_deliveries')) {
      return { rows: delivered.map((h) => ({ token_hash: h })), rowCount: delivered.length };
    }
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PUSH_ENABLED = 'true';
  delete process.env.PUSH_ALLOWED_ORGS;
  delete process.env.PUSH_DELIVERY_RETENTION_DAYS;
  fcm.isConfigured.mockReturnValue(true);
  devices.activeTokens.mockResolvedValue([]);
  devices.ownsToken.mockResolvedValue(true);
  devices.revokeDead.mockResolvedValue(0);
  poolResponder();
});

afterAll(() => {
  delete process.env.PUSH_ENABLED;
  delete process.env.PUSH_ALLOWED_ORGS;
  delete process.env.PUSH_DELIVERY_RETENTION_DAYS;
});

describe('sendPush', () => {
  it('sends nothing while the activation gate is off', async () => {
    process.env.PUSH_ENABLED = 'false';
    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });
    expect(res).toEqual({ status: 'disabled', error: 'push_disabled' });
    expect(fcm.isConfigured).not.toHaveBeenCalled();
    expect(devices.activeTokens).not.toHaveBeenCalled();
    expect(fcm.sendMessage).not.toHaveBeenCalled();
  });

  it('sends nothing for a tenant outside the staging allowlist', async () => {
    process.env.PUSH_ALLOWED_ORGS = 'org-other, org-third';
    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });
    expect(res).toEqual({ status: 'disabled', error: 'push_disabled' });
    expect(devices.activeTokens).not.toHaveBeenCalled();
  });

  it('sends for a tenant inside the staging allowlist', async () => {
    process.env.PUSH_ALLOWED_ORGS = 'org-other, org-1';
    devices.activeTokens.mockResolvedValue([{ token: 'tok-a', app: 'studio' }]);
    fcm.sendMessage.mockResolvedValue({ ok: true, providerId: 'm' });

    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });
    expect(res.status).toBe('sent');
  });

  it('reports not_configured without a service account', async () => {
    fcm.isConfigured.mockReturnValue(false);
    const res = await sendPush({ recipient: RECIPIENT, type: 'session_reminder', title: 't', body: 'b' });
    expect(res).toEqual({ status: 'not_configured', error: 'fcm_not_configured' });
    expect(devices.activeTokens).not.toHaveBeenCalled();
  });

  it('fails closed without a tenant-scoped recipient', async () => {
    const res = await sendPush({ recipient: { user_id: 'usr-1' }, type: 'x', title: 't', body: 'b' });
    expect(res.status).toBe('failed');
    expect(res.error).toBe('recipient_not_scoped');
    expect(devices.activeTokens).not.toHaveBeenCalled();
  });

  it('looks devices up by user AND organization', async () => {
    await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });
    expect(devices.activeTokens).toHaveBeenCalledWith({ userId: 'usr-1', organizationId: 'org-1' });
  });

  it('skips quietly when the user has no device', async () => {
    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });
    expect(res).toEqual({ status: 'skipped', error: 'no_device' });
  });

  it('sends to every live device of the user', async () => {
    devices.activeTokens.mockResolvedValue([
      { token: 'tok-a', app: 'studio' },
      { token: 'tok-b', app: 'member' },
    ]);
    fcm.sendMessage.mockResolvedValue({ ok: true, providerId: 'projects/p/messages/1' });

    const res = await sendPush({
      recipient: RECIPIENT,
      type: 'session_reminder',
      title: 'Session tomorrow',
      body: 'Hi',
      link: '/member/schedule',
      dedupeKey: 'job:7',
    });

    expect(res.status).toBe('sent');
    expect(res.sent).toBe(2);
    expect(fcm.sendMessage).toHaveBeenCalledTimes(2);
    // The studio device must not be routed into the member half of the site.
    expect(fcm.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-a', data: expect.objectContaining({ link: '/engagement/notifications', app: 'studio' }) }));
    expect(fcm.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-b', data: expect.objectContaining({ link: '/member/schedule', app: 'member' }) }));
    // The FCM data block carries routing only: no name, phone, amount or
    // free-form template arguments.
    const memberCall = fcm.sendMessage.mock.calls.find(([args]) => args.token === 'tok-b')[0];
    expect(Object.keys(memberCall.data).sort()).toEqual(['app', 'link', 'type']);
    const ledger = pool.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO push_deliveries'));
    // One row per device, written as each device accepts.
    expect(ledger.map(([, params]) => params[0])).toEqual(['job:7', 'job:7']);
    expect(ledger.map(([, params]) => params[1][0])).toEqual([hashToken('tok-a'), hashToken('tok-b')]);
  });

  it('revokes only the token FCM declares dead', async () => {
    devices.activeTokens.mockResolvedValue([
      { token: 'tok-live', app: 'studio' },
      { token: 'tok-dead', app: 'studio' },
    ]);
    fcm.sendMessage
      .mockResolvedValueOnce({ ok: true, providerId: 'm1' })
      .mockResolvedValueOnce({ ok: false, invalidToken: true, code: 'UNREGISTERED', retryable: false });

    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });

    expect(res.status).toBe('sent');
    expect(devices.revokeDead).toHaveBeenCalledWith(['tok-dead'], 'fcm_invalid');
  });

  it('does not resend to a device that already accepted this job', async () => {
    devices.activeTokens.mockResolvedValue([
      { token: 'tok-a', app: 'studio' },
      { token: 'tok-b', app: 'studio' },
    ]);
    poolResponder({ delivered: [hashToken('tok-a')] });
    fcm.sendMessage.mockResolvedValue({ ok: true, providerId: 'm2' });

    await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b', dedupeKey: 'job:8' });

    expect(fcm.sendMessage).toHaveBeenCalledTimes(1);
    expect(fcm.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-b' }));
  });

  it('returns retryable for a transient failure so BullMQ backs off', async () => {
    devices.activeTokens.mockResolvedValue([{ token: 'tok-a', app: 'studio' }]);
    fcm.sendMessage.mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_503' });

    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });

    expect(res.status).toBe('failed');
    expect(res.retryable).toBe(true);
  });

  it('reports a partial send but still retries the failed device', async () => {
    devices.activeTokens.mockResolvedValue([
      { token: 'tok-a', app: 'studio' },
      { token: 'tok-b', app: 'studio' },
    ]);
    fcm.sendMessage
      .mockResolvedValueOnce({ ok: true, providerId: 'm3' })
      .mockResolvedValueOnce({ ok: false, retryable: true, code: 'NETWORK' });

    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b', dedupeKey: 'job:9' });

    expect(res.status).toBe('partial');
    expect(res.retryable).toBe(true);
    expect(res.sent).toBe(1);

    // Only the device that accepted is in the ledger, so the retry reaches
    // the failed device and not the one that already has the message.
    const ledger = pool.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO push_deliveries'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0][1][1]).toEqual([hashToken('tok-a')]);
  });

  it('does not deliver a retried job to the new owner of a reassigned token', async () => {
    // User B now holds the same token. The ledger still says this job was
    // delivered, so the retry completes without alerting B with A's message.
    devices.activeTokens.mockResolvedValue([{ token: 'tok-a', app: 'member' }]);
    poolResponder({ delivered: [hashToken('tok-a')] });

    const res = await sendPush({
      recipient: { user_id: 'usr-b', organization_id: 'org-1' },
      type: 'x', title: 't', body: 'b', dedupeKey: 'job:55',
    });

    expect(res).toEqual({ status: 'sent', provider_id: null, deduped: true });
    expect(fcm.sendMessage).not.toHaveBeenCalled();
  });

  it('does not reach a previous owner after the token moves to another account', async () => {
    // The reassignment happens in devices.service; the sender only ever sees
    // the current owner's live devices. If the token moved, this is empty.
    devices.activeTokens.mockResolvedValue([]);

    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });

    expect(res).toEqual({ status: 'skipped', error: 'no_device' });
    expect(devices.activeTokens).toHaveBeenCalledWith({ userId: 'usr-1', organizationId: 'org-1' });
    expect(fcm.sendMessage).not.toHaveBeenCalled();
  });

  it('skips a device whose ownership moved while the send loop was running', async () => {
    devices.activeTokens.mockResolvedValue([
      { token: 'tok-moved', app: 'studio' },
      { token: 'tok-still-mine', app: 'studio' },
    ]);
    // The snapshot said both belonged to us; the per-device re-check sees the
    // first one already reassigned to the account that just signed in.
    devices.ownsToken.mockImplementation(async ({ token }) => token !== 'tok-moved');
    fcm.sendMessage.mockResolvedValue({ ok: true, providerId: 'm4' });

    const res = await sendPush({ recipient: RECIPIENT, type: 'x', title: 't', body: 'b' });

    expect(res.status).toBe('sent');
    expect(fcm.sendMessage).toHaveBeenCalledTimes(1);
    expect(fcm.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-still-mine' }));
    expect(devices.ownsToken).toHaveBeenCalledWith({
      userId: 'usr-1', organizationId: 'org-1', token: 'tok-moved',
    });
  });
});

describe('pruneDeliveries', () => {
  it('deletes only rows older than the window and leaves the audit table alone', async () => {
    pool.query.mockResolvedValue({ rowCount: 4 });

    const res = await pruneDeliveries({ days: 30 });

    expect(res).toEqual({ deleted: 4, days: 30 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('DELETE FROM push_deliveries');
    expect(String(sql)).toContain('make_interval(days => $1)');
    expect(String(sql)).not.toContain('notification_log');
    expect(params).toEqual([30]);
  });

  it('reads the retention window from the environment and clamps it', async () => {
    process.env.PUSH_DELIVERY_RETENTION_DAYS = '7';
    expect(retentionDays()).toBe(7);

    process.env.PUSH_DELIVERY_RETENTION_DAYS = '0';
    expect(retentionDays()).toBe(30);

    process.env.PUSH_DELIVERY_RETENTION_DAYS = '9999';
    expect(retentionDays()).toBe(365);
  });
});


describe('linkForApp', () => {
  it('keeps a member link on a member device and a trainer link on a studio device', () => {
    expect(linkForApp('/member/schedule', 'member')).toBe('/member/schedule');
    expect(linkForApp('/pt-os/clients/at-risk', 'studio')).toBe('/pt-os/clients/at-risk');
  });

  it('refuses to cross planes', () => {
    expect(linkForApp('/pt-os/clients/at-risk', 'member')).toBe('/member/notifications');
    expect(linkForApp('/member/payments', 'studio')).toBe('/engagement/notifications');
  });

  it('falls back per shell for an unusable link', () => {
    expect(linkForApp('https://evil.example', 'member')).toBe('/member/notifications');
    expect(linkForApp(null, 'studio')).toBe('/engagement/notifications');
  });
});

describe('safeLink', () => {
  it('accepts an internal path', () => {
    expect(safeLink('/member/schedule')).toBe('/member/schedule');
    expect(safeLink('/pt-os/clients/at-risk')).toBe('/pt-os/clients/at-risk');
  });

  it('refuses an absolute, protocol-relative or control-character URL', () => {
    expect(safeLink('https://evil.example')).toBeNull();
    expect(safeLink('//evil.example')).toBeNull();
    expect(safeLink('/\\evil.example')).toBeNull();
    expect(safeLink('/ok\nSet-Cookie: x')).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});

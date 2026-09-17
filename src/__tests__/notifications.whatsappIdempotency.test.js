// The WhatsApp channel's send-once idempotency key used to be keyed only on
// (organization, phone, template): `notif:${orgId}:${to}:${template}`. That
// collides across genuinely different notifications that share a template —
// a 7-day and a 1-day membership_expiring reminder to the same client, two
// different class_reminder classes, two different booking_confirmed bookings
// — so the gateway's send-once ledger treated the second one as a retry of
// the first and never delivered it. Deep-audit finding: notifications
// silently, permanently de-duplicated to nothing after the first send.
//
// Fixed by folding the actual event payload into the key, so distinct events
// hash to distinct keys, while a genuine retry of the *same* job (same type,
// same data) still reuses the same key and dedupes correctly.
'use strict';

jest.mock('../db/pool', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../modules/messaging/transport', () => ({
  send: jest.fn().mockResolvedValue({ status: 'sent', provider_id: 'wamid.1' }),
  SendStatus: { SENT: 'sent' },
}));

const transport = require('../modules/messaging/transport');
const { deliverChannel } = require('../modules/notifications/notifications.service');

const recipient = { organization_id: 'org-1', phone: '+911234567890', name: 'Riya' };

afterEach(() => jest.clearAllMocks());

describe('WhatsApp notification idempotency key', () => {
  test('a 7-day and a 1-day membership_expiring reminder to the same client get different keys', async () => {
    await deliverChannel('whatsapp', 'membership_expiring', recipient, { days: 7, plan: 'Gold' });
    await deliverChannel('whatsapp', 'membership_expiring', recipient, { days: 1, plan: 'Gold' });

    const [firstArgs] = transport.send.mock.calls[0];
    const [secondArgs] = transport.send.mock.calls[1];
    expect(firstArgs.clientMessageId).not.toEqual(secondArgs.clientMessageId);
  });

  test('two different class reminders to the same client get different keys', async () => {
    await deliverChannel('whatsapp', 'class_reminder', recipient, { class_name: 'HIIT', time: '6pm' });
    await deliverChannel('whatsapp', 'class_reminder', recipient, { class_name: 'Yoga', time: '7pm' });

    const [firstArgs] = transport.send.mock.calls[0];
    const [secondArgs] = transport.send.mock.calls[1];
    expect(firstArgs.clientMessageId).not.toEqual(secondArgs.clientMessageId);
  });

  test('redelivering the exact same notification reuses the same key (a retry still dedupes)', async () => {
    await deliverChannel('whatsapp', 'membership_expiring', recipient, { days: 3, plan: 'Gold' });
    await deliverChannel('whatsapp', 'membership_expiring', recipient, { days: 3, plan: 'Gold' });

    const [firstArgs] = transport.send.mock.calls[0];
    const [secondArgs] = transport.send.mock.calls[1];
    expect(firstArgs.clientMessageId).toEqual(secondArgs.clientMessageId);
  });
});

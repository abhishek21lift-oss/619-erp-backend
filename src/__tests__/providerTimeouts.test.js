'use strict';
// A provider that stops answering fails the send instead of hanging it (Phase 4).
//
// The Twilio (WhatsApp and SMS) and FCM calls had no timeout. Node's fetch
// waits about five minutes for headers, so one stuck provider held a request
// — or a queue worker's slot — for that long, and a burst of sends could tie
// up every worker. With a timeout the call fails like any other provider
// error: logged, returned as `failed`, and retried by the queue.

process.env.PROVIDER_HTTP_TIMEOUT_MS = '50';
process.env.TWILIO_ACCOUNT_SID = 'AC_test';
process.env.TWILIO_AUTH_TOKEN = 'token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+10000000000';
process.env.TWILIO_SMS_FROM = '+10000000000';
process.env.FCM_SERVER_KEY = 'fcm-key';

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

/** A provider that accepts the connection and never answers. */
function hangingFetch() {
  return jest.fn((_url, opts = {}) => new Promise((_resolve, reject) => {
    if (!opts.signal) return; // no timeout: hangs forever
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
  }));
}

const realFetch = global.fetch;
afterAll(() => { global.fetch = realFetch; });

const withinMs = (p, ms) => Promise.race([
  p, new Promise((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms)),
]);

describe('provider calls time out', () => {
  beforeEach(() => { global.fetch = hangingFetch(); });

  it('Twilio WhatsApp', async () => {
    const { sendText } = require('../services/whatsappDelivery');
    const out = await withinMs(sendText({ to: '9876543210', body: 'hi' }), 2000);
    expect(out.status).toBe('failed');
    expect(global.fetch.mock.calls[0][1].signal).toBeDefined();
  });

  it('Twilio SMS', async () => {
    const { channels } = require('../modules/notifications/notifications.service');
    const out = await withinMs(channels.sms({ to: '+919876543210', body: 'hi' }), 2000);
    expect(out.status).toBe('failed');
  });

  it('FCM push', async () => {
    const { channels } = require('../modules/notifications/notifications.service');
    const out = await withinMs(channels.push({ device_token: 'tok', title: 't', body: 'b' }), 2000);
    expect(out.status).toBe('failed');
  });
});

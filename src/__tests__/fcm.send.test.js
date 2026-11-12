'use strict';
// The v1 request itself: correct project URL, bearer credential, and the
// notification/data/android shape the Android client depends on.

jest.mock('google-auth-library', () => ({
  JWT: class {
    constructor(opts) { this.opts = opts; }
    getAccessToken() { return Promise.resolve({ token: 'test-access-token' }); }
  },
}));

const ACCOUNT = JSON.stringify({
  project_id: 'myptstudio-test',
  client_email: 'push@myptstudio-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
});

let fcm;
let fetchMock;

beforeEach(() => {
  jest.resetModules();
  process.env.FIREBASE_SERVICE_ACCOUNT = ACCOUNT;
  delete process.env.FIREBASE_PROJECT_ID;
  fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({ name: 'projects/myptstudio-test/messages/123' }),
  }));
  global.fetch = fetchMock;
  fcm = require('../lib/fcm');
});

afterEach(() => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete global.fetch;
});

it('sends a v1 message to the configured project', async () => {
  const res = await fcm.sendMessage({
    token: 'tok-abc',
    title: 'Session tomorrow',
    body: 'Hi Amit',
    data: { type: 'session_reminder', link: '/member/schedule', app: 'member', missing: null },
  });

  expect(res).toEqual({ ok: true, providerId: 'projects/myptstudio-test/messages/123' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://fcm.googleapis.com/v1/projects/myptstudio-test/messages:send');
  expect(init.headers.Authorization).toBe('Bearer test-access-token');

  const { message } = JSON.parse(init.body);
  expect(message.token).toBe('tok-abc');
  expect(message.notification).toEqual({ title: 'Session tomorrow', body: 'Hi Amit' });
  expect(message.data).toEqual({ type: 'session_reminder', link: '/member/schedule', app: 'member' });
  expect(message.android).toEqual(expect.objectContaining({
    priority: 'high',
    notification: expect.objectContaining({ channel_id: 'default' }),
  }));
});

it('does not send when no service account is configured', async () => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  jest.resetModules();
  const fresh = require('../lib/fcm');
  expect(fresh.isConfigured()).toBe(false);
  await expect(fresh.sendMessage({ token: 't', title: 't', body: 'b' })).rejects.toThrow(/not configured/);
  expect(fetchMock).not.toHaveBeenCalled();
});

'use strict';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';

const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: class {
    constructor(clientId) { this.clientId = clientId; }
    verifyIdToken(args) { return mockVerifyIdToken(args, this.clientId); }
  },
}));

const { verifyGoogleCredential } = require('../lib/googleIdentity');

beforeEach(() => mockVerifyIdToken.mockReset());

function ticket(payload) {
  return { getPayload: () => payload };
}

it('returns the verified payload and checks the configured audience', async () => {
  mockVerifyIdToken.mockResolvedValue(ticket({
    sub: 'google-sub-1', email: 'owner@studio.com', email_verified: true,
  }));

  const payload = await verifyGoogleCredential('credential');

  expect(payload.sub).toBe('google-sub-1');
  expect(mockVerifyIdToken).toHaveBeenCalledWith(
    { idToken: 'credential', audience: 'test-client-id' },
    'test-client-id'
  );
});

it('rejects an unverified email', async () => {
  mockVerifyIdToken.mockResolvedValue(ticket({
    sub: 'google-sub-1', email: 'owner@studio.com', email_verified: false,
  }));

  await expect(verifyGoogleCredential('credential')).rejects.toMatchObject({
    code: 'GOOGLE_INVALID_CREDENTIAL',
  });
});

it('rejects a payload with no subject', async () => {
  mockVerifyIdToken.mockResolvedValue(ticket({ email: 'owner@studio.com', email_verified: true }));

  await expect(verifyGoogleCredential('credential')).rejects.toMatchObject({
    code: 'GOOGLE_INVALID_CREDENTIAL',
  });
});

it('rejects a token Google will not verify', async () => {
  mockVerifyIdToken.mockRejectedValue(new Error('bad token'));

  await expect(verifyGoogleCredential('credential')).rejects.toMatchObject({
    code: 'GOOGLE_INVALID_CREDENTIAL',
  });
});

it('refuses to verify when the server has no client id', async () => {
  const previous = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;

  try {
    await expect(verifyGoogleCredential('credential')).rejects.toMatchObject({
      code: 'GOOGLE_NOT_CONFIGURED',
    });
  } finally {
    process.env.GOOGLE_CLIENT_ID = previous;
  }
});

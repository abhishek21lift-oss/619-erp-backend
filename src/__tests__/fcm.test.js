'use strict';
// FCM v1 error mapping. The important line: only errors that mean the token is
// dead revoke a device; a malformed payload must not unsubscribe a user.

const { classify } = require('../lib/fcm');

describe('FCM error classification', () => {
  it('treats UNREGISTERED as a dead token', () => {
    const res = classify(404, {
      error: {
        status: 'NOT_FOUND',
        message: 'Requested entity was not found.',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
      },
    });
    expect(res.invalidToken).toBe(true);
    expect(res.retryable).toBe(false);
  });

  it('treats SENDER_ID_MISMATCH as a dead token for this project', () => {
    const res = classify(403, {
      error: {
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'SENDER_ID_MISMATCH' }],
      },
    });
    expect(res.invalidToken).toBe(true);
  });

  it('does not revoke a token for a generic INVALID_ARGUMENT payload error', () => {
    const res = classify(400, {
      error: {
        status: 'INVALID_ARGUMENT',
        message: 'Invalid notification title.',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }],
      },
    });
    expect(res.invalidToken).toBe(false);
    expect(res.retryable).toBe(false);
  });

  it('revokes INVALID_ARGUMENT only when FCM says the registration token is invalid', () => {
    const res = classify(400, {
      error: {
        status: 'INVALID_ARGUMENT',
        message: 'The registration token is not a valid FCM registration token',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }],
      },
    });
    expect(res.invalidToken).toBe(true);
  });

  it('retries 429 and 5xx, and not 401/403 configuration errors', () => {
    expect(classify(429, { error: { status: 'RESOURCE_EXHAUSTED' } }).retryable).toBe(true);
    expect(classify(503, { error: { status: 'UNAVAILABLE' } }).retryable).toBe(true);
    expect(classify(401, { error: { status: 'UNAUTHENTICATED' } }).retryable).toBe(false);
    expect(classify(403, { error: { status: 'PERMISSION_DENIED' } }).retryable).toBe(false);
  });
});

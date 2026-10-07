'use strict';
// The notice sent to the OLD address when an account's sign-in email changes.

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }));

const { maskEmail } = require('../lib/email');
const { EMAIL_TYPES } = require('../services/email.service');

describe('maskEmail', () => {
  test('keeps the first character and the domain', () => {
    expect(maskEmail('jane.doe@gmail.com')).toBe('j••••••@gmail.com');
  });

  test('never reveals a one-character local part whole', () => {
    expect(maskEmail('a@x.io')).toBe('a•@x.io');
  });

  test('returns empty for anything that is not an address', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail(null)).toBe('');
    expect(maskEmail('no-at-sign')).toBe('');
  });
});

test('the notice is a known queue job type, so it can be sent off the request path', () => {
  expect(EMAIL_TYPES.has('email_changed')).toBe(true);
});

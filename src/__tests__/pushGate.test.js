'use strict';
// Push activation is a server-side switch. Default off, and the only value that
// turns it on is an explicit `true`.

const gate = require('../lib/pushGate');

beforeEach(() => {
  delete process.env.PUSH_ENABLED;
  delete process.env.PUSH_ALLOWED_ORGS;
});

afterAll(() => {
  delete process.env.PUSH_ENABLED;
  delete process.env.PUSH_ALLOWED_ORGS;
});

describe('pushGate', () => {
  it('is off when nothing is configured', () => {
    expect(gate.isEnabled()).toBe(false);
    expect(gate.isEnabledFor('org-1')).toBe(false);
  });

  it('does not treat 1, yes, on or an empty value as activation', () => {
    for (const value of ['1', 'yes', 'on', 'enabled', '']) {
      process.env.PUSH_ENABLED = value;
      expect(gate.isEnabled()).toBe(false);
    }
  });

  it('accepts true regardless of case or surrounding spaces', () => {
    for (const value of ['true', 'TRUE', ' true ']) {
      process.env.PUSH_ENABLED = value;
      expect(gate.isEnabled()).toBe(true);
    }
  });

  it('enables push for every tenant when no allowlist is set', () => {
    process.env.PUSH_ENABLED = 'true';
    expect(gate.isEnabledFor('org-1')).toBe(true);
    expect(gate.isEnabledFor('org-2')).toBe(true);
  });

  it('locks push to the staging allowlist when it is set', () => {
    process.env.PUSH_ENABLED = 'true';
    process.env.PUSH_ALLOWED_ORGS = 'org-stage, org-second';

    expect(gate.isEnabledFor('org-stage')).toBe(true);
    expect(gate.isEnabledFor('org-second')).toBe(true);
    expect(gate.isEnabledFor('org-production')).toBe(false);
    expect(gate.allowedOrganizations()).toEqual(['org-stage', 'org-second']);
  });

  it('fails closed without a tenant id', () => {
    process.env.PUSH_ENABLED = 'true';
    process.env.PUSH_ALLOWED_ORGS = 'org-stage';

    expect(gate.isEnabledFor(null)).toBe(false);
    expect(gate.isEnabledFor(undefined)).toBe(false);
  });
});

'use strict';
// User-controlled names reach HTML email templates. They must be escaped at
// the interpolation point, not only in the one welcome mail that had a helper.

jest.mock('../db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(() => Promise.resolve({ query: jest.fn(), release: jest.fn() })),
}));

const { templates } = require('../modules/notifications/notifications.service');
const { escapeHtml } = require('../lib/escape-html');

describe('notification HTML escaping', () => {
  it('escapes every character that can break out of markup', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('does not let a client name inject markup into a trainer reminder', () => {
    const tpl = templates.assessment_trainer_reminder({
      name: '<img src=x onerror=alert(1)>',
      client_name: '<script>alert(1)</script>',
      scheduled_date: '2026-10-20',
      days: 7,
      state: 'upcoming',
    });

    expect(tpl.email.html).not.toContain('<script>');
    expect(tpl.email.html).not.toContain('<img');
    expect(tpl.email.html).toContain('&lt;script&gt;');
    expect(tpl.email.html).toContain('&lt;img');
  });

  it('escapes a member name in a payment receipt', () => {
    const tpl = templates.payment_received({
      name: '<b>Asha</b>', amount: 1000, currency: '₹',
    });

    expect(tpl.email.html).not.toContain('<b>Asha</b>');
    expect(tpl.email.html).toContain('&lt;b&gt;Asha&lt;/b&gt;');
  });
});

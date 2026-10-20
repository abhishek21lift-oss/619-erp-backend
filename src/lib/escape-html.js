'use strict';
// Single HTML-escaping contract for user-supplied text placed in email markup.
// Reused by lib/email.js and the notification templates so the two cannot drift.

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };

'use strict';
// The SMTP verification script must exercise the production send path.
//
// ── Why this is a test and not a comment ───────────────────────────────────
//
// scripts/verify-smtp.js is the tool the boot-failure diagnosis tells an
// operator to run. It used to build its OWN nodemailer transport and carry its
// OWN copy of diagnose(), and both had drifted from the library:
//
//   · The transport had no IPv4 pin and no servername, so it kept the exact
//     bug src/lib/email.js had just been fixed for. nodemailer resolves both
//     address families and picks one with Math.random(), so the script would
//     have failed at random against a host publishing an AAAA — while the
//     server it was meant to be verifying worked fine. An operator checking
//     the fix would have concluded it had not worked.
//
//   · Its diagnose() had no IPv6 case at all. For the very failure that
//     started the investigation it would have answered "some hosts block
//     outbound SMTP" — the wrong diagnosis that sent the previous
//     investigation after the port for days.
//
// A verification tool that does not exercise the production path verifies
// nothing, and the failure is silent: the script keeps running and keeps
// printing confident answers.

const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'verify-smtp.js');
const raw = fs.readFileSync(SCRIPT, 'utf8');

/**
 * Strip comments before matching.
 *
 * The header of that script quotes the things it no longer does, in order to
 * explain why. A raw check reads the explanation as the defect returning —
 * this has now caught out four separate guards in this repo.
 */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('verify-smtp.js goes through src/lib/email.js', () => {
  it('reads a real script', () => {
    expect(raw.length).toBeGreaterThan(500);
    expect(src).toMatch(/async function main\(\)/);
  });

  it('builds no transport of its own', () => {
    // The whole point: one transport implementation, so the tool cannot
    // disagree with the server about how a connection is made.
    expect(src).not.toMatch(/createTransport/);
    expect(src).not.toMatch(/require\(['"]nodemailer['"]\)/);
  });

  it('carries no second copy of diagnose()', () => {
    expect(src).not.toMatch(/function diagnose\s*\(/);
    expect(src).toMatch(/email\.diagnose\(/);
  });

  it('verifies and sends through the library', () => {
    expect(src).toMatch(/require\(['"]\.\.\/src\/lib\/email['"]\)/);
    expect(src).toMatch(/email\.verifyConnection\(\)/);
    expect(src).toMatch(/email\.sendWithRetry\(/);
  });

  it('still never prints the password', () => {
    // It reports the LENGTH, which catches a truncated paste or a trailing
    // newline without putting the secret in a terminal or a screenshot.
    expect(src).toMatch(/SMTP_PASS\.length/);
    expect(src).not.toMatch(/\$\{process\.env\.SMTP_PASS\}/);
    expect(src).not.toMatch(/console\.log\([^)]*SMTP_PASS\s*\)/);
  });
});

describe('the library still exports what the script depends on', () => {
  // The script is not covered by the unit suite, so a rename in email.js would
  // otherwise only surface when an operator runs it during an incident.
  const email = require('../lib/email');

  it.each(['verifyConnection', 'diagnose', 'sendWithRetry'])('exports %s', (fn) => {
    expect(typeof email[fn]).toBe('function');
  });
});

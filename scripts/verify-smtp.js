#!/usr/bin/env node
'use strict';
// Check the SMTP credentials before a real customer's invitation is the test.
//
//   node scripts/verify-smtp.js                 # verify the connection only
//   node scripts/verify-smtp.js you@example.com # ...and send a real invitation
//
// The second form sends the ACTUAL invitation template with a dummy token, so
// what lands in the inbox is what a studio owner will see — including how it
// renders in dark mode and whether it went to spam. A template that passes
// unit tests can still look wrong in Outlook.
//
// Reads the same environment variables the server does. Nothing is written to
// the database and no invitation row is created.
//
// ── It uses src/lib/email.js, and must keep doing so ───────────────────────
//
// This script used to build its OWN nodemailer transport and carry its OWN
// copy of diagnose(). Both drifted, and a verification tool that does not
// exercise the production path verifies nothing:
//
//   · The transport had no IPv4 pinning and no servername, so it kept the bug
//     the library had just been fixed for — nodemailer resolves both address
//     families and picks one with Math.random(), so this script would have
//     failed at random against a host publishing an AAAA, while the server
//     itself was fine. An operator checking the fix would have concluded it
//     had not worked.
//
//   · Its diagnose() had no IPv6 case at all. For the exact failure that
//     started this whole investigation it would have answered "some hosts
//     block outbound SMTP" — the wrong diagnosis that sent the last
//     investigation after the port for days. A wrong diagnosis is worse than
//     none, because it is followed.
//
// So the transport and the diagnosis both come from the library now. If this
// script ever needs behaviour the library does not have, add it to the
// library.

require('dotenv').config();

const REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

// The same module the server sends through, so what is proved here is what
// production does — including the IPv4 pin and the SNI servername.
const email = require('../src/lib/email');

async function main() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing: ${missing.join(', ')}`);
    console.error('Set them in .env (locally) or the Render dashboard, then re-run.');
    process.exit(1);
  }

  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  console.log('Configuration');
  console.log(`  host    ${process.env.SMTP_HOST}`);
  console.log(`  port    ${port} (${port === 465 ? 'implicit TLS' : 'STARTTLS'})`);
  console.log(`  user    ${process.env.SMTP_USER}`);
  // Never printed. Length alone is enough to catch a truncated paste or a
  // trailing newline picked up from a copy.
  console.log(`  pass    ${'*'.repeat(8)} (${process.env.SMTP_PASS.length} chars)`);
  console.log(`  from    ${process.env.EMAIL_FROM || process.env.SMTP_FROM || '(unset)'}`);
  console.log('');

  if (/\s/.test(process.env.SMTP_PASS)) {
    console.warn('  ! SMTP_PASS contains whitespace — often a stray newline from a paste.\n');
  }

  // verifyConnection() opens a session and authenticates without sending, and
  // never throws — it reports the failure as data with a diagnosis attached.
  // A full line rather than a trailing write(): the library logs the DNS
  // resolution while this runs, and a half-written line gets a JSON log record
  // appended to it.
  console.log('Verifying connection and credentials…');
  const result = await email.verifyConnection();
  if (!result.ok) {
    console.log('\nFAILED\n');
    console.error(`${result.reason || 'ERROR'}: ${result.message || ''}`);
    if (result.response) console.error(`Server said: ${result.response}`);
    if (result.diagnosis) console.error(`\n${result.diagnosis}`);
    process.exit(1);
  }
  console.log('\nOK\n');

  const to = process.argv[2];
  if (!to) {
    console.log('Credentials are good. Pass an address to send a real test invitation:');
    console.log('  node scripts/verify-smtp.js you@example.com');
    return;
  }

  // Deliberately the real template with a dummy token, so what arrives is
  // exactly what a studio owner receives. The link will land on the
  // set-password page and correctly report an invalid invitation.
  const { invitationHtml, invitationText } = require('../src/lib/emailTemplates/invitation');
  const vars = {
    ownerName: 'Test Owner',
    studioName: 'Test Studio',
    email: to,
    actionUrl: `${(process.env.FRONTEND_URL || 'https://example.com').replace(/\/+$/, '')}/auth/set-password?token=smtp-verification-not-a-real-token`,
    expiryHours: 24,
  };

  try {
    process.stdout.write(`Sending a test invitation to ${to}… `);
    // sendWithRetry, not sendRaw: sendRaw swallows the error and returns
    // {sent:false}, discarding the SMTP dialogue that IS the diagnosis here.
    const info = await email.sendWithRetry({
      from: process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: '[TEST] You\'re invited to MY PT STUDIO — activate Test Studio',
      text: invitationText(vars),
      html: invitationHtml(vars),
    });
    console.log('sent');
    console.log(`  message id  ${info.messageId}`);
    if (info.accepted?.length) console.log(`  accepted    ${info.accepted.join(', ')}`);
    if (info.rejected?.length) console.log(`  rejected    ${info.rejected.join(', ')}`);
    console.log('');
    console.log('Check the inbox — and the spam folder. Worth confirming:');
    console.log('  • it did not land in spam (if it did, check SPF/DKIM for the domain)');
    console.log('  • the maroon button renders, including in dark mode');
    console.log('  • the "Set Your Password" link opens the activation page');
    console.log('    (it will correctly say the invitation is not valid — the token is fake)');
  } catch (err) {
    console.log('FAILED\n');
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
    if (err.response) console.error(`Server said: ${err.response}`);
    console.error(`\n${email.diagnose(err)}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

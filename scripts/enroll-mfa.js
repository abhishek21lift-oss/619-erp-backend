#!/usr/bin/env node
'use strict';
// Enrol MFA on an account, end to end, from one command.
//
// Everything that can be automated is automated: signing in, starting
// enrolment, drawing the QR in your terminal, verifying, and saving the
// recovery codes to a file with tight permissions.
//
// Two steps are left to you, and not for want of trying:
//
//   · Scanning the QR. The TOTP secret has to end up in YOUR authenticator,
//     because that is the whole mechanism — a second factor somebody else
//     holds is not a second factor, and if the secret never reaches your
//     phone you cannot produce codes and cannot log in.
//   · Typing the six digits. That IS the proof of possession.
//
// Everything else this script does for you.
//
// ── Usage ───────────────────────────────────────────────────────────────
//
//   node scripts/enroll-mfa.js
//
//   API_URL=https://api.myptstudio.com \
//   MFA_EMAIL=abhishek@myptstudio.com \
//     node scripts/enroll-mfa.js
//
// The password is prompted for without echo. Pass MFA_PASSWORD only if you
// are piping it from a secret store — never type it inline, or it lands in
// your shell history.
//
// ── What it will not do ─────────────────────────────────────────────────
//
// It talks to the API, exactly as the Settings screen does. It does not
// write mfa_enabled or a secret into the database directly: doing that
// would mark the account protected by a factor nobody can produce, which
// locks out the one account that reaches the operator console.
//
// The secret is never written to disk and never logged. It is shown once,
// as a QR and as a manual key, because that is the only moment it can be
// transferred to your phone — the same thing the Settings screen does.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const QRCode = require('qrcode');

const API = (process.env.API_URL || 'https://api.myptstudio.com').replace(/\/+$/, '');

const bold = (s) => `[1m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;
const green = (s) => `[32m${s}[0m`;
const red = (s) => `[31m${s}[0m`;

function die(msg) {
  console.error(`\n${red('✗')} ${msg}\n`);
  process.exit(1);
}

async function api(pathname, { method = 'GET', body, token } = {}) {
  let res;
  try {
    res = await fetch(API + pathname, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    die(`Could not reach ${API} — ${err.message}\n  Check API_URL, and that this machine can see the API.`);
  }
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function ask(question, { silent = false } = {}) {
  return new Promise((resolve, reject) => {
    // Without a TTY there is no way to suppress echo, so a password can only
    // come from the environment. A one-time 6-digit code is not a secret and
    // is fine to read from a pipe, which is also what makes this script
    // testable end to end.
    if (!process.stdin.isTTY) {
      if (silent) {
        reject(new Error('No TTY — set MFA_EMAIL and MFA_PASSWORD, or run this in a terminal.'));
        return;
      }
      const rl = readline.createInterface({ input: process.stdin });
      process.stdout.write(question);
      rl.once('line', (a) => { rl.close(); resolve(a.trim()); });
      rl.once('close', () => resolve(''));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!silent) {
      rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
      return;
    }
    // No echo: repaint the prompt over each keystroke so the password is not
    // left on screen or in the scrollback.
    const onData = () => rl.output.write(`[2K[200D${question}`);
    rl.output.write(question);
    process.stdin.on('data', onData);
    rl.question('', (a) => {
      process.stdin.removeListener('data', onData);
      rl.output.write('\n');
      rl.close();
      resolve(a.trim());
    });
  });
}

/** The error body shapes this API uses, flattened to one line. */
function reason(body) {
  if (typeof body === 'string') return body;
  if (body?.error?.message) return body.error.message;
  if (typeof body?.error === 'string') return body.error;
  return JSON.stringify(body);
}

async function main() {
  console.log(`\n${bold('MFA enrolment')}  ${dim(API)}\n`);

  const email = process.env.MFA_EMAIL || await ask('Email: ');
  if (!email) die('No email given.');
  const password = process.env.MFA_PASSWORD || await ask('Password (not echoed): ', { silent: true });
  if (!password) die('No password given.');

  // ── 1. Sign in ────────────────────────────────────────────────────────
  let r = await api('/api/auth/login', { method: 'POST', body: { email, password } });

  if (r.status === 401 && r.body?.mfaRequired) {
    console.log(`\n${green('✓')} MFA is already enabled on this account — nothing to do.`);
    console.log(`  ${dim('To re-enrol, turn it off first in Settings → Profile → Security.')}\n`);
    process.exit(0);
  }
  if (r.status !== 200 || !r.body?.token) die(`Sign-in failed (${r.status}): ${reason(r.body)}`);

  const token = r.body.token;
  const role = r.body.user?.role;
  console.log(`${green('✓')} Signed in as ${email} ${dim(`(${role})`)}`);

  // ── 2. Already enrolled? ──────────────────────────────────────────────
  r = await api('/api/profile/me', { token });
  if (r.status === 200 && r.body?.mfaEnabled) {
    console.log(`\n${green('✓')} MFA is already enabled on this account — nothing to do.\n`);
    process.exit(0);
  }

  // ── 3. Start enrolment ────────────────────────────────────────────────
  r = await api('/api/profile/mfa/setup', { method: 'POST', token });
  if (r.status !== 200 || !r.body?.qrUrl) die(`Could not start enrolment (${r.status}): ${reason(r.body)}`);
  const { secret, qrUrl } = r.body;

  const qr = await QRCode.toString(qrUrl, { type: 'terminal', small: true });
  console.log(`\n${bold('1. Scan this with your authenticator app')}`);
  console.log(`   ${dim('Google Authenticator, 1Password, Authy, Bitwarden — any TOTP app.')}\n`);
  console.log(qr);
  console.log(`   ${bold('Or enter this key by hand:')}  ${bold(secret)}`);
  console.log(`   ${dim('Account will appear as MY PT STUDIO: ' + email)}\n`);

  // ── 4. Prove possession ───────────────────────────────────────────────
  console.log(bold('2. Enter the 6-digit code your app is showing'));
  console.log(`   ${dim('If it is rejected, wait for the next code and try again — codes rotate every 30s.')}\n`);

  let enabled = false;
  let codes = [];
  for (let attempt = 1; attempt <= 5 && !enabled; attempt += 1) {
    const code = (await ask('   Code: ')).replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { console.log(`   ${red('✗')} That is not a 6-digit code.`); continue; }

    r = await api('/api/profile/mfa/verify', { method: 'POST', token, body: { code } });
    if (r.status === 200) { enabled = true; codes = r.body.recoveryCodes || []; break; }
    console.log(`   ${red('✗')} ${reason(r.body)}${attempt < 5 ? ' — try the next code.' : ''}`);
  }
  if (!enabled) die('Enrolment not completed. Nothing was changed: MFA is still off.');

  console.log(`\n${green('✓')} MFA enabled.`);

  // ── 5. Recovery codes, saved where they cannot be lost ────────────────
  //
  // Outside the repository, 0600, and this is the only time they exist in
  // readable form — the server keeps digests only.
  if (codes.length) {
    const file = path.join(os.homedir(), `619-mfa-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`);
    const contents = [
      'MY PT STUDIO — MFA recovery codes',
      `Account: ${email}`,
      `Issued:  ${new Date().toISOString()}`,
      '',
      'Each code works ONCE, in place of the 6-digit code, at sign-in.',
      'Keep these offline. Anyone holding them can pass your second factor.',
      '',
      ...codes.map((c) => `  ${c}`),
      '',
    ].join('\n');
    fs.writeFileSync(file, contents, { mode: 0o600 });

    console.log(`\n${bold('3. Your recovery codes')}  ${dim('(saved to ' + file + ', mode 0600)')}\n`);
    for (const c of codes) console.log(`   ${bold(c)}`);
    console.log(`\n   ${dim('Each works once, at sign-in, instead of the 6-digit code.')}`);
    console.log(`   ${dim('Print them or put them in a password manager. They are not recoverable later.')}\n`);
  }

  // ── 6. Prove the challenge is live ────────────────────────────────────
  r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (r.status === 401 && r.body?.mfaRequired) {
    console.log(`${green('✓')} Verified: signing in now requires a second factor.\n`);
  } else {
    console.log(`${red('!')} Expected sign-in to be challenged and it was not (${r.status}).`);
    console.log(`  ${dim('Check Settings → Profile → Security before enabling SUPER_ADMIN_REQUIRE_MFA.')}\n`);
    process.exit(1);
  }

  if (role === 'super_admin') {
    console.log(bold('Next:'));
    console.log('  1. Sign out and back in once, to confirm the code works for you.');
    console.log('  2. Test ONE recovery code, so you know the fallback is real.');
    console.log('  3. Only then set SUPER_ADMIN_REQUIRE_MFA=on and redeploy.\n');
  }
}

main().catch((err) => die(err.message));

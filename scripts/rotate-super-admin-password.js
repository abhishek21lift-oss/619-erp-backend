#!/usr/bin/env node
'use strict';
// Rotate the platform super admin's password, out of band.
//
// Migrations 091 and 131 each committed a live bcrypt hash for this account
// into git. That is why this script exists rather than a migration: a
// migration file is version-controlled, so setting a password in one puts the
// replacement in git beside the one it replaces. The plaintext must never
// reach the repository, the deploy log, the shell history or a process list.
//
// So the password is read from an environment variable or a no-echo prompt,
// never from argv — `ps` shows another user's argv on a shared box, and a
// shell writes it to history. It is never printed, and neither is the hash.
//
// ── Usage ───────────────────────────────────────────────────────────────
//
//   Interactive (recommended — nothing lands in shell history):
//     DATABASE_URL='...' node scripts/rotate-super-admin-password.js
//
//   Non-interactive, e.g. from a password manager's CLI:
//     DATABASE_URL='...' SUPER_ADMIN_NEW_PASSWORD="$(op read op://vault/item/password)" \
//       node scripts/rotate-super-admin-password.js
//
//   Target a specific account (defaults to the sole role='super_admin' row):
//     SUPER_ADMIN_EMAIL='someone@example.com' ...
//
//   Preview without writing:
//     DRY_RUN=1 ...
//
// ── What it does ────────────────────────────────────────────────────────
//
//   1. Finds the target account and refuses if the match is ambiguous.
//   2. Hashes with bcrypt cost 12 — the same parameters as
//      POST /api/auth/reset-password, so this account is not a special case
//      for verification.
//   3. Verifies the new hash actually validates the new password BEFORE
//      writing, so a broken rotation cannot lock the account.
//   4. Writes the hash, bumps token_version AND revokes every refresh token,
//      in ONE statement.
//
// ── Why all three, and why one statement ────────────────────────────────
//
// Bumping token_version alone is NOT enough, and an earlier version of this
// script made exactly that mistake. middleware/auth.js compares a JWT's
// token_version against the row, so the bump kills the 15-minute ACCESS
// tokens — but refresh tokens live in their own table and POST /auth/refresh
// never compares token_version. It checks only `is_active` and `deleted_at`,
// then signs a NEW access token carrying whatever the current token_version
// is. So a refresh token minted under the OLD password keeps minting valid
// access tokens for its remaining 7 days, and rotation renews it each time.
//
// That is AUD-005, and routes/auth.js already solves it for
// /auth/reset-password with the data-modifying CTE below. This mirrors it
// rather than inventing a second answer.
//
// One statement, not two: the password write and the revocation have to
// succeed or fail together. If the revoke were a separate query and it
// failed, the password would already have changed while the attacker's
// session survived — the precise bug this closes.
//
// ── After running ───────────────────────────────────────────────────────
//
// Rotating the password does NOT un-publish the old hash: it is in the git
// history of a repository that has been public, so it must be assumed
// captured and crackable offline at leisure. Rotation removes its value; it
// does not remove the hash. See docs/SECURITY-INCIDENT-superadmin-credential.md
// for the rest of the response, including enabling MFA on this account —
// which is what stops a cracked password from being enough on its own.

const readline = require('node:readline');
const bcrypt = require('bcryptjs');

const BCRYPT_COST = 12;

/** Read a password without echoing it, and without it reaching argv. */
function promptSecret(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(
        'No TTY to prompt on. Set SUPER_ADMIN_NEW_PASSWORD instead — but pipe it in from a '
        + 'secret store rather than typing it inline, so it does not land in shell history.'
      ));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress echo: swallow the output the interface would write for each
    // keystroke, so the password is not left on screen or in a scrollback.
    const onData = () => { rl.output.write('[2K[200D' + question); };
    rl.output.write(question);
    process.stdin.on('data', onData);
    rl.question('', (answer) => {
      process.stdin.removeListener('data', onData);
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

function assertStrong(password) {
  const problems = [];
  if (password.length < 16) problems.push('at least 16 characters');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('a digit');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('a symbol');
  if (problems.length) {
    // Names what is missing, never what was supplied.
    throw new Error(`Refusing to set a weak password. It needs ${problems.join(', ')}.`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Point it at the database you intend to rotate.');
  }

  // Required late so the missing-DATABASE_URL message above is the one seen:
  // db/pool.js exits the process itself when it is unset.
  const pool = require('../src/db/pool');

  const email = process.env.SUPER_ADMIN_EMAIL || null;
  const { rows: targets } = await pool.query(
    email
      ? `SELECT id, email, role, is_active, token_version FROM users WHERE LOWER(email) = LOWER($1)`
      : `SELECT id, email, role, is_active, token_version FROM users WHERE role = 'super_admin'`,
    email ? [email] : []
  );

  if (targets.length === 0) {
    throw new Error(email
      ? `No user with email ${email}.`
      : "No user with role 'super_admin'. Pass SUPER_ADMIN_EMAIL to target one explicitly.");
  }
  if (targets.length > 1) {
    throw new Error(
      `${targets.length} accounts matched (${targets.map((t) => t.email).join(', ')}). `
      + 'Pass SUPER_ADMIN_EMAIL to say which one.'
    );
  }

  const target = targets[0];
  console.log(`Target: ${target.email} (id=${target.id}, role=${target.role}, active=${target.is_active})`);
  console.log(`Sessions minted before this rotation stop working (token_version ${target.token_version} → ${target.token_version + 1}).`);

  const password = process.env.SUPER_ADMIN_NEW_PASSWORD
    || await promptSecret('New password (not echoed): ');

  if (!password) throw new Error('No password supplied.');
  assertStrong(password);

  const hash = await bcrypt.hash(password, BCRYPT_COST);

  // Prove the hash before storing it. A rotation that writes a hash the app
  // cannot verify locks out the only account that can reach the console.
  if (!(await bcrypt.compare(password, hash))) {
    throw new Error('Generated hash failed its own verification — refusing to write it.');
  }

  if (process.env.DRY_RUN) {
    console.log('DRY_RUN set — verified the new hash and stopped without writing.');
    await pool.end();
    return;
  }

  // Password + token_version + refresh-token revocation, atomically. See the
  // header: the bump alone leaves refresh tokens minting valid access tokens.
  const { rowCount } = await pool.query(
    `WITH pw AS (
       UPDATE users
          SET password = $1,
              token_version = token_version + 1,
              updated_at = NOW()
        WHERE id = $2
       RETURNING id
     )
     UPDATE refresh_tokens
        SET revoked_at = NOW()
      WHERE user_id = (SELECT id FROM pw)
        AND revoked_at IS NULL`,
    [hash, target.id]
  );

  // rowCount here is the refresh_tokens count — the CTE's UPDATE is the outer
  // statement. Confirm the password actually changed by reading it back,
  // rather than inferring it from a number that counts something else.
  const { rows: after } = await pool.query(
    'SELECT token_version FROM users WHERE id = $1', [target.id]
  );
  if (!after[0] || after[0].token_version !== target.token_version + 1) {
    throw new Error('Password row did not update as expected — check the account and re-run.');
  }

  console.log(`Password rotated. ${rowCount} refresh token(s) revoked; all existing sessions are dead.`);
  console.log('Next: enable MFA on this account before setting SUPER_ADMIN_REQUIRE_MFA=on.');
  console.log('See docs/SECURITY-INCIDENT-superadmin-credential.md for the remaining steps.');

  await pool.end();
}

main().catch((err) => {
  // The message, never the stack: a stack from bcrypt or pg can carry the
  // arguments it was called with.
  console.error(`rotation failed: ${err.message}`);
  process.exit(1);
});

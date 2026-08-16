'use strict';
// No live credential may be committed to this repository.
//
// Migrations 091 and 131 each carried a real bcrypt hash for the platform
// super admin. Both headers argued the same defence — "the plaintext was
// delivered out of band and is not in git" — and both missed the same thing:
// a bcrypt hash is not a public value. It is an offline-crackable copy of the
// credential, and this repository has been public, so committing it published
// the account. The P0 remediation verified the hash in 131 was byte-identical
// to the one still live in production, on an active account with cross-tenant
// authority over every studio and MFA disabled.
//
// A comment saying "do not do this" would not have stopped it, because the
// second occurrence was written by someone following the first as precedent.
// This fails the build instead.
//
// ── Why a static scan rather than a scanning service ────────────────────
//
// Not a replacement for GitHub secret scanning or a pre-commit hook — those
// catch more, and one of them should exist too. This is the cheap half that
// runs in the same CI job as everything else and blocks the merge: no
// enrolment, no token, no third party, and it fails on the branch rather than
// after the push.
//
// ── What "locked placeholder" means ─────────────────────────────────────
//
// The seed migrations still need SOMETHING in the password column. They now
// carry a syntactically valid bcrypt string whose salt and digest are '.'
// padding. No input produces it, so bcrypt.compare() answers false for every
// password and the seeded row exists but cannot be signed into until an
// operator sets one with scripts/rotate-super-admin-password.js. That string
// is the one bcrypt-shaped literal this test allows.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

/** A bcrypt hash: $2a/$2b/$2y, a two-digit cost, then 53 salt+digest chars. */
const BCRYPT = /\$2[aby]\$[0-9]{2}\$[A-Za-z0-9./]{53}/g;

/** The deliberate no-password value. Matches BCRYPT, and is not a secret. */
const LOCKED = '$2a$12$' + '.'.repeat(53);

/**
 * Directories worth scanning. node_modules and .git are excluded for cost,
 * not because they are trusted — .git history is exactly where the old
 * hashes still live, and removing them from history is an operator decision
 * (it rewrites published commits), tracked in the incident document rather
 * than enforced here.
 */
const ROOTS = ['src', 'scripts', 'infra', 'db'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next']);
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.sql', '.json', '.yml', '.yaml', '.md', '.sh', '.env']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(path.join(REPO, r)));

describe('no live credential is committed', () => {
  test('the scan actually looked at something', () => {
    // A guard whose file list silently became empty passes forever.
    expect(FILES.length).toBeGreaterThan(100);
  });

  test('no bcrypt hash appears anywhere outside the locked placeholder', () => {
    const offenders = [];

    for (const file of FILES) {
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.match(BCRYPT) || []) {
        if (match === LOCKED) continue;
        // Report WHERE, never the hash itself — a test failure is printed to
        // a CI log that is often more public than the file it is protecting.
        offenders.push(path.relative(REPO, file));
      }
    }

    const unique = [...new Set(offenders)];
    if (unique.length) {
      throw new Error(
        'A bcrypt hash is committed in:\n  ' + unique.join('\n  ')
        + '\n\nIf this is a seed account, use the locked placeholder ($2a$12$ followed by '
        + '53 dots) and set a real password out of band with '
        + 'scripts/rotate-super-admin-password.js. If it is a test fixture, generate it at '
        + 'runtime with bcrypt.hash() instead of pasting a constant.'
      );
    }
    expect(unique).toEqual([]);
  });

  test('the super-admin seed migrations carry the locked placeholder', () => {
    // Specifically, so that a future edit that reintroduces a working
    // credential into these two files fails here with a pointed message
    // rather than only in the broad scan above.
    for (const name of ['091_seed_platform_super_admin.sql', '131_rename_platform_super_admin.sql']) {
      const src = fs.readFileSync(path.join(REPO, 'src', 'db', 'migrations', name), 'utf8');
      const hashes = src.match(BCRYPT) || [];
      // Reported as a {file, ...} shape so a failure names the migration
      // rather than only printing an unhelpful "expected 1, got 2".
      expect({ file: name, count: hashes.length }).toEqual({ file: name, count: 1 });
      expect({ file: name, locked: hashes[0] === LOCKED }).toEqual({ file: name, locked: true });
    }
  });

  test('the locked placeholder cannot authenticate', async () => {
    // The property the whole approach rests on. If a future bcryptjs upgrade
    // ever made this string verify against something, the seed accounts would
    // silently become usable again.
    const bcrypt = require('bcryptjs');
    for (const attempt of ['', '.', 'password', 'admin', LOCKED, 'a'.repeat(53)]) {
      await expect(bcrypt.compare(attempt, LOCKED)).resolves.toBe(false);
    }
  });
});

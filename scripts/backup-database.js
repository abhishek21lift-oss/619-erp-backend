#!/usr/bin/env node
'use strict';
// Take an off-site logical backup of the production database.
//
// ── Why this script exists ──────────────────────────────────────────────
//
// This project's Supabase organisation is on the FREE plan, and Supabase does
// not back up free-plan projects at all. From their own documentation:
//
//   "We automatically back up all Pro, Team, and Enterprise Plan projects on
//    a daily basis. … We recommend that free tier plan projects regularly
//    export their data using the Supabase CLI db dump command and maintain
//    off-site backups."
//   https://supabase.com/docs/guides/platform/backups
//
// So there is no daily backup, no Point-in-Time Recovery, and no restore
// point of any kind for six live studios' data. Nothing in this repository
// provided one either. This is that missing piece.
//
// It is a stopgap, not a substitute for the Pro plan. A nightly logical dump
// gives an RPO of up to 24 hours — a bad afternoon loses an afternoon of
// check-ins, payments and assessments. PITR is what reduces that to minutes,
// and it needs a paid plan. See docs/DISASTER-RECOVERY.md.
//
// ── What it does ────────────────────────────────────────────────────────
//
//   1. pg_dump in custom format (-Fc), which is compressed and restorable
//      selectively with pg_restore.
//   2. Writes to a directory OUTSIDE the repository. A dump is a complete
//      copy of every studio's data; it must never land in a working tree
//      that might be committed or in an image layer.
//   3. Verifies the dump is non-trivial and readable by pg_restore -l before
//      calling it a backup — a truncated dump that nobody opens until the
//      day they need it is worse than no dump, because it is trusted.
//   4. Optionally uploads to Cloudflare R2, reusing the same credentials the
//      app already uses for file storage, and prunes old objects.
//
// Credentials come from the environment only. Nothing here writes a secret
// to disk, to the log, or to argv.
//
// ── Usage ───────────────────────────────────────────────────────────────
//
//   DATABASE_URL='...' node scripts/backup-database.js
//   DATABASE_URL='...' BACKUP_DIR=/var/backups/619 node scripts/backup-database.js
//
//   With upload + 30-day retention (R2_* are the app's existing variables):
//   DATABASE_URL='...' BACKUP_UPLOAD=1 BACKUP_RETAIN_DAYS=30 \
//     node scripts/backup-database.js
//
// Exit code is non-zero on any failure, so cron/systemd surfaces it.

const { execFileSync, execFileSync: run } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const RETAIN_DAYS = Number(process.env.BACKUP_RETAIN_DAYS || 30);

function fail(msg) {
  console.error(`backup failed: ${msg}`);
  process.exit(1);
}

/** Redact the password from a connection string before it is ever printed. */
function safeUrl(url) {
  return String(url).replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:***@');
}

function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set.');

  // A dump inside the repo is one `git add -A` away from being published,
  // and this repository has been public. Refuse outright rather than warn.
  const dir = path.resolve(process.env.BACKUP_DIR || path.join(os.homedir(), '619-backups'));
  if (dir === REPO || dir.startsWith(REPO + path.sep)) {
    fail(`BACKUP_DIR (${dir}) is inside the repository. A database dump must never sit in a working tree.`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `619-erp-${stamp}.dump`);

  console.log(`Dumping ${safeUrl(url)}`);
  console.log(`  → ${file}`);

  try {
    // -Fc: custom format — compressed, and pg_restore can pull single tables
    // out of it, which is what a partial recovery actually needs.
    // --no-owner/--no-privileges: the roles differ between Supabase and any
    // machine you restore onto, and ownership statements make a restore fail
    // for a reason that has nothing to do with the data.
    execFileSync('pg_dump', ['-Fc', '--no-owner', '--no-privileges', '-f', file, url], {
      stdio: ['ignore', 'inherit', 'inherit'],
      // pg_dump on a database this size is minutes, not seconds.
      timeout: 30 * 60 * 1000,
    });
  } catch (err) {
    fail(`pg_dump exited non-zero (${err.status ?? err.message}).`);
  }

  // ── Prove the dump before trusting it ─────────────────────────────────
  const { size } = fs.statSync(file);
  if (size < 100 * 1024) {
    fail(`dump is only ${size} bytes — that is not a backup of this database.`);
  }

  let tables = 0;
  try {
    // pg_restore -l reads the archive's table of contents. It parses the
    // whole file, so a truncated or corrupt dump fails here rather than on
    // the day it is needed.
    const toc = run('pg_restore', ['-l', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    tables = (toc.match(/^\d+;.*TABLE DATA /gm) || []).length;
  } catch (err) {
    fail(`pg_restore could not read the dump back (${err.status ?? err.message}) — it is not a usable backup.`);
  }

  if (tables < 50) {
    fail(`dump contains only ${tables} tables with data; this schema has ~185. Refusing to report success.`);
  }

  console.log(`Verified: ${(size / 1024 / 1024).toFixed(1)} MiB, ${tables} tables with data.`);

  prune(dir);

  if (process.env.BACKUP_UPLOAD) {
    upload(file).catch((err) => fail(`upload: ${err.message}`));
  } else {
    console.log('BACKUP_UPLOAD not set — the dump is on this machine only.');
    console.log('A backup on the same host as the thing it protects is not off-site.');
  }
}

/** Delete local dumps older than the retention window. */
function prune(dir) {
  const cutoff = Date.now() - RETAIN_DAYS * 86400_000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('619-erp-') || !name.endsWith('.dump')) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
  }
  if (removed) console.log(`Pruned ${removed} local dump(s) older than ${RETAIN_DAYS} days.`);
}

/**
 * Upload to R2, reusing the app's existing credentials (lib/fileStorage.js
 * reads the same four variables). A separate bucket by default: file storage
 * is served to users, and a database dump is not something to keep one
 * misconfigured policy away from a public object.
 */
async function upload(file) {
  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`BACKUP_UPLOAD is set but ${missing.join(', ')} are not.`);

  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = process.env.BACKUP_R2_BUCKET || 'db-backups';
  const key = `619-erp/${path.basename(file)}`;

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(file),
    ContentType: 'application/octet-stream',
  }));

  console.log(`Uploaded to r2://${bucket}/${key}`);
  console.log('Set a lifecycle rule on that bucket for retention — this script prunes only local copies.');
}

main();

#!/usr/bin/env node
'use strict';
// Restore drill: prove a backup restores, not just that it exists.
//
// scripts/backup-database.js verifies its dump by reading the archive's table
// of contents back (pg_restore -l). That proves the file is a readable
// archive. It does not prove the data comes back. This does: it restores the
// dump into a NEW, EMPTY database and compares, table by table, the row count
// of every table in `public` with the source.
//
//   node scripts/restore-drill.js <dump-file> <target-url> [--compare <source-url>]
//
// <target-url> must name a throwaway database: one with no tables in `public`
// yet, on a host that is not a managed production provider. The drill refuses
// anything else, because "restore over the live database" is the mistake a
// recovery tool must make impossible, not merely unlikely.
//
// With --compare, every table in the source's `public` schema must exist in
// the restore with exactly the same row count. Without it, the drill checks
// that the core tables came back and are not all empty. Read-only on the
// source: it runs count(*) and nothing else.
//
// pg_restore's own exit status is reported but not used as the verdict. A
// Supabase dump carries Supabase-only schemas and extensions (auth, storage,
// graphql, vault) that a plain Postgres cannot recreate, and pg_restore exits
// non-zero for every one of them while restoring the application's data
// perfectly. The data is the verdict.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { Client } = require('pg');

/** The tables a studio cannot run without. Checked even without --compare. */
const CORE_TABLES = Object.freeze([
  'organizations', 'users', 'pt_clients', 'pt_payments', 'pt_client_subscriptions',
  'invoices', 'pt_informed_consents', 'pt_parq_forms', '_migrations',
]);

const PRODUCTION_HOSTS = /supabase|pooler|amazonaws|rds\./i;

class DrillError extends Error {}

function safeUrl(url) {
  return String(url).replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:***@');
}

async function withClient(url, fn) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** row count of every ordinary table in `public`, by name. */
async function publicCounts(url, only = null) {
  return withClient(url, async (c) => {
    const { rows: tables } = await c.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`);
    const out = {};
    for (const { relname } of tables) {
      if (only && !only.includes(relname)) continue;
      const { rows } = await c.query(`SELECT count(*)::bigint AS n FROM public."${relname.replace(/"/g, '""')}"`);
      out[relname] = Number(rows[0].n);
    }
    return out;
  });
}

async function assertThrowawayTarget(targetUrl) {
  let host;
  try { host = new URL(targetUrl).hostname; } catch { throw new DrillError('target is not a connection URL'); }
  if (PRODUCTION_HOSTS.test(host)) {
    throw new DrillError(`refusing to restore into ${host}: the target must be a throwaway database, never a managed production host`);
  }
  const existing = await withClient(targetUrl, async (c) => (await c.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`)).rows[0].n);
  if (existing > 0) {
    throw new DrillError(`refusing to restore: the target already has ${existing} table(s) in public — use a new, empty database`);
  }
}

/**
 * Restore `file` into `targetUrl` and verify it. Returns a report; throws
 * DrillError when the restore cannot be trusted.
 */
async function restoreAndVerify({ file, targetUrl, sourceUrl = null }) {
  if (!file || !fs.existsSync(file)) throw new DrillError(`dump file not found: ${file}`);
  await assertThrowawayTarget(targetUrl);

  const started = Date.now();
  const r = spawnSync('pg_restore', ['--no-owner', '--no-privileges', '-d', targetUrl, file], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000,
  });
  if (r.error) throw new DrillError(`pg_restore could not run: ${r.error.message}`);
  const restoreErrors = (r.stderr.match(/^pg_restore: error:/gm) || []).length;
  const restoredIn = Date.now() - started;

  const restored = await publicCounts(targetUrl);
  const missingCore = CORE_TABLES.filter((t) => !(t in restored));
  if (missingCore.length) {
    throw new DrillError(`restore is missing core table(s): ${missingCore.join(', ')} (pg_restore reported ${restoreErrors} error(s))`);
  }

  const mismatches = [];
  let compared = 0;
  if (sourceUrl) {
    const source = await publicCounts(sourceUrl);
    for (const [table, n] of Object.entries(source)) {
      compared += 1;
      if (!(table in restored)) mismatches.push(`${table}: missing (source has ${n})`);
      else if (restored[table] !== n) mismatches.push(`${table}: source ${n}, restored ${restored[table]}`);
    }
  } else if (CORE_TABLES.every((t) => t === '_migrations' || restored[t] === 0)) {
    throw new DrillError('every core table restored empty — that is not a backup of a live studio');
  }
  if (mismatches.length) {
    throw new DrillError(`restore does not match the source in ${mismatches.length} table(s): ${mismatches.slice(0, 10).join('; ')}`);
  }

  return {
    tables: Object.keys(restored).length,
    rows: Object.values(restored).reduce((a, b) => a + b, 0),
    compared,
    restoreErrors,
    restoredIn,
    core: Object.fromEntries(CORE_TABLES.map((t) => [t, restored[t]])),
  };
}

async function main(argv) {
  const [file, targetUrl, flag, sourceUrl] = argv;
  if (!file || !targetUrl || (flag && flag !== '--compare')) {
    console.error('usage: node scripts/restore-drill.js <dump-file> <target-url> [--compare <source-url>]');
    process.exit(2);
  }
  console.log(`Restoring ${file}`);
  console.log(`  → ${safeUrl(targetUrl)}${sourceUrl ? `, comparing with ${safeUrl(sourceUrl)}` : ''}`);
  try {
    const rep = await restoreAndVerify({ file, targetUrl, sourceUrl: sourceUrl || null });
    console.log(`Restore verified: ${rep.tables} tables, ${rep.rows} rows in public, in ${(rep.restoredIn / 1000).toFixed(1)}s.`);
    if (sourceUrl) console.log(`  Every one of ${rep.compared} source tables matched its row count exactly.`);
    console.log(`  Core: ${Object.entries(rep.core).map(([t, n]) => `${t}=${n}`).join(' ')}`);
    if (rep.restoreErrors) {
      console.log(`  pg_restore reported ${rep.restoreErrors} error(s) outside the verified data (e.g. provider-only schemas).`);
    }
  } catch (err) {
    console.error(`restore drill FAILED: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { restoreAndVerify, DrillError, CORE_TABLES };

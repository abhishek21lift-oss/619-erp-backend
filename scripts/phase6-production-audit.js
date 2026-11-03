#!/usr/bin/env node
'use strict';
// Phase 6/7 — the guarded, read-only production audit.
//
// Phase 7 extends the same guarded run with the column-complete audit in
// phase7-legacy-column-audit.js. Both analyzers run read-only and produce
// artifacts in the same private run directory; the schema-removal gate reads
// both results.
//
// This is the only supported way to point the D1–D25 reconciliation report at
// a production database. It exists because "run the Phase 5 script with a
// production URL" is one typo away from a report written into the repository,
// a password printed in a CI log, or an audit run against the wrong cluster.
//
// What it guarantees, in order:
//
//   * an explicit `--acknowledge-production` and an exact `--confirm-host`
//     match before a connection is opened;
//   * plaintext transport is refused for a non-loopback host unless the
//     operator also passes `--allow-no-tls`;
//   * the preflight session is `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL
//     REPEATABLE READ`, and the analyzer child runs with
//     `default_transaction_read_only=on` as well;
//   * the expected tables must exist, so an empty or wrong database fails
//     before it produces a misleading zero-count report;
//   * output goes to a fresh directory outside the repository, mode 0700,
//     every artifact mode 0600, with a SHA-256 manifest;
//   * no client name, health value or password is printed to stdout.
//
// The analyzer still owns the SQL. This wrapper does not add a second set of
// queries that could disagree with it.
//
//   node scripts/phase6-production-audit.js \
//     --url "$PRODUCTION_READ_ONLY_DATABASE_URL" \
//     --confirm-host db.example.com \
//     --acknowledge-production \
//     --out-dir /secure/audits/619-phase6
//
// Exit codes: 0 audit complete, 1 audit/validation failure, 2 usage or
// security refusal.

const { Client } = require('pg');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeDecisionArtifacts } = require('./phase6-decisions');

const REPO = path.resolve(__dirname, '..');
const ANALYZER = path.join(__dirname, 'phase5-reconcile-ownership.js');
const COLUMN_AUDIT = path.join(__dirname, 'phase7-legacy-column-audit.js');
const REQUIRED_TABLES = [
  'pt_clients', 'pt_assessments', 'pt_goals', 'weekly_checkins',
  'pt_lifestyle_assessments', 'pt_nutrition_assessments',
  'pt_parq_forms', 'pt_client_interviews',
  // Phase 7 audits every column of both retired tables. Requiring them here
  // means a wrong or already-empty database fails before a zero-count report.
  'pt_os_measurements', 'client_fitness_profiles',
];

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function parseOptions(argv = process.argv.slice(2)) {
  const url = arg(argv, 'url') || process.env.PHASE6_AUDIT_DATABASE_URL;
  const outDir = arg(argv, 'out-dir');
  const confirmHost = arg(argv, 'confirm-host');
  const org = arg(argv, 'org');
  const allowNoTls = argv.includes('--allow-no-tls');
  const acknowledge = argv.includes('--acknowledge-production');

  if (!url || !outDir) {
    throw new Error('Usage: --url <database> --out-dir <dir> --confirm-host <host> --acknowledge-production [--org <uuid>] [--allow-no-tls]');
  }
  if (!acknowledge) {
    throw new Error('Refusing to connect: pass --acknowledge-production to confirm you are authorized to read this database.');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Refusing to connect: --url is not a valid PostgreSQL connection URL.');
  }
  if (!confirmHost) {
    throw new Error('Refusing to connect: --confirm-host is required so the target is named, not guessed.');
  }
  if (parsed.hostname.toLowerCase() !== confirmHost.toLowerCase()) {
    throw new Error(`Refusing to connect: --confirm-host ${confirmHost} does not match URL host ${parsed.hostname}.`);
  }
  const sslmode = parsed.searchParams.get('sslmode') || '';
  if (!isLoopback(parsed.hostname) && sslmode === 'disable' && !allowNoTls) {
    throw new Error(`Refusing to connect to ${parsed.hostname} with sslmode=disable; use TLS or pass --allow-no-tls.`);
  }

  const resolvedOut = path.resolve(outDir);
  if (resolvedOut === REPO || resolvedOut.startsWith(REPO + path.sep)) {
    throw new Error(`Refusing to write audit output inside the repository (${resolvedOut}). Use a directory outside the working tree.`);
  }

  return { url, outDir: resolvedOut, confirmHost, org, allowNoTls, acknowledge };
}

async function preflight(url) {
  const db = new Client({
    connectionString: url,
    application_name: 'phase6-production-audit-preflight',
  });
  await db.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await db.query("SET LOCAL statement_timeout = '60s'");
    const { rows: [state] } = await db.query(
      `SELECT current_setting('transaction_read_only')  AS read_only,
              current_setting('transaction_isolation')  AS isolation,
              current_setting('server_version')          AS server_version,
              current_user                              AS role,
              current_database()                        AS database`,
    );
    const { rows: [recovery] } = await db.query('SELECT pg_is_in_recovery() AS in_recovery');
    const { rows: [privileges] } = await db.query(
      `SELECT rolsuper, rolcreaterole, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`,
    );
    const { rows: [tables] } = await db.query(
      `SELECT ${REQUIRED_TABLES.map((t) => `to_regclass('public.${t}') AS ${t}`).join(',\n              ')}`,
    );
    await db.query('ROLLBACK');

    if (state.read_only !== 'on') {
      throw new Error(`Refusing to audit: transaction_read_only is "${state.read_only}", not "on".`);
    }
    if (state.isolation !== 'repeatable read') {
      throw new Error(`Refusing to audit: isolation is "${state.isolation}", not "repeatable read".`);
    }
    const missing = REQUIRED_TABLES.filter((t) => tables[t] === null);
    if (missing.length) {
      throw new Error(`Refusing to audit: missing expected table(s): ${missing.join(', ')}. Wrong database?`);
    }
    return {
      ...state,
      in_recovery: recovery.in_recovery,
      role_superuser: privileges.rolsuper,
      role_createrole: privileges.rolcreaterole,
      role_bypassrls: privileges.rolbypassrls,
      tables_present: REQUIRED_TABLES.length,
    };
  } finally {
    await db.end().catch(() => {});
  }
}

function runChild(script, args) {
  // The child's own BEGIN is already READ ONLY. This makes every transaction
  // in that session read-only, so a future edit to an analyzer cannot quietly
  // acquire a write connection.
  const pgoptions = [process.env.PGOPTIONS, '-c default_transaction_read_only=on']
    .filter(Boolean).join(' ');
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PGOPTIONS: pgoptions, PGCONNECT_TIMEOUT: '15' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${path.basename(script)} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)} failed with exit ${result.status}: ${(result.stderr || '').trim() || 'no stderr'}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAnalyzer(options, runDir) {
  const args = [
    '--url', options.url,
    '--json', path.join(runDir, 'phase5-report.json'),
    '--md', path.join(runDir, 'phase5-report.md'),
    '--plan', path.join(runDir, 'phase5-plan.json'),
    '--csv', path.join(runDir, 'phase5-review.csv'),
  ];
  if (options.org) args.push('--org', options.org);
  return runChild(ANALYZER, args);
}

function runColumnAudit(options, runDir) {
  const args = ['--url', options.url, '--out-dir', runDir];
  if (options.org) args.push('--org', options.org);
  return runChild(COLUMN_AUDIT, args);
}

function artifactList(runDir, names) {
  return names.map((name) => {
    const file = path.join(runDir, name);
    const stat = fs.statSync(file);
    fs.chmodSync(file, 0o600);
    return { name, bytes: stat.size, sha256: sha256(file), mode: '0600' };
  });
}

function writeManifest(runDir, manifest) {
  const file = path.join(runDir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);

  const sums = [...manifest.artifacts, {
    name: 'manifest.json', bytes: fs.statSync(file).size, sha256: sha256(file),
  }].map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n';
  const sumsFile = path.join(runDir, 'SHA256SUMS');
  fs.writeFileSync(sumsFile, sums, { mode: 0o600 });
  fs.chmodSync(sumsFile, 0o600);
  return file;
}

async function main() {
  let options;
  try {
    options = parseOptions();
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const url = new URL(options.url);
  const startedAt = new Date().toISOString();
  console.log('# Phase 6/7 production audit');
  console.log(`Target: ${url.hostname}${url.pathname}`);
  console.log('Mode: read-only (acknowledged)');

  let state;
  try {
    state = await preflight(options.url);
  } catch (err) {
    console.error(`Preflight failed: ${err.message}`);
    process.exit(1);
  }

  fs.mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
  const runDir = fs.mkdtempSync(path.join(options.outDir, 'run-'));
  fs.chmodSync(runDir, 0o700);

  try {
    runAnalyzer(options, runDir);
    runColumnAudit(options, runDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const reportPath = path.join(runDir, 'phase5-report.json');
  const planPath = path.join(runDir, 'phase5-plan.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const columnAudit = JSON.parse(fs.readFileSync(path.join(runDir, 'phase7-summary.json'), 'utf8'));

  if (report.read_only !== true || report.validation?.ok !== true) {
    console.error('Audit failed: the analyzer did not certify a read-only, self-validating run.');
    process.exit(1);
  }
  if (columnAudit.read_only !== true || columnAudit.validation?.ok !== true) {
    console.error('Audit failed: the column audit did not certify a read-only, self-validating run.');
    process.exit(1);
  }

  let built;
  try {
    built = writeDecisionArtifacts(runDir, report, plan);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const analyzerFiles = ['phase5-report.json', 'phase5-report.md', 'phase5-plan.json', 'phase5-review.csv'];
  const columnFiles = ['phase7-report.json', 'phase7-report.md', 'phase7-records.csv',
    'phase7-candidates.csv', 'phase7-summary.json'];
  const decisionFiles = ['records.csv', 'conflicts.csv', 'backfill-candidates.csv',
    'decision-register.md', 'backfill-review.md', 'decision-summary.json'];
  const artifacts = artifactList(runDir, [...analyzerFiles, ...columnFiles, ...decisionFiles]);

  const readyForReview = report.totals.legacy_only === 0 && report.totals.conflicts === 0
    && columnAudit.totals.legacy_only === 0 && columnAudit.totals.conflict === 0
    && columnAudit.totals.no_canonical_owner === 0 && columnAudit.totals.tenant_blocked === 0
    && columnAudit.tenant.ok === true
    && built.candidates.length === 0 && columnAudit.candidates.count === 0;
  const reasons = [];
  if (report.totals.legacy_only > 0) reasons.push(`${report.totals.legacy_only} legacy-only record(s) still hold data absent from the owner`);
  if (report.totals.conflicts > 0) reasons.push(`${report.totals.conflicts} conflicting record(s) need a named reviewer decision`);
  if (built.candidates.length > 0) reasons.push(`${built.candidates.length} Phase 5 backfill candidate(s) remain unapplied`);
  if (columnAudit.totals.legacy_only > 0) reasons.push(`${columnAudit.totals.legacy_only} populated legacy column cell(s) exist only in a retired table`);
  if (columnAudit.totals.conflict > 0) reasons.push(`${columnAudit.totals.conflict} populated legacy column cell(s) conflict with the canonical owner`);
  if (columnAudit.totals.no_canonical_owner > 0) reasons.push(`${columnAudit.totals.no_canonical_owner} populated column cell(s) have no canonical owner`);
  if (columnAudit.totals.tenant_blocked > 0) reasons.push(`${columnAudit.totals.tenant_blocked} column cell(s) are blocked by tenant isolation`);
  if (columnAudit.tenant.orphan_rows > 0) reasons.push(`${columnAudit.tenant.orphan_rows} legacy row(s) have no client`);
  if (columnAudit.tenant.organization_mismatch_rows > 0) reasons.push(`${columnAudit.tenant.organization_mismatch_rows} profile row(s) disagree with the client organization`);
  if (columnAudit.tenant.owner_org_mismatch_rows > 0) reasons.push(`${columnAudit.tenant.owner_org_mismatch_rows} owner value cell(s) belong to another organization`);
  if (columnAudit.candidates.count > 0) reasons.push(`${columnAudit.candidates.count} Phase 7 backfill candidate(s) remain unapplied`);

  const manifest = {
    phase: 7,
    includes_phase6: true,
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    mode: 'read-only',
    acknowledgement: {
      production_acknowledged: options.acknowledge,
      confirmed_host: options.confirmHost,
    },
    database: {
      host: url.hostname,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      sslmode: url.searchParams.get('sslmode') || 'default',
      role: state.role,
      server_version: state.server_version,
      in_recovery: state.in_recovery,
      transaction_read_only: state.read_only,
      transaction_isolation: state.isolation,
      role_superuser: state.role_superuser,
      role_createrole: state.role_createrole,
      role_bypassrls: state.role_bypassrls,
      tables_present: state.tables_present,
    },
    scripts: {
      analyzer: { file: 'scripts/phase5-reconcile-ownership.js', sha256: sha256(ANALYZER) },
      columnAudit: { file: 'scripts/phase7-legacy-column-audit.js', sha256: sha256(COLUMN_AUDIT) },
      decisions: { file: 'scripts/phase6-decisions.js', sha256: sha256(path.join(__dirname, 'phase6-decisions.js')) },
    },
    report: {
      read_only: report.read_only,
      validation: report.validation,
      totals: report.totals,
      organizations: report.organizations,
    },
    column_audit: {
      read_only: columnAudit.read_only,
      validation: columnAudit.validation,
      tables: columnAudit.tables,
      totals: columnAudit.totals,
      tenant: columnAudit.tenant,
      unmapped_columns: columnAudit.unmapped_columns,
      candidates: columnAudit.candidates,
    },
    decisions: built.summary,
    schema_removal: {
      decision: readyForReview ? 'ELIGIBLE_FOR_REVIEW' : 'NO-GO',
      reasons,
    },
    contains_pii: true,
    artifacts,
  };

  const manifestFile = writeManifest(runDir, manifest);
  const totalConflicts = built.conflicts.length;
  const totalRecords = built.records.length;

  console.log(`Role: ${state.role}${state.in_recovery ? ' (replica)' : ''}`);
  console.log(`Legacy-only: ${report.totals.legacy_only}`);
  console.log(`Conflicting: ${totalConflicts}`);
  console.log(`Total records: ${totalRecords}`);
  console.log(`Column audit cells: ${columnAudit.totals.cells} (${columnAudit.totals.fact_cells} facts)`);
  console.log(`Column audit: ${columnAudit.totals.match} match, ${columnAudit.totals.conflict} conflict, ${columnAudit.totals.legacy_only} legacy-only, ${columnAudit.totals.no_canonical_owner} ownerless`);
  console.log(`Backfill candidates awaiting authorization: ${built.candidates.length + columnAudit.candidates.count} (not applied)`);
  console.log(`Aggregate validation: ${report.validation.ok && columnAudit.validation.ok ? 'ok' : 'FAILED'}`);
  console.log(`Schema removal: ${manifest.schema_removal.decision}`);
  for (const reason of reasons) console.log(`  - ${reason}`);
  console.log(`Artifacts: ${runDir}`);
  console.log(`Manifest: ${manifestFile}`);
}

module.exports = { parseOptions, preflight, isLoopback };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

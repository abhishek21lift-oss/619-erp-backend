'use strict';
// Phase 6 — the guarded production audit, against the real migrated fixture.
//
// This proves the wrapper, not just the Phase 5 analyzer:
//   * the preflight certifies a read-only repeatable-read session;
//   * the report, decision register and 27-candidate packet are complete and
//     internally consistent;
//   * every artifact is written outside the repository with mode 0600 and a
//     verifiable SHA-256 manifest;
//   * the register starts with zero prefilled decisions and the packet says
//     authorization is not granted.
//
// Gated on PHASE4_SHAPE_DATABASE_URL. CI builds that database in
// scripts/phase4-shape-setup.sh and runs this suite with `npm test`.

const DB_URL = process.env.PHASE4_SHAPE_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Phase 6 production audit, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('PHASE4_SHAPE_DATABASE_URL is not set in CI — the Phase 6 audit proof would skip.');
    });
  });
}

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUDIT = path.join(__dirname, '../../scripts/phase6-production-audit.js');
const ORG_A = 'a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4';

const run = (args) => spawnSync(process.execPath, [AUDIT, ...args], {
  encoding: 'utf8',
  env: process.env,
  timeout: 120000,
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function countCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  return { header: lines[0].split(','), rows: lines.slice(1) };
}

describeIf('Phase 6 production audit, against a real database', () => {
  let tmp;
  let outDir;
  let runDir;
  let manifest;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-audit-'));
    outDir = path.join(tmp, 'audit');
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the guarded audit completes read-only and writes a complete manifest', () => {
    const result = run([
      '--url', DB_URL,
      '--confirm-host', new URL(DB_URL).hostname,
      '--acknowledge-production',
      '--org', ORG_A,
      '--out-dir', outDir,
    ]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });

    const runs = fs.readdirSync(outDir).filter((d) => d.startsWith('run-'));
    expect(runs).toHaveLength(1);
    runDir = path.join(outDir, runs[0]);
    manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));

    expect(manifest.mode).toBe('read-only');
    expect(manifest.database.transaction_read_only).toBe('on');
    expect(manifest.database.transaction_isolation).toBe('repeatable read');
    expect(manifest.database.tables_present).toBe(10);
    expect(manifest.report.read_only).toBe(true);
    expect(manifest.report.validation).toEqual({ ok: true, mismatches: [] });
    expect(manifest.report.totals.records).toBe(
      manifest.report.totals.legacy_only + manifest.report.totals.conflicts,
    );
    expect(manifest.decisions.conflicts_in_register).toBe(manifest.report.totals.conflicts);
    expect(manifest.decisions.records_in_register).toBe(manifest.report.totals.records);
    expect(manifest.decisions.backfill_candidates).toBe(manifest.report.totals.auto_candidates);
    expect(manifest.decisions.decisions_prefilled).toBe(0);
    expect(manifest.decisions.authorization).toBe('NOT GRANTED');
    expect(manifest.column_audit.read_only).toBe(true);
    expect(manifest.column_audit.validation.ok).toBe(true);
    expect(manifest.column_audit.tables.map((t) => [t.table, t.expected_columns, t.actual_columns])).toEqual([
      ['pt_os_measurements', 22, 22],
      ['client_fitness_profiles', 17, 17],
    ]);
    expect(manifest.column_audit.totals.fact_cells).toBeGreaterThan(0);
    expect(manifest.column_audit.candidates.prefilled_decisions).toBe(0);
    expect(manifest.column_audit.candidates.authorization).toBe('NOT GRANTED');
    expect(manifest.column_audit.unmapped_columns.map((c) => c.column)).toEqual([
      'assignment_id', 'shoulders_cm', 'photo_front_url', 'photo_side_url',
      'photo_back_url', 'notes', 'measured_by',
    ]);
    expect(manifest.contains_pii).toBe(true);
    expect(manifest.artifacts.map((a) => a.name).sort()).toEqual([
      'backfill-candidates.csv', 'backfill-review.md', 'conflicts.csv',
      'decision-register.md', 'decision-summary.json', 'phase5-plan.json',
      'phase5-report.json', 'phase5-report.md', 'phase5-review.csv',
      'phase7-candidates.csv', 'phase7-records.csv', 'phase7-report.json',
      'phase7-report.md', 'phase7-summary.json', 'records.csv',
    ]);
  });

  test('every artifact is private and its recorded hash matches', () => {
    expect(fs.statSync(runDir).mode & 0o777).toBe(0o700);
    for (const artifact of manifest.artifacts) {
      const file = path.join(runDir, artifact.name);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(artifact.bytes).toBe(fs.statSync(file).size);
      expect(artifact.sha256).toBe(sha256(file));
    }

    const sums = fs.readFileSync(path.join(runDir, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
    for (const line of sums) {
      const [hash, name] = line.split(/\s{2,}/);
      expect(sha256(path.join(runDir, name))).toBe(hash);
    }
  });

  test('the conflict register covers every conflict with a blank decision', () => {
    const { header, rows } = countCsv(path.join(runDir, 'conflicts.csv'));
    expect(rows).toHaveLength(manifest.report.totals.conflicts);
    expect(header.slice(-4)).toEqual(['decision', 'reviewer', 'reviewed_at', 'rationale']);
    for (const row of rows) {
      const cells = row.split(',');
      expect(cells.slice(-4)).toEqual(['', '', '', '']);
    }

    const records = countCsv(path.join(runDir, 'records.csv'));
    expect(records.rows).toHaveLength(manifest.report.totals.records);
  });

  test('the backfill-candidate packet is complete, unapplied and explicitly unauthorised', () => {
    const { rows } = countCsv(path.join(runDir, 'backfill-candidates.csv'));
    expect(rows).toHaveLength(manifest.report.totals.auto_candidates);
    for (const row of rows) {
      const cells = row.split(',');
      expect(cells.slice(-4)).toEqual(['', '', '', '']);
    }

    const packet = fs.readFileSync(path.join(runDir, 'backfill-review.md'), 'utf8');
    expect(packet).toContain('Authorization: NOT GRANTED');
    expect(packet).toContain('have not been applied');
    expect(packet).toContain(`Candidates: **${manifest.report.totals.auto_candidates}**`);

    const register = fs.readFileSync(path.join(runDir, 'decision-register.md'), 'utf8');
    expect(register).toContain('Every conflict below starts with an empty decision');
    expect(register).toContain(`**${manifest.report.totals.conflicts}** conflicts`);
  });

  test('schema removal is NO-GO while legacy-only or conflicting rows remain', () => {
    expect(manifest.report.totals.records).toBeGreaterThan(0);
    expect(manifest.schema_removal.decision).toBe('NO-GO');
    expect(manifest.schema_removal.reasons.length).toBeGreaterThan(0);
  });

  test('a second run gets a fresh directory instead of overwriting the first', () => {
    const result = run([
      '--url', DB_URL,
      '--confirm-host', new URL(DB_URL).hostname,
      '--acknowledge-production',
      '--org', ORG_A,
      '--out-dir', outDir,
    ]);
    expect(result.status).toBe(0);
    const runs = fs.readdirSync(outDir).filter((d) => d.startsWith('run-'));
    expect(runs).toHaveLength(2);
    expect(fs.existsSync(path.join(runDir, 'manifest.json'))).toBe(true);
  });
});

describe('Phase 6 production audit refusals', () => {
  test('refuses to run without the production acknowledgement', () => {
    const result = run([
      '--url', 'postgres://user@db.example.com/prod',
      '--confirm-host', 'db.example.com',
      '--out-dir', path.join(os.tmpdir(), 'phase6-refusal'),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--acknowledge-production');
  });

  test('refuses a host that does not match the URL', () => {
    const result = run([
      '--url', 'postgres://user@db.example.com/prod?sslmode=require',
      '--confirm-host', 'other.example.com',
      '--acknowledge-production',
      '--out-dir', path.join(os.tmpdir(), 'phase6-refusal'),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not match URL host');
  });

  test('refuses plaintext transport to a non-loopback host without explicit consent', () => {
    const result = run([
      '--url', 'postgres://user@db.example.com/prod?sslmode=disable',
      '--confirm-host', 'db.example.com',
      '--acknowledge-production',
      '--out-dir', path.join(os.tmpdir(), 'phase6-refusal'),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('sslmode=disable');
  });

  test('refuses output inside the repository', () => {
    const result = run([
      '--url', 'postgres://user@db.example.com/prod?sslmode=require',
      '--confirm-host', 'db.example.com',
      '--acknowledge-production',
      '--out-dir', path.join(__dirname, '../../audit-output'),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('inside the repository');
  });
});

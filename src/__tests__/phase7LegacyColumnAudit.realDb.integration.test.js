'use strict';
// Phase 7 — column-complete legacy audit against the real migrated fixture.
//
// The Phase 5 report answers D1–D25. This proves the other half: every column
// of both retired tables is accounted for, the tenant join is checked, the
// owner provenance is row-level, and the artifacts are read-only and private.

const DB_URL = process.env.PHASE4_SHAPE_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('Phase 7 column audit, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('PHASE4_SHAPE_DATABASE_URL is not set in CI — the Phase 7 audit proof would skip.');
    });
  });
}

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compareValues, classifyTenant, ownerValue, recommendation, validate, stableValue,
} = require('../../scripts/phase7-legacy-column-audit');

const AUDIT = path.join(__dirname, '../../scripts/phase7-legacy-column-audit.js');
const ORG_A = 'a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4';

const run = (args) => spawnSync(process.execPath, [AUDIT, ...args], {
  encoding: 'utf8',
  env: process.env,
  timeout: 120000,
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const csvRows = (file) => fs.readFileSync(file, 'utf8').trimEnd().split('\n');

describeIf('Phase 7 column audit, against a real database', () => {
  let tmp;
  let outDir;
  let summary;
  let report;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-audit-'));
    outDir = path.join(tmp, 'audit');
    const result = run([
      '--url', DB_URL,
      '--org', ORG_A,
      '--out-dir', outDir,
    ]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    summary = JSON.parse(fs.readFileSync(path.join(outDir, 'phase7-summary.json'), 'utf8'));
    report = JSON.parse(fs.readFileSync(path.join(outDir, 'phase7-report.json'), 'utf8'));
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('certifies a read-only repeatable-read run', () => {
    expect(summary.read_only).toBe(true);
    expect(summary.transaction_read_only).toBe('on');
    expect(summary.transaction_isolation).toBe('repeatable read');
    expect(report.read_only).toBe(true);
  });

  test('audits every column of both retired tables and no unregistered column', () => {
    const tables = Object.fromEntries(report.tables.map((t) => [t.table, t]));
    expect(tables.pt_os_measurements.expected_columns).toBe(22);
    expect(tables.pt_os_measurements.actual_columns).toHaveLength(22);
    expect(tables.client_fitness_profiles.expected_columns).toBe(17);
    expect(tables.client_fitness_profiles.actual_columns).toHaveLength(17);
    expect(report.validation).toEqual({ ok: true, problems: [] });

    for (const table of report.tables) {
      expect(table.coverage).toHaveLength(table.expected_columns);
      expect(table.coverage.map((c) => c.column).sort()).toEqual(
        table.actual_columns.map((c) => c.column_name).sort(),
      );
    }
  });

  test('checks tenant isolation through the client join and the profile organization', () => {
    expect(report.tenant.ok).toBe(true);
    expect(report.tenant.orphan_rows).toBe(0);
    expect(report.tenant.organization_mismatch_rows).toBe(0);
    expect(report.tenant.owner_org_mismatch_rows).toBe(0);
    for (const table of report.tables) {
      expect(table.rows_total).toBeGreaterThan(0);
      expect(table.rows_in_scope).toBeGreaterThan(0);
      expect(table.tenant.ok).toBeGreaterThan(0);
    }
  });

  test('produces one provenance row per populated cell', () => {
    expect(report.totals.cells).toBe(report.totals.fact_cells + report.totals.metadata_cells);
    expect(report.records).toHaveLength(report.totals.cells);
    expect(report.totals.fact_cells).toBeGreaterThan(0);
    for (const record of report.records) {
      expect(record.decision).toBe('');
      expect(record.reviewer).toBe('');
      expect(record.rationale).toBe('');
      if (record.kind === 'fact' && record.status !== 'no_canonical_owner') {
        expect(['match', 'conflict', 'legacy_only', 'tenant_blocked']).toContain(record.status);
        if (record.status !== 'tenant_blocked') expect(record.owner_table).toBeTruthy();
      }
    }
  });

  test('names every populated-ownerless column, even when the fixture has no value', () => {
    expect(report.unmapped_columns.map((c) => c.column)).toEqual([
      'assignment_id', 'shoulders_cm', 'photo_front_url', 'photo_side_url',
      'photo_back_url', 'notes', 'measured_by',
    ]);
    for (const column of report.unmapped_columns) {
      expect(column.rows_with_value).toBe(0);
      expect(column.note).toBeTruthy();
    }
  });

  test('writes a reviewer register with blank decisions and an unapplied candidate packet', () => {
    const records = csvRows(path.join(outDir, 'phase7-records.csv'));
    expect(records).toHaveLength(report.totals.cells + 1);
    expect(records[0]).toContain('decision,reviewer,reviewed_at,rationale');
    for (const row of records.slice(1)) {
      expect(row.endsWith(',,,,')).toBe(true);
    }

    const candidates = csvRows(path.join(outDir, 'phase7-candidates.csv'));
    expect(candidates).toHaveLength(summary.totals.backfill_eligible + 1);
    expect(summary.candidates).toEqual({
      count: summary.totals.backfill_eligible,
      prefilled_decisions: 0,
      authorization: 'NOT GRANTED',
    });
  });

  test('every artifact is private and its summary hash is stable', () => {
    expect(fs.statSync(outDir).mode & 0o777).toBe(0o700);
    for (const name of ['phase7-report.json', 'phase7-report.md', 'phase7-records.csv',
      'phase7-candidates.csv', 'phase7-summary.json']) {
      expect(fs.statSync(path.join(outDir, name)).mode & 0o777).toBe(0o600);
    }
    const first = sha256(path.join(outDir, 'phase7-report.json'));
    const second = sha256(path.join(outDir, 'phase7-report.json'));
    expect(first).toBe(second);
  });

  test('keeps schema removal at NO-GO while populated legacy cells remain', () => {
    expect(summary.schema_removal.decision).toBe('NO-GO');
    expect(summary.schema_removal.reasons.length).toBeGreaterThan(0);
  });
});

describe('Phase 7 column audit helpers', () => {
  test('numeric comparisons use the column tolerance', () => {
    expect(compareValues('7.8', '7.9', { tolerance: 0.25 })).toBe(true);
    expect(compareValues('7.8', '8.1', { tolerance: 0.25 })).toBe(false);
    expect(compareValues('77.00', '77', {})).toBe(true);
  });

  test('date comparisons use the calendar day, not the timestamp', () => {
    expect(compareValues('2026-11-03T22:00:00Z', '2026-11-03', { compare: 'date' })).toBe(true);
    expect(compareValues('2026-11-03T22:00:00Z', '2026-11-04', { compare: 'date' })).toBe(false);
  });

  test('array-to-text comparison is exact and single-element only', () => {
    expect(compareValues('vegetarian', ['vegetarian'], { compare: 'array-text' })).toBe(true);
    expect(compareValues('vegetarian', ['vegetarian', 'vegan'], { compare: 'array-text' })).toBe(false);
    expect(compareValues('vegetarian', ['vegan'], { compare: 'array-text' })).toBe(false);
  });

  test('object comparison ignores key order', () => {
    expect(stableValue({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
    expect(compareValues({ b: 1, a: 2 }, { a: 2, b: 1 }, {})).toBe(true);
  });

  test('tenant classification catches orphans, mismatches and archived clients', () => {
    expect(classifyTenant({}, 'client_fitness_profiles').status).toBe('orphan_client');
    expect(classifyTenant({ __client_id: 'c1' }, 'pt_os_measurements').status)
      .toBe('client_without_organization');
    expect(classifyTenant({
      __client_id: 'c1', __client_org: 'org-a', organization_id: 'org-b',
    }, 'client_fitness_profiles').status).toBe('organization_mismatch');
    expect(classifyTenant({
      __client_id: 'c1', __client_org: 'org-a', __client_deleted: '2026-01-01',
    }, 'pt_os_measurements').status).toBe('client_archived');
    expect(classifyTenant({ __client_id: 'c1', __client_org: 'org-a' }, 'pt_os_measurements').status)
      .toBe('ok');
  });

  test('ownerValue reads a JSON path and treats an empty owner field as absent', () => {
    expect(ownerValue({ past_history: { previous_injuries: 'knee' } }, {
      owner: 'parq.past_history', owner_path: ['previous_injuries'],
    })).toBe('knee');
    expect(ownerValue({ current_health: {} }, {
      owner: 'parq.current_health', empty_is_null: true,
    })).toBeNull();
    expect(ownerValue({ current_health: { asthma: true } }, {
      owner: 'parq.current_health', empty_is_null: true,
    })).toEqual({ asthma: true });
  });

  test('recommendation distinguishes a reviewed candidate from a conflict', () => {
    expect(recommendation('legacy_only', { mapping: 'exact', legacy_sources: 1 }, true))
      .toBe('reviewed_backfill_candidate');
    expect(recommendation('conflict', { mapping: 'exact', legacy_sources: 1 }, false))
      .toBe('manual_review_conflict');
    expect(recommendation('no_canonical_owner', {}, false)).toBe('product_decision_required');
  });

  test('validation rejects an unregistered or missing column', () => {
    const table = {
      table: 'pt_os_measurements',
      rows_in_scope: 0,
      out_of_scope_rows: 0,
      orphan_rows: 0,
      scoped: true,
      rows_total: 0,
      expected_columns: 22,
      actual_columns: [{ column_name: 'id' }, { column_name: 'new_column' }],
      coverage: [],
      records: [],
    };
    const result = validate([table]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('unregistered column(s): new_column');
    expect(result.problems.join(' ')).toContain('missing audited column(s)');
  });
});

describe('Phase 7 column audit refusals', () => {
  test('refuses output inside the repository', () => {
    const result = run([
      '--url', 'postgres://postgres@127.0.0.1:1/placeholder?sslmode=disable',
      '--out-dir', path.join(__dirname, '../../audit-output'),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('inside the repository');
  });

  test('refuses a non-UUID organization filter', () => {
    const result = run([
      '--url', 'postgres://postgres@127.0.0.1:1/placeholder?sslmode=disable',
      '--org', 'org-a',
      '--out-dir', path.join(os.tmpdir(), 'phase7-refusal'),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--org must be a UUID');
  });
});

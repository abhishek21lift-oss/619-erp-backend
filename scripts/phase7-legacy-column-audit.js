#!/usr/bin/env node
'use strict';
// Phase 7 — column-complete read-only audit of the two retired tables.
//
// Phase 5 reconciles the D1–D25 fact registers. It does not cover every
// column: `pt_os_measurements` has 22 columns and `client_fitness_profiles`
// has 17, and a schema cannot be removed until every populated column has a
// named owner or an explicit product decision. This analyzer closes that gap.
//
// For every legacy row and every non-null column it answers:
//   * which tenant does the row belong to, and is that tenant consistent;
//   * what is the canonical owner value, record id and timestamp;
//   * is the value a match, a conflict, legacy-only, or ownerless.
//
// It never writes a database row. The whole run is one `BEGIN TRANSACTION
// READ ONLY ISOLATION LEVEL REPEATABLE READ`. Output goes to a fresh directory
// outside the repository, mode 0700, every file mode 0600.
//
//   node scripts/phase7-legacy-column-audit.js \
//     --url "$DATABASE_URL" --out-dir /secure/audits/phase7 [--org <uuid>]
//
// Exit codes: 0 report written, 1 validation/runtime failure, 2 usage.

const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const OUTPUT_FILES = [
  'phase7-report.json', 'phase7-report.md', 'phase7-records.csv',
  'phase7-candidates.csv', 'phase7-summary.json',
];

/**
 * Every column of both tables, with its canonical owner. A column is either
 * `fact` (it carries client data), `identity` (the row key), `tenant` (the
 * tenancy link) or `metadata` (insert/update bookkeeping). Only a `fact` with
 * an exact one-to-one mapping can ever become a reviewed backfill candidate.
 *
 * `legacy_sources` counts independent legacy copies of the same fact. Two
 * copies means a machine cannot know which one is true, so the row is review
 * only. This is the same "exactly one legacy source" rule as Phase 5.
 */
const fact = (name, owner, mapping, options = {}) => ({
  name, kind: 'fact', owner, mapping, legacy_sources: 1, ...options,
});

const TABLES = {
  pt_os_measurements: {
    tenant: 'client_join',
    note: 'No organization_id. Tenant scope is the pt_clients join; an orphan client is a tenant blocker.',
    columns: [
      { name: 'id', kind: 'identity' },
      { name: 'client_id', kind: 'tenant' },
      fact('assignment_id', null, 'unmapped', {
        note: 'No workout_assignments table exists in this schema; the link cannot be resolved.',
      }),
      fact('weight_kg', 'assessment.weight', 'exact', {
        legacy_sources: 2, note: 'pt_clients.weight is the second legacy copy.',
      }),
      fact('body_fat_pct', 'assessment.body_fat_pct', 'exact', {
        legacy_sources: 2, note: 'pt_clients.body_fat is the second legacy copy.',
      }),
      fact('chest_cm', 'assessment.chest_cm', 'exact'),
      fact('waist_cm', 'assessment.waist_cm', 'exact'),
      fact('arms_cm', 'assessment.arm_left_cm', 'ambiguous', {
        note: 'The owner stores left and right arms separately; a single value cannot be mapped mechanically.',
      }),
      fact('thighs_cm', 'assessment.thigh_left_cm', 'ambiguous', {
        note: 'The owner stores left and right thighs separately; a single value cannot be mapped mechanically.',
      }),
      fact('calves_cm', 'assessment.calf_left_cm', 'ambiguous', {
        note: 'The owner stores left and right calves separately; a single value cannot be mapped mechanically.',
      }),
      fact('shoulders_cm', null, 'unmapped', {
        note: 'No shoulder measurement column exists in the canonical owner tables.',
      }),
      fact('neck_cm', 'assessment.neck_cm', 'exact'),
      fact('hip_cm', 'assessment.hips_cm', 'renamed'),
      fact('bmi', 'assessment.bmi', 'exact'),
      fact('bmr', 'assessment.bmr', 'exact'),
      fact('photo_front_url', null, 'unmapped', {
        note: 'Fitness Testing stores scores, not progress photos. A photo store decision is required before removal.',
      }),
      fact('photo_side_url', null, 'unmapped', {
        note: 'Fitness Testing stores scores, not progress photos. A photo store decision is required before removal.',
      }),
      fact('photo_back_url', null, 'unmapped', {
        note: 'Fitness Testing stores scores, not progress photos. A photo store decision is required before removal.',
      }),
      fact('notes', null, 'unmapped', {
        note: 'Three candidate note columns exist (posture_notes, health_notes, trainer_notes); none is a field-level owner.',
      }),
      fact('measured_by', null, 'unmapped', {
        note: 'trainer_id and created_by mean different things; no field-level owner.',
      }),
      fact('measured_at', 'assessment.assessment_date', 'renamed', {
        compare: 'date', note: 'Assessment date is a date, measured_at is a timestamp; only the calendar day is comparable.',
      }),
      { name: 'created_at', kind: 'metadata' },
    ],
  },
  client_fitness_profiles: {
    tenant: 'own_organization_id',
    note: 'Has organization_id. It must equal the client organization; a mismatch is a tenant blocker.',
    columns: [
      { name: 'id', kind: 'identity' },
      { name: 'client_id', kind: 'tenant' },
      fact('goal', 'goal.goal_type', 'ambiguous', {
        legacy_sources: 2, note: 'pt_clients.goal is the second copy and the vocabularies differ.',
      }),
      fact('goal_other', 'goal.goal_other', 'exact'),
      fact('height_cm', 'assessment.height_cm', 'exact', {
        legacy_sources: 2, note: 'pt_clients.height is the second legacy copy.',
      }),
      fact('body_fat_pct', 'assessment.body_fat_pct', 'exact', {
        legacy_sources: 2, note: 'pt_clients.body_fat is the second legacy copy.',
      }),
      fact('health_conditions', 'parq.current_health', 'structured', {
        legacy_sources: 3, empty_is_null: true,
        note: 'Free text/array cannot be promoted into the structured PAR-Q without a reviewer.',
      }),
      fact('injuries', 'parq.past_history', 'ambiguous', {
        legacy_sources: 2, owner_path: ['previous_injuries'],
        note: 'PAR-Q history and the interview narrative are different facts with different dates.',
      }),
      fact('emergency_contact', 'parq.emergency_contact', 'renamed', {
        legacy_sources: 2, note: 'The PAR-Q/consent snapshot is a historical attestation, not a merge target.',
      }),
      fact('emergency_phone', 'parq.emergency_phone', 'renamed', {
        legacy_sources: 2, note: 'The PAR-Q/consent snapshot is a historical attestation, not a merge target.',
      }),
      fact('fitness_level', 'client.workout_experience_level', 'ambiguous', {
        legacy_sources: 3, note: 'Enrolment, Lifestyle and the profile use different vocabularies.',
      }),
      fact('sleep_hours', 'lifestyle.sleep_duration_hours', 'exact', {
        legacy_sources: 2, tolerance: 0.25, note: 'Interview sleep hours is the second copy.',
      }),
      fact('stress_level', 'lifestyle.stress_level', 'exact'),
      fact('diet_preference', 'nutrition.diet_preferences', 'ambiguous', {
        legacy_sources: 2, compare: 'array-text',
        note: 'Nutrition stores an array; Lifestyle food_preferences is the second copy.',
      }),
      { name: 'created_at', kind: 'metadata' },
      { name: 'updated_at', kind: 'metadata' },
      { name: 'organization_id', kind: 'tenant' },
    ],
  },
};

const SOURCE_TABLE = {
  assessment: 'pt_assessments',
  goal: 'pt_goals',
  parq: 'pt_parq_forms',
  lifestyle: 'pt_lifestyle_assessments',
  nutrition: 'pt_nutrition_assessments',
  client: 'pt_clients',
};

const OWNER_SQL = {
  assessment: `SELECT DISTINCT ON (client_id) id, client_id, organization_id,
                     assessment_date, created_at,
                     weight, height_cm, body_fat_pct, chest_cm, waist_cm, hips_cm,
                     neck_cm, bmi, bmr, arm_left_cm, arm_right_cm, thigh_left_cm,
                     thigh_right_cm, calf_left_cm, calf_right_cm
                FROM pt_assessments
               WHERE client_id = ANY($1::text[])
               ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
  goal: `SELECT DISTINCT ON (client_id) id, client_id, organization_id, goal_type,
                goal_other, motivation_level, created_at
           FROM pt_goals
          WHERE client_id = ANY($1::text[]) AND is_active = TRUE
          ORDER BY client_id, created_at DESC`,
  parq: `SELECT DISTINCT ON (client_id) id, client_id, organization_id, current_health,
                past_history, emergency_contact, emergency_phone, assessment_date, created_at
           FROM pt_parq_forms
          WHERE client_id = ANY($1::text[]) AND deleted_at IS NULL
          ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
  lifestyle: `SELECT DISTINCT ON (client_id) id, client_id, organization_id,
                     sleep_duration_hours, stress_level, occupation_type,
                     workout_experience_level, assessment_date, created_at
                FROM pt_lifestyle_assessments
               WHERE client_id = ANY($1::text[])
               ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
  nutrition: `SELECT DISTINCT ON (client_id) id, client_id, organization_id,
                     diet_preferences, medical_conditions, assessment_date, created_at
                FROM pt_nutrition_assessments
               WHERE client_id = ANY($1::text[])
               ORDER BY client_id, assessment_date DESC NULLS LAST, created_at DESC`,
};

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function parseOptions(argv = process.argv.slice(2)) {
  const url = arg(argv, 'url') || process.env.PHASE7_DATABASE_URL;
  const outDir = arg(argv, 'out-dir');
  const org = arg(argv, 'org');
  if (!url || !outDir) {
    throw new Error('Usage: --url <database> --out-dir <dir> [--org <uuid>]');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('--url is not a valid PostgreSQL connection URL.');
  }
  if (org && !isUuid(org)) {
    throw new Error('--org must be a UUID.');
  }
  const resolvedOut = path.resolve(outDir);
  if (resolvedOut === REPO || resolvedOut.startsWith(REPO + path.sep)) {
    throw new Error(`Refusing to write audit output inside the repository (${resolvedOut}).`);
  }
  return {
    url, outDir: resolvedOut, org, host: parsed.hostname,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function stableValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function compareValues(legacy, owner, column) {
  if (legacy === null || legacy === undefined || owner === null || owner === undefined) return false;

  if (column.compare === 'date') {
    return toIso(legacy).slice(0, 10) === toIso(owner).slice(0, 10);
  }
  if (column.compare === 'array-text') {
    const list = Array.isArray(owner) ? owner : [owner];
    return list.length === 1 && String(list[0]) === String(legacy);
  }
  if (Array.isArray(legacy) || Array.isArray(owner)
      || typeof legacy === 'object' || typeof owner === 'object') {
    return JSON.stringify(stableValue(legacy)) === JSON.stringify(stableValue(owner));
  }

  const legacyNumber = Number(legacy);
  const ownerNumber = Number(owner);
  const numeric = String(legacy).trim() !== '' && String(owner).trim() !== ''
    && Number.isFinite(legacyNumber) && Number.isFinite(ownerNumber);
  if (numeric) {
    return Math.abs(legacyNumber - ownerNumber) <= (column.tolerance || 0);
  }
  return String(legacy) === String(owner);
}

function ownerValue(ownerRow, column) {
  if (!ownerRow) return null;
  let value = ownerRow[column.owner.split('.')[1]];
  for (const key of column.owner_path || []) value = value == null ? null : value[key];
  if (column.empty_is_null && isEmpty(value)) return null;
  return value === undefined ? null : value;
}

function ownerRecordedAt(ownerRow) {
  if (!ownerRow) return null;
  return toIso(ownerRow.assessment_date || ownerRow.created_at || ownerRow.updated_at || null);
}

function classifyTenant(row, tableName) {
  const clientOrg = row.__client_org || null;
  const ownOrg = tableName === 'client_fitness_profiles' ? row.organization_id : null;
  if (!row.__client_id) return { status: 'orphan_client', organization_id: ownOrg || null, client_organization_id: null };
  if (!clientOrg) return { status: 'client_without_organization', organization_id: ownOrg || null, client_organization_id: null };
  if (ownOrg && String(ownOrg) !== String(clientOrg)) {
    return { status: 'organization_mismatch', organization_id: String(ownOrg), client_organization_id: String(clientOrg) };
  }
  if (row.__client_deleted) {
    return { status: 'client_archived', organization_id: String(ownOrg || clientOrg), client_organization_id: String(clientOrg) };
  }
  return { status: 'ok', organization_id: String(ownOrg || clientOrg), client_organization_id: String(clientOrg) };
}

function recommendation(status, column, eligible) {
  if (status === 'metadata') return 'no_action_metadata';
  if (status === 'no_canonical_owner') return 'product_decision_required';
  if (status === 'tenant_blocked') return 'blocked_tenant_isolation';
  if (status === 'match') return 'no_action_match';
  if (status === 'conflict') return 'manual_review_conflict';
  return eligible ? 'reviewed_backfill_candidate' : 'manual_review_legacy_only';
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(stableValue(value)) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((key) => csvCell(row[key])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function introspect(db) {
  const out = {};
  for (const tableName of Object.keys(TABLES)) {
    const { rows } = await db.query(
      `SELECT column_name, data_type, is_nullable, ordinal_position
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [tableName],
    );
    out[tableName] = rows;
  }
  return out;
}

async function loadOwners(db, clientIds) {
  if (!clientIds.length) return {};
  const owners = {};
  for (const [source, sql] of Object.entries(OWNER_SQL)) {
    const { rows } = await db.query(sql, [clientIds]);
    owners[source] = new Map(rows.map((row) => [String(row.client_id), row]));
  }
  return owners;
}

async function countRows(db, tableName, org) {
  const scoped = org
    ? await db.query(
      `SELECT count(*)::int AS n FROM ${tableName} l
         JOIN pt_clients c ON c.id = l.client_id
        WHERE c.organization_id = $1`,
      [org],
    )
    : { rows: [{ n: null }] };
  const outOfScope = org
    ? await db.query(
      `SELECT count(*)::int AS n FROM ${tableName} l
         JOIN pt_clients c ON c.id = l.client_id
        WHERE c.organization_id IS DISTINCT FROM $1`,
      [org],
    )
    : { rows: [{ n: 0 }] };
  const orphan = await db.query(
    `SELECT count(*)::int AS n FROM ${tableName} l
      WHERE NOT EXISTS (SELECT 1 FROM pt_clients c WHERE c.id = l.client_id)`,
  );
  return {
    in_scope: scoped.rows[0].n,
    out_of_scope: outOfScope.rows[0].n,
    orphan: orphan.rows[0].n,
  };
}

async function auditTable(db, tableName, spec, options) {
  const selected = options.org
    ? `WHERE c.organization_id = $1`
    : '';
  const params = options.org ? [options.org] : [];
  const { rows } = await db.query(
    `SELECT l.*,
            c.id AS __client_id,
            c.name AS __client_name,
            c.organization_id AS __client_org,
            c.deleted_at AS __client_deleted,
            c.workout_experience_level AS __client_workout_experience_level,
            c.updated_at AS __client_updated_at
       FROM ${tableName} l
       LEFT JOIN pt_clients c ON c.id = l.client_id
       ${selected}
      ORDER BY l.id`,
    params,
  );

  const clientIds = [...new Set(rows.map((row) => row.__client_id).filter(Boolean).map(String))];
  const owners = await loadOwners(db, clientIds);
  const counts = await countRows(db, tableName, options.org);

  const clientOwner = new Map(rows.filter((row) => row.__client_id).map((row) => [String(row.__client_id), {
    id: row.__client_id,
    organization_id: row.__client_org,
    workout_experience_level: row.__client_workout_experience_level,
    updated_at: row.__client_updated_at,
  }]));
  owners.client = clientOwner;

  const coverage = spec.columns.map((column) => ({
    legacy_table: tableName,
    column: column.name,
    kind: column.kind,
    owner: column.owner || null,
    mapping: column.mapping || null,
    legacy_sources: column.legacy_sources || null,
    rows_with_value: 0,
    match: 0,
    conflict: 0,
    legacy_only: 0,
    no_canonical_owner: 0,
    tenant_blocked: 0,
    metadata: 0,
    backfill_eligible: 0,
  }));
  const byColumn = new Map(coverage.map((entry) => [entry.column, entry]));
  const records = [];
  const tenantCounts = { ok: 0, orphan_client: 0, client_without_organization: 0, organization_mismatch: 0, client_archived: 0 };
  let ownerOrgMismatch = 0;

  for (const row of rows) {
    const tenant = classifyTenant(row, tableName);
    tenantCounts[tenant.status] = (tenantCounts[tenant.status] || 0) + 1;
    const clientOrg = tenant.client_organization_id;

    for (const column of spec.columns) {
      const value = row[column.name];
      if (value === null || value === undefined) continue;
      const entry = byColumn.get(column.name);
      entry.rows_with_value += 1;

      let status = null;
      let owner = null;
      let ownerField = null;
      let eligible = false;
      let tenantBlocked = false;
      const [source] = column.owner ? column.owner.split('.') : [null];

      if (column.kind !== 'fact') {
        status = 'metadata';
        entry.metadata += 1;
      } else if (!column.owner) {
        status = 'no_canonical_owner';
        entry.no_canonical_owner += 1;
      } else {
        owner = owners[source] ? owners[source].get(String(row.client_id)) || null : null;
        if (owner && owner.organization_id && clientOrg
            && String(owner.organization_id) !== String(clientOrg)) {
          ownerOrgMismatch += 1;
          owner = null;
          tenantBlocked = true;
        }
        if (tenantBlocked) {
          status = 'tenant_blocked';
          entry.tenant_blocked += 1;
        } else if (!owner) {
          status = 'legacy_only';
          entry.legacy_only += 1;
        } else {
          ownerField = ownerValue(owner, column);
          if (ownerField === null) {
            status = 'legacy_only';
            entry.legacy_only += 1;
            eligible = column.mapping === 'exact' && column.legacy_sources === 1;
          } else if (compareValues(value, ownerField, column)) {
            status = 'match';
            entry.match += 1;
          } else {
            status = 'conflict';
            entry.conflict += 1;
          }
        }
      }

      if (eligible) entry.backfill_eligible += 1;
      records.push({
        phase7_id: `${tableName}:${row.id}:${column.name}`,
        legacy_table: tableName,
        legacy_record_id: row.id,
        client_id: row.client_id,
        client_name: row.__client_name || null,
        organization_id: tenant.organization_id,
        client_organization_id: tenant.client_organization_id,
        tenant_status: tenant.status,
        column: column.name,
        kind: column.kind,
        mapping: column.mapping || null,
        legacy_sources: column.legacy_sources || null,
        owner_table: source ? SOURCE_TABLE[source] : null,
        owner_column: column.owner ? column.owner.split('.')[1] : null,
        owner_record_id: owner ? owner.id : null,
        owner_recorded_at: ownerRecordedAt(owner),
        owner_value: ownerField,
        legacy_value: value,
        legacy_recorded_at: toIso(row.measured_at || row.updated_at || row.created_at || null),
        status,
        backfill_eligible: eligible,
        recommended_action: recommendation(status, column, eligible),
        decision: '',
        reviewer: '',
        reviewed_at: '',
        rationale: '',
      });
    }
  }

  return {
    table: tableName,
    note: spec.note,
    actual_columns: spec.actual_columns,
    expected_columns: spec.columns.length,
    rows_total: rows.length + counts.out_of_scope + (options.org ? counts.orphan : 0),
    rows_in_scope: rows.length,
    scoped: Boolean(options.org),
    out_of_scope_rows: counts.out_of_scope,
    orphan_rows: counts.orphan,
    tenant: tenantCounts,
    owner_org_mismatch: ownerOrgMismatch,
    coverage,
    records,
  };
}

function validate(tables) {
  const problems = [];
  const totals = {
    rows: 0, cells: 0, fact_cells: 0, metadata_cells: 0, match: 0, conflict: 0,
    legacy_only: 0, no_canonical_owner: 0, tenant_blocked: 0, backfill_eligible: 0,
  };
  for (const table of tables) {
    const expected = TABLES[table.table].columns.map((c) => c.name).sort();
    const actual = (table.actual_columns || []).map((c) => c.column_name).sort();
    const missing = expected.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !expected.includes(name));
    if (missing.length) problems.push(`${table.table}: missing audited column(s): ${missing.join(', ')}`);
    if (extra.length) problems.push(`${table.table}: unregistered column(s): ${extra.join(', ')}`);
    if (table.coverage.length !== expected.length) {
      problems.push(`${table.table}: coverage ${table.coverage.length} != catalog ${expected.length}`);
    }
    const rowsTotal = table.rows_in_scope + table.out_of_scope_rows
      + (table.scoped ? table.orphan_rows : 0);
    if (rowsTotal !== table.rows_total) {
      problems.push(`${table.table}: in-scope ${table.rows_in_scope} + out-of-scope ${table.out_of_scope_rows} + orphan ${table.scoped ? table.orphan_rows : 0} != total ${table.rows_total}`);
    }
    for (const entry of table.coverage) {
      const sum = entry.match + entry.conflict + entry.legacy_only
        + entry.no_canonical_owner + entry.tenant_blocked;
      if (entry.kind === 'fact' && sum !== entry.rows_with_value) {
        problems.push(`${table.table}.${entry.column}: status sum ${sum} != populated ${entry.rows_with_value}`);
      }
    }
    const tableCells = table.coverage.reduce((n, c) => n + c.rows_with_value, 0);
    const tableRecords = table.records.length;
    if (tableCells !== tableRecords) {
      problems.push(`${table.table}: populated cells ${tableCells} != detail rows ${tableRecords}`);
    }
    totals.rows += table.rows_total;
    totals.cells += tableCells;
    totals.fact_cells += table.coverage.filter((c) => c.kind === 'fact')
      .reduce((n, c) => n + c.rows_with_value, 0);
    totals.metadata_cells += table.coverage.filter((c) => c.kind !== 'fact')
      .reduce((n, c) => n + c.rows_with_value, 0);
    for (const entry of table.coverage) {
      totals.match += entry.match;
      totals.conflict += entry.conflict;
      totals.legacy_only += entry.legacy_only;
      totals.no_canonical_owner += entry.no_canonical_owner;
      totals.tenant_blocked += entry.tenant_blocked;
      totals.backfill_eligible += entry.backfill_eligible;
    }
  }
  return { ok: problems.length === 0, problems, totals };
}

function writeReportMd(file, report) {
  const lines = [];
  lines.push('# Phase 7 — column-complete legacy audit');
  lines.push('');
  lines.push(`Database: \`${report.database}\``);
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Organizations: ${report.organizations.length ? report.organizations.join(', ') : 'all'}`);
  lines.push(`Read-only: ${report.read_only} (${report.transaction_isolation})`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|---|---:|');
  lines.push(`| Legacy rows | ${report.totals.rows} |`);
  lines.push(`| Populated cells audited | ${report.totals.cells} |`);
  lines.push(`| Fact cells audited | ${report.totals.fact_cells} |`);
  lines.push(`| Metadata cells | ${report.totals.metadata_cells} |`);
  lines.push(`| Match | ${report.totals.match} |`);
  lines.push(`| Conflict | ${report.totals.conflict} |`);
  lines.push(`| Legacy-only | ${report.totals.legacy_only} |`);
  lines.push(`| No canonical owner | ${report.totals.no_canonical_owner} |`);
  lines.push(`| Tenant-blocked | ${report.totals.tenant_blocked} |`);
  lines.push(`| Reviewed-backfill eligible | ${report.totals.backfill_eligible} |`);
  lines.push('');
  lines.push('## Tenant isolation');
  lines.push('');
  lines.push('| Table | Rows in scope | Out of scope | Orphan client | Org mismatch | Missing org | Owner org mismatch | Archived client |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const table of report.tables) {
    lines.push(`| ${table.table} | ${table.rows_in_scope} | ${table.out_of_scope_rows} | ${table.orphan_rows} | ${table.tenant.organization_mismatch || 0} | ${table.tenant.client_without_organization || 0} | ${table.owner_org_mismatch} | ${table.tenant.client_archived || 0} |`);
  }
  lines.push('');
  lines.push('`pt_os_measurements` has no `organization_id`; its tenant is the `pt_clients` join. `client_fitness_profiles.organization_id` must equal the client organization. An owner row from another organization is never used.');
  lines.push('');
  lines.push('## Column coverage');
  lines.push('');
  for (const table of report.tables) {
    lines.push(`### ${table.table} (${table.expected_columns} columns)`);
    lines.push('');
    lines.push('| Column | Kind | Owner | Mapping | Sources | Populated | Match | Conflict | Legacy-only | No owner | Tenant-blocked | Eligible |');
    lines.push('|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const c of table.coverage) {
      lines.push(`| ${c.column} | ${c.kind} | ${c.owner || '—'} | ${c.mapping || '—'} | ${c.legacy_sources ?? '—'} | ${c.rows_with_value} | ${c.match} | ${c.conflict} | ${c.legacy_only} | ${c.no_canonical_owner} | ${c.tenant_blocked} | ${c.backfill_eligible} |`);
    }
    lines.push('');
  }
  lines.push('## Columns with no canonical owner');
  lines.push('');
  if (!report.unmapped_columns.length) {
    lines.push('None.');
  } else {
    lines.push('| Table | Column | Populated rows | Why it needs a product decision |');
    lines.push('|---|---|---:|---|');
    for (const c of report.unmapped_columns) lines.push(`| ${c.legacy_table} | ${c.column} | ${c.rows_with_value} | ${c.note || ''} |`);
  }
  lines.push('');
  lines.push('A populated ownerless column is a schema-removal blocker: the data has nowhere canonical to go.');
  lines.push('');
  lines.push('## Decision policy');
  lines.push('');
  lines.push('- Every detail row starts with an empty `decision`, `reviewer`, `reviewed_at` and `rationale`.');
  lines.push('- A conflict is never auto-overwritten.');
  lines.push('- A backfill candidate requires an existing owner row, a NULL owner field, an exact mapping and exactly one legacy source.');
  lines.push('- A blank decision is not consent. Any unresolved conflict, legacy-only fact or ownerless populated column keeps schema removal at NO-GO.');
  lines.push('');
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function main() {
  let options;
  try {
    options = parseOptions();
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const db = new Client({
    connectionString: options.url,
    application_name: 'phase7-legacy-column-audit',
  });
  await db.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
    await db.query("SET LOCAL statement_timeout = '120s'");
    const { rows: [state] } = await db.query(
      `SELECT current_setting('transaction_read_only') AS read_only,
              current_setting('transaction_isolation') AS isolation,
              current_user AS role,
              current_database() AS database`,
    );
    if (state.read_only !== 'on' || state.isolation !== 'repeatable read') {
      throw new Error(`Refusing to audit: session is ${state.read_only}/${state.isolation}, not read-only/repeatable-read.`);
    }

    const schema = await introspect(db);
    for (const [tableName, columns] of Object.entries(schema)) {
      if (!columns.length) throw new Error(`Refusing to audit: table ${tableName} does not exist.`);
    }
    for (const [tableName, spec] of Object.entries(TABLES)) {
      spec.actual_columns = schema[tableName];
    }

    const organizations = options.org
      ? [options.org]
      : (await db.query(
        'SELECT DISTINCT organization_id AS id FROM pt_clients WHERE organization_id IS NOT NULL ORDER BY 1',
      )).rows.map((row) => row.id);

    const tables = [];
    for (const [tableName, spec] of Object.entries(TABLES)) {
      if (process.env.PHASE7_AUDIT_VERBOSE) console.error(`audit ${tableName}...`);
      tables.push(await auditTable(db, tableName, spec, { ...options, organizations }));
    }
    await db.query('ROLLBACK');

    const validation = validate(tables);
    const unmapped = tables.flatMap((table) => table.coverage
      .filter((c) => c.kind === 'fact' && !c.owner)
      .map((c) => ({
        legacy_table: table.table,
        column: c.column,
        rows_with_value: c.rows_with_value,
        note: TABLES[table.table].columns.find((x) => x.name === c.column).note,
      })));
    const candidates = tables.flatMap((table) => table.records.filter((r) => r.backfill_eligible));
    const tenant = {
      ok: tables.every((t) => (t.tenant.organization_mismatch || 0) === 0
        && (t.tenant.client_without_organization || 0) === 0
        && t.orphan_rows === 0 && t.owner_org_mismatch === 0),
      orphan_rows: tables.reduce((n, t) => n + t.orphan_rows, 0),
      organization_mismatch_rows: tables.reduce((n, t) => n + (t.tenant.organization_mismatch || 0), 0),
      client_without_organization_rows: tables.reduce((n, t) => n + (t.tenant.client_without_organization || 0), 0),
      owner_org_mismatch_rows: tables.reduce((n, t) => n + t.owner_org_mismatch, 0),
    };

    const report = {
      phase: 7,
      generated_at: new Date().toISOString(),
      database: `${options.host}/${options.database}`,
      organizations,
      read_only: true,
      transaction_read_only: state.read_only,
      transaction_isolation: state.isolation,
      role: state.role,
      mapping: Object.fromEntries(Object.entries(TABLES).map(([name, spec]) => [name, spec.note])),
      tables: tables.map((t) => ({ ...t, records: undefined })),
      totals: validation.totals,
      tenant,
      unmapped_columns: unmapped,
      validation: { ok: validation.ok, problems: validation.problems },
      records: tables.flatMap((t) => t.records),
    };

    const reasons = [];
    if (!validation.ok) reasons.push('the audit did not validate');
    if (report.totals.legacy_only > 0) reasons.push(`${report.totals.legacy_only} populated fact cell(s) exist only in a retired table`);
    if (report.totals.conflict > 0) reasons.push(`${report.totals.conflict} fact cell(s) conflict with the canonical owner`);
    if (report.totals.no_canonical_owner > 0) reasons.push(`${report.totals.no_canonical_owner} populated cell(s) have no canonical owner`);
    if (report.totals.tenant_blocked > 0) reasons.push(`${report.totals.tenant_blocked} cell(s) are blocked by tenant isolation`);
    if (tenant.orphan_rows > 0) reasons.push(`${tenant.orphan_rows} legacy row(s) have no client`);
    if (tenant.organization_mismatch_rows > 0) reasons.push(`${tenant.organization_mismatch_rows} profile row(s) disagree with the client organization`);
    if (tenant.owner_org_mismatch_rows > 0) reasons.push(`${tenant.owner_org_mismatch_rows} owner row(s) belong to another organization`);
    if (candidates.length > 0) reasons.push(`${candidates.length} reviewed-backfill candidate(s) remain unapplied`);

    const summary = {
      phase: 7,
      generated_at: report.generated_at,
      database: report.database,
      read_only: true,
      transaction_read_only: state.read_only,
      transaction_isolation: state.isolation,
      tables: report.tables.map((t) => ({
        table: t.table,
        expected_columns: t.expected_columns,
        actual_columns: t.actual_columns.length,
        rows_total: t.rows_total,
        rows_in_scope: t.rows_in_scope,
        out_of_scope_rows: t.out_of_scope_rows,
        orphan_rows: t.orphan_rows,
        tenant: t.tenant,
        owner_org_mismatch: t.owner_org_mismatch,
      })),
      totals: report.totals,
      tenant,
      unmapped_columns: unmapped,
      validation: report.validation,
      candidates: { count: candidates.length, prefilled_decisions: 0, authorization: 'NOT GRANTED' },
      schema_removal: {
        decision: reasons.length ? 'NO-GO' : 'ELIGIBLE_FOR_REVIEW',
        reasons,
      },
    };

    fs.mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(options.outDir, 0o700);
    const jsonFile = path.join(options.outDir, 'phase7-report.json');
    fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), { mode: 0o600 });
    const mdFile = path.join(options.outDir, 'phase7-report.md');
    writeReportMd(mdFile, report);
    writeCsv(
      path.join(options.outDir, 'phase7-records.csv'),
      ['phase7_id', 'legacy_table', 'legacy_record_id', 'client_id', 'client_name',
        'organization_id', 'client_organization_id', 'tenant_status', 'column', 'kind',
        'mapping', 'legacy_sources', 'owner_table', 'owner_column', 'owner_record_id',
        'owner_recorded_at', 'owner_value', 'legacy_value', 'legacy_recorded_at', 'status',
        'backfill_eligible', 'recommended_action', 'decision', 'reviewer', 'reviewed_at', 'rationale'],
      report.records,
    );
    writeCsv(
      path.join(options.outDir, 'phase7-candidates.csv'),
      ['legacy_table', 'legacy_record_id', 'client_id', 'client_name', 'organization_id',
        'column', 'owner_table', 'owner_record_id', 'owner_column', 'owner_value',
        'legacy_value', 'mapping', 'legacy_sources', 'recommended_action',
        'decision', 'reviewer', 'reviewed_at', 'rationale'],
      candidates,
    );
    const summaryFile = path.join(options.outDir, 'phase7-summary.json');
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), { mode: 0o600 });
    fs.chmodSync(summaryFile, 0o600);

    const hashes = Object.fromEntries(OUTPUT_FILES.map((name) => [name, sha256(path.join(options.outDir, name))]));
    console.log([
      '# Phase 7 legacy column audit',
      `Database: ${report.database}`,
      `Rows: ${report.totals.rows}`,
      `Populated cells: ${report.totals.cells} (${report.totals.fact_cells} facts)`,
      `Match: ${report.totals.match}`,
      `Conflict: ${report.totals.conflict}`,
      `Legacy-only: ${report.totals.legacy_only}`,
      `No canonical owner: ${report.totals.no_canonical_owner}`,
      `Tenant-blocked: ${report.totals.tenant_blocked}`,
      `Backfill candidates: ${candidates.length} (not applied)`,
      `Validation: ${validation.ok ? 'ok' : 'FAILED'}`,
      `Schema removal: ${summary.schema_removal.decision}`,
      `Output: ${options.outDir}`,
      `SHA-256: ${JSON.stringify(hashes)}`,
    ].join('\n'));

    if (!validation.ok) process.exitCode = 1;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await db.end().catch(() => {});
  }
}

module.exports = {
  TABLES, OWNER_SQL, parseOptions, compareValues, classifyTenant, ownerValue,
  recommendation, validate, stableValue,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

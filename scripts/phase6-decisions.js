#!/usr/bin/env node
'use strict';
// Phase 6 — turn a Phase 5 field-level report into a reviewable decision register.
//
// The report lists every legacy-only and conflicting record. This script adds
// the one thing a reviewer needs and a machine must never invent: a decision
// column that starts empty, plus the policy that constrains what a legal
// decision is.
//
// It writes no database row and never marks a candidate approved. The 27
// backfill candidates are rendered as a review packet with
// `authorization: NOT GRANTED`. A reviewer who wants one applied has to edit
// the plan and run the Phase 5 apply workflow with its sha256 and their name —
// this register cannot do it.
//
//   node scripts/phase6-decisions.js --report report.json --plan plan.json \
//        --out-dir /secure/phase6
//
// Exit codes: 0 register written, 1 report/plan inconsistency, 2 usage.

const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((h) => csvCell(row[h])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function allRecords(report) {
  return report.checks.flatMap((check) => (check.records || []).map((record) => ({
    ...record,
    field: check.field,
    owner: check.owner,
    copies: check.copies,
  })));
}

/**
 * Build the register and reject any report whose own totals do not add up.
 * A reviewer reading 628 rows must be able to trust that 628 is the whole set.
 */
function buildRegister(report, plan) {
  const records = allRecords(report);
  const conflicts = records.filter((r) => r.status === 'conflict');
  const legacyOnly = records.filter((r) => r.status === 'legacy_only');
  const candidates = plan && Array.isArray(plan.candidates) ? plan.candidates : [];

  const problems = [];
  if (!report.totals) problems.push('report has no totals');
  if (records.length !== report.totals?.records) {
    problems.push(`detail records ${records.length} != reported total ${report.totals?.records}`);
  }
  if (legacyOnly.length !== report.totals?.legacy_only) {
    problems.push(`legacy-only rows ${legacyOnly.length} != reported ${report.totals?.legacy_only}`);
  }
  if (conflicts.length !== report.totals?.conflicts) {
    problems.push(`conflict rows ${conflicts.length} != reported ${report.totals?.conflicts}`);
  }
  if (report.totals && candidates.length !== report.totals.auto_candidates) {
    problems.push(`plan candidates ${candidates.length} != reported ${report.totals.auto_candidates}`);
  }
  for (const candidate of candidates) {
    const owner = records.find((r) => r.plan_id === candidate.plan_id);
    if (!owner) problems.push(`plan candidate ${candidate.plan_id} is not in the report`);
    else if (owner.status !== 'legacy_only') problems.push(`plan candidate ${candidate.plan_id} is not legacy-only`);
    else if (!owner.backfill) problems.push(`plan candidate ${candidate.plan_id} has no backfill proposal`);
    if (candidate.decision) problems.push(`plan candidate ${candidate.plan_id} already has a decision`);
  }
  if (problems.length) throw new Error(`Decision register refused:\n  ${problems.join('\n  ')}`);

  const byCheck = report.checks.map((check) => ({
    id: check.id,
    field: check.field,
    owner: check.owner,
    legacy_only: check.counts.legacy_only,
    conflicts: check.counts.conflicts,
    recommended: (check.records || []).reduce((acc, r) => {
      acc[r.recommended_action] = (acc[r.recommended_action] || 0) + 1;
      return acc;
    }, {}),
  }));

  return { records, conflicts, legacyOnly, candidates, byCheck };
}

const DECISION_COLUMNS = [
  'check_id', 'field', 'status', 'client_id', 'client_name',
  'owner_table', 'owner_record_id', 'owner_recorded_at', 'owner_value',
  'legacy_table', 'legacy_record_id', 'legacy_recorded_at', 'legacy_value',
  'recommended_action', 'decision', 'reviewer', 'reviewed_at', 'rationale',
];

function decisionRow(record) {
  return {
    check_id: record.check_id,
    field: record.field,
    status: record.status,
    client_id: record.client_id,
    client_name: record.client_name,
    owner_table: record.owner_table,
    owner_record_id: record.owner_record_id,
    owner_recorded_at: record.owner_recorded_at,
    owner_value: record.owner_value,
    legacy_table: record.legacy_table,
    legacy_record_id: record.legacy_record_id,
    legacy_recorded_at: record.legacy_recorded_at,
    legacy_value: record.legacy_value,
    recommended_action: record.recommended_action,
    // Deliberately empty: a machine may recommend, only a named reviewer decides.
    decision: '',
    reviewer: '',
    reviewed_at: '',
    rationale: '',
  };
}

function writeDecisionRegisterMd(dir, report, built) {
  const lines = [];
  lines.push('# Phase 6 — D1–D25 conflict decision register');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Database: \`${report.database}\``);
  lines.push(`Read-only source report: yes`);
  lines.push('');
  lines.push('## Decision policy');
  lines.push('');
  lines.push('- Every conflict below starts with an empty decision. Nothing is pre-approved.');
  lines.push('- A conflict is never auto-overwritten: the Phase 5 apply workflow refuses any row whose status is not `legacy_only`.');
  lines.push('- A legacy-only row is backfill-eligible only when its owner row exists, the owner field is NULL, and exactly one legacy source supplies a value.');
  lines.push('- A decision is `keep_owner`, `keep_legacy_manual_merge`, `accept_legacy`, or `no_action_snapshot`; the reviewer writes the reason in `rationale`.');
  lines.push('- A blank decision is not consent. The schema removal gate treats any unresolved conflict as NO-GO.');
  lines.push('');
  lines.push('## Register summary');
  lines.push('');
  lines.push('| Field | Owner | Legacy-only | Conflicts | Recommendations |');
  lines.push('|---|---|---:|---:|---|');
  for (const row of built.byCheck) {
    const recs = Object.entries(row.recommended).map(([k, v]) => `${k}: ${v}`).join('; ') || '—';
    lines.push(`| ${row.id} — ${row.field} | ${row.owner} | ${row.legacy_only} | ${row.conflicts} | ${recs} |`);
  }
  lines.push('');
  lines.push(`Totals: **${report.totals.legacy_only}** legacy-only, **${report.totals.conflicts}** conflicts, **${report.totals.records}** records.`);
  lines.push('');
  lines.push('The field-level rows are in `conflicts.csv` (one row per conflict) and `records.csv` (every record). Both carry blank decision columns.');
  lines.push('');
  fs.writeFileSync(path.join(dir, 'decision-register.md'), lines.join('\n'), { mode: 0o600 });
}

function writeBackfillPacket(dir, report, candidates) {
  const lines = [];
  lines.push('# Phase 6 — reviewed backfill candidates');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Database: \`${report.database}\``);
  lines.push('');
  lines.push('> **Authorization: NOT GRANTED.** These candidates have not been applied.');
  lines.push('> This packet is evidence for a reviewer, not an approval. The Phase 5');
  lines.push('> apply workflow refuses to run without `--apply`, the reviewed plan');
  lines.push('> sha256, and a named reviewer, and it re-checks every owner field for');
  lines.push('> NULL inside the transaction.');
  lines.push('');
  lines.push(`Candidates: **${candidates.length}**. Every one is a legacy-only row whose owner field is NULL and whose value comes from exactly one legacy source.`);
  lines.push('');
  lines.push('| Plan id | Check | Client | Owner column | Current | Proposed | Legacy source | Decision |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const c of candidates) {
    lines.push(`| ${c.plan_id} | ${c.check_id} | ${c.client_id} (${c.client_name || ''}) | ${c.owner_table}.${c.owner_column} | ${csvCell(c.current_value)} | ${csvCell(c.proposed_value)} | ${c.legacy_table} ${c.legacy_record_id} | *(blank)* |`);
  }
  lines.push('');
  lines.push('## To authorize a subset');
  lines.push('');
  lines.push('1. Read the row against the client record and the legacy source.');
  lines.push('2. Copy the plan file, set `"decision": "backfill"` only on approved rows, and record the reviewer separately.');
  lines.push('3. Run `phase5-apply-reconciliation.js` without `--apply` first.');
  lines.push('4. Run it with `--apply --confirm <sha256 of the edited plan> --reviewer <name>`.');
  lines.push('5. Keep the plan and the audit_log rows as the authorization record.');
  lines.push('');
  lines.push('No candidate may be applied from this packet directly.');
  lines.push('');
  fs.writeFileSync(path.join(dir, 'backfill-review.md'), lines.join('\n'), { mode: 0o600 });
}

function writeDecisionArtifacts(dir, report, plan) {
  const built = buildRegister(report, plan);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeCsv(path.join(dir, 'records.csv'), DECISION_COLUMNS, built.records.map(decisionRow));
  writeCsv(path.join(dir, 'conflicts.csv'), DECISION_COLUMNS, built.conflicts.map(decisionRow));
  writeCsv(
    path.join(dir, 'backfill-candidates.csv'),
    ['plan_id', 'check_id', 'status', 'client_id', 'client_name', 'owner_table', 'owner_record_id',
      'owner_column', 'current_value', 'proposed_value', 'legacy_table', 'legacy_record_id',
      'decision', 'reviewer', 'reviewed_at', 'rationale'],
    built.candidates.map((c) => ({
      ...c,
      decision: '',
      reviewer: '',
      reviewed_at: '',
      rationale: '',
    })),
  );
  writeDecisionRegisterMd(dir, report, built);
  writeBackfillPacket(dir, report, built.candidates);

  const summary = {
    generated_at: new Date().toISOString(),
    database: report.database,
    read_only: report.read_only === true,
    totals: report.totals,
    conflicts_in_register: built.conflicts.length,
    records_in_register: built.records.length,
    backfill_candidates: built.candidates.length,
    decisions_prefilled: 0,
    authorization: 'NOT GRANTED',
    validation: { ok: true, problems: [] },
  };
  fs.writeFileSync(path.join(dir, 'decision-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  for (const name of ['records.csv', 'conflicts.csv', 'backfill-candidates.csv',
    'decision-register.md', 'backfill-review.md', 'decision-summary.json']) {
    fs.chmodSync(path.join(dir, name), 0o600);
  }
  return { ...built, summary };
}

async function main() {
  const reportPath = arg('report');
  const planPath = arg('plan');
  const outDir = arg('out-dir');
  if (!reportPath || !planPath || !outDir) {
    console.error('Usage: --report <phase5-report.json> --plan <phase5-plan.json> --out-dir <dir>');
    process.exit(2);
  }
  for (const file of [reportPath, planPath]) {
    if (!fs.existsSync(file)) {
      console.error(`Not found: ${file}`);
      process.exit(2);
    }
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  let built;
  try {
    built = writeDecisionArtifacts(outDir, report, plan);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log([
    '# Phase 6 decision register',
    `Database: ${report.database}`,
    `Records: ${built.records.length}`,
    `Legacy-only: ${built.legacyOnly.length}`,
    `Conflicts: ${built.conflicts.length}`,
    `Backfill candidates awaiting authorization: ${built.candidates.length}`,
    'Decisions prefilled: 0',
    `Output: ${outDir}`,
  ].join('\n'));
}

module.exports = { buildRegister, writeDecisionArtifacts };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

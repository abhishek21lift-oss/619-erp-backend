#!/usr/bin/env node
'use strict';
// Phase 5 — apply a reviewed reconciliation plan.
//
// The plan is produced by phase5-reconcile-ownership.js. It contains only
// candidates where an owner row already exists, the owner field is NULL, and
// exactly one legacy source supplies a value. A reviewer sets
// `"decision": "backfill"` on the rows they approve.
//
// Safety properties, in order:
//   * dry-run is the default; nothing is written without `--apply`;
//   * `--apply` also needs `--confirm <sha256 of the plan file>` so the plan
//     that was reviewed is the plan that runs;
//   * only the table/column pairs in ALLOWED may be written;
//   * every candidate re-reads the owner row inside the transaction and aborts
//     the whole run if the field is no longer NULL — a conflict is never
//     overwritten, even if it appeared after review;
//   * one audit_log row is written per change with the reviewer, plan hash,
//     check id and legacy provenance.
//
//   node scripts/phase5-apply-reconciliation.js --plan plan.json
//   node scripts/phase5-apply-reconciliation.js --plan plan.json --apply \
//        --confirm <sha256> --reviewer <name> --url ...
//
// Exit codes: 0 success/no-op, 1 validation or database failure, 2 usage.

const { Client } = require('pg');
const fs = require('fs');
const crypto = require('crypto');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PLAN_PATH = arg('plan');
const URL_ARG = arg('url') || process.env.DATABASE_URL || process.env.PHASE4_SHAPE_DATABASE_URL;
const APPLY = process.argv.includes('--apply');
const CONFIRM = arg('confirm');
const REVIEWER = arg('reviewer');

if (!PLAN_PATH || !URL_ARG) {
  console.error('Usage: --plan <file> --url <database> [--apply --confirm <sha256> --reviewer <name>]');
  process.exit(2);
}
if (!fs.existsSync(PLAN_PATH)) {
  console.error(`Plan not found: ${PLAN_PATH}`);
  process.exit(2);
}

// Only fields the report itself can propose. A hand-edited plan cannot widen
// this list, and an identifier from the plan never reaches SQL: the table and
// column below are the only ones the update builder will use.
const ALLOWED = {
  'pt_lifestyle_assessments:occupation_type': 'text',
  'pt_lifestyle_assessments:screen_time_bracket': 'text',
  'pt_lifestyle_assessments:sleep_duration_hours': 'number',
  'pt_lifestyle_assessments:smoking_status': 'text',
  'pt_lifestyle_assessments:alcohol_status': 'text',
  'pt_nutrition_assessments:water_intake_liters': 'number',
  'pt_goals:motivation_level': 'number',
};

const planBytes = fs.readFileSync(PLAN_PATH);
const planSha = crypto.createHash('sha256').update(planBytes).digest('hex');

if (APPLY) {
  if (!CONFIRM || CONFIRM !== planSha) {
    console.error(`Refusing to apply: --confirm must be the plan's sha256 (${planSha}).`);
    process.exit(2);
  }
  if (!REVIEWER || !REVIEWER.trim()) {
    console.error('Refusing to apply: --reviewer is required for the audit trail.');
    process.exit(2);
  }
}

let plan;
try {
  plan = JSON.parse(planBytes.toString('utf8'));
} catch (err) {
  console.error(`Plan is not valid JSON: ${err.message}`);
  process.exit(2);
}
if (!Array.isArray(plan.candidates)) {
  console.error('Plan has no candidates array.');
  process.exit(2);
}

const approved = plan.candidates.filter((c) => c.decision === 'backfill');
const pending = plan.candidates.filter((c) => !c.decision);
const skipped = plan.candidates.filter((c) => c.decision && c.decision !== 'backfill');

function validate(candidate) {
  const key = `${candidate.owner_table}:${candidate.owner_column}`;
  const kind = ALLOWED[key];
  if (!kind) throw new Error(`${candidate.plan_id || candidate.check_id}: column ${key} is not allowlisted`);
  if (candidate.status !== 'legacy_only') {
    throw new Error(`${candidate.plan_id}: status ${candidate.status} is not a legacy-only candidate; conflicts are never written`);
  }
  if (!candidate.owner_record_id) throw new Error(`${candidate.plan_id}: missing owner record id`);
  if (candidate.proposed_action !== 'backfill') throw new Error(`${candidate.plan_id}: not a backfill proposal`);
  if (candidate.proposed_value === null || candidate.proposed_value === undefined) {
    throw new Error(`${candidate.plan_id}: missing proposed value`);
  }
  if (kind === 'number') {
    const n = Number(candidate.proposed_value);
    if (!Number.isFinite(n)) throw new Error(`${candidate.plan_id}: proposed value is not numeric`);
    return n;
  }
  return String(candidate.proposed_value);
}

async function main() {
  const db = new Client({ connectionString: URL_ARG });
  await db.connect();
  // Dry-run still checks the live row, so it needs a transaction; READ ONLY
  // makes the no-write promise structural rather than a code-review promise.
  await db.query(APPLY ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
  await db.query("SET LOCAL statement_timeout = '60s'");

  const changes = [];
  try {
    for (const candidate of approved) {
      const value = validate(candidate);
      const key = `${candidate.owner_table}:${candidate.owner_column}`;
      const [table, column] = key.split(':');
      const { rows } = await db.query(
        `SELECT ${column} AS current_value FROM ${table} WHERE id = $1 ${APPLY ? 'FOR UPDATE' : ''}`,
        [candidate.owner_record_id],
      );
      if (!rows.length) throw new Error(`${candidate.plan_id}: owner record ${candidate.owner_record_id} no longer exists`);
      if (rows[0].current_value !== null) {
        throw new Error(`${candidate.plan_id}: owner value is no longer NULL (${rows[0].current_value}); refusing to overwrite`);
      }

      if (APPLY) {
        const updated = await db.query(
          `UPDATE ${table} SET ${column} = $2, updated_at = NOW() WHERE id = $1 AND ${column} IS NULL`,
          [candidate.owner_record_id, value],
        );
        if (updated.rowCount !== 1) {
          throw new Error(`${candidate.plan_id}: update affected ${updated.rowCount} rows; expected 1`);
        }
        await db.query(
          `INSERT INTO audit_log (table_name, record_id, action, old_data, new_data)
           VALUES ($1, $2, 'legacy_reconciliation_backfill', $3, $4)`,
          [
            table,
            candidate.owner_record_id,
            JSON.stringify({ column, before: null }),
            JSON.stringify({
              column,
              after: value,
              check_id: candidate.check_id,
              legacy_table: candidate.legacy_table,
              legacy_record_id: candidate.legacy_record_id,
              reviewer: REVIEWER,
              plan_sha256: planSha,
            }),
          ],
        );
      }
      changes.push({ ...candidate, effective_value: value });
    }
    await db.query(APPLY ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    await db.end();
  }

  const mode = APPLY ? 'APPLIED' : 'DRY RUN (no writes)';
  console.log(`# Phase 5 reconciliation apply — ${mode}`);
  console.log(`Plan: ${PLAN_PATH}`);
  console.log(`Plan sha256: ${planSha}`);
  console.log(`Approved candidates: ${approved.length}`);
  console.log(`Pending review (not applied): ${pending.length}`);
  console.log(`Skipped by reviewer: ${skipped.length}`);
  console.log(`Would change / changed: ${changes.length}`);
  for (const c of changes) {
    console.log(`  ${c.check_id} ${c.owner_table} ${c.owner_record_id} ${c.owner_column} <- ${JSON.stringify(c.effective_value)} (${c.legacy_table} ${c.legacy_record_id})`);
  }
  if (pending.length) {
    console.log(`\n${pending.length} candidate(s) still have an empty decision. Set "decision": "backfill" after review.`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

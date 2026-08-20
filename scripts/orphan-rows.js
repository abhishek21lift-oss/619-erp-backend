#!/usr/bin/env node
'use strict';
/**
 * Lists rows that migration 174 could not attribute to a studio.
 *
 * 174 retrofits organization_id onto twelve tables that never had it, and
 * backfills each from whatever signal the table actually carries — the client
 * for an assessment, the author for a campaign, the automation rule for a
 * message log. Tables built as single-tenant global catalogues (plans, meals,
 * pt_packages, integrations) carry no such signal, and a database with more
 * than one studio in it gives the migration nowhere to put them.
 *
 * Those rows keep a NULL organization_id. From the deploy that ships 174
 * onward every route filters on organization_id, so a NULL row matches no
 * studio and is invisible — which is the fail-closed outcome and the correct
 * one for a row nobody can prove the ownership of, but it does mean a studio
 * may notice something has gone missing.
 *
 * This script is the "which rows, and what do I do about it" half. It only
 * ever reads. Assignment is deliberately left to a human running UPDATE
 * statements, because the whole reason these rows are here is that no rule
 * could decide who owns them, and a script that guessed would be the same
 * mistake in a new place.
 *
 *   node scripts/orphan-rows.js
 *
 * After assigning, re-run `npm run migrate`; 174 is idempotent and will
 * tighten each column to NOT NULL once its orphans are gone.
 */

require('dotenv').config();
const pool = require('../src/db/pool');

const TABLES = [
  'pt_lifestyle_assessments', 'pt_nutrition_assessments', 'session_balance',
  'pt_packages', 'automation_rules', 'communication_logs', 'campaigns',
  'offers', 'feedback', 'integrations', 'plans', 'meals', 'module_records',
];

// A human-readable column per table, so the listing says "Gold Monthly"
// rather than a row of UUIDs nobody can act on.
const LABEL = {
  pt_lifestyle_assessments: 'client_id',
  pt_nutrition_assessments: 'client_id',
  session_balance: 'package_name',
  pt_packages: 'name',
  automation_rules: 'name',
  communication_logs: 'recipient_id',
  campaigns: 'name',
  offers: 'title',
  feedback: 'member_name',
  integrations: 'name',
  plans: 'name',
  meals: 'name',
  module_records: 'title',
};

const MAX_ROWS_SHOWN = 20;

async function tableExists(name) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS reg', [`public.${name}`]);
  return rows[0].reg !== null;
}

async function hasOrgColumn(name) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'organization_id'`,
    [name]
  );
  return rows.length > 0;
}

async function main() {
  const { rows: orgs } = await pool.query(
    'SELECT id, name, slug FROM organizations ORDER BY created_at'
  );

  console.log('');
  console.log(`Organisations on this database: ${orgs.length}`);
  for (const o of orgs) console.log(`  ${o.id}  ${o.slug}  (${o.name})`);
  console.log('');

  let total = 0;
  const withOrphans = [];

  for (const table of TABLES) {
    if (!await tableExists(table)) continue;
    if (!await hasOrgColumn(table)) {
      console.log(`${table}: no organization_id column — migration 174 has not run here.`);
      continue;
    }

    const label = LABEL[table] || 'id';
    // Table and column names come from the constants above, never from input.
    const { rows } = await pool.query(
      `SELECT id, ${label} AS label FROM public.${table}
        WHERE organization_id IS NULL ORDER BY id LIMIT ${MAX_ROWS_SHOWN + 1}`
    );
    if (rows.length === 0) continue;

    const { rows: [{ count }] } = await pool.query(
      `SELECT count(*)::int AS count FROM public.${table} WHERE organization_id IS NULL`
    );
    total += count;
    withOrphans.push(table);

    console.log(`── ${table} — ${count} unattributed row(s)`);
    for (const r of rows.slice(0, MAX_ROWS_SHOWN)) {
      console.log(`     ${String(r.id).padEnd(38)} ${r.label ?? ''}`);
    }
    if (count > MAX_ROWS_SHOWN) console.log(`     … and ${count - MAX_ROWS_SHOWN} more`);
    console.log('');
  }

  if (total === 0) {
    console.log('No unattributed rows. Re-run `npm run migrate` to tighten any');
    console.log('columns still nullable, then this script has nothing left to do.');
    return;
  }

  console.log(`${total} row(s) across ${withOrphans.length} table(s) belong to no studio.`);
  console.log('They are invisible to every studio until assigned. To assign:');
  console.log('');
  for (const t of withOrphans) {
    console.log(`  UPDATE ${t} SET organization_id = '<org-uuid>' WHERE id = '<row-id>';`);
  }
  console.log('');
  console.log('Then re-run `npm run migrate` — 174 is idempotent and will tighten');
  console.log('each column to NOT NULL once its orphans are gone.');
  console.log('');
  console.log('For integrations rows specifically, prefer having the studio');
  console.log('reconnect the integration over assigning the row: the stored API');
  console.log('key was readable platform-wide before this fix, so it should be');
  console.log('treated as compromised and rotated rather than reused.');
}

main()
  .catch((err) => {
    console.error('orphan-rows failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

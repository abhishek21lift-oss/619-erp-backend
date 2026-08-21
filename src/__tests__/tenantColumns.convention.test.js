'use strict';
// Every table the API reads must be able to answer "which studio owns this?".
//
// ── Why this test exists, and why it is the inverse of its neighbour ────────
//
// tenantScope.convention.test.js next door asks: "for each TENANT TABLE this
// file touches, does the file scope it?" That is a good question, and it has a
// hole in it that is invisible from inside the question itself — it builds its
// list of tenant tables by scanning the migrations for `organization_id`.
//
// So a table that never received the column is not merely unprotected; it is,
// by that test's own definition, NOT A TENANT TABLE. The test does not skip it
// after consideration. It never sees it. Migration 157's RLS policy generator
// discovers its policy list exactly the same way, and so is blind in exactly
// the same place.
//
// Twelve tables sat in that blind spot: campaigns, offers, feedback,
// integrations, plans, meals, pt_packages, session_balance, automation_rules,
// communication_logs, pt_lifestyle_assessments and pt_nutrition_assessments.
// Every route serving them ran with no tenant filter at all, and every guard in
// the repository passed on every commit — including 2,301 tests, one of which
// proves cross-tenant isolation against a real database with a real app_tenant
// role. It could not help: it can only prove isolation for tables that have a
// policy, and these had no policy because they had no column.
//
// This test asks the question the other way round, which closes the loop:
//
//     for each table the application reads, does it carry organization_id —
//     and if not, is it on a list where a human wrote down why that is safe?
//
// A new table with no tenant column and no entry fails the build. That is the
// check that would have caught all four of those clusters on the branch.
//
// ── Why it reads the migrations rather than a live database ────────────────
//
// Same reasoning as every other convention test here: CI has no application
// database at the point this runs, and a runtime check only catches the
// mistake after it has shipped. Reading the source catches it before merge.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const MIGRATIONS = path.join(SRC, 'db', 'migrations');

/** Every table the migrations create, and which of them carry organization_id. */
function schemaFacts() {
  const known = new Set();
  const withOrg = new Set();
  const sources = fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(MIGRATIONS, f));
  const baseSchema = path.join(SRC, 'db', 'schema.sql');
  if (fs.existsSync(baseSchema)) sources.unshift(baseSchema);

  for (const p of sources) {
    const sql = fs.readFileSync(p, 'utf8').replace(/--[^\n]*/g, ' ');
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s*\(([\s\S]*?)\n\s*\)/gi
    )) {
      known.add(m[1].toLowerCase());
      if (/\borganization_id\b/i.test(m[2])) withOrg.add(m[1].toLowerCase());
    }
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["']?([a-z0-9_]+)["']?\s+ADD\s+COLUMN[^;]*?organization_id/gi
    )) {
      known.add(m[1].toLowerCase());
      withOrg.add(m[1].toLowerCase());
    }
  }
  return { known, withOrg };
}

/**
 * Tables that legitimately have no organization_id, each with the reason.
 *
 * Adding an entry is an assertion that the table cannot leak across studios —
 * not a way to quiet a failure. Four shapes, and nothing else belongs here.
 */
const NO_TENANT_COLUMN_BY_DESIGN = {
  // ── 1. The boundary itself ────────────────────────────────────────────────
  organizations: 'IS the tenant. Its own id is the tenant key; migration 159 gives it an RLS policy on `id`.',

  // ── 2. Platform control plane — cross-tenant by purpose, super-admin only ─
  platform_owners: 'Platform operator accounts. No studio owns them; FORCE RLS in migration 161.',
  platform_features: 'Catalogue of features a subscription plan may grant. Platform product config.',
  platform_announcements: 'Operator broadcasts addressed to every studio at once.',
  platform_billing_settings: 'Platform billing configuration (the SaaS vendor\'s, not a studio\'s).',
  platform_ai_settings: 'Platform-wide AI provider configuration, owned by the operator.',
  ai_platform_settings: 'Same, under the older name still referenced by the super-admin console.',
  ai_model_rates: 'Per-model pricing used to cost AI usage. Platform reference data.',
  ai_usage_log: 'Platform AI cost accounting. Aggregated by the operator console across studios.',
  plan_features: 'Join between a subscription plan and the features it grants. Plan-level, not studio-level.',
  subscription_plans: 'The SaaS plans studios subscribe TO — owned by the platform, not a studio.',
  subscription_coupons: 'Platform discount codes for SaaS subscriptions, not studio offers.',
  storage_accounting_meta: 'Platform-wide storage accounting, aggregated by the operator console.',
  system_alerts: 'Command Centre operator alerting, raised about studios rather than by one.',
  system_logs: 'Command Centre log capture. Operator surface, mounted behind requireSuperAdmin + MFA.',
  trials: 'Platform-level trial tracking for the SaaS subscription funnel.',
  admin_reset_intents: 'Break-glass reset intents, reachable only behind the platform guard.',

  // ── 3. Reference libraries — platform-global content every studio draws on ─
  muscles: 'Anatomical reference data shared by every studio\'s exercise library.',
  equipment_types: 'Equipment reference data shared by every studio\'s exercise library.',
  exercise_categories: 'Exercise taxonomy reference data, shared across every studio.',
  exercise_muscles: 'Join between an exercise and the muscles it trains. Follows `exercises`, which is itself shared.',
  exercise_relations: 'Exercise-to-exercise relationships (progressions, alternatives). Follows `exercises`.',

  // ── 4. Child rows reached only through a scoped parent ────────────────────
  //
  // This is the codebase's deliberate design, documented at the top of
  // modules/training/authz.js: a set belongs to a performance belongs to a
  // session belongs to a client, and the only safe way to reach one is to walk
  // back up and check THAT. These tables carry no organization_id on purpose.
  set_performances: 'Reached via exercise_performances → training_sessions → pt_clients (authz.loadSet).',
  exercise_performances: 'Reached via training_sessions → pt_clients (authz.loadPerformance).',
  cardio_performances: 'Reached via exercise_performances → training_sessions → pt_clients (authz.loadCardio).',
  training_program_phases: 'Child of training_programs; every handler calls authz.loadOwned on the parent first.',
  training_program_weeks: 'Child of training_programs; guarded by authz.loadOwned on the parent.',
  workout_template_exercises: 'Child of workout_templates; reached via authz.loadOwned.',
  workout_exercises: 'Child of workout_plans; reached via loadEditablePlan / planReadFilter.',
  workout_session_exercises: 'Child of workout_sessions, which carries organization_id.',
  workout_sets: 'Child of workout_session_exercises, itself a child of an org-scoped session.',
  invoice_items: 'Child of invoices, which carries organization_id and is scoped there.',
  diet_plan_meals: 'Join between diet_templates and meals; both now carry the column.',
  support_ticket_messages: 'Child of support_tickets, which carries organization_id.',
  ai_messages: 'Child of ai_conversations, which is keyed on the user who owns it.',
  exercise_versions: 'Version history of an exercises row; follows that table\'s shared shape.',
  exercise_favorites: 'Keyed on the user who favourited the exercise, not on a studio.',
  exercise_recent_usage: 'Keyed on the user whose usage it records, not on a studio.',
  pt_parq_documents: 'Child of pt_parq_forms, reached only through an org-resolved client.',
  pt_family_medical_history: 'Child of pt_parq_forms, reached only through an org-resolved client.',
  pt_medical_clearances: 'Child of pt_parq_forms, reached only through an org-resolved client.',
  pt_consent_records: 'Child of pt_informed_consents, reached through an org-resolved client.',
  pt_parq_forms: 'Reached by client_id; every handler resolves the client through the caller\'s org first.',
  pt_informed_consents: 'Carries organization_id in the uploads ownership check (routes/uploads.js OWNED_CATEGORIES).',
  pt_client_renewals: 'Reached by client_id, through a client already resolved in the caller\'s org.',
  pt_client_subscriptions: 'Reached by client_id, same shape.',
  pt_commissions: 'Keyed on trainer_id + client_id, both org-resolved by pt-os.service.js\'s tenantScope.',
  pt_payouts: 'Keyed on trainer_id, resolved through the caller\'s org.',
  pt_plans: 'Reached by client_id through an org-resolved client.',
  weight_logs: 'Reached by client_id through an org-resolved client.',

  // ── 5. Identity and session, keyed on the user not the studio ─────────────
  refresh_tokens: 'Keyed on user_id. Pre-auth lookup by token hash; no org exists yet at that point.',
  user_profiles: 'Keyed on user_id, one row per account.',
  webauthn_challenges: 'Short-lived passkey ceremony state, keyed on the account.',
  mfa_recovery_codes: 'Credential, keyed on user_id, with its own user-scoped RLS policy (migration 169).',
  notifications: 'Keyed on the recipient user, who belongs to exactly one studio.',
  ai_conversations: 'Keyed on user_id, and every read carries `AND user_id = $n` bound from the session — a conversation belongs to the account that had it, not to a studio.',
};

/**
 * Tables that SHOULD carry organization_id and do not.
 *
 * This is debt, not design, and it is listed separately from the block above on
 * purpose: an entry here is an admission, not a justification. The test still
 * passes — failing the build on pre-existing debt would only get the whole
 * check deleted — but the list is the backlog, and it must only ever shrink.
 *
 * A NEW table cannot be added here without someone deliberately editing this
 * comment, which is the point.
 */
const KNOWN_GAPS = {
  system_settings: 'Per-studio keys (branch_N) inside a shared table. Reviewed exception in tenantScope.convention.test.js; a real column would be better.',
  feature_flags: 'Studio feature toggles, admin-only, read through settings routes.',
  payments: 'Legacy payment rows. The live path is pt_payments (which carries the column) and payment_orders; this table is read by invoices.js and the Razorpay webhook.',
  clients: 'The legacy table migration 170 drops. Still referenced by admin-reset and clients.js.',
};

/** Every route/module source file. */
function sourceFiles() {
  const out = [];
  for (const root of ['routes', 'modules']) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) out.push(p);
      }
    })(path.join(SRC, root));
  }
  return out;
}

/**
 * SQL-looking literals in a source file.
 *
 * Restricted to string and template literals that actually read like SQL,
 * because scanning raw file text matches English prose in the comments — this
 * codebase's comments are long and mention table names constantly, and an
 * earlier draft of this test reported "and", "the" and "whichever" as tables.
 */
function sqlLiteralsIn(src) {
  const out = [];
  let m;
  const tpl = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  while ((m = tpl.exec(src)) !== null) {
    if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i.test(m[1])) out.push(m[1]);
  }
  const str = /(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  while ((m = str.exec(src)) !== null) {
    if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(m[2])
      && /\b(FROM|INTO|UPDATE)\s+[a-z_]/i.test(m[2])) out.push(m[2]);
  }
  return out;
}

describe('every table the API reads can name its owning studio', () => {
  const { known, withOrg } = schemaFacts();

  /** table -> Set of files that read or write it. */
  const referenced = new Map();
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const sql of sqlLiteralsIn(src)) {
      for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:public\.)?["']?([a-z][a-z0-9_]*)["']?/gi)) {
        const t = m[1].toLowerCase();
        if (!known.has(t)) continue; // an alias, a CTE, or a keyword — not a table
        if (!referenced.has(t)) referenced.set(t, new Set());
        referenced.get(t).add(path.relative(SRC, file).split(path.sep).join('/'));
      }
    }
  }

  it('finds the application SQL it is supposed to be checking', () => {
    // A guard that silently matches nothing passes forever. Pin the floor.
    expect(referenced.size).toBeGreaterThan(100);
    expect(referenced.has('pt_clients')).toBe(true);
  });

  it('no table is read without either a tenant column or a written-down reason', () => {
    const unexplained = [];
    for (const [table, files] of referenced) {
      if (withOrg.has(table)) continue;
      if (NO_TENANT_COLUMN_BY_DESIGN[table]) continue;
      if (KNOWN_GAPS[table]) continue;
      unexplained.push(`${table} — read by ${[...files].sort().join(', ')}`);
    }

    expect(unexplained.sort()).toEqual([]);
  });

  it('the twelve tables migration 174 retrofitted are visible to the migration scanners', () => {
    // Not a restatement of the migration — a check that the columns were added
    // with LITERAL `ALTER TABLE … ADD COLUMN … organization_id` statements.
    //
    // 174's first draft added all twelve inside a `FOREACH … EXECUTE format()`
    // loop. The database would have been identical and every regex-based guard
    // in this repository — this test, tenantScope.convention.test.js, and
    // migration 157's policy generator — would still have been unable to see
    // them. The fix would have left the blind spot exactly where it was.
    for (const t of [
      'pt_lifestyle_assessments', 'pt_nutrition_assessments', 'session_balance',
      'pt_packages', 'automation_rules', 'communication_logs', 'campaigns',
      'offers', 'feedback', 'integrations', 'plans', 'meals', 'module_records',
    ]) {
      expect(withOrg.has(t)).toBe(true);
    }
  });

  it('every INSERT into a table 174 retrofitted stamps organization_id', () => {
    // Adding the column is half the job; the writes have to fill it. Migration
    // 174 tightens each column to NOT NULL wherever the backfill left no NULLs
    // — the ordinary case on a fresh database — so an INSERT that omits it does
    // not degrade quietly, it 500s. Both assessment POST handlers did exactly
    // that and shipped in the first push of this branch: the reads had been
    // scoped, the writes had not, and nothing in this suite looked at writes.
    //
    // On a database left nullable it is worse than a 500, because it succeeds:
    // the row lands with a NULL org and is then invisible to the org-filtered
    // read that just created it.
    const RETROFITTED = [
      'pt_lifestyle_assessments', 'pt_nutrition_assessments', 'session_balance',
      'pt_packages', 'automation_rules', 'communication_logs', 'campaigns',
      'offers', 'feedback', 'integrations', 'plans', 'meals', 'module_records',
    ];

    const unstamped = [];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      for (const table of RETROFITTED) {
        // The column list of an INSERT runs from the table name to the VALUES
        // keyword; that is the whole of what this needs to look at.
        const re = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([\\s\\S]*?)\\)\\s*(?:VALUES|SELECT)`, 'gi');
        let m;
        while ((m = re.exec(src)) !== null) {
          if (!/\borganization_id\b/i.test(m[1])) {
            const line = src.slice(0, m.index).split('\n').length;
            unstamped.push(`${path.relative(SRC, file).split(path.sep).join('/')}:${line} → ${table}`);
          }
        }
      }
    }

    expect(unstamped.sort()).toEqual([]);
  });

  it('the debt list only ever shrinks', () => {
    // Pinned at the count established when this test was written. Fixing a gap
    // means deleting its entry AND lowering this number; nothing else should
    // move it. An addition fails here rather than passing quietly.
    expect(Object.keys(KNOWN_GAPS)).toHaveLength(4);
  });

  it('no table is in both lists, which would make the reason meaningless', () => {
    const both = Object.keys(KNOWN_GAPS).filter((t) => NO_TENANT_COLUMN_BY_DESIGN[t]);
    expect(both).toEqual([]);
  });

  it('every reason is a sentence somebody wrote, not a placeholder', () => {
    for (const [table, reason] of Object.entries({ ...NO_TENANT_COLUMN_BY_DESIGN, ...KNOWN_GAPS })) {
      expect(`${table}: ${reason}`.length).toBeGreaterThan(table.length + 30);
    }
  });
});

'use strict';
// A table that has been given a parent walk never quietly loses it.
//
// ── The regression this exists to prevent a third time ──────────────────────
//
// Some tenant tables need a two-part RLS policy: the column check AND a walk to
// the parent that proves the row's studio agrees with its parent's.
//
//   USING (organization_id::text = current_setting('app.org_id', true)
//          AND EXISTS (SELECT 1 FROM public.<parent> p
//                       WHERE p.id = <table>.<fk>
//                         AND p.organization_id::text = current_setting('app.org_id', true)))
//
// Migration 185 shipped a loop that did this over every table carrying an
// organization_id column:
//
//   DROP POLICY IF EXISTS tenant_isolation ON public.%I
//   CREATE POLICY tenant_isolation ... USING (organization_id::text = ...)
//
// Column-only. Every table that had a parent walk lost it — silently, because
// the sweep never names the tables it damages and the migration applies
// cleanly. pt_lifestyle_assessments and pt_nutrition_assessments were the two
// that mattered; migration 186 restored them.
//
// Policies are PERMISSIVE and combine with OR, so the weaker policy always
// wins. That is what makes this class of change dangerous out of proportion to
// how it reads in review: nothing errors, nothing logs, and the isolation is
// simply thinner than the architecture says it is.
//
// ── Why "protected", not "derived" ──────────────────────────────────────────
//
// A first draft of this test split tables into direct and derived by whether
// they carry an organization_id column, and asked derived ones for a parent
// walk. That model is wrong twice over, and the test said so before this
// comment did:
//
//   · It mis-classified personal_records and meals, which carry the column
//     outright and were never derived.
//   · The two tables the incident actually damaged BOTH carry the column too.
//     Their parent walk is not there because the column is missing; it is
//     there as defence in depth, for a row whose organization_id disagrees
//     with its parent's.
//
// So the property that matters is not how a table resolves its studio. It is
// whether somebody has already decided this table needs the stronger policy.
// PROTECTED below is computed from that decision as recorded in the migration
// history — every table ever given a parent walk — and the rule is simply that
// the decision cannot be reversed by accident.
//
// ── What this checks, and what it does not ──────────────────────────────────
//
// It reads migration SQL, not a live database. It cannot reconstruct the final
// policy state across 200 forward-only migrations, and pretending otherwise
// would produce a fragile test whose failures nobody trusts. So it guards the
// WRITE path — what a migration is allowed to create — and leaves verifying
// actual state to rls.isolation.integration.test.js, which connects as
// app_tenant and tries the four crimes for real.
//
// That runtime proof is skipped unless RLS_TEST_DATABASE_URL is set, so CI does
// not currently run it. Closing that is roadmap phase 2 work and is recorded in
// the phase 1 report; this test is the static half.

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

/** Every migration file, oldest first. */
function migrations() {
  return fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: fs.readFileSync(path.join(MIGRATIONS, f), 'utf8') }));
}

const ALL = migrations();

/** Does this SQL create a policy scoped by the tenant GUC? */
function isTenantPolicy(sql) {
  return /CREATE\s+POLICY/i.test(sql) && /app\.org_id/.test(sql);
}

/** Does it contain a parent walk? */
function hasParentWalk(sql) {
  return /EXISTS\s*\(\s*SELECT/i.test(sql);
}

/**
 * Every table that has been given a parent walk at some point.
 *
 * Two shapes carry one: a policy that names its table, and a DO-block loop over
 * a literal array of table names whose template contains the EXISTS. Both are
 * in use — 177 uses the first, 159/174/186 the second — so both are read.
 *
 * `public` is excluded: it falls out of `ON public.%I` in the dynamic form and
 * is a parse artefact, not a table.
 */
const PROTECTED = (() => {
  const out = new Set();

  for (const { sql } of ALL) {
    if (!isTenantPolicy(sql)) continue;

    // Named form: CREATE POLICY tenant_isolation ON <table> ... EXISTS (SELECT
    const named = /CREATE\s+POLICY\s+tenant_isolation\s+ON\s+(?:public\.)?["']?([a-z_][a-z0-9_]*)["']?([\s\S]{0,900}?)(?:;|$)/gi;
    let m;
    while ((m = named.exec(sql)) !== null) {
      if (hasParentWalk(m[2])) out.add(m[1].toLowerCase());
    }

    // Dynamic form: a loop whose template has the walk, over a literal list.
    if (/CREATE\s+POLICY\s+tenant_isolation\s+ON\s+public\.%I/i.test(sql) && hasParentWalk(sql)) {
      for (const t of sql.match(/'([a-z_][a-z0-9_]*)'/g) || []) {
        const name = t.slice(1, -1).toLowerCase();
        // Only names that are plausibly tables in this codebase's conventions.
        if (/^(pt_|workout_|training_|exercise_|diet_|client_)/.test(name)) out.add(name);
      }
    }
  }

  out.delete('public');
  return out;
})();

/**
 * A migration that drops and recreates `tenant_isolation` across a table set it
 * computes at run time rather than naming.
 *
 * The policy NAME matters. A draft that ignored it flagged ten migrations whose
 * loops recreate `deny_all_direct_access` for anon and authenticated — sweeps
 * that only ever tighten access and cannot remove a parent walk, because they
 * never touch tenant_isolation at all.
 */
function hasDynamicPolicySweep(sql) {
  return /DROP\s+POLICY\s+IF\s+EXISTS\s+tenant_isolation\s+ON\s+public\.%I/i.test(sql)
    && /CREATE\s+POLICY\s+tenant_isolation\s+ON\s+public\.%I/i.test(sql);
}

/** `CREATE POLICY <name> ON [public.]<table>` where the table is a literal. */
function policyTargets(sql) {
  const re = /CREATE\s+POLICY\s+[a-z0-9_]+\s+ON\s+(?:public\.)?["']?([a-z_][a-z0-9_]*)["']?/gi;
  const out = [];
  let m;
  while ((m = re.exec(sql)) !== null) out.push(m[1].toLowerCase());
  return out;
}

/**
 * Migrations excused from the sweep rule, each with what it did and what
 * repaired it. Both are applied in production and cannot be edited; failing on
 * them forever would be noise that teaches people to ignore this test.
 *
 * Nothing joins this list without the same kind of entry.
 */
const SWEEP_EXEMPTIONS = {
  '158_activity_log_organization_id.sql':
    'The FIRST occurrence, found by this test rather than by the incident. Same shape '
    + 'as 185: selects every table carrying an organization_id and recreates '
    + 'tenant_isolation column-only. Superseded by the later policies and by 186. Its '
    + 'value now is evidence that this is a recurring pattern, not a one-off slip.',
  '185_whatsapp_instances.sql':
    'The second occurrence, and the one that was noticed. Dropped the parent walk from '
    + 'pt_lifestyle_assessments and pt_nutrition_assessments. Repaired by 186, which the '
    + 'tests below verify is still in place.',
};

describe('a protected table keeps its parent walk', () => {
  it('no migration gives a protected table a column-only policy', () => {
    const violations = [];

    for (const { name, sql } of ALL) {
      if (SWEEP_EXEMPTIONS[name]) continue;
      for (const statement of sql.split(/;\s*(?:\n|$)/)) {
        if (!isTenantPolicy(statement)) continue;
        for (const table of policyTargets(statement)) {
          if (!PROTECTED.has(table)) continue;
          if (!hasParentWalk(statement)) {
            violations.push(`${name}: tenant_isolation on protected table "${table}" has no parent walk`);
          }
        }
      }
    }

    expect(violations.sort()).toEqual([]);
  });

  it('a dynamic policy sweep carries the parent walk in its template', () => {
    // The half that actually caught fire. A sweep cannot be reviewed table by
    // table, so its TEMPLATE has to be safe for the widest set it could match.
    const violations = [];

    for (const { name, sql } of ALL) {
      if (!hasDynamicPolicySweep(sql)) continue;
      if (SWEEP_EXEMPTIONS[name]) continue;
      if (!hasParentWalk(sql)) {
        violations.push(
          `${name}: drops and recreates tenant_isolation over a computed table set with a `
          + 'column-only template — this silently removes the parent walk from every '
          + 'protected table it touches',
        );
      }
    }

    expect(violations.sort()).toEqual([]);
  });

  it('every sweep exemption names a migration that exists', () => {
    // A stale exemption is a hole that looks like a decision.
    const present = new Set(ALL.map((m) => m.name));
    const stale = Object.keys(SWEEP_EXEMPTIONS).filter((n) => !present.has(n));
    expect(stale).toEqual([]);
  });
});

describe('the repair of the 185 regression is still in place', () => {
  const repair = ALL.find((m) => m.name.startsWith('186_'));

  it('migration 186 exists and restores a parent walk', () => {
    expect(repair).toBeDefined();
    expect(hasParentWalk(repair.sql)).toBe(true);
  });

  it('it repairs both tables the sweep damaged', () => {
    expect(repair.sql).toContain('pt_lifestyle_assessments');
    expect(repair.sql).toContain('pt_nutrition_assessments');
  });

  it('both damaged tables are still protected', () => {
    // PROTECTED is what tells the guard above which tables need the stronger
    // policy. If either dropped out of it — a migration rewriting 186, a change
    // to how policies are expressed — the guard would stop protecting the exact
    // rows the incident was about, and nothing else would say so.
    expect(PROTECTED.has('pt_lifestyle_assessments')).toBe(true);
    expect(PROTECTED.has('pt_nutrition_assessments')).toBe(true);
  });
});

describe('the scanner is looking at something', () => {
  it('finds migrations, tenant policies and protected tables', () => {
    // Without this, a change that broke migration discovery would turn every
    // assertion above into a pass over an empty set — an architecture that had
    // silently stopped being measured, reported as green.
    expect(ALL.length).toBeGreaterThan(150);
    expect(ALL.filter((m) => isTenantPolicy(m.sql)).length).toBeGreaterThanOrEqual(10);
    expect(PROTECTED.size).toBeGreaterThanOrEqual(6);
  });

  it('protects the tables the audit identified', () => {
    // Pinned so the set cannot quietly shrink. These are the tables the
    // migration history shows somebody deliberately gave a two-part policy.
    for (const t of [
      'pt_clients', 'pt_packages', 'pt_lifestyle_assessments',
      'pt_nutrition_assessments', 'pt_os_measurements', 'workout_sets',
    ]) {
      expect([...PROTECTED]).toContain(t);
    }
  });
});

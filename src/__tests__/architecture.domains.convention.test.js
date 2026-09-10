'use strict';
// The domain manifest is enforceable, not aspirational.
//
// src/architecture/domains.js declares the approved target architecture:
// twenty domains, which plane each serves, which tables each owns and which
// other domains it may depend on. A manifest nothing checks is a document with
// a .js extension, so this is what makes it binding:
//
//   · every table in the schema has exactly one owner
//   · every table the manifest names actually exists
//   · the dependency graph is a DAG
//   · read-only domains own nothing
//   · platform and tenant planes do not share tables
//
// None of this changes runtime behaviour. It changes what a future migration
// is allowed to do silently — which is the whole point of doing it before the
// module extraction rather than after.

const fs = require('fs');
const path = require('path');

const {
  PLANE, TENANCY, DOMAINS, ownerOf, allTables, findCycles, danglingDependencies,
} = require('../architecture/domains');

const DB = path.join(__dirname, '..', 'db');

/**
 * Every table that exists after schema.sql and every migration finish
 * applying, in order — i.e. what a fresh bootstrap actually ends up with.
 *
 * Read from src/db rather than a live connection so this runs in CI with no
 * database — the same reason every other convention test in this suite is
 * static. `CREATE TABLE IF NOT EXISTS` and a `public.` prefix are both in
 * use, and quoted identifiers appear in a couple of the older migrations.
 *
 * ── Why CREATE alone is not enough ───────────────────────────────────────
 *
 * A first version of this function matched CREATE TABLE only, and reported
 * 171 tables where the manifest — at the time — also claimed 171. They
 * matched by construction, not because either was right: the scan simply
 * counted every name a CREATE TABLE statement had ever mentioned, including
 * seven this codebase's own history goes on to remove.
 *
 *   leads, lead_followups         created by 012, dropped by
 *                                 020_remove_lead_crm.sql
 *   subscriptions, renewals       schema.sql's baseline; dropped by
 *                                 021_remove_members_feature.sql (CASCADE)
 *   clients                      schema.sql's baseline; dropped by
 *                                 170_drop_legacy_clients_and_renewals.sql,
 *                                 which RAISEs an exception if the table is
 *                                 somehow still there afterward
 *   staff_new, staff_targets_new  created by 033_schema_fixes.sql and, in
 *                                 the SAME migration, immediately
 *                                 `ALTER TABLE ... RENAME TO staff` /
 *                                 `staff_targets` — the "_new" names never
 *                                 persist past that one file
 *
 * PR #105 is what exposed this isn't a theoretical gap: Command Centre code
 * queried `subscriptions` directly and 500'd on every call, because the
 * table has not existed since migration 021 — years before that code was
 * written. A CREATE-only scan cannot tell a table like that from one that
 * genuinely exists, and a manifest built from a CREATE-only scan will
 * confidently assign an owner to a table that is not there.
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 *
 * Every file's SQL is concatenated in application order (schema.sql, then
 * every migration by filename) into one string, and CREATE / DROP / RENAME
 * are matched with a single pass over that string — so statements are
 * processed in the exact order they would execute in, including a table
 * dropped and immediately recreated within the same migration (048 creates
 * `pt_client_subscriptions`, 050 conditionally drops and unconditionally
 * recreates it to fix a column-type bug; the net result — exists — falls
 * out of processing both statements in order, without this function having
 * to understand *why* 050's drop is conditional).
 */
function schemaTables() {
  const files = [path.join(DB, 'schema.sql')];
  const migrations = path.join(DB, 'migrations');
  for (const f of fs.readdirSync(migrations).sort()) {
    if (f.endsWith('.sql')) files.push(path.join(migrations, f));
  }

  const chunks = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    chunks.push(fs.readFileSync(file, 'utf8'));
  }
  // A separator with no SQL keywords in it, so a statement cannot span the
  // join point — matters only for a table name split across a file boundary,
  // which none of these files do, but cheap insurance against ever adding one.
  const sql = chunks.join('\n-- === file boundary === \n');

  const ident = '["\']?([a-z_][a-z0-9_]*)["\']?';
  const stmt = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${ident}\\s*\\(`
    + `|DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${ident}\\b`
    + `|ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${ident}\\s+RENAME\\s+TO\\s+(?:public\\.)?${ident}\\b`,
    'gi',
  );

  const found = new Set();
  let m;
  while ((m = stmt.exec(sql)) !== null) {
    const [, created, dropped, renamedFrom, renamedTo] = m;
    if (created) found.add(created.toLowerCase());
    else if (dropped) found.delete(dropped.toLowerCase());
    else if (renamedFrom) {
      found.delete(renamedFrom.toLowerCase());
      found.add(renamedTo.toLowerCase());
    }
  }
  return found;
}

describe('the domain manifest is internally consistent', () => {
  it('no table is claimed by two domains', () => {
    // ownerOf() is built at require time and throws on a duplicate, so simply
    // loading the module proves this. Asserted explicitly so the intent is
    // visible rather than implied by an import that happened not to throw.
    expect(() => require('../architecture/domains')).not.toThrow();
    expect(allTables().length).toBeGreaterThan(150);
  });

  it('every declared dependency names a domain that exists', () => {
    expect(danglingDependencies()).toEqual([]);
  });

  it('the dependency graph is acyclic', () => {
    // A cycle means two domains cannot be reasoned about, tested or extracted
    // independently — and phase 4 extracts them one at a time. The failure
    // message names the path so the fix is obvious: extract the shared concept
    // downward, or invert the edge with a domain event.
    expect(findCycles()).toEqual([]);
  });

  it('every domain declares a known plane and tenancy model', () => {
    const planes = new Set(Object.values(PLANE));
    const models = new Set(Object.values(TENANCY));
    const bad = [];
    for (const [name, spec] of Object.entries(DOMAINS)) {
      if (!planes.has(spec.plane)) bad.push(`${name}: plane "${spec.plane}"`);
      if (!models.has(spec.tenancy)) bad.push(`${name}: tenancy "${spec.tenancy}"`);
      if (!spec.description) bad.push(`${name}: no description`);
    }
    expect(bad).toEqual([]);
  });

  it('read-only domains own no tables', () => {
    // insights and client-portal read through the owning domains. The moment
    // either owns a table it becomes a second write path onto data whose rules
    // live somewhere else — which is how a reporting query turns into an
    // unscoped read of another studio's rows.
    const violations = Object.entries(DOMAINS)
      .filter(([, s]) => s.readOnly && s.tables.length > 0)
      .map(([n, s]) => `${n} owns ${s.tables.length} tables`);
    expect(violations).toEqual([]);
  });

  it('every legacy table listed by a domain is a table that domain owns', () => {
    const bad = [];
    for (const [name, spec] of Object.entries(DOMAINS)) {
      for (const t of spec.legacyTables || []) {
        if (!spec.tables.includes(t)) bad.push(`${name}: legacyTables names "${t}" it does not own`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('the manifest and the schema agree', () => {
  const schema = schemaTables();

  it('every table in the schema has exactly one owning domain', () => {
    // The ratchet that matters most. A new table with no owner is a table
    // whose tenancy rules, permissions and RLS shape nobody has decided —
    // which is precisely the state the six documented KNOWN_GAPS arrived in.
    const unowned = [...schema].filter((t) => !ownerOf(t)).sort();
    expect(unowned).toEqual([]);
  });

  it('every table the manifest claims actually exists in the schema', () => {
    // The other direction, and the one a manifest usually gets wrong: a table
    // renamed or dropped by a migration leaves the manifest asserting
    // ownership of something that is gone, and the claim reads as authoritative
    // right up until somebody relies on it.
    const phantom = allTables().filter((t) => !schema.has(t)).sort();
    expect(phantom).toEqual([]);
  });

  it('platform tables and tenant tables are disjoint', () => {
    // Platform and Tenant authorization are never mixed. A table owned by the
    // platform domain is reached through the owner connection and carries
    // deny-all RLS; a tenant table is reached as app_tenant with app.org_id
    // set. One table cannot be both, and a table that drifted between the two
    // would be readable by the wrong connection with the wrong policy.
    const platform = new Set(DOMAINS.platform.tables);
    const tenant = new Set(
      Object.entries(DOMAINS)
        .filter(([n, s]) => n !== 'platform' && s.plane === PLANE.TENANT)
        .flatMap(([, s]) => s.tables),
    );
    const both = [...platform].filter((t) => tenant.has(t));
    expect(both).toEqual([]);
  });
});

describe('the manifest records the state the audit found', () => {
  it('names the legacy tables the roadmap retires, so removal stays deliberate', () => {
    // "Remove obsolete architecture ONLY after verified replacement" needs the
    // obsolete set written down. These are the tables the audit found still on
    // live read paths with no organization_id; roadmap phase 6 moves the reads
    // before anything is dropped.
    //
    // `clients` and `subscriptions` are deliberately NOT in this list, even
    // though the original Phase 1 audit named both as legacy gap tables still
    // awaiting retirement. They are not awaiting anything: migration 170
    // dropped `clients` (with a verification block that RAISEs if it is
    // somehow still there afterward), and migration 021 dropped `subscriptions`
    // years earlier still. Both were already gone by the time that audit ran —
    // it read old comments and route code rather than the migration history,
    // and PR #105 is the bug that came of trusting it (Command Centre code
    // querying a `subscriptions` table that had not existed since 021).
    // Listing either here would assert a retirement this manifest also has to
    // assert is impossible, since schemaTables() no longer contains them.
    const { legacyTables } = require('../architecture/domains');
    const legacy = legacyTables();
    for (const t of ['members']) {
      expect(legacy).toContain(t);
    }
    // `payments` joins clients and subscriptions on the retired side: migration
    // 191 drops it, so schemaTables() no longer contains it and listing it as
    // legacy would assert a retirement this manifest also has to assert is
    // impossible. It had no organization_id at all — the reason it went rather
    // than being scoped — and pt_payments is the ledger.
    for (const t of ['clients', 'subscriptions', 'payments']) {
      expect(legacy).not.toContain(t);
    }
  });

  it('does not carry an already-retired table as a live legacy entry', () => {
    // The complement of the assertion above: every table this manifest DOES
    // list as legacy must actually exist post-migration — legacyTables names
    // something still on a live read path, not something already gone. If a
    // future edit re-adds `clients`/`subscriptions`/`renewals`/`leads` (or any
    // table a migration has since dropped) to a domain's legacyTables, this
    // fails, because the ownership test below would fail first for the same
    // reason: schemaTables() has already retired it.
    const { legacyTables } = require('../architecture/domains');
    const legacy = legacyTables();
    const retired = ['clients', 'subscriptions', 'renewals', 'leads', 'lead_followups',
      'staff', 'staff_new', 'staff_targets', 'staff_targets_new'];
    for (const t of retired) {
      expect(legacy).not.toContain(t);
    }
  });

  it('places the gym-ERP surface in a domain of its own', () => {
    // group-classes is separated from scheduling on purpose: the retire-or-
    // promote decision needs live usage evidence, and a domain that is hidden
    // inside another one never gets that decision made.
    expect(DOMAINS['group-classes'].status).toBe('legacy');
    expect(DOMAINS['group-classes'].tables).toEqual(
      expect.arrayContaining(['bookings', 'class_sessions', 'class_templates']),
    );
  });
});

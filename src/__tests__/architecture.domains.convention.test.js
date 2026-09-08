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
 * Every table the schema creates.
 *
 * Read from src/db rather than a live connection so this runs in CI with no
 * database — the same reason every other convention test in this suite is
 * static. `CREATE TABLE IF NOT EXISTS` and a `public.` prefix are both in use,
 * and quoted identifiers appear in a couple of the older migrations.
 */
function schemaTables() {
  const files = [path.join(DB, 'schema.sql')];
  const migrations = path.join(DB, 'migrations');
  for (const f of fs.readdirSync(migrations).sort()) {
    if (f.endsWith('.sql')) files.push(path.join(migrations, f));
  }

  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z_][a-z0-9_]*)["']?\s*\(/gi;
  const found = new Set();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(sql)) !== null) found.add(m[1].toLowerCase());
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
    const { legacyTables } = require('../architecture/domains');
    const legacy = legacyTables();
    for (const t of ['clients', 'subscriptions', 'payments', 'members']) {
      expect(legacy).toContain(t);
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

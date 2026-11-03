# Phase 7 — Column-Complete Reconciliation Readiness

| Field | Value |
|---|---|
| Date | 2026-11-03 |
| Scope | Audit every column of `pt_os_measurements` (22) and `client_fitness_profiles` (17), verify tenant and row-level provenance, stabilize the load-sensitive tests, verify the 23 ownership guards, and produce the final schema-removal go/no-go. |
| Verdict | **PASS for the Phase 7 tooling and fixture evidence. BLOCKED for real production. NO-GO for schema removal.** |
| Production mutations | **None.** The audit is read-only and additive to the Phase 6 envelope; no backfill was applied, no column or table was dropped, and no destructive migration was written. |
| Production blockers | No production dump, replica or read-only credential has been supplied. The 27 Phase 5 candidates remain unauthorized. The 628 Phase 5 conflicts (all-organization fixture; 581 in ORG_A) still have blank decisions. |
| Evidence class | **Fixture only.** Every count below comes from the synthetic `phase4_shape` database, not from production. |

## 1. What Phase 7 set out to do

Phase 5 reconciles the D1–D25 fact register. It explicitly did not audit
`pt_os_measurements`, and it compared only the profile fields the register
names. Phase 6 built the guarded production wrapper and the ownership CI
guard, but it carried that same coverage limit in writing. Phase 7 closes it:

1. Account for **every column** of both retired tables, including columns with
   no D-register entry.
2. Refuse to produce a report when a live column is missing from the audit
   specification or the specification names a column the schema does not have.
3. Check tenant isolation per row, including the `pt_os_measurements` →
   `pt_clients` join and the profile `organization_id`.
4. Never use an owner row from another organization, even for display.
5. Give each populated cell one provenance row and each remaining decision a
   reviewer-ready register.
6. Prove the result with read-only, real-database tests and keep the schema
   decision at NO-GO while any populated legacy fact remains unresolved.

The deliverable is not a migration. It is the missing half of the evidence a
migration would need.

## 2. Column-complete audit

`scripts/phase7-legacy-column-audit.js` is a separate analyzer. The guarded
wrapper runs it read-only in the same run as the Phase 5 analyzer.

| Table | Columns introspected | Identity | Tenant | Metadata | Fact columns |
|---|---:|---:|---:|---:|---:|
| `pt_os_measurements` | 22 | 1 | 1 (`client_id`) | 1 (`created_at`) | 19 |
| `client_fitness_profiles` | 17 | 1 | 2 (`client_id`, `organization_id`) | 2 (`created_at`, `updated_at`) | 12 |
| **Total** | **39** | **2** | **3** | **3** | **31** |

Of the 31 fact columns, 24 have a canonical owner and are compared against the
latest owner row. Seven have no canonical owner:

| Column | Why there is no owner |
|---|---|
| `assignment_id` | No `workout_assignments` table exists in this schema; the link cannot be resolved |
| `shoulders_cm` | No shoulder measurement column exists in the canonical owner tables |
| `photo_front_url`, `photo_side_url`, `photo_back_url` | Fitness Testing stores scores, not progress photos; a photo-store decision is required before removal |
| `notes` | Three candidate note columns exist (`posture_notes`, `health_notes`, `trainer_notes`); none is a field-level owner |
| `measured_by` | `trainer_id` and `created_by` mean different things; no field-level owner |

The audit refuses to run when the specification and the live schema disagree:
a missing column, an unregistered column, or an unexpected table is a
validation failure, not a silently smaller report.

Every populated cell is classified as one of:

| Status | Meaning |
|---|---|
| `match` | Legacy value equals the latest canonical owner value, within the column's tolerance and comparison rule |
| `conflict` | Both values exist and differ; never auto-overwritten |
| `legacy_only` | The legacy value exists and the owner field is absent or `NULL` |
| `no_canonical_owner` | The column is populated but has no canonical owner to compare against |
| `tenant_blocked` | The row cannot be attributed to exactly one organization |
| `metadata` | Identity, tenant or timestamp bookkeeping, not a fact to migrate |

Comparison rules are column-specific: numeric tolerance (for example sleep
hours ±0.25), calendar-day comparison for `measured_at` versus
`assessment_date`, exact single-element array-to-text comparison, key-order
insensitive object comparison, and structured PAR-Q promotion that always
requires a reviewer.

### 2.1 Tenant isolation

`pt_os_measurements` has no `organization_id`, so its only tenant path is the
`pt_clients` join. The profile table has its own `organization_id`, which must
equal the client's organization. The audit reports five distinct findings:

- orphan client;
- client without an organization;
- profile/client organization mismatch;
- archived client (reported, not a blocker);
- owner row that belongs to another organization (never used, not even for
  display).

On the fixture, all tenant findings are zero. The only non-`ok` rows are
archived clients: 3 measurements and 7 profiles. They are attributed to their
organization and audited normally.

### 2.2 Fixture result, scoped to ORG_A

`a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4`, the same scope Phase 6 uses:

| Metric | Value |
|---|---:|
| Legacy rows audited | 400 (150 measurements + 250 profiles) |
| Out-of-scope rows (other organization) | 32 (12 + 20) |
| Populated cells | 3,100 |
| Fact cells | 1,400 |
| Metadata cells | 1,700 |
| Match / conflict / legacy-only | **491 / 509 / 400** |
| Populated cells with no canonical owner | **0** (7 columns named, all empty here) |
| Tenant-blocked cells | **0** |
| Orphan clients / org mismatches / owner-org mismatches | 0 / 0 / 0 |
| Phase 7 backfill candidates | **0** |
| Validation | **ok** |
| Schema removal | **NO-GO** |

The all-organization fixture run audits 432 rows and 3,348 populated cells
(1,512 facts): **531 match, 549 conflict, 432 legacy-only**, 0 ownerless
populated cells, 0 tenant findings and 0 candidates. It also returns NO-GO.

The counts differ from Phase 5 because they measure different things: Phase 5
counts **records** (908 legacy-only, 581 conflicts, 1,489 records for ORG_A),
while Phase 7 counts **populated fact cells** inside those records. A record
with two divergent fields contributes one record to Phase 5 and two conflicts
to Phase 7.

### 2.3 Candidate policy

A Phase 7 candidate is deliberately narrower than a Phase 5 candidate:

1. the canonical owner row exists;
2. the owner field is `NULL`;
3. the mapping is exact, not renamed, ambiguous or structured;
4. exactly one legacy source supplies the value.

On the fixture there are **0** such candidates. Every populated profile fact
has at least two legacy copies or an ambiguous vocabulary, so it is review-only.
The candidate packet is headed `Authorization: NOT GRANTED`, every decision
field is blank, and `prefilled_decisions` is `0`. Conflicts are never
overwritten.

### 2.4 Artifacts

Each run writes a fresh private directory (`0700`) with `0600` artifacts and a
SHA-256 manifest:

| Artifact | Content |
|---|---|
| `phase7-report.json` | Full audit, one row per populated cell |
| `phase7-report.md` | Human-readable summary and per-column coverage |
| `phase7-records.csv` | Reviewer register for every audited cell |
| `phase7-candidates.csv` | Candidate packet, decisions blank |
| `phase7-summary.json` | Counts, validation, tenant result and schema decision |
| `manifest.json`, `SHA256SUMS` | Hashes, modes, PII flag and the combined Phase 6/7 verdict |

## 3. Guarded wrapper

`scripts/phase6-production-audit.js` now:

- requires **ten** tables: the eight Phase 4 fact tables plus both retired
  tables;
- runs the Phase 5 analyzer and the Phase 7 analyzer with
  `default_transaction_read_only=on`;
- keeps `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ`,
  `--acknowledge-production`, exact `--confirm-host`, TLS for non-loopback
  hosts, output outside the repository, private directories and hashed
  artifacts;
- writes `phase: 7`, `includes_phase6: true`, both script hashes, both
  validation results and a combined `schema_removal` reason list.

The combined reasons from the guarded ORG_A fixture run are:

1. 908 legacy-only records still hold data absent from the owner;
2. 581 conflicting records need a named reviewer decision;
3. 25 Phase 5 backfill candidates remain unapplied;
4. 400 populated legacy column cells exist only in a retired table;
5. 509 populated legacy column cells conflict with the canonical owner.

No production connection was opened. The fixture run is the same target Phase 6
used; it proves the wiring, not the production data.

## 4. Ownership guard

`scripts/phase6-ownership-guard.js` scans source, not a database:

- **343 files scanned**;
- **23 registered dependencies** (11 legacy reads, 2 allowlisted writes,
  10 AI direct reads);
- every entry carries an owner, reason and sunset condition;
- keys are unique and the count is asserted at 23;
- a new retired-table write, a new legacy `pt_clients` fact write, a new
  unregistered read, a new direct AI fact query, or a stale baseline entry
  fails the build.

Result: **PASS**. The CI wiring is unchanged because the guarded wrapper now
runs Phase 7 internally.

## 5. Test evidence

| Suite | Result |
|---|---|
| Phase 7 column audit | **18/18 passed** — read-only repeatable-read certification, all 39 columns, tenant join and profile organization, one provenance row per populated cell, ownerless columns named even when empty, blank reviewer register, private/hashed artifacts, NO-GO with populated cells, numeric/date/array/object comparisons, tenant classification, owner JSON-path reads, recommendations, validation refusal, output-outside-repo refusal, non-UUID organization refusal |
| Phase 6 guarded wrapper | **10/10 passed** — complete manifest, ten-table requirement, private/hashed artifacts, conflict register, unauthorized candidate packet, NO-GO, fresh run directories, four refusal paths |
| Phase 6 ownership guard | **8/8 passed** — committed baseline passes, comments are not reads, new legacy writes/reads/AI queries fail, stale entries fail, all 23 entries have owner/reason/sunset and unique keys |
| Backend load-sensitive suites | **35/35 passed** — `superAdmin.securityCentre` + `superAdmin.adminManagement` in isolation |
| Frontend load-sensitive suites | **19/19 passed** — `workout-builder-weeks` + `today-sessions-card` in isolation |
| TypeScript (frontend) | `npx tsc --noEmit` exit 0 |
| ESLint (changed backend files) | **0 errors, 0 warnings** |

### 5.1 Flaky stabilization

Two backend suites and two frontend suites timed out only under the CPU
contention of a full parallel run. They passed in isolation before and after
the change. The stabilization is explicit load headroom, not a retry or a
skipped assertion:

| File | Change |
|---|---|
| `src/__tests__/superAdmin.securityCentre.test.js` | `jest.setTimeout(15000)` |
| `src/__tests__/superAdmin.adminManagement.test.js` | `jest.setTimeout(15000)` |
| `src/__tests__/workout-builder-weeks.test.tsx` | `findBy*` timeout 10s; autosave wait 5s |
| `src/__tests__/today-sessions-card.test.tsx` | remaining default `findBy*` timeout raised to 10s |

No test was skipped, deleted or loosened.

### 5.2 Commands

```bash
# Ownership guard (no database)
node scripts/phase6-ownership-guard.js

# Phase 6/7 proof suites
PHASE4_SHAPE_DATABASE_URL='postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
  NODE_OPTIONS=--experimental-vm-modules TZ=UTC \
  npx jest phase6OwnershipGuard phase6ProductionAudit phase7LegacyColumnAudit \
  --runInBand --forceExit

# Guarded fixture audit
node scripts/phase6-production-audit.js \
  --url 'postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
  --confirm-host 127.0.0.1 --acknowledge-production \
  --org a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4 \
  --out-dir /tmp/phase7-guarded

# Direct column audit
node scripts/phase7-legacy-column-audit.js \
  --url 'postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
  --out-dir /tmp/phase7-all
```

The direct CLI refuses output inside the repository and a non-UUID `--org`.

## 6. Changed files

| File | Change |
|---|---|
| `619-erp-backend/scripts/phase7-legacy-column-audit.js` | New column-complete read-only analyzer and artifact writer |
| `619-erp-backend/scripts/phase6-production-audit.js` | Runs both analyzers; requires both retired tables; combined verdict |
| `619-erp-backend/src/__tests__/phase7LegacyColumnAudit.realDb.integration.test.js` | New real-DB and helper suite (18 tests) |
| `619-erp-backend/src/__tests__/phase6ProductionAudit.realDb.integration.test.js` | Ten-table and Phase 7 artifact/column assertions |
| `619-erp-backend/src/__tests__/phase6OwnershipGuard.test.js` | Baseline completeness and uniqueness test |
| `619-erp-backend/src/__tests__/superAdmin.securityCentre.test.js` | Load timeout |
| `619-erp-backend/src/__tests__/superAdmin.adminManagement.test.js` | Load timeout |
| `619-erp-frontend/src/__tests__/workout-builder-weeks.test.tsx` | `findBy*` and autosave timeouts |
| `619-erp-frontend/src/__tests__/today-sessions-card.test.tsx` | `findBy*` timeout |
| `docs/specs/CLIENT-ASSESSMENT-FIELD-MATRIX.md` | §17 updated to ten tables; §18 added |
| `docs/implementation/CLIENT-ASSESSMENT-IMPLEMENTATION-ROADMAP.md` | Phase 7 execution note |
| `docs/implementation/PHASE7-PRODUCTION-READINESS-REPORT.md` | This report |

No migration, schema, production data or application behavior was changed.

## 7. Remaining blockers

| Blocker | Why it blocks | What unblocks it |
|---|---|---|
| No production evidence | The fixture cannot prove whether a live row's only copy of a fact is legacy | Supply a read-only production dump/replica or `PRODUCTION_READ_ONLY_DATABASE_URL`, then run the guarded wrapper |
| 628 Phase 5 conflicts blank (581 in ORG_A) | A conflict needs a named human decision | Reviewer fills `decision`, `reviewer`, `reviewed_at`, `rationale` |
| 27 Phase 5 candidates unauthorized | Applying them changes live data | Reviewer signs the plan hash; operator runs the guarded apply workflow |
| 7 columns have no canonical owner | `assignment_id`, `shoulders_cm`, three photo URLs, `notes`, `measured_by` need a product decision if production holds values | Decide the owner or accept documented loss before removal |
| Legacy reads still present | Removing them without production evidence risks data loss | Run the production audit, retire one baseline entry at a time, observe a release |
| No PITR | The free plan has no point-in-time recovery | Accept the dump RPO in writing or move to a plan with PITR |

## 8. Schema-removal decision

**NO-GO.**

The gate is conjunctive and unchanged in substance; Phase 7 adds two
conditions that were previously unmeasured:

1. the production audit shows **zero** legacy-only fact cells, or every
   remaining one has been applied through the reviewed backfill workflow with
   an `audit_log` row;
2. every conflict has a named decision and the register shows no blank
   decision;
3. every populated column with no canonical owner has a written product
   decision and, if required, an owner;
4. every legacy read has been removed from code and from the baseline, and one
   release has been observed without it;
5. the ownership guard passes with zero legacy writes and zero legacy reads;
6. a verified backup and a successful restore drill exist for the change
   window;
7. the release manager and data reviewer have signed the approval record in
   the runbook.

Today, conditions 1–4 are false. Condition 5 is true only because the
allowlisted cache write remains. Conditions 6–7 have not been attempted
because there is nothing safe to apply.

Dropping `pt_os_measurements`, `client_fitness_profiles` or any legacy
`pt_clients` fact now would erase facts that exist nowhere else for part of the
fixture population. The fixture is the best evidence available; it is not
production evidence.

The correct next action is the production read-only audit, then the named
reviewer decisions, then a separately authorized backfill. Not a migration.

## 9. Reproduction notes

Fixture setup and the guarded audit:

```bash
cd 619-erp-backend
./scripts/phase4-shape-setup.sh
node scripts/phase6-ownership-guard.js
node scripts/phase6-production-audit.js \
  --url 'postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
  --confirm-host 127.0.0.1 --acknowledge-production \
  --org a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4 \
  --out-dir /tmp/phase7-guarded
```

Production, after supplying a read-only credential:

```bash
node scripts/phase6-production-audit.js \
  --url "$PRODUCTION_READ_ONLY_DATABASE_URL" \
  --confirm-host db.example.com \
  --acknowledge-production \
  --out-dir /secure/audits/619-phase7
```

The production run must show, in `phase7-summary.json`:

- `validation.ok: true` and zero validation problems;
- zero `no_canonical_owner` populated cells;
- zero `tenant_blocked` cells and `tenant.ok: true`;
- zero unresolved `legacy_only` facts after reviewed backfills;
- zero conflicts without a named decision;
- zero `backfill_eligible` cells outside an authorized plan.

Until then, the decision remains **NO-GO** and the production status remains
**BLOCKED**.

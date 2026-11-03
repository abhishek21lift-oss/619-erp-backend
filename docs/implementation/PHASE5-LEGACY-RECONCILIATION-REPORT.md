# Phase 5 — Legacy Data Reconciliation & Consumer Parity

| Field | Value |
|---|---|
| Date | 2026-11-03 |
| Scope | Reconcile the 981 legacy-only and 628 conflicting D1–D25 records at field level, fix the last canonical consumer, wire the Phase 4 gate into CI, and decide schema-removal readiness. |
| Verdict | **PASS on the synthetic production-shaped fixture. Real-production evidence remains BLOCKED. NO-GO for schema removal.** |
| Production mutations | None. The report run is `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ`; the apply workflow was exercised only against a temporary studio inside `phase4_shape`. |
| Data written to the fixture | None by the report. The real-DB apply test writes one `motivation_level`, one `audit_log` row, then deletes both. All 27 real candidates remain unapplied. |

## 1. What Phase 5 set out to do

Phase 4 counted the duplicate registers but did not answer the question a
reviewer actually needs: *for this client and this field, which record holds
which value, on what date, and what should happen next?* Phase 5 answers that
per field, per client, with provenance on both sides — and then makes the only
safe automated action narrow enough to audit.

Four deliverables:

1. `/api/me/measurements` reads canonical `pt_assessments`, not just the legacy
   measurement log.
2. A field-level reconciliation report for every legacy-only and conflicting
   record, with a reviewed backfill plan.
3. A guarded apply workflow with dry-run default, plan hash, column allowlist,
   conflict refusal and per-change `audit_log` rows.
4. A mandatory CI gate for the Phase 4 production-shape suite, so the fixture
   result cannot silently disappear.

## 2. Reconciliation statistics

Database: `phase4_shape` — the same synthetic production-shaped fixture Phase 4
used (540 clients, two studios, 722 assessments, 243 goals, 1,458 check-ins, 270
fitness profiles, 162 legacy measurement rows, 14 soft-deleted clients).

| Metric | Count |
|---|---:|
| Legacy-only records | **981** |
| Conflicting records | **628** |
| Total records reviewed | **1,609** |
| Reviewed backfill candidates | **27** |
| Conflicts eligible for automatic write | **0** |
| Aggregate validation | **ok** — every detail count equals the Phase 4 aggregate in the same snapshot |

Per register (only registers with records shown):

| # | Field | Legacy-only | Conflict | Records |
|---|---|---:|---:|---:|
| D3 | Height / weight / BMI | 53 | 52 | 105 |
| D4 | Goal | 53 | 52 | 105 |
| D5 | Health conditions | 211 | 52 | 263 |
| D6 | Injuries | 53 | 52 | 105 |
| D7 | Workout experience | 0 | 52 | 52 |
| D8 | Occupation | 53 | 52 | 105 |
| D9 | Screen time | 0 | 52 | 52 |
| D11 | Smoking | 0 | 52 | 52 |
| D12 | Alcohol | 0 | 52 | 52 |
| D14 | Meal frequency | 52 | 0 | 52 |
| D16 | Food preferences | 52 | 0 | 52 |
| D17 | Training days | 53 | 52 | 105 |
| D18 | Sit-and-reach | 105 | 0 | 105 |
| D19 | 1RM | 3 | 1 | 4 |
| D20 | Consent attestations | 2 | 2 | 4 |
| D21 | Medical clearance | 1 | 1 | 2 |
| D22 | Workout experience in programming | 0 | 52 | 52 |
| D23 | Medical conditions in Nutrition | 210 | 0 | 210 |
| D24 | `pt_clients.occupation` | 53 | 52 | 105 |
| D25 | Motivation to exercise | 27 | 0 | 27 |

D1, D2, D10, D13 and D15 produced no rows in this fixture: the snapshot fields
already agree, and the lifestyle/interview values are equal within tolerance.

### 2.1 Why only 27 records are writable

A candidate must satisfy all of the following:

- status is `legacy_only` — never `conflict`;
- an owner row **already exists** (no fabricated assessments, goals or
  PAR-Q forms);
- the owner field is `NULL`;
- exactly one legacy source supplies a value (two disagreeing copies go to
  manual review).

The 27 candidates are all D25 `pt_goals.motivation_level` values sourced from
`pt_lifestyle_assessments.motivation_to_exercise`. Every other legacy-only
register has no owner row at all, which is a coaching/clinical decision, not a
mechanical copy.

The plan file records all 27 with `decision: ""`. **Nothing has been applied.**
A reviewer must set `"decision": "backfill"` on each approved row.

### 2.2 Reconciliation report artefacts

`scripts/phase5-reconcile-ownership.js` writes four files:

| File | Purpose |
|---|---|
| `phase5-report.md` | Human review: one section per register, one row per record, both values and both timestamps. |
| `phase5-report.json` | Machine record of the same report, including validation and per-register counts. |
| `phase5-plan.json` | The reviewed-write plan; only eligible candidates, each with an empty decision. |
| `phase5-review.csv` | Spreadsheet review sheet with a `reviewer_decision` column. |

The analyzer is read-only by construction, opens one `REPEATABLE READ`
snapshot, and validates every detail count against the Phase 4 aggregate before
exiting 0. A mismatch fails the run.

## 3. Guarded apply workflow

`scripts/phase5-apply-reconciliation.js`:

| Guard | Behaviour |
|---|---|
| Default mode | Dry-run. Opens `BEGIN TRANSACTION READ ONLY` and reports what would change. |
| `--apply` | Requires `--confirm <sha256 of the plan file>` and `--reviewer <name>`. A changed plan fails the hash check. |
| Column allowlist | Seven columns only: `pt_lifestyle_assessments.occupation_type`, `screen_time_bracket`, `sleep_duration_hours`, `smoking_status`, `alcohol_status`; `pt_nutrition_assessments.water_intake_liters`; `pt_goals.motivation_level`. Table/column names never come from the plan file. |
| Conflict refusal | Refuses any candidate whose status is not `legacy_only`, then re-reads the owner row inside the transaction; if the field is no longer `NULL`, the whole run aborts. A value that appeared after review is never overwritten. |
| Missing row | Aborts rather than inserting. |
| Audit | One `audit_log` row per change with `action = 'legacy_reconciliation_backfill'`, old/new value, check id, legacy table/id, reviewer and plan hash. |

The apply workflow cannot delete, insert, rename or widen a column. It is a
single-column, single-row backfill tool.

## 4. Member measurements parity (the Phase 4 blocker)

`GET /api/me/measurements` now unions three labelled sources:

| Source | Table | Label |
|---|---|---|
| Canonical fitness test | `pt_assessments` | `assessment` |
| Legacy trainer log | `pt_os_measurements` | `trainer` |
| Member's own check-in | `weekly_checkins` | `checkin` |

Sources are returned as recorded, not merged; a test and a trainer measurement
on the same day are two facts with two provenances. Canonical assessments and
check-ins are scoped by `client_id` **and** `organization_id`; the legacy log
has no `organization_id` column in any migration and is scoped by the
session-derived client id.

Frontend parity:

- `WeightPoint` and `MeMeasurement.source` include `assessment`.
- The progress page ranks `assessment > trainer > checkin` for a same-day
  point and labels a fitness test as **Fitness test**.
- The chart tooltip distinguishes a member check-in from a studio measurement.

Real-DB proof (`clientPortal.realDb.integration.test.js`, 31/31): canonical
assessment first with body measurements, legacy trainer reading still visible,
check-in visible, and a second member sees an empty list.

## 5. Consumer-parity audit

| Consumer | Reads | Verdict |
|---|---|---|
| Member weight goal | `member-goals.service.js` → `pt_assessments`, then `pt_os_measurements` | Canonical first, fallback labelled |
| Transformations | `pt-os.service.js` → `pt_assessments` union legacy log | Canonical first; legacy rows kept and labelled |
| Training brief / snapshot / coach | `client-read.service.js` → `loadClientSources` → assessments + legacy | Both series, canonical ranked first |
| AI workout generator | `client-facts.js` → canonical columns, legacy fallback logged as `ownership.deprecated_read` | No assumed values; missing is stated |
| AI progress / context | `authoritative-client.js` / `client-context.js` → assessments and clients | Canonical, tenant-scoped |
| Frontend | HTTP endpoints only | No database access |
| WhatsApp gateway | No database driver, no client-table reads | Clean |

Legacy writers: the only remaining write to a duplicate column is
`syncClientBodyFromLatest`, which maintains the documented `pt_clients`
weight/height cache from the newest assessment. `pt_os_measurements` has no
writer. No module writes Lifestyle/Nutrition duplicate columns.

## 6. CI enforcement

`.github/workflows/ci.yml` now:

1. Sets `PHASE4_SHAPE_DATABASE_URL`.
2. Stands up the fixture with `scripts/phase4-shape-setup.sh` (real schema,
   real migrations, synthetic seed).
3. Runs `productionShape.phase4.realDb.integration.test.js` as a named,
   non-skipping gate (`--passWithNoTests=false`).
4. Generates the Phase 5 reconciliation report read-only.

Both suites throw in CI when their database variable is missing, so a skip is
a red build, not a green absence. The setup script was run locally and
recreates the fixture from scratch.

## 7. Test evidence

| Suite | Result |
|---|---|
| Phase 4 + Phase 5 real-DB (`productionShape.phase4`, `phase5Reconciliation`) | **29/29 passed** |
| RLS isolation + client portal real-DB | **57/57 passed** (`clientPortal.realDb` 31/31) |
| Phase 5 report + apply workflow | **7/7 passed** — report integrity, validation, scoped candidate, dry-run no-write, missing-hash refusal, audited backfill, second-apply refusal, hand-edited conflict refusal |
| Analyzer on the full fixture | 981 legacy-only / 628 conflicts / 1,609 records / 27 candidates / validation ok |
| Fixture rebuild | `scripts/phase4-shape-setup.sh` completed; schema + migrations + seed |
| Backend regression | **434 suites / 7,312 tests passed** (four shards, real-DB suites included) |
| Frontend regression | **302 files / 5,643 tests passed** |
| TypeScript / ESLint | `tsc` 0 errors; backend ESLint 0; frontend ESLint 0 errors / 388 pre-existing warnings |

### 7.1 Commands

```bash
# Fixture
./scripts/phase4-shape-setup.sh

# Reconciliation report (read-only)
node scripts/phase5-reconcile-ownership.js \
  --url 'postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
  --json /tmp/opencode/phase5-report.json \
  --md /tmp/opencode/phase5-report.md \
  --plan /tmp/opencode/phase5-plan.json \
  --csv /tmp/opencode/phase5-review.csv

# Real-DB gates
PHASE4_SHAPE_DATABASE_URL='postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
  NODE_OPTIONS=--experimental-vm-modules TZ=UTC \
  npx jest productionShape.phase4 phase5Reconciliation --runInBand --forceExit

RLS_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55432/rls_proof?sslmode=disable' \
  NODE_OPTIONS=--experimental-vm-modules TZ=UTC \
  npx jest rls.isolation.integration clientPortal.realDb --runInBand --forceExit
```

## 8. Changed files

| File | Change |
|---|---|
| `scripts/phase5-reconcile-ownership.js` | New read-only field-level report and plan generator; self-validates against Phase 4 aggregates. |
| `scripts/phase5-apply-reconciliation.js` | New dry-run/apply workflow with plan hash, allowlist, conflict refusal and audit rows. |
| `scripts/phase4-audit-ownership.js` | Exports `CHECKS` / `LATEST`; `main()` guarded so Phase 5 can reuse the same definitions. |
| `scripts/phase4-shape-setup.sh` | New fixture setup script used by CI. |
| `src/__tests__/phase5Reconciliation.realDb.integration.test.js` | New real-DB proof of report and apply behaviour. |
| `src/__tests__/clientPortal.realDb.integration.test.js` | Canonical assessment, legacy fallback and tenant-scoping assertions for `/api/me/measurements`. |
| `src/modules/client-portal/client-portal.routes.js` | `/api/me/measurements` now unions assessments, legacy log and check-ins. |
| `.github/workflows/ci.yml` | Phase 4 shape database, mandatory Phase 4 gate, read-only Phase 5 report. |
| `../619-erp-frontend/src/lib/api/types.ts` | `MeMeasurement.source` includes `assessment`. |
| `../619-erp-frontend/src/components/member/WeightChart.tsx` | `assessment` source and tooltip wording. |
| `../619-erp-frontend/src/app/(bare)/member/progress/page.tsx` | Source ranking and labels for three sources. |
| `../docs/specs/CLIENT-ASSESSMENT-FIELD-MATRIX.md` | §16 Phase 5 reconciliation and schema-removal readiness. |
| `../docs/implementation/CLIENT-ASSESSMENT-IMPLEMENTATION-ROADMAP.md` | Phase 5 status and execution note. |

## 9. Remaining blockers

1. **No production dump.** All Phase 5 evidence is from the synthetic
   `phase4_shape` fixture. The production prevalence of each register is still
   unknown, and the real-data criterion stays BLOCKED.
2. **The 27 backfill candidates are unapplied.** They are a safe set for a
   reviewed run, not a completed migration.
3. **Every other legacy-only register needs a human decision.** A missing
   assessment, goal or PAR-Q cannot be invented by a script.
4. **`pt_os_measurements` has no migration definition and no writer.** It is a
   read-only historical fallback; it cannot be dropped until a studio confirms
   its history exists nowhere else.
5. **Conflict rows are never auto-resolved.** 628 conflicts remain report-only
   by design; each is either expected historical drift or a coaching decision.

## 10. Schema-removal decision

**NO-GO.**

The fixture still has 981 records whose only copy is a legacy column and 628
records where owner and legacy disagree. Dropping, renaming or contracting any
of those columns today would erase facts for studios that never wrote the
owner — including medical conditions, injuries and goal history.

The gate for a future contract step is all of:

1. A read-only audit of a **real production dump** shows zero legacy-only facts
   (or every one has been reviewed and reversibly backfilled).
2. The 27-candidate backfill (and any production equivalent) has been reviewed,
   applied with the guarded workflow, and audited.
3. `/api/me/measurements` no longer needs the legacy fallback.
4. One full release has run with every reader on the canonical owner.

Until then: no column drop, no rename, no destructive migration. This phase
changed no schema.

## 11. Reproduction notes

- Local database: Docker `ptstudio-testpg` (`pgvector/pgvector:pg15`) on
  `127.0.0.1:55432`.
- Fixture database: `phase4_shape`; RLS database: `rls_proof`.
- The Phase 5 apply test creates a temporary studio, applies one backfill,
  verifies the audit row and a second-apply refusal, then deletes its own rows.
- The report's `database` field records host and database name, so a review pack
  cannot be mistaken for production.

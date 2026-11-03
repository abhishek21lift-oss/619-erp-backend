# Phase 6 — Production Readiness & Data Ownership Lockdown

| Field | Value |
|---|---|
| Date | 2026-11-03 |
| Scope | Guarded read-only production audit, field-level decisions for every legacy-only and conflicting record, ownership enforcement in CI, consumer verification, reversible migration/rollback procedures, and the final schema-removal go/no-go. |
| Verdict | **PASS for the Phase 6 tooling and fixture evidence. BLOCKED for real production. NO-GO for schema removal.** |
| Production mutations | **None.** No production connection was opened, no backfill was applied, no column or table was dropped, and no destructive migration was written. |
| Production blockers | No production dump, replica or read-only production credential has been supplied. 628 conflicts have blank decisions. 27 backfill candidates remain unauthorised. |

## 1. What Phase 6 set out to do

Phases 4 and 5 proved the ownership architecture on a synthetic
production-shaped fixture. They left three questions unanswered, and Phase 6
answers them or states plainly why it cannot:

1. **Can the audit be pointed at production without risking a write, a leak or
   a report in the wrong place?** Yes — one guarded wrapper, proved by tests
   and exercised against the fixture.
2. **Who decides what happens to each of the 1,609 legacy records?** A named
   reviewer, in a register that starts empty. A machine may recommend; it may
   not approve, and it may not apply a conflict.
3. **What stops the codebase drifting back while the data decision is
   pending?** A CI guard over writes, legacy reads and direct AI fact queries,
   with a baseline that fails when it goes stale.

The deliverable is not a migration. It is the evidence, the decision surface
and the rollback procedure a migration would need before it is allowed to
exist.

## 2. Guarded read-only production audit

`scripts/phase6-production-audit.js` is the only supported production entry
point. It does not duplicate the analyzer's SQL; it wraps
`phase5-reconcile-ownership.js` and enforces the conditions under which that
SQL is safe to run.

| Control | Enforcement |
|---|---|
| Explicit intent | `--acknowledge-production` is required before a connection is opened |
| Named target | `--confirm-host` must exactly match the URL hostname; a typo is a refusal, not a wrong-cluster audit |
| Transport | TLS is required for a non-loopback host; `sslmode=disable` needs `--allow-no-tls` |
| Session | Preflight runs `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ`, then verifies `transaction_read_only=on`, `transaction_isolation=repeatable read`, the current role, the server version and replica status |
| Child process | The analyzer runs with `PGOPTIONS=-c default_transaction_read_only=on`, so a future edit cannot silently acquire a write |
| Right database | Eight expected tables must exist; a wrong or empty database fails before producing a misleading zero-count report |
| Output location | Output is refused inside the repository |
| Output handling | Fresh `run-*` directory per run, mode `0700`; every artifact mode `0600`; `manifest.json` and `SHA256SUMS` |
| PII | The manifest records `contains_pii: true`; client names and health values never reach stdout |

### 2.1 Fixture result

Run against the full `phase4_shape` fixture (both studios):

| Metric | Value |
|---|---:|
| Legacy-only records | **981** |
| Conflicting records | **628** |
| Total records | **1,609** |
| Backfill candidates (unapplied) | **27** |
| Aggregate validation | **ok** |
| Schema removal | **NO-GO** |
| Artifacts | 10, all `0600`, hashes verified |

Scoped to ORG_A (`a4a4a4a4-a4a4-4a4a-a4a4-a4a4a4a4a4a4`): 908 legacy-only, 581
conflicts, 1,489 records, 25 candidates, NO-GO. The scoped run exists to prove
`--org` works; the full fixture is the evidence set.

The decision register generated inside the same run contains:

| File | Rows | Content |
|---|---:|---|
| `records.csv` | 1,609 + header | Every legacy-only and conflicting record |
| `conflicts.csv` | 628 + header | Every conflict, with both values, both ids, both timestamps |
| `backfill-candidates.csv` | 27 + header | Every candidate, with blank decision/reviewer/rationale |
| `decision-register.md` | — | Per-field summary and the decision policy |
| `backfill-review.md` | — | The packet, headed `Authorization: NOT GRANTED` |

`decisions_prefilled` is `0` and `authorization` is `NOT GRANTED` in
`decision-summary.json`. The register cannot apply anything: the only write
path remains `phase5-apply-reconciliation.js`, which requires `--apply`, the
reviewed plan's SHA-256, a named reviewer, an allowlisted column and a
re-check of the owner field inside the transaction.

### 2.2 Refusals proved by test

- Missing `--acknowledge-production` → exit 2, no connection.
- `--confirm-host` mismatch → exit 2, names both hosts.
- `sslmode=disable` to a non-loopback host without `--allow-no-tls` → exit 2.
- Output inside the repository → exit 2.

These are asserted in
`src/__tests__/phase6ProductionAudit.realDb.integration.test.js`, not just
described here.

### 2.3 The real-production gap

No production URL, dump or replica has been supplied. The fixture is built
from the real schema and migrations and seeded to reproduce the shapes the
rules must survive, but its rows are synthetic. It cannot tell us whether a
particular live client's goal exists only in `pt_clients.goal`, and that is
exactly the question a schema decision turns on.

**Therefore:** the audit is ready, the result is not production evidence, and
the Phase 6 production criterion remains BLOCKED.

One coverage limit is stated rather than implied: the analyzer implements the
D1–D25 register. It compares `client_fitness_profiles` on the fields that
register names (goal, injuries, occupation) but not every profile-only column,
and it does not compare `pt_os_measurements` at all — that table is outside
D1–D25. Retiring either needs a targeted read-only comparison in addition to
this audit, not instead of it.

## 3. Field-level decisions

Every one of the 628 conflicts has a row in the register with:

- the field and its canonical owner;
- the owner record id, value and recorded-at timestamp;
- the legacy table(s), record id, value and recorded-at timestamp;
- a machine recommendation (`keep_owner`, `keep_legacy_manual_merge`,
  `accept_legacy`, `no_action_snapshot`);
- blank `decision`, `reviewer`, `reviewed_at` and `rationale`.

The policy is enforced by construction:

- A conflict is **never** auto-overwritten. The apply workflow refuses any row
  whose status is not `legacy_only`.
- A legacy-only row is backfill-eligible only when an owner row already
  exists, the owner field is `NULL`, and exactly one legacy source supplies a
  value.
- A blank decision is **not** consent. The schema gate treats any unresolved
  conflict as NO-GO.
- The 27 candidates are a review packet, not an approval. They remain
  unapplied, and the packet says so on its first line.

The candidate set is unchanged from Phase 5: D25
`pt_goals.motivation_level` from
`pt_lifestyle_assessments.motivation_to_exercise`, where the active goal row
exists and the column is `NULL`.

## 4. Ownership enforcement in CI

`scripts/phase6-ownership-guard.js` scans source, not a database, so it runs in
the lint job with no services.

| Rule | Failure it prevents |
|---|---|
| No new write to `pt_os_measurements` or `client_fitness_profiles` | A retired table coming back to life |
| No new write to a legacy `pt_clients` fact (`weight`, `height`, `goal`, `health_conditions`, `injuries`, `occupation`, `workout_experience_level`) | A form quietly re-creating the duplicate the matrix just retired |
| No new legacy-table read outside the baseline | A new consumer coupling itself to the old copy |
| No new direct AI client-fact SQL in the AI surfaces | A second, unaudited answer to "what do we know about this client" |
| A baseline entry whose code is gone is a failure | A baseline that only grows and stops describing reality |

Current result: **343 files scanned, 23 registered dependencies, PASS** (exit
0). The register is `scripts/phase6-legacy-read-baseline.json`:

| Section | Count | Meaning |
|---|---:|---|
| `legacy_reads` | 11 | 6 `pt_os_measurements`, 5 `client_fitness_profiles`, each with owner, reason and sunset |
| `legacy_writes` | 2 | The Fitness Testing cache sync for `pt_clients.weight` and `height` |
| `ai_direct_reads` | 10 | Bounded progress/history reads in `ai.js`, the `find_client` goal fallback, and the generator repo's shared fact sources |

No read was removed in Phase 6. Removing a read without production evidence
would risk dropping a fact some studio depends on; the honest alternative is to
keep it labelled, register it, and let the guard prevent the next one. The
sunset column states what must be true before each entry can go.

CI wiring:

- `.github/workflows/ci.yml`, lint job → `node scripts/phase6-ownership-guard.js`
  (no database).
- `.github/workflows/ci.yml`, test job → the guarded audit against
  `phase4_shape` with `--org` scoped to ORG_A, alongside the existing Phase 4
  gate and Phase 5 report.
- `package.json` → `npm run guard:ownership`, `npm run audit:phase6`.

## 5. Consumer verification

The question is not "does any code mention a legacy table" — 23 do, by
design. It is "does every consumer that *writes* a fact write it to the
canonical owner, and does every read that still touches a legacy copy say so
and prefer the owner?"

| Surface | Canonical path | Legacy dependency | Status |
|---|---|---|---|
| Member measurements (`GET /api/me/measurements`) | `pt_assessments` first (`source: 'assessment'`) | `pt_os_measurements` (`trainer`) and `weekly_checkins` (`checkin`) as labelled fallbacks | Verified in Phase 5; read is baselined |
| Member goals (`GET/POST/DELETE /api/me/goals`) | `pt_goals` via `member-goals.service.js` | `pt_os_measurements` weight fallback | Baselined |
| Trainer client profile / snapshot | `loadClientSources` → `pt_assessments`, `pt_goals`, PAR-Q, lifestyle, nutrition, interview | `pt_os_measurements` history, `client_fitness_profiles` fallback | Baselined with sunset |
| Training brief | `client-read.service.js` → `loadClientSources` (`clinical`, `training`) | None of its own | Canonical |
| Client agent (portal assistant) | `client-read.service.js` → `loadClientSources` | None of its own | Canonical |
| AI workout/diet context | `loadClientSources` with `generator: true` (`routes/ai.js:418`) | Bounded progress reads and `client_fitness_profiles` fallbacks | 10 AI reads baselined |
| AI client facts | `client-facts.js` named-column resolver | `client_fitness_profiles` and `pt_clients` fallbacks, logged as `ownership.deprecated_read` | Baselined |
| Diet fitness-profile endpoint | `GET/PUT /api/diet/fitness-profile/:clientId` | Reads `client_fitness_profiles`; the PUT refuses every write with 422 | Legacy read baselined; write retired by Phase 2 |
| Frontend measurements | `src/lib/api/endpoints/platform.ts:922` | None — HTTP only | Verified |
| Frontend goals | `platform.ts:1015-1018`, `progress.ts:37-45` | None — HTTP only | Verified |
| Frontend fitness profile | `training.ts:307-309` | Calls the legacy endpoint above | Verified as HTTP-only; endpoint dependency baselined |
| WhatsApp gateway | No database access | None | Unchanged from Phase 4 audit |

No consumer writes a fact to a legacy column. The only legacy write left is
the derive-from-newest-assessment cache sync, which is registered. Every
legacy read is either a labelled fallback that logs when it wins or a bounded
history read registered with a sunset condition.

## 6. Reversible migration and rollback

The procedure is `docs/implementation/PHASE6-BACKUP-ROLLBACK-RUNBOOK.md`. It
covers:

- **Backup** — the existing off-site `pg_dump` script, a checksum recorded in
  the change ticket, and a restore drill against a throwaway database with a
  row-count comparison. "The dump exists" is not accepted as evidence.
- **Read-only audit** — the wrapper in section 2, with the rule that output
  contains PII and stays on the restricted volume.
- **Backfill authorization** — dry run first, edited plan, SHA-256, named
  reviewer, `audit_log` verification, then re-audit.
- **Expand/contract schema removal** — four separate stages: stop reads and
  observe, drop retired tables, drop legacy columns, remove the baseline. No
  stage runs in the same release as the one before it.
- **Reversibility matrix** — per object: code rollback redeploys the previous
  image; data rollback restores from the dump; column drops are explicitly not
  reversible by code.
- **Rollback** — code-only path, data-incident path, and selective
  `pg_restore --table` with reconciliation.
- **Post-change verification** — guard, audit, real-DB and isolation suites,
  compared against the expected delta rather than "tests passed".

The runbook's own limitation is stated: the project is on the Supabase free
plan, so there is no automated daily backup and no PITR. A backup taken for
this change is the only restore point, with an RPO equal to the dump time.

## 7. Test evidence

| Suite | Result |
|---|---|
| Phase 6 ownership guard unit tests | **7/7 passed** — passes on the committed baseline; comments are not reads; a new retired-table read fails unless registered; a legacy `pt_clients` fact write fails; a direct AI `pt_clients.goal` query fails; a removed-but-registered read is stale; comment stripping keeps SQL strings |
| Phase 6 production-audit real-DB tests | **10/10 passed** — read-only preflight, artifact modes and hashes, 628-row conflict register with blank decisions, 27-row unauthorised backfill packet, NO-GO, fresh run directories, and four refusal paths |
| Phase 4 + Phase 5 + Phase 6 real-DB (`productionShape.phase4`, `phase5Reconciliation`, `phase6ProductionAudit`) | **39/39 passed** |
| RLS isolation + client portal real-DB | **57/57 passed** (`clientPortal.realDb` 31/31) |
| Analyzer on the full fixture | 981 legacy-only / 628 conflicts / 1,609 records / 27 candidates / validation ok |
| Backend regression | **436 suites / 7,329 tests** across four shards: 390 suites and 6,771 tests passed; 46 suites and 558 tests skipped by their own gates; **0 genuine failures**. Two `superAdmin` tests hit the 5-second Jest timeout under parallel CPU load; both suites passed 35/35 when re-run in isolation. |
| Frontend regression | **302 files / 5,643 tests**: 300 files / 5,640 tests passed in the full run; two files (`workout-builder-weeks`, `today-sessions-card`) timed out on `findBy*` under the same load and passed **19/19** when re-run in isolation. 0 genuine failures. |
| TypeScript | `tsc --noEmit` exit 0 |
| ESLint | Backend `eslint . --max-warnings=0` exit 0; frontend exit 0 with **0 errors / 388 pre-existing warnings** |

Two load-induced timeouts are recorded rather than hidden: the machine ran four
Jest shards and the full Vitest suite concurrently, and both failures are
`findBy*`/5-second timeouts in files this phase did not touch. Isolated re-runs
are the evidence that they are not regressions. A CI run does not reproduce
that contention.

### 7.1 Commands

```bash
# Ownership guard (no database)
node scripts/phase6-ownership-guard.js

# Phase 6 suites + all real-DB gates
PHASE4_SHAPE_DATABASE_URL='postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
  NODE_OPTIONS=--experimental-vm-modules TZ=UTC \
  npx jest productionShape.phase4 phase5Reconciliation phase6ProductionAudit \
  --runInBand --forceExit

RLS_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55432/rls_proof?sslmode=disable' \
  NODE_OPTIONS=--experimental-vm-modules TZ=UTC \
  npx jest rls.isolation.integration clientPortal.realDb --runInBand --forceExit

# Full regression
NODE_OPTIONS=--experimental-vm-modules TZ=UTC npx jest --shard=i/4 --forceExit   # i = 1..4
cd ../619-erp-frontend && npx vitest run && npx tsc --noEmit && npx eslint .
```

## 8. Changed files

| File | Change |
|---|---|
| `619-erp-backend/scripts/phase6-production-audit.js` | New guarded production audit wrapper and manifest generator |
| `619-erp-backend/scripts/phase6-decisions.js` | New decision register and backfill review packet generator |
| `619-erp-backend/scripts/phase6-ownership-guard.js` | New CI source guard |
| `619-erp-backend/scripts/phase6-legacy-read-baseline.json` | New 23-entry baseline with owner, reason and sunset |
| `619-erp-backend/src/__tests__/phase6ProductionAudit.realDb.integration.test.js` | New real-DB suite (10 tests) |
| `619-erp-backend/src/__tests__/phase6OwnershipGuard.test.js` | New guard suite (7 tests) |
| `619-erp-backend/.github/workflows/ci.yml` | Guard in lint job; guarded fixture audit in test job |
| `619-erp-backend/package.json` | `guard:ownership`, `audit:phase6` |
| `docs/implementation/PHASE6-BACKUP-ROLLBACK-RUNBOOK.md` | New operational runbook |
| `docs/implementation/PHASE6-PRODUCTION-READINESS-REPORT.md` | This report |
| `docs/specs/CLIENT-ASSESSMENT-FIELD-MATRIX.md` | §17 ownership enforcement |
| `docs/implementation/CLIENT-ASSESSMENT-IMPLEMENTATION-ROADMAP.md` | Phase 6 status and execution note |

No migration, schema, data or production file was changed.

## 9. Remaining blockers

| Blocker | Why it blocks | What unblocks it |
|---|---|---|
| No production evidence | Fixture counts cannot prove whether a live client's only copy of a fact is legacy | Supply a read-only production dump/replica or `PRODUCTION_READ_ONLY_DATABASE_URL`, then run the wrapper |
| 628 decisions blank | A conflict needs a named human decision; the register intentionally cannot invent one | Reviewer fills `decision`, `reviewer`, `reviewed_at`, `rationale` |
| 27 candidates unauthorised | Applying them changes live data | Reviewer signs the plan hash; operator runs the guarded apply workflow |
| Legacy reads still present | Removing them without production evidence risks data loss. The D1–D25 audit does not cover `pt_os_measurements` or every profile-only column | Run the targeted read-only comparison for those tables, retire one baseline entry at a time, and observe a release without it |
| No PITR | The free plan has no point-in-time recovery | Accept the dump RPO in writing or move to a plan with PITR before any destructive step |

## 10. Schema-removal decision

**NO-GO.**

The gate is deliberately conjunctive:

1. The production audit shows **zero** legacy-only facts, or every remaining
   one has been applied through the reviewed backfill workflow with an
   `audit_log` row.
2. Every one of the 628 conflicts has a named decision, and the register shows
   no blank decision.
3. Every legacy read has been removed from code and from the baseline, and one
   release has been observed without it.
4. The guard passes with zero legacy writes and zero legacy reads.
5. A verified backup and a successful restore drill exist for the change
   window.
6. The release manager and data reviewer have signed the approval record in
   the runbook.

Today, conditions 1–3 are false, condition 4 is true only because the
allowlisted cache write remains, and conditions 5–6 have not been attempted
because there is nothing safe to apply. Dropping `pt_clients.goal`,
`pt_clients.health_conditions`, `client_fitness_profiles` or
`pt_os_measurements` now would erase facts that exist nowhere else for part of
the fixture population — and the fixture is the best evidence available.

The correct next action is not a migration. It is the production read-only
audit, then the decision register.

## 11. Reproduction notes

Fixture setup and the read-only audit:

```bash
cd 619-erp-backend
./scripts/phase4-shape-setup.sh

node scripts/phase6-ownership-guard.js

node scripts/phase6-production-audit.js \
  --url 'postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
  --confirm-host 127.0.0.1 \
  --acknowledge-production \
  --out-dir /tmp/phase6-audit
```

Production (after supplying a read-only credential):

```bash
node scripts/phase6-production-audit.js \
  --url "$PRODUCTION_READ_ONLY_DATABASE_URL" \
  --confirm-host db.example.com \
  --acknowledge-production \
  --out-dir /secure/audits/619-phase6
```

Phase 6 suites:

```bash
PHASE4_SHAPE_DATABASE_URL='postgres://postgres@127.0.0.1:55432/phase4_shape?sslmode=disable' \
NODE_OPTIONS=--experimental-vm-modules TZ=UTC \
npx jest src/__tests__/phase6OwnershipGuard.test.js \
  src/__tests__/phase6ProductionAudit.realDb.integration.test.js \
  --runInBand --forceExit
```

The run directory is disposable evidence until the decisions are recorded.
Because it contains client names and health values, do not commit it, do not
attach it to a ticket, and delete it under the retention policy once the
register has been transcribed.

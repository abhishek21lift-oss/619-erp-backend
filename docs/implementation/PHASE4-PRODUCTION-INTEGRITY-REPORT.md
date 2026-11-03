# Phase 4 — Production Data Integrity & Final Verification

| Field | Value |
|---|---|
| Date | 2026-11-03 |
| Scope | Verify the D1–D25 ownership architecture against production shape, all consumers, tenant isolation, history, recovery, cache consistency, and AI provenance. No schema change. |
| Verdict | **PASS on the synthetic production-shaped fixture. BLOCKED for real production data and for member-measurements parity. NO-GO for schema removal.** |
| Production mutations | None. The audit ran in `BEGIN TRANSACTION READ ONLY`; every test ran against local Docker databases. |

## 1. What "production-shaped" means here — and what it does not

No production dump was supplied for this phase. The evidence below comes from `phase4_shape`: a database restored from a `pg_dump` of the real schema and migrations, then seeded by `scripts/phase4-seed-shape.sql` with a synthetic population designed to reproduce the shapes the ownership rules must survive:

- 540 clients across two studios (500 / 40), named `P4-###`
- 722 assessments, 243 goals, 1,458 check-ins, 270 fitness profiles, 162 legacy measurement rows
- 14 soft-deleted clients
- rich clients, legacy-only clients, deliberate owner/legacy conflicts, records older than a year
- assessments and check-ins typed months after the event they describe
- same-date assessment ties, duplicate active goals, draft-only PAR-Q, identity-only clients

This fixture is **synthetic**. It reproduces production *shapes*, not production *provenance*. Criterion 1 therefore stays BLOCKED until a real dump is supplied.

Fixture artifact: `/tmp/opencode/phase4-production-shape.sql` (2.1 MB, `pg_dump --no-owner --no-privileges`).

## 2. Criterion results

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Ownership architecture against a real production dump | **BLOCKED** | No production dump supplied. The suite passes against the synthetic production-shaped fixture (22/22). |
| 2 | D1–D25 missing / conflicting / stale / legacy-only audit | **PASS on fixture; production prevalence BLOCKED** | Read-only audit completed all 25 registers; no query failed. Totals: 4,149 owner present, 981 legacy-only, 628 conflicting, 53 stale. |
| 3 | Tenant isolation and cross-tenant protection | **PASS** | Phase 4 tenant cases plus `rls.isolation.integration.test.js` 26/26 as the real `app_tenant` role. Foreign and soft-deleted clients are unreachable through every consumer. |
| 4 | RLS enabled and policied on every table the architecture reads | **PASS** | 15/15 tables have `relrowsecurity = true` and at least one policy; `app_tenant` has `rolbypassrls = false`, `rolsuper = false`. |
| 5 | Historical assessment integrity | **PASS** | Content date beats typing date; a late-typed test cannot become current; same-date ties follow insertion time; deleting the newest test falls back to the previous one. |
| 6 | Audit trails | **PASS** | `client.delete` audit row verified in Phase 4; `assessment.delete` actor/identity/new-data and retest re-pointing re-run in `assessmentIntegrity.phase0.realDb.integration.test.js` (4/4). |
| 7 | Deletion recovery | **PASS** | Soft-deleted client retains child history, disappears from all reads, and becomes readable again on restore. Assessment hard delete is audited and the body cache falls back. |
| 8 | Cache consistency | **PASS** | `syncClientBodyFromLatest` follows the same newest-test rule; a backdated insert cannot move `pt_clients.weight/height` backwards; no assessment leaves the last known body untouched. |
| 9 | Frontend consumers | **PASS** | Frontend reads HTTP endpoints only (`src/lib/api/endpoints/ptOs.ts`: training brief, snapshot, coach); no database client and no direct table access. |
| 10 | API consumers (trainer, coach, agent) | **PASS** | Training brief, snapshot, client agent tools, and PT-OS context routes use `loadClientSources` / `client-read.service`. |
| 11 | Member measurements endpoint parity | **BLOCKED** | `/api/me/measurements` still reads `pt_os_measurements` + check-ins, not `pt_assessments`. Documented legacy reader and schema-removal blocker. |
| 12 | WhatsApp consumer | **PASS** | Gateway has no database driver and no client-table reads; backend WhatsApp code reads no client tables. |
| 13 | AI consumers | **PASS** | `routes/ai.js` resolves through `loadAuthoritativeClient`; the generator, digital twin, coach, and client agent share the loader. |
| 14 | AI provenance, stale warnings, disputed values | **PASS** | Stale (>365 days), conflicting owners, draft-only PAR-Q, and missing facts reach the prompt labelled; no averaging or invention. |
| 15 | Documentation updated to enforced behaviour | **PASS** | `docs/specs/CLIENT-ASSESSMENT-FIELD-MATRIX.md` §16 and the roadmap status/execution note. |
| 16 | Legacy-data migration and schema-removal readiness | **PASS (report delivered; conclusion NO-GO)** | §9 below. No column drop is authorised. |
| 17 | Safe verification and fixes | **PASS** | Two consumer reads that preferred the legacy measurement log were moved onto canonical assessments, with tests. |
| 18 | Full regression, real-DB integration, TypeScript, ESLint | **PASS** | Backend 388 suites / 6,760 tests; frontend 302 files / 5,643 tests; `tsc` 0; ESLint 0 errors. Details in §7. |
| 19 | No production mutation or destructive rewrite | **PASS** | Audit read-only; all test writes confined to local `phase4_shape` / `rls_proof`; test transactions rolled back. |

## 3. D1–D25 audit

The audit ran inside `BEGIN TRANSACTION READ ONLY` with `SET LOCAL statement_timeout = '60s'` and a savepoint per check. `conflict` means both records hold a value and disagree. `legacy-only` means the owner is missing and only a legacy copy holds the fact. `stale` means the owner value is older than 365 days.

| # | Data point | Owner | Owner present | Legacy-only | Conflict | Stale |
|---|---|---|---:|---:|---:|---:|
| D1 | Client identity at signing | Consent / PAR-Q snapshot | 272 | 0 | 0 | 0 |
| D2 | Emergency contact / phone | Consent / PAR-Q snapshot | 272 | 0 | 0 | 0 |
| D3 | Height / weight / BMI | Fitness Testing | 316 | 53 | 52 | 53 |
| D4 | Goal | Goal Assessment | 210 | 53 | 52 | 0 |
| D5 | Health conditions | PAR-Q | 104 | 211 | 52 | 0 |
| D6 | Injuries | PAR-Q history / Interview narrative | 52 | 53 | 52 | 0 |
| D7 | Workout experience | Add Client / enrolment | 263 | 0 | 52 | 0 |
| D8 | Occupation | Lifestyle | 210 | 53 | 52 | 0 |
| D9 | Screen time | Lifestyle | 210 | 0 | 52 | 0 |
| D10 | Sleep hours | Lifestyle | 158 | 0 | 0 | 0 |
| D11 | Smoking | Lifestyle | 210 | 0 | 52 | 0 |
| D12 | Alcohol | Lifestyle | 210 | 0 | 52 | 0 |
| D13 | Water intake | Nutrition | 158 | 0 | 0 | 0 |
| D14 | Meal frequency | Nutrition | 210 | 52 | 0 | 0 |
| D15 | Meal regularity | Interview | 210 | 0 | 0 | 0 |
| D16 | Food preferences | Nutrition | 210 | 52 | 0 | 0 |
| D17 | Training days | Interview availability / Goal prescription | 210 | 53 | 52 | 0 |
| D18 | Sit-and-reach | Fitness Testing | 4 | 105 | 0 | 0 |
| D19 | 1RM | Fitness Testing / Strength Tracking | 1 | 3 | 1 | 0 |
| D20 | Consent attestations | Informed Consent | 2 | 2 | 2 | 0 |
| D21 | Medical clearance | PAR-Q gate + Consent physician block | 1 | 1 | 1 | 0 |
| D22 | Workout experience in programming | client-facts precedence | 263 | 0 | 52 | 0 |
| D23 | Medical conditions in Nutrition | PAR-Q | 52 | 210 | 0 | 0 |
| D24 | `pt_clients.occupation` | Lifestyle | 210 | 53 | 52 | 0 |
| D25 | Motivation to exercise | Goal | 131 | 27 | 0 | 0 |
| | **Totals** | | **4,149** | **981** | **628** | **53** |

No audit check failed. A conflict is not automatically corruption: old rows written before the ownership move, and deliberate snapshot drift (D1/D2), are expected. The 981 legacy-only rows are the real cleanup population: facts that exist only in a deprecated copy.

Artifacts: `/tmp/opencode/phase4-audit.md`, `/tmp/opencode/phase4-audit.json`.

## 4. What the real-database suite proved

`productionShape.phase4.realDb.integration.test.js` — 22/22 passing in ~6.9 s against `phase4_shape`.

- **Canonical agreement wholesale.** For every canonical-rich fixture client (140+), the training brief reports the same height, weight, and `as_of` date the database says is newest. The snapshot agrees on a deterministic tenth of the same set.
- **Content date beats typing date.** P4-006's newest *typed* assessment is the older test; both the brief and the AI loader still resolve the newer test. P4-007's late-typed check-in does not out-rank the newer week.
- **Ties.** Two assessments on the same date resolve to the later insertion for the loader, the cache, and the snapshot.
- **Goals.** Two active goals resolve consistently to the newest one in the loader and `client-facts`.
- **Tenant isolation.** A foreign client returns `null`/`not found` through the loader, brief, snapshot, and AI; the reverse direction is also blocked. Soft-deleted clients are invisible while their child rows remain.
- **RLS metadata and role.** All 15 read tables are RLS-enabled and policied; `app_tenant` cannot bypass RLS.
- **Deletion and recovery.** Restoring a soft-deleted client makes retained history readable. Deleting the newest assessment re-points the cache to the previous test. A backdated insert cannot move the cache backwards; deleting all assessments leaves the last known body.
- **Provenance.** A record older than a year is marked `STALE; confirm with the client`; two owners disagreeing produce `DISPUTED` with both values and no averaging; a draft PAR-Q answers nothing while the legacy list still resolves; an identity-only client reports missing facts rather than inventing them.
- **Consumers.** A member weight goal reads canonical assessments when the legacy log is empty; Transformations reports an assessment-only client with the correct start, current, change, and reading count.

Separate proofs:

- `rls.isolation.integration.test.js` — 26/26 as the real `app_tenant` role.
- `assessmentIntegrity.phase0.realDb.integration.test.js` — 4/4, including `assessment.delete` audit content and retest re-pointing.

## 5. Consumer validation

| Surface | Finding |
|---|---|
| Frontend | `src/lib/api/endpoints/ptOs.ts` calls `/training-brief`, `/snapshot`, and `/coach`. No Supabase client, no database driver, no direct table access in application code. The `pt_*` names in frontend types/components are API-shape fields, not SQL. |
| Backend API | `client-read.service.js`, `authoritative-client.js`, and `client-agent/tools.js` are the read paths for brief, snapshot, coach, and agent tools. PT-OS context routes at `pt-os.routes.js` use `loadClientSources`. |
| WhatsApp | The gateway package has no `pg`/database dependency and no client-table reads. Backend WhatsApp paths do not read client tables. |
| AI | `routes/ai.js` and `client-facts.js` resolve one canonical context. Provenance, stale flags, conflicts, and missing facts are prompt-visible. |
| Member measurements | **Known exception.** `/api/me/measurements` still reads `pt_os_measurements` + `weekly_checkins` and not `pt_assessments`. It can disagree with the trainer's canonical body. Documented as a schema-removal blocker. |

## 6. Safe fixes made in this phase

Both were consumers that still treated the legacy measurement log as the primary body source.

1. `member-goals.service.js` — `weightSeries` now unions `pt_assessments` (canonical), `pt_os_measurements` (legacy fallback), and `weekly_checkins`, oldest first. A fitness test wins a same-day tie, then the member's own weigh-in, then the legacy log. This fixes a member weight goal showing no series for a studio that only runs assessments.
2. `pt-os.service.js` — `getTransformations` now ranks a union of assessments and legacy measurements, scoped through the `pt_clients` join. Assessment-only clients no longer appear with empty start/current columns; `measurement_count` now means readings from either source.

Each fix has a Phase 4 real-DB case; `transformations.test.js` also guards that both sources remain in the SQL.

## 7. Regression evidence

| Check | Result |
|---|---|
| Backend Jest, 4 shards, `--runInBand` | **388 suites passed, 45 skipped, 0 failed; 6,760 tests passed, 543 skipped, 0 failed** |
| Backend real-DB suites (run separately with env) | Phase 4 22/22; RLS 26/26; Phase 0 integrity 4/4 |
| Frontend Vitest | **302 files passed, 5,643 tests passed, 0 failed** |
| Frontend `tsc --noEmit` | **0 errors** |
| Frontend ESLint | **0 errors, 388 warnings** (pre-existing warning backlog) |
| Backend ESLint | **0 errors, 0 warnings** |

Skipped backend suites are the env-gated real-database suites; they self-skip when `RLS_TEST_DATABASE_URL` / `PHASE4_SHAPE_DATABASE_URL` are unset. They passed when run explicitly above.

## 8. Residual risks and blockers

1. **No production provenance.** The fixture is synthetic. Production prevalence of legacy-only, conflicting, and stale facts is unknown. This is the only BLOCKED criterion.
2. **The Phase 4 suite is not wired into CI.** `productionShape.phase4.realDb.integration.test.js` self-skips without `PHASE4_SHAPE_DATABASE_URL`; CI currently sets only `RLS_TEST_DATABASE_URL`. A CI job must restore a fixture dump and set the variable, or the proof will silently disappear.
3. **`/api/me/measurements` remains a legacy reader** and can show a different body from the trainer's canonical assessment. It is a schema-removal blocker and the one known consumer exception.
4. **Tie-break mismatch at identical timestamps.** The loader orders `assessment_date DESC, created_at DESC`; the cache writer and progress listing add `id DESC`. The fixture does not produce identical timestamps on the same date, so this is a theoretical divergence, not an observed failure. Align before contract.
5. **`pt_os_measurements` has no `organization_id` and no current writer.** It is reachable only through `pt_clients`. Its schema is not defined in this repo's migrations; keep treating its shape as unverified.
6. **Four duplicate columns remain text arrays** (`food_preferences`, `diet_preferences`, `medical_conditions`, `health_conditions`). No schema change was made.
7. **`pt_clients.weight`/`height` remain a cache** that legacy readers may fall back to when no assessment exists. That is intended, but it means cache divergence is still possible in reads that bypass the canonical loader.
8. **Frontend warnings.** 388 ESLint warnings remain; they are not introduced by this phase and are not errors.

## 9. Schema-removal go/no-go

**NO-GO for any column drop, rename, or destructive migration.**

Reasons, in order of weight:

1. On the synthetic fixture alone, **981 duplicate-register rows hold facts only in legacy copies**. Dropping those columns would erase real data for a studio that never wrote the owner. Production could be better or worse; it has not been measured.
2. **628 conflicting rows** need a reviewed, domain-by-domain decision, not an automatic "owner wins" sweep. D1/D2 snapshot drift is expected; D3/D4/D8 goal and body conflicts are cleanup candidates.
3. `/api/me/measurements` still depends on the legacy measurement table, and its shape is not migration-defined.
4. The timestamp tie-break is not yet identical between the loader and the cache writer.

A future contract step is gated on all of the following:

- a production read-only audit showing zero legacy-only facts, or a reversible backfill reviewed per field;
- `/api/me/measurements` retired or moved to assessments;
- `pt_os_measurements` readers and writer status resolved;
- loader/cache tie-break aligned;
- parity run on a production snapshot, with a rollback export.

Until then, the correct posture is additive and read-only: keep the columns, keep the read fallbacks, and keep logging deprecated reads.

## 10. Recommendation

- **GO** to ship the two consumer fixes, the Phase 4 suite, the audit tool, and the documentation updates.
- **GO** to continue using the canonical loader and the existing legacy fallbacks.
- **BLOCKED** on real production evidence: obtain a sanitized `pg_dump`, restore it into an isolated database, run `scripts/phase4-audit-ownership.js` and the Phase 4 suite, and record the result before making any claim about production data quality.
- **NO-GO** on schema cleanup.

## 11. Evidence index

| Artifact | Location |
|---|---|
| Fixture dump | `/tmp/opencode/phase4-production-shape.sql` |
| Fixture seed | `619-erp-backend/scripts/phase4-seed-shape.sql` |
| D1–D25 audit tool | `619-erp-backend/scripts/phase4-audit-ownership.js` |
| Audit report / JSON | `/tmp/opencode/phase4-audit.md`, `/tmp/opencode/phase4-audit.json` |
| Phase 4 suite | `619-erp-backend/src/__tests__/productionShape.phase4.realDb.integration.test.js` |
| RLS suite | `619-erp-backend/src/__tests__/rls.isolation.integration.test.js` |
| Phase 0 integrity suite | `619-erp-backend/src/__tests__/assessmentIntegrity.phase0.realDb.integration.test.js` |
| Field matrix enforcement section | `docs/specs/CLIENT-ASSESSMENT-FIELD-MATRIX.md` §16 |
| Roadmap status | `docs/implementation/CLIENT-ASSESSMENT-IMPLEMENTATION-ROADMAP.md` |

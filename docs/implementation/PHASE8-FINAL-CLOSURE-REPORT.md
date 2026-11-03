# Phase 8 — Final Closure: Client Data Integrity and Ownership

| Field | Value |
|---|---|
| Date | 2026-11-03 |
| Scope | Close the Phase 0–7 client-data ownership programme: D1–D25 register, writers and readers, tenant isolation, audit trail, historical integrity, provenance, backup/restore, migration safety, CI guard and test coverage. |
| Verdict — code | **PASS.** All safe, non-destructive fixes are implemented and verified. |
| Verdict — production migration | **BLOCKED.** No production dump, replica or read-only credential was supplied. |
| Verdict — schema removal | **NO-GO.** Fixture evidence only; conflicts, legacy-only facts and seven ownerless columns remain undecided. |
| Production mutations | **None.** No production write, backfill, migration, column drop or table drop was executed. |
| Evidence class | **Fixture only.** Every count marked "fixture" comes from the synthetic `phase4_shape` database. No production verification is claimed. |

This report closes the programme. It does not authorize a production change.
The decision gates are in §17 and §18.

---

## 1. What Phase 8 set out to do

Phases 4–7 proved that the ownership model works on a synthetic
production-shaped fixture, and repeatedly reported the same three blockers:
no real-production evidence, 27 unauthorized backfill candidates, and 628
conflicts with blank reviewer decisions. Phase 8 audits the parts those phases
did not cover — the consumers a SQL guard cannot see, the audit trail, the
seven ownerless columns, and the tests that silently skip — and then issues the
final verdict without pretending the blockers are gone.

The governing rule for every change in this phase: **a fix is allowed only if
it is additive, non-destructive, backward compatible, and proven by a test.**

---

## 2. Method

- Every claim was checked against source or a live database query. Phase 4–7
  reports were treated as claims to verify, not as evidence.
- The local `phase4_shape` database is the only data source. It is a synthetic
  fixture, built by `scripts/phase4-seed-shape.sql` on the real migration
  chain. It is not a production copy.
- Reads and writes were enumerated by SQL and by object-field access. The
  static ownership guard only sees SQL text, so the object-field register in
  §7 was compiled by hand.
- No file was deleted. No column, table or row was removed.
- The one production-shaped operation performed was a full dump and restore
  into a throwaway database (`phase6_restore_drill`), which proves the
  procedure, not production.

---

## 3. D1–D25 final status

Status legend:

- **Closed** — owner and reader precedence documented, no further action.
- **Closed with fallback** — owner is canonical, the legacy copy is read-only
  and registered, retention deferred to production evidence.
- **Open — product decision** — no canonical owner exists.

| # | Data point | Canonical owner (verified writer) | Legacy read | Status |
|---|---|---|---|---|
| D1 | Identity at signing | PAR-Q / Consent snapshot at creation only | — | Closed |
| D2 | Emergency contact / phone | `pt_clients` live; PAR-Q / Consent snapshot | — | Closed |
| D3 | Height / weight / BMI | Fitness Testing (`pt_assessments`) | `pt_clients` cache, `weekly_checkins.weight`, `client_fitness_profiles.height_cm` | Closed with fallback |
| D4 | Goal | Goal Assessment (`pt_goals`) | `pt_clients.goal` | Closed with fallback |
| D5 | Health conditions | PAR-Q | `pt_clients.health_conditions`, Nutrition notes | Closed with fallback |
| D6 | Injuries | PAR-Q medical history; Interview current narrative | `pt_clients.injuries` | Closed with fallback |
| D7 | Workout experience | Client enrolment (`pt_clients.workout_experience_level`) | Lifestyle copy | Closed with fallback |
| D8 | Occupation | Lifestyle | `pt_clients.occupation`, Interview, PAR-Q, consent snapshot | Closed with fallback |
| D9 | Screen time | Lifestyle | Interview | Closed with fallback |
| D10 | Sleep hours | Lifestyle | Interview, PAR-Q | Closed with fallback |
| D11 | Smoking | Lifestyle | Interview, PAR-Q | Closed with fallback |
| D12 | Alcohol | Lifestyle | Nutrition | Closed with fallback |
| D13 | Water intake | Nutrition | Lifestyle, PAR-Q | Closed with fallback |
| D14 | Meal frequency / breakfast / late night | Nutrition | Lifestyle | Closed with fallback |
| D15 | Meal regularity | Interview | Nutrition `meal_timing_consistency` | Closed with fallback |
| D16 | Food preferences | Nutrition | Lifestyle `food_preferences` | Closed with fallback |
| D17 | Training days | Three distinct facts: Interview availability, Goal prescription, `pt_clients.sessions_per_week` fallback | `client-facts` precedence | Closed |
| D18 | Sit-and-reach | Fitness flexibility | Mobility `sit_reach_cm` | Closed with fallback |
| D19 | 1RM | Fitness strength test; Strength Tracking by `assessment_id` | — | Closed |
| D20 | PAR-Q vs informed consent | Two separate legal artefacts | Historical PDFs | Closed |
| D21 | Medical clearance | PAR-Q clearance and Consent clearance are two distinct gates | — | Closed |
| D22 | Experience in programming | `client-facts` precedence | Profile + Lifestyle | Closed |
| D23 | Medical conditions in Nutrition | PAR-Q | Nutrition notes only | Closed with fallback |
| D24 | `pt_clients.occupation` | Lifestyle | Add Client, Interview, PAR-Q, consent snapshot | Closed with fallback |
| D25 | Motivation | Goal `motivation_level` | Lifestyle copy | Closed with fallback |

No D-row required a schema change in this phase. Every "fallback" row keeps
its column and its reader; none is removed without production evidence.

---

## 4. Writer audit

Every canonical write path was traced to source. The result is single-path for
each assessment type:

| Fact | Writer | Endpoint |
|---|---|---|
| Fitness assessment | `progress/assessments.repo.js` | `/api/progress/assessments` |
| Goal | `progress/progress.routes.js` → `pt_goals` | `/api/progress/goals` |
| PAR-Q / consent | `pt-os/parq.routes.js` | `/api/pt-os/parq/forms` |
| Lifestyle | `progress/assessments.repo.js` | `/api/progress/lifestyle-assessments` |
| Nutrition | `progress/assessments.repo.js` | `/api/progress/nutrition-assessments` |
| Interview | `pt-os/pt-os.routes.js` | `/api/pt-os/clients/:id/interview` |
| Mobility | `pt-os/pt-os.routes.js` | `/api/pt-os/clients/:id/mobility` |
| Strength | `progress` strength routes | `/api/progress/strength-tracking` |

`pt_clients.weight` and `pt_clients.height` have exactly one writer: the cache
sync in `syncClientBodyFromLatest`, called after an assessment create, update
or delete. Both are registered as the only permitted legacy writes in the
ownership baseline.

**Shared writes are not duplicate writes.** Three `pt_clients` surfaces have
two legitimate actors, not two representations:

- `photo_url` — trainer upload (`pt-os.routes.js:1253`, audited) and member
  upload (`client-portal.service.js:495`, now audited).
- `mobile` / `whatsapp` / `address` — trainer profile edit (`pt-os.routes.js`,
  audited) and member self-service (`/api/me/profile`, now audited).
- `status` — guarded lifecycle transitions (activation, screening gate,
  renewal, term expiry), each with its own precondition.

Nothing writes a D-row's canonical field from a second path.

---

## 5. Audit trail

`activity_log` is the business audit trail. Trainer-side client writes already
logged (`client.create`, `client.update`, `client.photo.update`,
`client.notes.update`, `client.delete`).

**Gap found and fixed.** Member self-service changed the same client record
without an audit entry. Two member paths were affected:

- `PATCH /api/me/profile` (mobile / WhatsApp / address)
- `POST /api/me/photo`, `DELETE /api/me/photo`

`updateMyContact` now reports whether anything actually changed, and the route
writes `client.contact.update` with the field names only when it did. Photo
set and remove write `client.photo.update` with `photo_updated` /
`photo_removed`. The `changed` flag is stripped from the API response so the
member-facing shape is unchanged.

Audit writes stay fire-and-forget: a failed log never undoes the member's own
correction, matching the existing `logActivity` contract.

---

## 6. The seven ownerless `pt_os_measurements` columns

Phase 7 named seven populated-in-schema columns with no canonical owner. Phase
8 resolved each one by grepping the whole workspace, not just the backend:

| Column | Writer | Explicit reader | Fixture rows populated | Decision |
|---|---|---|---|---|
| `shoulders_cm` | None | `client-portal.routes.js` `/measurements` → member progress page | 0 | Retain read-only |
| `assignment_id` | None | None found | 0 | Retain read-only |
| `photo_front_url` | None | None found | 0 | Retain read-only |
| `photo_side_url` | None | None found | 0 | Retain read-only |
| `photo_back_url` | None | None found | 0 | Retain read-only |
| `notes` | None | None found | 0 | Retain read-only |
| `measured_by` | None | None found | 0 | Retain read-only |

All seven are **0 populated in the fixture**. Because production may differ,
no column is dropped and no backfill is written. The table itself is retained
as a labelled legacy source (`source: 'trainer'`) behind the member timeline.
Removal remains a product decision that needs a production value count first.

`shoulders_cm` is the only column with a live consumer, so a future drop would
be a visible product change, not a silent cleanup.

---

## 7. Legacy consumer register (beyond the SQL guard)

The static guard (`scripts/phase6-ownership-guard.js`) matches table names per
file. It does **not** see object-field reads of `pt_clients` columns. Phase 8
compiled those by hand. Each is a read-only fallback with a named owner:

| Consumer | Legacy read | Why it is legitimate |
|---|---|---|
| `pt-os/client-facts.js` | `pt_clients.weight`, `height`, `goal`, `workout_experience_level`; `client_fitness_profiles.height_cm`, `goal`, `fitness_level` | Canonical-first resolver; every fallback use emits `ownership.deprecated_read` with owner, source and client id. |
| `routes/ai.js` `resolveDietInputs` | `client.weight`, `client.height`, `weekly_checkins.weight`, `profile.height_cm` | Logged fallbacks; assessment wins when present. |
| `routes/ai.js` `resolveWorkoutExtras` | `client.injuries`, `profile.injuries`, `client.health_conditions`, `profile.health_conditions` | Logged fallbacks to PAR-Q. |
| `pt-os/client-snapshot.js` + `pt-os.routes.js:2036` | `c.goal`, `c.injuries`, `c.workout_experience_level` | Read-only AI context; `client-facts` owns precedence. |
| `pt-os/workout-generator.repo.js` | `c.goal`, `c.workout_experience_level` as sources | Passed through `resolveClientFacts`; the generator itself receives resolved values only. |
| `pt-os/checkin-ai.js` | `c.weight` | Weekly check-in narrative fallback. |
| `pt-os/pt-os.service.js` | `c.weight`, `c.emergency_contact` | Display only. |
| `search/search.service.js` | `c.goal` | Search subtitle. |
| `lib/ptEnrollmentPdf.js` | `c.weight`, `c.goal` | Enrolment PDF; historical record. |
| `lib/formLinks.js` | `c.occupation` | Selected for the public form but not exposed in the payload; dead selection, harmless. |
| `client-portal/member-goals.service.js` | `pt_os_measurements.weight_kg` | Member weight history. |
| `pt-os/authoritative-client.js` | `pt_os_measurements`, `client_fitness_profiles` | AI source loader, additive. |

`workout-generator.js` reads `client.goal` and `client.experience`, but its
caller passes resolved facts — it is a pure function parameter, not a column
read. This distinction matters: a naive grep would register a false positive.

**Recommendation:** extend the guard with a small object-field allow-list, or
move these ten reads to a named accessor. This is a hardening task, not a
blocker: every read already has a canonical-first precedence and a sunset
condition in the matrix.

---

## 8. Tenant isolation and RLS

Verified against the live fixture schema, not the migrations alone.

- **163 public tables. 163 have `ROW LEVEL SECURITY` enabled.**
- Every table carrying `organization_id` has a tenant predicate.
  `ai_retrieval_log` is the one name difference: its policy is
  `ai_retrieval_log_tenant`, and it enforces the identical
  `organization_id::text = current_setting('app.org_id', true)` predicate on
  both `USING` and `WITH CHECK`.
- `pt_os_measurements` is tenant-scoped through its `pt_clients` join, which is
  the only correct scope because the table has no `organization_id` column.
  `client_fitness_profiles` is scoped directly by `organization_id`.
- `platform_owners` is intentionally global: RLS enabled, zero policies, so
  it is deny-all to tenant roles.
- Shared reference tables (`pt_plans`, `branches`, `receipt_counter`,
  `feature_flags`, `system_settings`, anatomy/exercise catalogues,
  `ai_model_rates`, `ai_provider_settings`, `audit_log`,
  `storage_accounting_meta`, `plan_features`) carry
  `tenant_shared_read USING (true)`. This is a deliberate read-sharing policy,
  **not** a tenancy hole: the app layer remains the write gate. Phase 8 did not
  change this because doing so would break platform-wide reference reads and
  requires an approved migration.
- `notification_log` is insert-only for `app_tenant`; it has no read policy.
- `audit_log` is a global platform table without `organization_id`; the
  platform console reads it through the owner connection.

**Isolation proof: 26/26 tests passed** against `rls_proof`
(`rls.isolation.integration.test.js`), including cross-tenant read and write
denials.

Residual risk: shared-reference `USING (true)` means a bug in an app-layer
write would be able to write across studios on those tables. Documented, not
changed without authorization.

---

## 9. Historical integrity and provenance

- PAR-Q, informed consent, goal starting values and assessment rows are
  snapshots. No Phase 8 change refreshes them.
- Conflicts are never auto-overwritten. `client-facts` returns the winner plus
  a `conflicts` array; the model and the UI are told a conflict exists.
- Every legacy fallback emits `ownership.deprecated_read` with field, owner,
  source and client id.
- Deletes are soft (`deleted_at`) or audited; the assessment cache is
  recomputed from the newest surviving row after a delete, using `MAX` not
  `COUNT`, so a deleted latest assessment cannot leave a stale cache.
- The Phase 7 scoped run is internally consistent: 3,100 populated cells,
  1,400 facts, 491 match + 509 conflict + 400 legacy-only = 1,400.

---

## 10. Backup, restore and rollback

Proven end to end on the local fixture. This proves the **procedure**; it is
not a production backup.

| Step | Command | Result |
|---|---|---|
| Dump | `BACKUP_DATABASE_URL=…phase4_shape BACKUP_DIR=/tmp/opencode/phase6-backup node scripts/backup-database.js` | `1.1 MiB`, **189 tables with data** |
| Restore into fresh DB | `node scripts/restore-drill.js <dump> <fresh-url> --compare <source-url>` | **163 tables**, **5,046 rows**, **162/162 source tables matched**, 12.8 s |
| Core counts | same | `organizations=3 users=3 pt_clients=540 pt_parq_forms=270 _migrations=269` |

The backup script refuses to write inside the repository and refuses to report
success below ~185 tables with data. It warns, correctly, that a same-host dump
is not off-site.

**Known limitation:** the Supabase free plan has no point-in-time recovery.
The dump is the only restore point, so RPO is "time since last manual dump".

Rollback by stage is documented in
`PHASE6-BACKUP-ROLLBACK-RUNBOOK.md`: code-only rollback for stage 1, table
restore for stage 2, full-database restore for stage 3.

---

## 11. Migration safety

No migration was written or applied in Phase 8. The schema-removal sequence
remains three separate releases:

1. stop reading (code only, reversible by redeploy),
2. drop the two retired tables (restorable from dump),
3. drop legacy columns (not reversible by redeploy).

The guard's baseline must shrink as reads are removed; the guard fails on a
stale entry, so the migration cannot be generated from memory.

---

## 12. CI and the ownership guard

`.github/workflows/ci.yml` runs, on every push and PR:

| Step | Purpose |
|---|---|
| `npm run lint -- --max-warnings=0` | Zero-warning ceiling |
| `node scripts/phase6-ownership-guard.js` | Fails on a new retired-table read/write, a new direct AI client-fact query, or a stale baseline entry |
| RLS database setup + full Jest | Real tenant-isolation suite |
| Phase 4 shape setup + gate | Production-shape gate, named red step |
| Phase 5 reconciliation report | Read-only report and review plan |
| Phase 6 guarded audit against the fixture | Proves the production wrapper, read-only |
| WhatsApp gateway seam job | Cross-repo HTTP contract |

Guard status on final code: **343 files scanned, 23 registered dependencies,
`ok: true`.** A completeness test asserts all 23 entries carry owner, reason
and sunset.

**Guard limits, stated plainly:**

- It matches a table name per file, not per statement. Object-field reads
  (§7) and dynamically composed SQL evade it.
- It does not prove that a canonical writer is the *only* writer; the writer
  audit in §4 does.
- It does not run against production.

---

## 13. Test coverage and skipped tests

- Backend: **437 test files.** No test uses `it.skip` / `test.skip`; the only
  skips are **49 database-gated suites** that self-skip when their URL is
  absent.
- **44 of 49** fail loudly in CI when the env var is missing. The other five
  (`tenantReadSession`, `assessments.rollback`, `assessments.transaction`,
  `assessmentNumbering.concurrency`, `rls.overhead`) read
  `RLS_TEST_DATABASE_URL`, which CI sets — so they do run. The missing
  loud-fail guard is defense-in-depth only; no coverage is lost today.
- Frontend: no skipped or `.todo` tests. One historical comment mentions
  `process.exit`, not a skipped test.
- Two backend and two frontend load-sensitive suites were flaky under
  parallel load; they were given explicit load timeouts after reproducing
  their isolated passes. They now pass both in isolation and in the full run.
- Portal and member-wiring suites against a real migrated database: **38/38**.

---

## 14. Verification evidence

All commands run locally against the fixture databases
(`rls_proof`, `phase4_shape`) on 2026-11-03.

| Gate | Command | Result |
|---|---|---|
| Backend full suite, shard 1/4 | `npx jest --shard=1/4 --runInBand` | **110 suites, 1,514 tests — pass** |
| Backend full suite, shard 2/4 | `npx jest --shard=2/4 --runInBand` | **109 suites, 2,540 tests — pass** |
| Backend full suite, shard 3/4 | `npx jest --shard=3/4 --runInBand` | **109 suites, 1,716 tests — pass** |
| Backend full suite, shard 4/4 | `npx jest --shard=4/4 --runInBand` | **109 suites, 1,578 tests — pass** |
| **Backend total** | four shards | **437 suites, 7,348 tests — pass** |
| Ownership guard | `node scripts/phase6-ownership-guard.js` | **343 files, 23 registered, `ok: true`** |
| RLS isolation | `npx jest rls.isolation.integration` | **26/26 pass** |
| Portal + member wiring | `npx jest clientPortal.realDb memberTrainerWiring.realDb` | **38/38 pass** |
| Phase 6/7 focused | `npx jest phase6OwnershipGuard phase6ProductionAudit phase7LegacyColumnAudit` | **36/36 pass** |
| Backup | `node scripts/backup-database.js` | **1.1 MiB, 189 tables with data** |
| Restore drill | `node scripts/restore-drill.js … --compare` | **163 tables, 5,046 rows, 162/162 matched** |
| Frontend full suite | `npx vitest run` | **302 files, 5,643 tests — pass** |
| Frontend typecheck | `npx tsc --noEmit` | **exit 0** |
| Frontend ESLint | `npx eslint .` | **130 warnings, 0 errors** (CI ceiling 269, exit 0) |
| Backend ESLint | `npx eslint .` | **exit 0** |

**Local lint note.** A bare `npx eslint .` in the frontend first reported 388
warnings. The excess was `.worktrees/` — two full copies of the repo held as
local git worktrees, which ESLint linted because flat config does not ignore
dot-directories by default. After ignoring them the count is 130. `.worktrees/**` was
added to the ESLint ignores so a local run now matches CI; CI never checks out
those directories, so its result was already correct.

---

## 15. Changed files

Backend (Phase 8 additions in **bold**; earlier phases listed for the full
programme diff):

- `src/modules/client-portal/client-portal.service.js` — contact update
  returns `changed`; **photo/contact writers unchanged otherwise**
- `src/modules/client-portal/client-portal.routes.js` — **`client.contact.update`
  and `client.photo.update` audit events; `changed` stripped from response**
- `src/__tests__/clientPortal.realDb.integration.test.js` — **contact audit
  assertion**
- `src/__tests__/memberTrainerWiring.realDb.integration.test.js` — **photo
  audit assertion**
- Phase 4–7: `scripts/phase4-*`, `phase5-*`, `phase6-*`, `phase7-*`,
  `src/lib/fieldOwnership.js`, `src/modules/pt-os/authoritative-client.js`,
  `src/modules/pt-os/client-facts.js`, `progress/assessments.repo.js`,
  `progress/assessment-facts.js`, `progress/retests.*`, `routes/ai.js`,
  `routes/diet.js`, and the tests listed by `git status`
- `.github/workflows/ci.yml` — Phase 4/5/6 gates

Frontend: Phase 4–7 consumer updates (member progress page, goal assessment
types, nutrition assessment steps and types, program-design page, weight chart,
API types) and one Phase 8 tooling change — `eslint.config.mjs` now ignores
`.worktrees/**`. WhatsApp repository: no change; it has no database access.

Root `docs/`: this report plus matrix and roadmap updates. `docs/` is not a git
repository.

---

## 16. Risks and open decisions

| # | Risk / decision | Severity | Owner | State |
|---|---|---|---|---|
| R1 | No production evidence: all counts are fixture | **High** | Release manager | Blocked |
| R2 | 628 conflicts with blank decisions | **High** | Named reviewers | Blocked |
| R3 | 27 backfill candidates unauthorized | **High** | Product | Blocked |
| R4 | Seven ownerless columns may hold production values | Medium | Product | Open |
| R5 | Shared-reference RLS `USING (true)` relies on app-layer writes | Medium | Engineering | Documented |
| R6 | Object-field legacy reads are outside the static guard | Medium | Engineering | Documented |
| R7 | No PITR; dump-only restore point | Medium | Operations | Accepted |
| R8 | Guard matches table per file, not per statement | Low | Engineering | Documented |
| R9 | `formLinks` selects an unused `occupation` column | Low | Engineering | Deferred |
| R10 | Five DB-gated suites lack a loud-fail guard | Low | Engineering | Accepted |

---

## 17. Prioritized remediation

1. **Obtain production evidence.** A read-only credential or dump, then run
   `scripts/phase6-production-audit.js` with `--confirm-host` and
   `--acknowledge-production`. Every number in this report must be recomputed
   from it.
2. **Assign reviewers to the 628 conflicts.** Conflicts are never
   auto-overwritten; each needs a decision record.
3. **Authorize or reject the 27 backfill candidates.** Until then, zero are
   applied.
4. **Count the seven ownerless columns in production.** If non-zero, decide
   retain/backfill/drop per column; `shoulders_cm` is user-visible.
5. **Extend the ownership guard to object-field reads** using the §7 register
   as the first allow-list.
6. **Harden shared-reference RLS** only with an approved migration and a
   platform-wide read test.
7. **Add loud-fail guards** to the five DB-gated suites, matching the other 44.
8. **Re-run the full gate** after each change; the guard fails on stale
   baseline entries, so the baseline and the code cannot drift.

---

## 18. Final verdict

**Code: PASS.** The ownership model is implemented, the readers have a
documented precedence, the writers are single-path, the audit gap found in
Phase 8 is fixed and tested, tenant isolation is proven 26/26, and backup and
restore are proven on the fixture. No data was destroyed or exposed.

**Production migration: BLOCKED.** Without a production dump or read-only
credential, no claim about production row counts, conflicts or ownerless
values can be made. Running the migration on fixture evidence would be a
guess.

**Schema removal: NO-GO.** The gate requires zero unresolved conflicts, zero
legacy-only facts, zero populated ownerless columns, zero tenant findings and
zero unapplied candidates in production. The fixture alone reports 549
conflicts and 432 legacy-only facts (all-organization run), and the seven
ownerless columns are undecided.

Both verdicts are evidence-driven and will change only when the evidence does.

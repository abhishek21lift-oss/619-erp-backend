# Client Onboarding & Assessment — Implementation Roadmap

| Field | Value |
|---|---|
| Date | 2026-11-03 |
| Status | Phase 0 (integrity hotfixes), Phase 1 (write-path enforcement), a legacy-compatibility Phase 2 (canonical-first reads, diet PUT retired), an out-of-sequence Phase 3 (AI data integrity: one client-facts loader shared by every AI/context consumer), a verification-only Phase 4 (production data integrity), Phase 5 (legacy reconciliation and consumer parity), Phase 6 (guarded production audit, decision register, CI ownership guard, rollback runbook), Phase 7 (column-complete reconciliation readiness) and Phase 8 (final closure: writer/reader audit, member self-service audit trail, ownerless-column decisions, backup/restore proof) are implemented and verified on the fixture. Phases 4–8 used a synthetic production-shaped fixture; real-production evidence is still outstanding and reported BLOCKED. Schema removal is NO-GO. §5 below — evidence, recovery, and soft delete — has NOT been executed and still needs approval. §6 (validation parity, scoring_version, BMR policy, parity harness) also remains unexecuted and is not the Phase 3 that shipped. |
| Basis | `../audits/CLIENT-ASSESSMENT-CURRENT-STATE.md`, `../audits/CLIENT-ASSESSMENT-GAP-ANALYSIS.md`, `../specs/CLIENT-ASSESSMENT-TARGET-ARCHITECTURE.md`, `../specs/CLIENT-ASSESSMENT-FIELD-MATRIX.md` |
| Constraint | Preserve existing functionality and data. Additive or expand-contract only. No column drop, rename, or destructive migration in the first release. |
| Rule | One data point = one owner = one source of truth. Snapshots are evidence, not live owners. |

---

## 1. Operating rules

1. **Phase order is a gate, not a suggestion.** Phase 1 does not start until the Phase 0 exit criteria pass.
2. **One writer per fact.** A field may be read by many modules; it may be written by one.
3. **No production data rewrite in a code release.** Reports are read-only. Repairs are separate, reviewed ops scripts with a before/after export.
4. **Expand, then contract.** A deprecated field is accepted with a warning, then ignored with a warning, then rejected. It is never silently stripped.
5. **Every phase is independently shippable and reversible.** Additive columns stay if code rolls back.
6. **Every new branch or loop gets a regression test.** Safety and ownership changes get integration tests, not only unit tests.
7. **No scoring formula change is bundled with an ownership change.** A formula change needs its own evidence and its own approval.

**Effort scale:** S = under a day; M = 1–3 days; L = 3–5 days. These are implementation estimates for an agent-assisted change, not calendar promises.

---

## 2. Phase map

| Phase | Outcome | Findings | Schema | Primary risk | Effort |
|---|---|---|---|---|---|
| **0** | Stop wrong current data and unlogged loss | G-01, G-02, G-03 (stop-write), G-04 (minimum) | None | Cache correction changes visible weight; external caller sees `not_saved` | S–M |
| **1** | One writer per fact; documented read precedence | G-03, G-05–G-14 | None | External callers of legacy fields | M–L |
| **2** | Evidence, recovery, and audit | G-04 (full), G-08, G-09, G-16 | Additive | Soft delete leaks into reads | M–L |
| **3** | Consistency and optional capability | G-15, G-17–G-22 | Additive (scoring version); new table only if approved | Scope creep | M |

Phase 0 is deliberately small. It fixes the two findings that produce a wrong value presented as current (G-01, G-02), measures the legacy surface before changing it (G-03), and makes deletion traceable (G-04).

> **Execution note (2026-11-03).** A verification-only Phase 4 ran the ownership architecture against a synthetic production-shaped fixture: canonical ordering, tenant isolation and RLS, deletion recovery, cache consistency, AI provenance, and all frontend/API/WhatsApp/AI consumers. It changed no schema and executed neither §5 nor §6. Its fixes were two consumer reads that still preferred the legacy measurement log over `pt_assessments` (member weight goals and Transformations). The full evidence, residual risks, and the schema-removal go/no-go are in `PHASE4-PRODUCTION-INTEGRITY-REPORT.md`. Real-production data remains unverified.

> **Execution note (2026-11-03) — Phase 5, legacy reconciliation.** Phase 5 produced a field-level report for all 981 legacy-only and 628 conflicting rows (1,609 records) with provenance and timestamps, and a guarded apply workflow. The report validates against the Phase 4 aggregate in one repeatable-read snapshot. Only 27 rows are eligible for a reviewed backfill (D25 `pt_goals.motivation_level` from Lifestyle); none has been applied, and conflicts are never auto-written. `/api/me/measurements` now returns canonical `pt_assessments` first, legacy trainer measurements second and member check-ins third, with matching frontend labels. The Phase 4 suite and the reconciliation report are mandatory, non-skipping CI steps. Schema removal remains **NO-GO**: 981 facts still exist only in legacy copies, and no production dump has been supplied. Full evidence is in `PHASE5-LEGACY-RECONCILIATION-REPORT.md`.

> **Execution note (2026-11-03) — Phase 6, production readiness and ownership lockdown.** Phase 6 adds the guarded read-only production audit (`scripts/phase6-production-audit.js`), the field-level decision register (`scripts/phase6-decisions.js`), the CI ownership guard (`scripts/phase6-ownership-guard.js`) and its 23-entry legacy-read baseline, plus a backup/migration/rollback runbook. The fixture audit reproduces the Phase 5 totals (981 legacy-only, 628 conflicts, 1,609 records, 27 unapplied candidates) and returns `NO-GO`.
>
> Enforcement is now mechanical: a new write to `pt_os_measurements`/`client_fitness_profiles` or a legacy `pt_clients` fact fails the build, as does a new unregistered legacy read, a new direct AI client-fact query, or a baseline entry whose code has been removed. The audit itself has not run against production because no read-only production dump, replica or credential has been supplied — that is the single remaining blocker before any schema decision. Every conflict is still undecided (628 blank decision rows), every backfill candidate is still unapplied (27, `Authorization: NOT GRANTED`), and no destructive migration was written. Full evidence and the explicit go/no-go are in `PHASE6-PRODUCTION-READINESS-REPORT.md`; the operational procedure is `PHASE6-BACKUP-ROLLBACK-RUNBOOK.md`.

> **Execution note (2026-11-03) — Phase 7, column-complete reconciliation readiness.** Phase 7 adds `scripts/phase7-legacy-column-audit.js`, which audits all 22 `pt_os_measurements` and 17 `client_fitness_profiles` columns, introspects the live schema, classifies every populated cell as match / conflict / legacy-only / no-canonical-owner, and checks tenant isolation through the client join and the profile organization. The same guarded wrapper now runs both analyzers read-only and requires ten tables. On the ORG_A fixture it audited 400 legacy rows (150 measurements, 250 profiles), 3,100 populated cells (1,400 facts), and found 491 matches, 509 conflicts, 400 legacy-only facts, 0 populated ownerless cells, 0 tenant findings and 0 Phase 7 backfill candidates; both the scoped and all-organization runs return `NO-GO`. Seven measurement columns have no canonical owner (`assignment_id`, `shoulders_cm`, three photo URLs, `notes`, `measured_by`) and need a product decision if production has data in them. The ownership guard still passes at 343 files / 23 registered dependencies, now with a completeness test over all 23 owner/reason/sunset entries. The two backend and two frontend load-sensitive suites were given explicit load timeouts after reproducing their isolated passes. Real-production evidence is still **BLOCKED**; no production dump, replica or credential was supplied, so no production verification is claimed. Full evidence is in `PHASE7-PRODUCTION-READINESS-REPORT.md`.

> **Execution note (2026-11-03) — Phase 8, final closure.** Phase 8 closes the register. It verified that all D1–D25 rows have one canonical writer and a documented reader precedence, that every one of the 163 public tables has RLS enabled and every `organization_id` table has a tenant predicate (26/26 isolation tests), and that the writer audit is single-path for every assessment type. It found and fixed one real gap: member self-service contact and photo changes updated `pt_clients` with no `activity_log` entry, while the trainer's edits on the same fields were audited; `/api/me/profile` now writes `client.contact.update` only when a value changed, and `/api/me/photo` writes `client.photo.update`. It also compiled the object-field legacy reads the static guard cannot see (all canonical-first through `client-facts`) and resolved the seven ownerless measurement columns as retained read-only, unowned and undecided; all seven are 0 populated in the fixture and `shoulders_cm` is the only one with a live reader. Backup and restore were proven end to end (1.1 MiB dump, 189 tables with data, restored to 163 tables / 5,046 rows with 162/162 counts matching). The final verdicts are **code PASS, production migration BLOCKED, schema removal NO-GO**; the blockers are unchanged — no production evidence, 628 undecided conflicts, 27 unauthorized backfill candidates, and the seven ownerless columns. Full evidence, risks and the prioritized remediation plan are in `PHASE8-FINAL-CLOSURE-REPORT.md`.

---

## 3. Phase 0 — Safety hotfixes

### 3.1 G-01: latest-only body cache

**Change.**

- Add `syncClientBodyFromLatest(clientId, organizationId, tx)` in `assessments.repo.js`.
- Select the latest non-deleted assessment by `(assessment_date DESC, created_at DESC, id DESC)`.
- Update `pt_clients.weight/height` only from that row.
- Call it after assessment create, edit, and delete.
- Remove direct `updateClientBody` calls from `progress.routes.js:494` and `:544`.

**Preserve.** If no assessment exists, leave the cache untouched. Do not null a value that a trainer may have entered before fitness testing existed.

**Files.** `619-erp-backend/src/modules/progress/assessments.repo.js`, `progress.routes.js`.

**Tests.**

- `assessments.cache.latest.test.js`: two tests, edit the older, cache unchanged.
- Delete the latest: cache falls back to the previous test.
- Delete the only test: cache unchanged.
- Backdated create: cache unchanged when the new test is older than the latest.
- Concurrent edit/delete: cache matches the surviving latest row.

**Rollback.** Revert the commit. No schema.

**Done when.** The cache is derived from the latest test on every mutation, and no route calls `updateClientBody` directly.

---

### 3.2 G-02: server-only PAR-Q BMI

**Change.**

- Remove `bmi` from the PAR-Q create/update schema, or keep it accepted only to return `deprecated_fields: ['bmi']`.
- Compute BMI from the merged stored height and weight on every write.
- If either is missing, store `null`.
- Do not change existing rows.

**Files.** `619-erp-backend/src/modules/pt-os/parq.routes.js`.

**Tests.**

- POST with a mismatched `bmi` stores the computed value.
- PATCH with a mismatched `bmi` stores the computed value.
- Height-only edit recomputes.
- Missing height/weight stores `null`.
- A source search confirms no `b.bmi` read remains.

**Rollback.** Revert the commit. No schema.

**Done when.** A caller cannot influence the stored BMI.

---

### 3.3 G-03: stop the legacy Add Client write path, warn first

**Change.**

- Stop writing `goal`, `height`, `weight`, `body_fat`, `health_conditions`, `injuries`, and `occupation`.
- If any is present, return `200` with `deprecated_fields` and `not_saved: true`, and log a structured warning (`deprecated_client_field`, field, org, client, route).
- Do **not** return `422` in Phase 0. A hard rejection lands in Phase 1 after the warning has been observed.
- The canonical values in Fitness, PAR-Q, Goal, and Lifestyle are untouched.

**Why not only log.** Logging while still writing leaves the P1 open: an API caller can still overwrite the live weight or medical history. Stopping the write is the safety fix. The warning keeps the contract visible.

**Files.** `619-erp-backend/src/modules/pt-os/pt-os.routes.js`, logger.

**Tests.**

- A legacy field produces one warning and one response entry, and does not change the column.
- The identity-only payload produces none.
- A request with only legacy fields still creates/updates the identity fields it owns.
- The response never claims the deprecated value was saved.

**Rollback.** Revert the commit. No schema.

**Done when.** Add Client cannot write a fact owned by another module, and every rejected field is visible in the response and the log.

---

### 3.4 G-04: audit and repair on delete

**Change.**

- Log `assessment.delete` with actor, org, client id, assessment id, date, type, and number.
- After delete, run `syncClientBodyFromLatest` (G-01).
- Refresh or clear the retest schedule for that client.
- Keep the existing confirmation dialog.
- Keep hard delete in Phase 0; the soft-delete decision is Phase 2.

**Files.** `progress.routes.js`, `assessments.repo.js`, `retests.service.js` or its caller.

**Tests.**

- Delete writes one audit event.
- Delete latest re-derives the cache.
- Delete refreshes the retest schedule; a schedule pointing at the deleted row is removed or recalculated.
- Delete a non-latest test leaves the cache unchanged.

**Rollback.** Revert the commit. No schema.

**Done when.** No delete can complete without an audit event and a cache/retest repair.

---

### 3.5 Phase 0 deployment

| Step | Action | Verification |
|---|---|---|
| 1 | Deploy backend with G-01, G-02, G-03, G-04 | Health endpoint; existing assessment create/edit/delete smoke |
| 2 | Run read-only reports: cache vs latest test, BMI vs height/weight | Counts reviewed; no writes |
| 3 | Watch `deprecated_client_field` logs for 7 days | Field/route usage list |
| 4 | Decide whether the cache/BMI repair script is needed | Before/after export approved |

**Rollback.** Revert the backend commit. No schema objects to remove. Reports are read-only.

**Do not.** Rewrite `pt_clients.weight` for all clients in the same release. A corrected cache can change what staff see; it needs its own reviewed change.

---

## 4. Phase 1 — Ownership truth

### 4.1 Module implementation specs

#### 1. Add Client

| Item | Spec |
|---|---|
| Owns | Name, gender, DOB, mobile, WhatsApp, email, address, emergency contact/phone/relationship, client source, trainer assignment, enrolment term/package, sessions per week, workout experience level |
| Stops writing | `goal`, `height`, `weight`, `body_fat`, `health_conditions`, `injuries`, `occupation` |
| Still reads | Nothing from other modules as live data; identity is the source others prefill from |
| API | Allow-list identity/enrolment fields. Deprecated fields return a warning, then `422 FIELD_MOVED` after zero observed use |
| UI | No change; it already collects identity only |
| Validation | For new records: name, gender, mobile; DOB real, not future, age 10–100; phone normalized; emergency relationship conditional |
| Migration | None |
| Tests | Legacy field ignored; identity payload unaffected; validation parity with the form; no write to owner columns |
| Acceptance | A POST with `weight` cannot change `pt_clients.weight`; only Fitness can |

#### 2. Informed Consent

| Item | Spec |
|---|---|
| Owns | Consent document, version chain, acknowledgements, exercise consent, signatures, physician-advised-against flag, consent-specific clearance upload |
| Stops writing | Nothing in Phase 1 |
| Still reads | Client identity for prefill only |
| Snapshots | Identity/contact at signing; never refresh after creation |
| API | No structural change in Phase 1; content version/hash is Phase 2 |
| UI | No change in Phase 1 |
| Validation | Keep one active record, archive-on-edit, one signature per role, completion requirements |
| Migration | None |
| Tests | Snapshot does not refresh when the client record changes; completed edit still archives and versions |
| Acceptance | A completed consent remains a faithful record of the identity and text at signing |

#### 3. PAR-Q

| Item | Spec |
|---|---|
| Owns | Current health, past history, family history, 10 answers, risk, trainer medical notes, clearance, PAR-Q attestation, screening documents |
| Stops writing | `current_health.water_intake`, `alcohol`, `alcohol_details`, `smoking`, `smoking_details`, `tobacco`, `tobacco_details`, `nicotine`, `nicotine_details`, `sleep_hours`; `past_history.occupation`, `daily_sitting_hours` |
| Still reads | Client identity; height/weight prefill from the latest fitness test when available; legacy values for old forms |
| API | On create, store only the medical allow-list. On PATCH, merge the allow-list into the stored JSONB instead of replacing the object; ignore the removed keys with a warning. BMI derived (Phase 0) |
| UI | Already removed from the wizard; keep legacy values render-only and keep a clinical smoking flag only if approved |
| Validation | 10 answers complete for submitted; red-flag rule unchanged; clearance fields unchanged |
| Migration | None |
| Tests | Removed keys are not added on create; an old form keeps every legacy key after PATCH; BMI still derived; risk unchanged |
| Acceptance | PAR-Q stores only medical facts; no habit fact has two writers; no old screening loses a stored answer |

**Clinical sign-off required.** Removing questions from a medical form is a product/clinical decision, not only an engineering one. The wizard questions are already gone; the remaining step is the backend stop-write, and it must preserve existing JSONB on PATCH.

#### 4. Client Interview

| Item | Spec |
|---|---|
| Owns | Sitting hours, meal regularity, training availability, training history, pain/injury narrative, motivation, preferences, notes |
| Stops writing | `lifestyle_occupation`, `lifestyle_screen_time`, `lifestyle_sleep_hours`, `lifestyle_smoking`, `lifestyle_alcohol` |
| Still reads | Client identity; nothing else as live data |
| API | Allow-list three structured fields plus free text; deprecated lifestyle fields warn then reject. Keep columns readable |
| UI | No question change; fix the comments that assign ownership to Lifestyle |
| Validation | At least one text or structured answer for completed; ranges/enums unchanged |
| Migration | None |
| Tests | Five deprecated fields do not write; three structured fields still write; completed/open rules unchanged |
| Acceptance | Interview cannot create a second sleep/smoking/alcohol value |

#### 5. Fitness Testing

| Item | Spec |
|---|---|
| Owns | Vitals, anthropometry, body composition, cardio, strength test lifts, endurance, flexibility battery, scores, assessment metadata, retest schedule, latest body cache |
| Stops writing | Nothing in Phase 1 |
| Still reads | Client identity, age, gender, experience level |
| API | No field change; G-01 cache rule and G-04 delete audit are Phase 0 |
| UI | No change; optionally show which test is the current body source |
| Validation | Existing scoring and safety rules unchanged |
| Migration | None in Phase 1 |
| Tests | Historical edit cannot move the cache; delete repairs cache/retest; lift projection guard remains |
| Acceptance | Fitness is the only writer of live measurements; every write leaves a trace |

#### 6. Goal Assessment

| Item | Spec |
|---|---|
| Owns | Goal type/statement, targets, target date, priority, motivation/commitment, barriers, readiness, programmed schedule, milestones, review cadence, starting baseline snapshot |
| Stops writing | `pt_clients.goal`; no starting-field writes on update |
| Still reads | Latest Fitness measurements; Interview availability/meal regularity; Nutrition detailed meal pattern; Lifestyle context |
| API | On create, prefer the latest assessment for starting weight/body fat; manual only when no assessment exists. On update, ignore starting fields |
| UI | Read Interview first for sitting/meal/availability; show source labels; starting values read-only when an assessment exists |
| Validation | Goal type required; target rules unchanged |
| Migration | None |
| Tests | Latest assessment wins; manual value ignored when an assessment exists; PATCH cannot change starting values; Interview read order |
| Acceptance | Goal is the only writer of the programmed schedule and the starting snapshot is write-once |

#### 7. Lifestyle

| Item | Spec |
|---|---|
| Owns | Sleep, stress, hydration behaviour, occupation, steps, screen time, travel, smoking, alcohol, recovery, energy, lifestyle scores |
| Stops writing | `workout_experience_level`, `food_preferences`, `water_intake_liters`, `meal_frequency`, `breakfast_habit`, `late_night_eating`, `motivation_to_exercise` |
| Still reads | Nutrition water/meal habits for its nutrition sub-score; Goal motivation for display; client identity |
| API | Ignore the seven deprecated fields with a warning; keep columns |
| UI | No step asks them; show Nutrition’s resolved values and Goal motivation read-only if useful |
| Validation | Habit-count clearing rules unchanged; a new row with neither Nutrition nor a legacy value marks the water/meal sub-score “not assessed”; old Lifestyle values remain a read fallback per D13/D14 |
| Migration | None |
| Tests | Deprecated fields do not write; nutrition sub-score still reads Nutrition first; a new row without Nutrition or legacy values marks the components not assessed; old rows readable |
| Acceptance | Lifestyle cannot overwrite Add Client’s experience, Nutrition’s preferences/water/meals, or Goal’s motivation |

#### 8. Nutrition

| Item | Spec |
|---|---|
| Owns | Diet pattern/preferences, allergies, foods to avoid, supplements, digestive health, meal pattern detail, cravings, preparation/budget, nutrition-specific medical notes, water, scores |
| Stops writing | `alcoholic_drinks_per_week`, `meal_timing_consistency`, `medical_conditions` |
| Still reads | Lifestyle alcohol/smoking; PAR-Q medical conditions; keeps `medical_notes` for diet-specific implications |
| API | Alcohol: stop immediately with a warning (the UI never sends it). Meal timing and medical conditions: stop in the same release that removes them from the form. Keep columns as fallback |
| UI | No alcohol field exists; remove meal-timing consistency and the editable medical-condition list, keep medical notes, and replace the list with a read-only PAR-Q condition summary |
| Validation | Hydration/diet/protein/digestive/supplement scoring unchanged |
| Migration | None |
| Tests | New rows have null deprecated fields; `medical_notes` still saves; resolver still falls back to Lifestyle; scoring unchanged when Lifestyle is absent |
| Acceptance | Nutrition cannot create a second alcohol, meal-regularity, or medical-condition value |

#### 9. Mobility & Performance

| Item | Spec |
|---|---|
| Owns | Functional movement screen, pain/restriction flags, referrals, grip, jump, balance, reaction time |
| Stops writing | `sit_reach_cm` |
| Still reads | Pain history from PAR-Q/Interview for context; Fitness sit-and-reach for display only if needed |
| API | Accept `null` to clear a legacy value; reject a positive `sit_reach_cm` with a warning; keep column |
| UI | No entry field today; keep the clear action as a one-time cleanup or retire it; show Fitness value read-only if useful |
| Validation | 1–5 scores, category caps unchanged |
| Migration | None |
| Tests | New row has null; a positive value is rejected; the clear action still works; old row readable; score unchanged |
| Acceptance | One physical test, one unit, one score |

#### 10. Posture

| Item | Spec |
|---|---|
| Owns | Front/side/back observations, other notes, referrals, posture risk |
| Stops writing | Nothing |
| Still reads | None |
| API | No change |
| UI | No change |
| Validation | Issue list bounds and risk rule unchanged |
| Migration | None |
| Tests | Existing posture validation and org-scope tests remain green |
| Acceptance | No change; audit event added in Phase 2 |

#### 11. Strength Tracking

| Item | Spec |
|---|---|
| Owns | Standalone workout logs (`assessment_id IS NULL`), 1RM estimate/formula for those rows |
| Stops writing | Assessment-linked rows remain read-only projections; guard unchanged |
| Still reads | Assessment-linked lift rows; client identity |
| API | No change |
| UI | No change |
| Validation | `calc1RM` server-only; direct-1RM flag rules unchanged |
| Migration | None |
| Tests | Guard returns `409 ASSESSMENT_LOG`; estimated 1RM is recomputed |
| Acceptance | Two-writer table remains mediated by `assessment_id`; no regression |

### 4.2 Cross-module read precedence

| Fact | First source | Fallback | Never |
|---|---|---|---|
| Current weight/height | Latest fitness test | `pt_clients.weight/height` (legacy/cache) | PAR-Q snapshot, goal snapshot |
| Current goal | Active `pt_goals` | `pt_clients.goal` | Consent/PAR-Q |
| Experience level | `pt_clients.workout_experience_level` | `client_fitness_profiles.fitness_level` | Lifestyle copy |
| Motivation | Goal `motivation_level` | Lifestyle `motivation_to_exercise` (legacy) | Interview narrative as a score |
| Training availability | Interview `lifestyle_training_days` | `pt_clients.sessions_per_week` | Preferred weekdays as a count |
| Programmed days | Goal `training_days_per_week` | Availability | — |
| Sitting hours | Interview | PAR-Q `past_history.daily_sitting_hours` (legacy) | — |
| Meal regularity | Interview | Nutrition `meal_timing_consistency` (legacy) | — |
| Water/meals/breakfast/late-night | Nutrition | Lifestyle copies (legacy) | PAR-Q |
| Alcohol/smoking | Lifestyle | Nutrition alcohol column (legacy) | PAR-Q quantity |
| Medical conditions | PAR-Q | Nutrition `medical_conditions` (legacy) | — |
| Injuries | PAR-Q | Interview narrative, then `pt_clients.injuries` | — |
| Sit-and-reach | Fitness Testing | Mobility `sit_reach_cm` (legacy, cm) | Comparing the two units |
| 1RM | Fitness test lift | Strength Tracking log | Client-supplied estimate |

**Implementation.** Put each family behind one server resolver or one documented frontend selector. Do not copy the precedence table into a third page.

### 4.3 API compatibility rollout

**Track A — fields the current UI never sends** (Add Client legacy, the five Interview lifestyle fields, the seven Lifestyle duplicates, the eight PAR-Q habit keys, Nutrition alcohol, and a positive Mobility sit-and-reach):

| Release | Backend | Frontend | Caller experience |
|---|---|---|---|
| 1a | Stop writing; return `200` with `deprecated_fields` and `not_saved: true` | Unchanged | Canonical data is safe; the caller is told the value was not saved |
| 1b | Reject with `422 FIELD_MOVED` | Unchanged | Only unmaintained external callers break, with a clear error |
| 1c | Remove from schema and docs | Unchanged | Contract is clean |

**PAR-Q exception.** On PATCH, merge the still-asked medical keys into the stored `current_health`/`past_history` JSONB; never replace the object. An old form keeps its habit answers even though a new caller cannot add one.

**Mobility exception.** Accept `null` for `sit_reach_cm` so the existing clear action can remove a legacy value; reject a positive value.

**Track B — fields the current UI still asks** (Nutrition meal timing and medical conditions):

| Release | Backend | Frontend | Caller experience |
|---|---|---|---|
| 1a | Keep accepting and writing; add a warning/log | Remove the fields from the forms (or ship together) | No visible answer is discarded during the transition |
| 1b | Stop writing; return `200` with the warning | Removed | New records stop storing duplicates |
| 1c | Reject with `422 FIELD_MOVED` | Removed | Contract is clean |

**Phase 1 exit gate is after Track B 1b.** The short 1a window still has two writers, but no user-visible form loses an answer.

**Rule:** never rely on Zod stripping to “remove” a field. A stripped field looks successful to the caller and silently loses data. Warn or reject explicitly.

### 4.4 Phase 1 acceptance

- Each duplicate register row (D1–D25) has one writer.
- A source search for each deprecated field finds no write in the owning module.
- Old rows still render in the UI and in PDFs.
- The read-precedence table is implemented in one place per fact family.
- No new mandatory onboarding field.
- All Phase 0 tests remain green.

---

## 5. Phase 2 — Evidence, recovery, and audit

### 5.1 Assessment delete: soft delete or documented hard delete

**Decision required.** Recommended: soft delete.

**If soft delete.**

- Add `deleted_at TIMESTAMPTZ`, `deleted_by TEXT` (or the existing user id type) to `pt_assessments`.
- Add a partial index on `(client_id, assessment_date DESC) WHERE deleted_at IS NULL`.
- Update every read path: list, detail, comparison, retest, goal baseline, programme inputs, member comparison.
- Decide the lift projection: either keep assessment-linked `strength_logs` and filter through the parent, or delete them and accept that restore loses lifts. Recommended: keep them and filter.
- Add a restore action for admins with its own audit event.
- Do not reuse deleted assessment numbers.

**If hard delete stays.**

- Keep the Phase 0 audit and repair.
- Add an export/backup step before delete, or restrict delete to an admin role.
- Document the accepted risk.

**Tests.**

- Deleted rows are absent from every list, comparison, retest, and baseline query.
- Restore returns the row and its lifts.
- A deleted assessment cannot become the “latest” for the body cache.
- Assessment numbering still does not reuse a deleted number.

### 5.2 Consent content version and hash

**Schema.**

```sql
ALTER TABLE pt_informed_consents
  ADD COLUMN IF NOT EXISTS content_version TEXT,
  ADD COLUMN IF NOT EXISTS content_hash TEXT;
```

**Behavior.**

- On completion (both signatures present), render the exact consent text and compute a SHA-256 hash.
- Store `content_version` (the template’s semantic version) and `content_hash`.
- Never refresh after completion.
- Old rows have `NULL`; the UI shows “pre-hash record” and keeps the PDF link.
- No backfill. A hash cannot be reconstructed for text that may have changed.

**Tests.**

- Same text + version => same hash.
- Changed text => different hash.
- Completing a record stores both fields.
- Editing a completed record archives it and creates a new version with a new hash.
- Old null rows render without an error.

### 5.3 Structured clearance restrictions

**Schema.**

```sql
ALTER TABLE pt_medical_clearances
  ADD COLUMN IF NOT EXISTS restrictions JSONB;
```

**Shape.**

```json
[
  { "area": "shoulder", "restriction": "no overhead pressing", "until": "2026-12-01" },
  { "area": "cardio", "restriction": "no high-intensity intervals" }
]
```

**Behavior.**

- Optional on create/update; validate an array of objects with short strings and an optional ISO date.
- Show in the client snapshot, PAR-Q detail, and programme warnings.
- Display-only in this phase. Do not auto-block exercise.
- Old rows have `NULL`; free-text trainer notes remain readable.

**Tests.**

- Valid array stores and returns.
- Invalid shape returns 422.
- Empty/null is allowed.
- Old null rows render.
- Programme warning displays without blocking.

### 5.4 Audit events on progress writes

**Events.** `assessment.create`, `assessment.update`, `assessment.delete`, `goal.create`, `goal.update`, `lifestyle.create`, `lifestyle.update`, `nutrition.create`, `nutrition.update`, `mobility.create`, `mobility.update`, `posture.create`, `posture.update`, `strength.create`, `strength.update`, `strength.delete`.

**Payload.** Actor, org, client id, row id, module, changed keys, and a small set of before/after values for safety-relevant fields. Do not log full medical JSONB or signatures.

**Tests.**

- One event per mutation.
- Failed transaction writes no event.
- Event is tenant-scoped.
- Delete event exists before the row is gone.

### 5.5 Phase 2 migration order

1. Add nullable columns (`content_version`, `content_hash`, `restrictions`).
2. Deploy code that writes and reads them.
3. Add `deleted_at`/`deleted_by` only after every read path is updated in the same release.
4. Create partial indexes concurrently.
5. Run verification queries.
6. Do not backfill.

**Rollback.** Revert code; leave columns. Nullable columns are harmless. If soft delete is rolled back, keep `deleted_at` but stop filtering; verify no rows were restored incorrectly.

---

## 6. Phase 3 — Consistency and capability

### 6.1 Validation parity at identity boundaries

- New-record create/update: name, gender, mobile required where the UI requires them.
- DOB: parse a real date, not future, age 10–100.
- Phone: one normalization function for Add Client, PAR-Q, and consent snapshots.
- Do not invalidate existing rows; report them.
- Tests: same payload accepted/rejected consistently across the three modules.

### 6.2 BMR policy for `Other`/unknown sex

**Decision required.** Either:

- return `null` and require manual BMR, or
- use a documented neutral formula approved by the product/clinical owner.

No silent female default. Add a test that `Other` does not produce the female value.

### 6.3 Scoring version

- Add nullable `scoring_version TEXT` to `pt_assessments`, `pt_lifestyle_assessments`, `pt_nutrition_assessments`, `pt_mobility_performance_assessments`, `pt_posture_assessments`, and `pt_goals`.
- Set on every write from a constant in the scoring module.
- Show in comparison detail.
- Do not recompute history.
- Tests: version is set; old null rows render; comparison reports mixed versions.

### 6.4 Cross-repo parity harness

- Extend `scripts/assert-scoring-parity.ts` with fixed fixtures for mobility category caps, posture risk, and goal SMART analysis.
- Each fixture is a named input/output pair used by both frontend and backend tests.
- CI fails on drift.

### 6.5 Single assessment-context resolver

- Extend the existing `client-facts` response with sitting hours, meal regularity, training availability, and their sources.
- Goal consumes those fields instead of reimplementing precedence.
- Do not add a parallel context endpoint if `client-facts` already carries the shape.
- Tests: source labels and fallbacks match the precedence table.

### 6.6 TDEE and calorie/macro targets (conditional)

This is a new capability, not a duplicate fix. If approved:

- New table owned by Nutrition, for example `pt_nutrition_targets` with `client_id`, `organization_id`, `tdee`, `calorie_target`, `protein_g`, `carbs_g`, `fat_g`, `activity_factor`, `formula_version`, `effective_from`, `created_by`.
- TDEE derives from the latest Fitness measurement (weight, height, age, sex, activity factor) and one documented formula.
- Do not add these columns to `pt_nutrition_assessments`; targets are a separate fact with their own history.
- If not approved, record it as out of scope and do not leave half-built fields.

---

## 7. Migration plan

| Phase | Migration | Type | Rollback |
|---|---|---|---|
| 0 | None | — | Revert code |
| 1 | None | — | Revert code |
| 2 | `pt_informed_consents.content_version`, `content_hash` | Additive nullable | Leave columns |
| 2 | `pt_medical_clearances.restrictions` | Additive nullable | Leave column |
| 2 | `pt_assessments.deleted_at`, `deleted_by` + partial index | Additive / index | Leave columns; stop filtering |
| 3 | `scoring_version` on five assessment tables + goals | Additive nullable | Leave columns |
| 3 | `pt_nutrition_targets` | New table (conditional) | Drop only if never used; otherwise leave |

**Rules.**

- Use the next available sequential migration numbers at implementation time; do not reserve numbers in this document.
- `CREATE INDEX CONCURRENTLY` runs outside a transaction.
- No `NOT NULL` without a default on a populated table.
- No backfill in the migration. A separate, reviewed script may populate a fallback later.
- Every migration has a matching down/rollback note, even if the project only moves forward.

---

## 8. Test plan

### 8.1 Phase 0

| Test | Layer | Must prove |
|---|---|---|
| `assessments.cache.latest` | Backend integration | Historical edit cannot move the cache |
| `assessments.cache.delete` | Backend integration | Delete re-derives and repairs retest |
| `parq.bmi.derived` | Backend route | Caller BMI is ignored |
| `clients.deprecated.stopWrite` | Backend route | Legacy fields return a warning and do not change owner columns |
| `assessments.delete.audit` | Backend integration | Actor and row identity are recorded |

### 8.2 Phase 1

| Test | Layer | Must prove |
|---|---|---|
| `interview.allowlist` | Backend route | Five lifestyle fields do not write |
| `parq.noHabits` | Backend route | Eight habit fields are not added on create; an edit preserves legacy keys |
| `mobility.noSitReach` | Backend route | A positive value is rejected; `null` clears a legacy value |
| `nutrition.noDuplicates` | Backend route | New rows do not write alcohol, meal timing, or medical conditions; resolver falls back |
| `lifestyle.noDuplicates` | Backend route | New rows do not write experience, preferences, water, meals, or motivation |
| `goal.precedence` | Frontend/unit | Interview wins; Nutrition is fallback |
| `goal.startSnapshot` | Backend route | Latest assessment wins; PATCH cannot change it |
| `clients.noLegacyWrite` | Backend route | Add Client cannot write owner facts |

### 8.3 Phase 2

| Test | Layer | Must prove |
|---|---|---|
| `assessments.softDelete` | Backend integration | Deleted rows are excluded everywhere |
| `assessments.restore` | Backend integration | Restore returns row and lifts |
| `consent.contentHash` | Backend unit | Hash is stable and versioned |
| `clearance.restrictions` | Backend route | Shape validation and display |
| `progress.audit` | Backend integration | One event per mutation |

### 8.4 Phase 3

| Test | Layer | Must prove |
|---|---|---|
| `identity.validationParity` | Backend route | Same rules across client/PAR-Q/consent |
| `bmr.other` | Backend unit | No female default |
| `scoring.version` | Backend integration | Version is set and reported |
| `scoring.parity` | Cross-repo | Frontend preview equals server |
| `goal.contextResolver` | Backend/frontend | Source labels match precedence |

### 8.5 End-to-end flows

1. New client -> consent -> PAR-Q -> fitness -> goal. Each module shows the same current weight after the fitness test.
2. High-risk PAR-Q -> blocked -> approved clearance -> unblocked.
3. Edit an older fitness test -> current weight does not change.
4. Delete the latest test -> current weight falls back; retest is repaired.
5. Client has only an Interview -> Goal uses Interview availability and meal regularity.
6. Client has only Lifestyle -> Nutrition reads alcohol/smoking; no duplicate write.
7. Old records (pre-hash consent, old PAR-Q BMI, old mobility sit-and-reach) still render.

---

## 9. Rollout and rollback

### 9.1 Deploy order

| Phase | Backend first | Frontend second | Why |
|---|---|---|---|
| 0 | Yes | No change | Server-side safety |
| 1 | Only for fields the UI does not send | Yes, together for fields the UI still asks | A visible form must not outlive its write path |
| 2 | Yes (columns + writers) | Yes (display fields) | Nullable columns are safe |
| 3 | Yes | Yes | Version/context fields |

### 9.2 Monitoring

- `deprecated_client_field` count by field and route.
- `422 FIELD_MOVED` count after enforcement.
- Cache mismatch report count.
- BMI mismatch report count.
- Assessment delete events per week.
- Consent completions with/without content hash.
- Clearance restrictions null rate.
- 5xx rate on assessment/PAR-Q/consent routes.

### 9.3 Rollback

- Code: revert the release. No migration is required for Phases 0–1.
- Phase 2: leave additive columns; stop writing/reading them.
- Soft delete: if rolled back, keep `deleted_at` but stop filtering; verify no deleted row was accidentally restored.
- Never roll back by deleting data.

---

## 10. Acceptance gates

### Global definition of done

- One writer per fact.
- Documented read precedence.
- Regression test on the boundary.
- Old rows readable.
- No silent data loss.
- Audit event for destructive/medical-legal actions.
- No new mandatory field.
- Reversible without data loss.

### Phase gates

| Gate | Criteria |
|---|---|
| **0 -> 1** | G-01/G-02 tests pass; G-03 logs exist; G-04 audit/repair passes; no schema change |
| **1 -> 2** | Every D-row has one writer; deprecated fields warn; old rows render; no new mandatory field |
| **2 -> 3** | Delete has recovery/audit; consent hash on new completions; restrictions visible; progress audit events |
| **3 -> done** | Validation parity; BMR policy; scoring version; parity harness; TDEE decision recorded |

---

## 11. Out of scope

- Dropping or renaming any column.
- Changing the PAR-Q risk thresholds, the screening gate semantics, or the fitness scoring formulas.
- Changing RLS, tenancy, or authentication.
- Adding a member-facing write path.
- Redesigning the consent or PAR-Q PDF.
- Changing WhatsApp bot behaviour, imports, or AI actions (they are consumers to audit, not targets of this roadmap).
- Backfilling historical data silently.
- TDEE/macros unless separately approved.
- A new module or a new assessment type.

---

## 12. Approval checklist

| # | Decision | Owner | Status |
|---|---|---|---|
| 1 | Interview owns sitting/meal/availability; Lifestyle owns the other five | Product | Pending |
| 2 | Fitness owns sit-and-reach; Mobility retires it | Product/clinical | Pending |
| 3 | `pt_clients` goal/body/medical/occupation become legacy fallbacks | Product | Pending |
| 4 | Goal starting values are write-once and prefer the latest test | Product | Pending |
| 5 | Assessment delete: soft delete or audited hard delete | Product/engineering | Pending |
| 6 | Consent content hash scope (hash vs full text snapshot) | Legal | Pending |
| 7 | PAR-Q habit-question removal timing | Clinical | Pending |
| 8 | BMR policy for `Other`/unknown sex | Product/clinical | Pending |
| 9 | TDEE/macros in scope | Product | Pending |
| 10 | Phase 0 approved to start | Product/engineering | Pending |

**No implementation starts until the Phase 0 row is approved.** Phase 0 does not require decisions 1–9; it only requires decision 10 and the safety intent in G-01/G-02/G-04.

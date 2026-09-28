# Assessment Modules Audit — 2026-09-28

Scope: Informed Consent, PAR-Q, Fitness Testing, Goal Setting, Lifestyle,
Nutrition, Mobility, Posture and Strength Tracking. That covers the backend
routes, the scoring libraries and their frontend twins, the screening gate, the
frontend pages, and a read-only check of production data.

Production snapshot (read-only, today):

| Item | Count |
|---|---|
| Live clients | 35 |
| Clients with a bodyweight on file | 0 |
| PAR-Q forms | 15, all `low/cleared` |
| Informed consents | 14 completed, 2 draft, 3 archived |
| Strength logs | 19 |
| Cross-org PAR-Q rows | 0 |
| Expired but approved clearances | 0 |

Severity: **Critical**, **High**, **Medium**, **Low**.

## Status

Fixed on `claude/project-setup-understanding-9t82iv` (backend + frontend):

| ID | Fix |
|---|---|
| A-1 | Red-flag questions 1, 3, 4, 5 are high risk on their own. The frontend preview is mirrored, and the rule is now in the CI parity check. |
| A-2 | `clientInOrg` on PAR-Q create. Gate reads are pinned to the client's own studio. |
| A-3 | Clearance expiry is checked at read time inside the gate. |
| A-4 | Approval needs a doctor, a clearance date (not in the future), an expiry on or after it, and a certificate. There is now a Clearance Status control in the wizard, since there was no way to approve before. A high-risk form can be submitted as Pending and stays blocked. |
| A-5 | Fitness testing is gated. Revoked consent and "physician advised against" (with no uploaded clearance) hard-block. Frontend toasts name the reason and link the fixing screen. |
| P-1 | Stage-2 hypertension is classified before hypotension. |
| P-3 | Future-dated forms are refused. The gate skips drafts and breaks ties by `created_at`. |
| P-4 | PAR-Q and clearance `PATCH` validate. The zod 4 `.partial()` default trap is avoided, so an edit can no longer wipe the answers. |
| F-1 | A strength-log failure after an assessment is saved is a warning, not "failed to save", so there are no duplicate assessments. A direct 1RM now sends its weight. |
| F-3 | For Epley, a single is its own 1RM. |
| S-1, S-2, S-3 | Bodyweight comes from the latest fitness test. NUMERIC values are coerced. The list limit is 200. |
| S-5, S-6, S-7 | Strength logs are bounded, reps are required for an estimate, a direct 1RM is weight × 1, `log_date` is accepted, and `assessment_id` is org-checked. |

Still open: A-6 (a live BP stop in the wizard), C-1 to C-6, F-2, F-4 to F-8, S-4, S-8, G-1 to G-4, L-1 (other PATCH schemas), L-2, L-3, M-1, PO-1, P-2, P-5 to P-9.

---

## Critical / High: client safety and tenant isolation

### A-1 (High, safety): a cardiac PAR-Q "yes" does not block training
`computeParqAnalysis` decides risk only by how many answers are "yes":

| "Yes" answers | Risk | Gate |
|---|---|---|
| 0 | low | cleared |
| 1–2 | medium | cleared |
| 3+ | high | blocked |

So chest pain, fainting or dizziness, or a diagnosed heart condition on its own
lands in "medium", which gets `workout_gate_status = 'cleared'`. The PAR-Q+
standard, and ACSM pre-participation screening, both say any cardiac "yes"
needs medical clearance before training starts. Three "no-risk" yeses (for
example family history, a bone/joint issue and a medication) block the client,
while a single chest-pain yes does not.

**Fix:** mark specific question IDs as "red flags" that force `high` whatever the
count. Mirror the change in `parq-calculations.ts`, and add a parity test.

### A-2 (High, tenant): PAR-Q create doesn't check the client belongs to the caller's studio
`POST /api/pt-os/parq/forms` inserts `b.client_id` without calling `clientInOrg`.
Every other assessment POST checks it. `checkScreeningGate` and
`isTrainingBlocked` then read the latest PAR-Q **by `client_id` alone**, with no
organization predicate.

A studio that knows another studio's client UUID can:
- write a `blocked` PAR-Q, which denies that client's training in the other
  studio; or
- write a newer low-risk PAR-Q, which **lifts a real medical block** in the
  other studio.

Client IDs are UUIDs, so the attack isn't trivially enumerable, but it's a
cross-tenant write into a medical-safety control. Production has 0 mismatched
rows today.

**Fix:**
- Add `clientInOrg` on `POST /parq/forms`.
- Scope both gate queries to the client's organization (`AND organization_id = …`).
- Add an E2E attack case in `tenant-isolation.api.spec.ts`.

### A-3 (High, safety): an expired medical clearance keeps the gate open
`recomputeGateStatus` checks `expiry_date >= CURRENT_DATE`, but it only runs
when a form or clearance is written. The gate readers use the stored
`workout_gate_status`, so a clearance that expires next month leaves a high-risk
client "cleared" indefinitely.

**Fix:** check expiry at read time inside `checkScreeningGate` and
`isTrainingBlocked` (join the clearances), or run a nightly recompute.

### A-4 (High, safety): the trainer can self-approve a clearance with no evidence
- `POST /parq/forms/:id/clearance` accepts `approval_status: 'approved'` on
  create, with no doctor name, certificate or date required.
- `PATCH /parq/clearance/:id` has no schema, so any string is accepted.

A trainer can clear a blocked client with one click, and the only record is the
activity log.

**Fix:** require `doctor_name`, `clearance_date` and a certificate (an uploaded
document or a `certificate_url`) before `approved`. Add a zod schema to PATCH.

### A-5 (Medium-High): screening gates are advisory for most flows
- **Fitness testing** (`POST /progress/assessments`): not gated at all. It
  includes a Harvard step test, maximal strength (1RM) and endurance-to-failure
  tests. A PAR-Q-blocked client can be put through a maximal test.
- **Missing PAR-Q, or consent not completed** (including **revoked**): only a
  warning on workout assignment and session creation.
- **`physician_advised_against = true`** on the informed consent: stored and
  printed on the PDF, but it doesn't stop the consent completing and doesn't
  affect the gate.

**Fix:**
- Apply `checkScreeningGate` to the assessment POST (at least block when `blocked`).
- Treat revoked consent and `physician_advised_against` as hard blocks.
- Consider a studio setting to make "no PAR-Q" a hard block.

### A-6 (Medium-High, safety): unsafe blood pressure is only reported after the test
BP is captured in the same wizard as the step test, and `bp_unsafe` is computed
only on save. The toast says "medical clearance recommended" *after* the step
and strength tests have been done and recorded.

**Fix:** evaluate BP live in `StepBloodPressure`. Stop the wizard (or require a
trainer override with a reason) before any exertion step when BP is at or above
160/100 or in the hypotension band.

---

## PAR-Q: correctness

| # | Sev | Finding |
|---|---|---|
| P-1 | Med | `classifyBp` checks `systolic < 90 \|\| diastolic < 60` **first**, so 160/58 is labelled "Hypotension". There's also no hypertensive-crisis band (≥180/120). Classify the higher-risk band first, and add the crisis band as a hard stop. |
| P-2 | Med | `PARQ_QUESTIONS` is a modified set. Q2 is "family history of heart disease", which isn't in PAR-Q+, yet it counts toward the 3-yes block the same as a cardiac symptom. |
| P-3 | Med | The gate reads `ORDER BY assessment_date DESC LIMIT 1` with no tie-breaker. The trainer controls `assessment_date`, so a **future-dated** low-risk form hides a newer high-risk one, and two forms on the same day resolve arbitrarily. Order by `assessment_date DESC, created_at DESC`, and reject future dates. |
| P-4 | Med | `PATCH /parq/forms/:id` has **no validation schema**. `parq_answers` can be any shape (more than 10 items, arbitrary answers), and `status` can be any string. Reuse the create schema's `.partial()`. |
| P-5 | Low | `assessment_number = COUNT(*)+1` races under concurrent submits, and counts soft-deleted forms. |
| P-6 | Low | `POST /parq/forms/:id/consent`: both signatures are optional, so a consent record can exist with **no signature at all**. Require `client_signature`. |
| P-7 | Low | There are two separate consent systems: `pt_consent_records` (PAR-Q step) and `pt_informed_consents`. The gate reads only the second, so a signed PAR-Q consent doesn't satisfy "consent completed". This should be documented, or the two merged. |
| P-8 | Low | UA sniffing: Edge's UA contains "Chrome", so Edge is never detected. This is cosmetic metadata on a legal record. |
| P-9 | Low | Multer `fileFilter` errors (a wrong MIME type) go to the generic error handler, possibly as a 500 rather than a 400. |

## Informed Consent

| # | Sev | Finding |
|---|---|---|
| C-1 | Med | **A signature doesn't freeze the content.** After the client signs a draft, `PATCH` can still change the name, acknowledgements and medical fields before the trainer signs. The completed PDF then shows the client "signing" text they never saw. Clear the existing signatures on any content edit, or block edits once anyone has signed. |
| C-2 | Med | `revoke` has no status check: it can "revoke" drafts and archived versions. No reason is recorded, and revoking the live version doesn't re-surface it anywhere except a warning. |
| C-3 | Low | `exercise_consent_signature` is sent through `PATCH`, which is under the global **100 kb** JSON limit. Only `/sign` gets 4 mb. A high-DPI canvas signature can return 413. The same applies to the PAR-Q consent POST with two signatures. |
| C-4 | Low | `sign` reads without `FOR UPDATE`. Two signers finishing at once can both run the "completed" branch and generate two PDFs. |
| C-5 | Low | `signature` accepts any non-empty string. It isn't validated as a PNG data URL, and the PDF embed can then throw, which is swallowed, so there's no PDF. |
| C-6 | Low | The `'expired'` status is checked for, but nothing ever sets it. There's no consent expiry or annual re-consent. |

## Fitness Testing

| # | Sev | Finding |
|---|---|---|
| F-1 | Med | **A failed save creates duplicates.** The frontend saves the assessment, then makes up to two strength-log POSTs. If a strength-log call fails, the page shows "Failed to save assessment" and keeps the form, so a retry creates a **second assessment** (with a new `assessment_number`). Create the logs server-side in the same transaction. |
| F-2 | Med | Harvard PEI bands are one level off the published table (<55 Poor, 55–64, 65–79, 80–89, ≥90 Excellent). |
| F-3 | Med | Epley at reps = 1 gives 1.033× the lifted weight, so a true single is inflated 3.3%. Use `reps === 1 ? weight : …`. Brzycki clamps reps at 12, which *under*-estimates high-rep sets silently. Neither warns that estimates above ~10 reps are unreliable. |
| F-4 | Med | Endurance tests without norms (Wall Sit, Bodyweight Squat, Custom) are classified against **plank** norms. Unknown strength exercises fall back to **bench-press** norms. Both produce confident but invented categories. Return `null`, as Strength Tracking already does. |
| F-5 | Med | There's no update or delete for fitness assessments. A typo is permanent, and it feeds progress charts and the client portal. |
| F-6 | Low | `age` and `gender` are trusted from the request body over the client record, so the norm band can be chosen by the caller. |
| F-7 | Low | Push-up and curl-up norms have no age bands (the YMCA/ACSM tables are age-banded). |
| F-8 | Low | Gender other than `Male` (including null) is scored on **female** norms, in both `classifyStrength` and the fitness scorers. |

## Strength Tracking

| # | Sev | Finding |
|---|---|---|
| S-1 | **High (broken)** | **Strength Level badges never show.** The page reads `client.weight`, which: (a) nothing ever writes (production: **0 of 35** clients have a weight, and Fitness Testing doesn't update it, despite the page's hint "Add a weight via Fitness Testing"); and (b) is `NUMERIC`, which `pg` returns as a **string**, so `typeof c.weight === 'number'` is false anyway. Use the latest assessment's weight, and coerce with `Number()`. |
| S-2 | **High (broken)** | **The trend sparkline never renders.** `one_rm_estimate` and `weight_kg` are `NUMERIC`, so they come back as strings, and `Number.isFinite("102.5")` is `false`. Every point is skipped. |
| S-3 | Med | The list call doesn't pass `limit`, and the API defaults to **50**. With more than 50 logs, older history silently disappears from both the trend and "Recent Lifts". |
| S-4 | Med | No edit or delete for strength logs. A 2000 kg typo becomes the permanent "latest" and distorts the trend forever. |
| S-5 | Med | The schema allows `weight_kg` of 0, negative, or 5000. `reps_done` has no bounds, and **defaults to 10 when omitted**, so a 1RM gets estimated from a phantom 10 reps. `is_direct_1rm` without `one_rm_estimate` stores null instead of the weight lifted. |
| S-6 | Low | No `log_date` input, so a lift can't be backfilled (for example from a meet or an earlier session). |
| S-7 | Low | `exercise_name` is free text on the API ("Squat" vs "Back Squat" vs "squat" split the history). `assessment_id` isn't checked against the caller's organization. |
| S-8 | Low | Norms stop at "Excellent" (for example a squat at 2.0× bodyweight). For advanced or competitive lifters, every lift reads "Excellent" with no further resolution. Consider an elite tier, or DOTS/IPF GL points for powerlifters. |

## Goal Setting

| # | Sev | Finding |
|---|---|---|
| G-1 | Med | `calcLifestyleReadinessScore` divides by all 6 keys, not the number answered, so partially completed readiness **understates** the score. |
| G-2 | Med | The muscle-gain safe rate is 0.35 kg/month (~0.08 kg/week) applied to *total* bodyweight change. That's very conservative, so "estimated duration" and the **recommended PT package months** are inflated for gain goals. The package recommendation is a sales number the client sees. |
| G-3 | Low | A target date in the past gives `difficulty = null`, with no risk flag or validation error. |
| G-4 | Low | `PATCH /goals/:id` has no zod schema, so wrong types reach Postgres as 500s. |

## Lifestyle / Nutrition / Mobility / Posture

| # | Sev | Finding |
|---|---|---|
| L-1 | Med | Every `PATCH` (lifestyle, nutrition, mobility, posture, goals, PAR-Q) has **no validation schema**. Only POST validates. Bad types either 500, or poison the recompute (for example `sleep_quality: "abc"` gives NaN, which gives a null score). |
| L-2 | Low | Lifestyle: hydration is judged in absolute litres (not ml/kg), any alcohol is flagged, and the breakfast and meal-frequency penalties are opinion rather than evidence. The habit-risk total double-counts sleep, stress and activity. |
| L-3 | Low | Nutrition: "protein adequacy" is a proxy guessed from the favourite-foods list, not from intake. Taking supplements *raises* the score. Hydration isn't bodyweight-based. |
| M-1 | Med | Mobility: reported **pain** during a screen costs only −5 points, with no referral flag. Pain on a movement screen should stop that pattern and flag a physio referral. |
| PO-1 | Med | Posture: suspected **scoliosis** is only a score weight (15), with no referral flag. It should produce a "refer for assessment" risk item. |

---

## Suggested fix order

1. **Safety gate** (A-1, A-2, A-3, A-4, P-3): cardiac red-flag questions, the
   tenant-scoped gate plus `clientInOrg`, a read-time expiry check, evidence
   required for clearance, a deterministic "latest" form.
2. **Gate coverage** (A-5, A-6, P-1): gate fitness testing, a live BP stop,
   hard-block on revoked consent or physician advice, fix the BP band order.
3. **Strength Tracking fixes** (S-1, S-2, S-3, S-5): bodyweight source, numeric
   coercion, limit, input bounds. Small and very visible.
4. **Data integrity** (F-1, F-5, S-4, C-1, L-1/P-4/G-4): atomic
   assessment-with-logs, edit/delete, a signature freeze, PATCH schemas.
5. **Scoring accuracy** (F-2, F-3, F-4, G-1, G-2, M-1, PO-1, the rest).

Each scoring change must land in both `src/modules/progress/*-scoring.js` and
the frontend `src/lib/*-calculations.ts`. The CI "Scoring parity" job enforces
this.

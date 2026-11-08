# Norm Alignment Cutover — 2026-11-09

**Status:** Accepted — owner instructed the recommended path on 2026-11-09
**Scope:** K11 fitness norms in `619-erp-frontend` and `619-erp-backend`
**Planned cutover:** the deploy of the norm-alignment commit (record the actual timestamp)
**Current state:** uncommitted working tree on `feat/google-signin`; no production change

## Context

The supplied K11 images were compared with the app's norms for blood pressure, resting
heart rate, SpO₂, anthropometrics, cardiorespiratory tests, strength, muscular endurance
and flexibility. The tables and safety guidance were aligned. Stored assessment rows
already contain categories and scores written under older norms, and most areas do not
persist a norm version.

A policy is needed so historical records are not silently rewritten and future audits can
tell which norms graded a row.

## Decision

1. **Historical rows keep the category and score written at assessment time.** No backfill
   and no mass update.
2. Assessments saved after the norm commit is deployed use the aligned norms.
3. Sit-and-reach records carry the table version. New rows use
   `k11-2026.02-sit-and-reach`; earlier rows may keep `k11-2026.01-sit-and-reach`.
4. `FITNESS_SCORING_VERSION` is exported but **not persisted or read at runtime**. Do not
   bump it as a cutover marker. When the assessment schema is next changed, persist a norm
   version per assessment or per category.
5. If the product later needs historical rows to show current grades, regrade from raw
   values at read time. Do not rewrite the database.

## Alternatives considered

### Backfill stored categories

- **Pros:** one consistent category everywhere.
- **Cons:** rewrites clinical history, needs a verified backup and restore plan, migration
  and rollback risk, and hides the fact that the original assessment used different norms.
- **Rejected.**

### Regrade everything on read now

- **Pros:** current norms everywhere without a database rewrite.
- **Cons:** historical reports and PDFs change over time; requires per-area read-path work
  and tests; signed records should stay as assessed.
- **Deferred.** Revisit as a product decision if historical consistency becomes a
  requirement.

## Consequences

**Positive:** no destructive data change; assessment history stays auditable; new
assessments use the corrected norms; flexibility already carries a version.

**Negative:** old rows can show categories the current norms would not produce; most areas
have no persisted norm version, so "as assessed" relies on the cutover timestamp.

**Risk:** a trainer comparing old and new assessments may see an unexplained category
change. Mitigation: note the cutover in release guidance; an assessment re-saved or
recomputed uses the current norms.

## Cutover inventory

| Area | What changed | Stored behaviour | Version marker |
|---|---|---|---|
| Blood pressure | Dual-criteria table; hypotension is a caution, not a stop; high diastolic precedence | `bp_category` stays as assessed | None |
| Resting heart rate | Bands unchanged; low-RHR and 81–100 guidance changed | `rhr_category` stays as assessed | None |
| SpO₂ | Four tiers; 86–90 now blocks testing | Legacy `Mildly Low` / `Critical` labels display as stored | None |
| Anthropometrics | Waist uses the iliac landmark; WHR uses the narrowest waist; K11 body-fat categories | Labels regraded on read; no stored label dependency | None |
| Cardio | Six step-test categories with open-ended Poor; FITT per-session time; bike modality | `cardio_category` stays as assessed | None |
| Strength | 80th percentile → Above Average | Category stays as assessed | None |
| Muscular endurance | Curl-up 70/30/10 rows; zero reps now scored | Category stays as assessed | None |
| Flexibility | Sit-and-reach Excellent floors and 66+ band | Stored norm payload stays as assessed | `k11-2026.01-sit-and-reach` → `k11-2026.02-sit-and-reach` |

## Identifying post-cutover records

- Sit-and-reach: `flexibility_test_data.tests.sit_and_reach.norm.table_version` is the
  exact marker.
- Other areas: use the deploy timestamp of the norm commit. `assessment_date` alone is not
  sufficient because earlier and later rows can share 2026-11-09.
- No exact marker exists for BP, RHR, SpO₂, cardio, strength or endurance until a norm
  version is persisted.

## Verification evidence

- Frontend targeted Vitest: **1160/1160** (K11 norms, flexibility protocol).
- Backend targeted Jest: **1130/1130** (K11 norms, flexibility route, flexibility protocol).
- `npx tsc --noEmit`: exit 0.
- Targeted ESLint: 0 errors in both repositories.
- Scoring parity: exit 0 — 270,312 fitness calls and 621 flexibility calls agree.
- No full suite, production build, browser/e2e, or staging pass for the norm changes.

## Release and commit plan

The norm work is mixed with unrelated auth/portal work in both working trees. Commit only
the norm files below; leave the auth work uncommitted.

**Frontend (21 files):**

```
src/lib/fitness-calculations.ts
src/lib/cardio-calculations.ts
src/lib/assessment-pdf.ts
src/lib/api/types.ts
src/app/(chrome)/pt-os/assessment/page.tsx
src/app/(chrome)/pt-os/cardio-calculator/page.tsx
src/components/pt-os/TrainingBriefPanel.tsx
src/components/pt-os/fitness-testing/FitnessDashboard.tsx
src/components/pt-os/fitness-testing/StepAnthropometric.tsx
src/components/pt-os/fitness-testing/StepBodyComposition.tsx
src/components/pt-os/fitness-testing/StepCardio.tsx
src/components/pt-os/fitness-testing/fitnessTheme.ts
src/__tests__/anthropometric-classification.test.tsx
src/__tests__/assessment-pdf-scores.test.ts
src/__tests__/cardio-calculations.test.ts
src/__tests__/k11-fitness-norms.test.ts
src/__tests__/k11-step-test-recovery.test.ts
src/__tests__/k11-strength-norms.test.ts
src/__tests__/parq-safety.test.ts
src/__tests__/training-brief-panel.test.tsx
src/__tests__/vitals-classification.test.tsx
```

**Backend (14 files):**

```
src/modules/progress/fitness-scoring.js
src/modules/progress/progress-insights.js
src/modules/progress/progress.routes.js
src/modules/pt-os/cardio.js
src/modules/pt-os/training-brief.js
src/__tests__/assessmentScoring.fixes.test.js
src/__tests__/cardio.engine.test.js
src/__tests__/flexibility.route.test.js
src/__tests__/k11-fitness-norms.test.js
src/__tests__/k11-step-test-recovery.test.js
src/__tests__/k11-strength-norms.test.js
src/__tests__/progress.strengthAndGate.test.js
src/__tests__/training-brief.test.js
src/__tests__/workoutGenerator.engine.test.js
```

**Excluded from the norm commit:** the auth/portal files in `src/lib/auth*`, `src/lib/http.ts`,
`src/lib/portals.ts`, `src/lib/session-*`, `src/proxy.ts`, `src/app/layout.tsx`,
`src/components/auth/SignInScreen.tsx`, the auth/portal tests, and the backend
`src/routes/auth*`, `src/routes/profile.js`, `src/middleware/auth*`, `src/lib/auth*`,
`src/server.js`, `platformNamespace.test.js`, `auth.portalSessions.test.js`.

No commit or push without explicit owner approval.

## Open items

- Clinical sign-off on the behaviour changes (see the companion review sheet).
- Full frontend/backend suites, production build, browser pass and staging verification.
- Persist a norm version per assessment when the schema is next touched.
- Image-gap features: shoulder reach, flexibility protocol copy, visual-test wording,
  the sit-and-reach "Score" label, strength display gaps, endurance protocol text and the
  female 46–55 step-test 94 bpm gap.

## Related files

- `docs/implementation/NORM-ALIGNMENT-CLINICAL-REVIEW-2026-11-09.md`
- `TRACKER.md` — entries `flexibility-norm-comparison`, `endurance-norm-comparison`,
  `strength-norm-comparison`, `cardio-norm-discrepancies`, `anthropometric-bodyfat-norms`,
  `spo2-four-tier-norms`, `rhr-norms`, `bp-dual-norms`.

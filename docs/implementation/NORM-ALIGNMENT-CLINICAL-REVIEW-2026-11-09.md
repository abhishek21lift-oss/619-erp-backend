# Clinical Review — K11 Norm Alignment — 2026-11-09

**Purpose:** review the behaviour-changing fitness norms before the norm-alignment commit
is deployed. This is a product norm review, not a diagnosis protocol.

**Reviewer instructions:** mark each row Approve / Change / Reject, then sign the summary.
Rows 1, 3 and 4 make testing **less** restrictive; rows 2, 5 and 6 make it **more**
restrictive. Those six need the closest review.

| # | Area | Before | After | Why / source | What to confirm | Decision |
|---|---|---|---|---|---|---|
| 1 | BP — hypotension | Low reading was a stop | Low reading is a caution; trainer checks dizziness/fainting and avoids sudden postural changes | Supplied dual-criteria table | Is a caution sufficient, or should low BP still block testing? | |
| 2 | BP — diastolic-only high | A high diastolic with normal systolic could go unflagged | 118/95 → Stage 2; 118/121 → Crisis | Supplied table uses systolic OR diastolic | Confirm the higher-risk row and the >120 crisis diastolic rule | |
| 3 | RHR — low | Non-athlete <40 and athlete <40 stopped | Non-athlete <40 is a caution; athlete <40 is safe with a context note | Supplied RHR table | Confirm the athlete exception and the non-athlete caution wording | |
| 4 | RHR — 81–100 | Added a recheck caution | No additional caution; >100 remains a stop | Supplied table calls 60–100 the wider non-pathological range | Confirm no recheck is needed for 81–100 | |
| 5 | SpO₂ — 86–90 | Caution only | Halts physical testing and seeks medical advice | Supplied four-tier table | Confirm the halt threshold; this is stricter than before | |
| 6 | SpO₂ — 85 and COPD | 85 undefined; no COPD exception | 85 treated as severe; COPD 88–92% targets are not supported, so 86–90 still halts | Image leaves 85 undefined; no COPD field exists | Confirm 85 → severe and accept the COPD limitation, or add a target field | |
| 7 | Body fat — gap and lower bound | No K11 body-fat category | Male 20–25% and female 25–30% show "Above Ideal Range"; below the printed lower bound shows Essential Fat | Image leaves the gap undefined | Confirm the gap label and the Essential Fat treatment | |
| 8 | Waist — landmark | Risk used the narrowest waist | Risk uses the iliac / greatest-anterior-extension landmark; WHR keeps the narrowest waist | Supplied waist table | Confirm the landmark change and that older rows without it are acceptable | |
| 9 | Strength — 80th percentile | 80th percentile scored as Well Above Average (90) | 80th percentile scores as Above Average (70) | Supplied strength images | Confirm the 70–80% band | |
| 10 | Endurance — zero and curl-ups | Zero reps was "not performed"; curl-up table omitted 70/30/10 rows | Zero scores; added rows move the band floors | Supplied curl-up table | Confirm a recorded 0 should score, while a blank stays unclassified | |
| 11 | Flexibility — sit-and-reach | Excellent floor was 1–3 inches too high; no 66+ band | Excellent floors use the image floors; 66+ band added | Supplied sit-and-reach table | Confirm the printed range floor is the intended cutoff | |
| 12 | Cardio — step test | Male had a seventh `Very Poor` band above 128 bpm | Six categories; Poor is open-ended to the 220 bpm guard | Supplied cardio images (no numeric table) | Confirm retaining the printed bands and making only Poor open-ended | |

## Sign-off

**Reviewer:** ______________________________

**Role / credential:** ______________________________

**Date:** ______________________________

**Decision:** ☐ Approve  ☐ Approve with changes  ☐ Reject

**Conditions or required changes:**

______________________________________________________________________________

______________________________________________________________________________

**Signature:** ______________________________

## Notes

- The numeric tables and the current test evidence are in
  `docs/implementation/NORM-ALIGNMENT-CUTOVER-2026-11-09.md` and `TRACKER.md`.
- No production deploy, migration or data backfill is part of this review.
- If a row is rejected, name the row number and the required behaviour; the code change is
  small and can be reverted independently.

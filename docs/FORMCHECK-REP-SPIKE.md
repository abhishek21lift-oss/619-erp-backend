# Form-check rep count spike (public clips)

Date: 2026-11-01

## Question

Can a generic pose-based counter, with no per-clip tuning, count reps within
+/-1 on a single fixed camera? This decides whether "AI form check" can ship a
rep count at all, before any provider is chosen.

## Method

- 14 public exercise clips from Wikimedia Commons (public domain / CC BY-SA),
  downloaded locally. Nothing was uploaded anywhere.
- MediaPipe `PoseLandmarker` (lite, VIDEO mode), CPU only.
- One counter, no per-clip thresholds. Per exercise only the joint angle to
  watch changes: knee for squat/lunge, hip (shoulder-hip-knee) for deadlift,
  elbow for push-up/curl.
- Ground truth was hand-counted from contact sheets with the skeleton drawn and
  the frame cropped to the person, then reconciled against the angle trace with
  one rule: a rep is a >=30 deg flexion from the standing baseline that returns
  to standing.
- Loss: exact count is secondary, within +/-1 is the pass criterion.

## Result

| clip | truth | prominence counter | delta | hysteresis counter | delta |
|---|---|---|---|---|---|
| squat_demo | 2 | 2 | 0 | 2 | 0 |
| deadlift_demo | 2 | 2 | 0 | 1 | -1 |
| kb_deadlift | 8 | 9 | +1 | 6 | -2 |
| kb_squat_side | 8 | 8 | 0 | 5 | -3 |

Prominence counter: **3/4 exact, 4/4 within +/-1, mean absolute error 0.25 reps
over 20 reps.**

Only 4 of 14 clips were scorable. The other 10 were excluded on input quality,
not algorithm quality:

- camera cuts, zooms or close-ups of legs/plates: assistive_sumo, forward_lunge,
  pushup_8count, squat_jump, curl_machine, sumo_deadlift
- handheld camera with the horizon swinging: kb_pushup_combo
- 320x240, two people, crop jumps: curl_home
- long isometric holds with no rep boundary: kb_lunge, overhead_lunge

## The one bug that mattered

A fixed percentile band (20th/80th of the whole clip) merges reps when range of
motion drifts inside the clip. In `kb_deadlift` the first reps top out at 156 deg
and later ones at 106 deg, so the band sits above the later peaks and 3 of 8 reps
are lost.

Counting **swings** instead of absolute levels fixes it: a rep is a valley
followed by a peak whose rise is at least 40% of the clip's own p80-p20 range.
Same generic rule, no per-clip values, 5 -> 9 against a truth of 8.

The other bug: a clip that opens at the top or the bottom drops its first rep
unless the counter seeds its state from the first valid sample.

## What this means

The pose signal is good enough. Counting logic is not the risk.

The risk is capture. Every failure above is a video problem - framing, distance,
cuts, handheld shake - and real client footage will contain all of them. A
propped phone with the whole body in frame works. A phone handed to a friend
across a gym floor does not.

## Recommendation

Conditional go, as **rep count assist**, not as an authoritative count:

1. Ship the capture checklist first: prop the phone, whole body in frame, one
   continuous shot, side or 45 degrees, no zoom.
2. Show a number with a visible quality gate; suppress the count when pose
   coverage or range of motion is too low.
3. Do not sell form scoring on this evidence.
4. Before choosing hosted vs local provider, run 5-10 real clips from a
   trainer's own library. Four studio clips cannot pick a provider.

CPU-only inference was slower than real time per clip, so this must stay an
async job - which the existing form-check queue already is.

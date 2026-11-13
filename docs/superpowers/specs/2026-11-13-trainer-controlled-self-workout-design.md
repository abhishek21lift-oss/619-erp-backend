# Trainer-Controlled Client Self Workout — Design

**Status:** approved 2026-11-13.

## Intent

The member app can already run a guided workout, but any member with a programme
can start one. The studio needs an explicit, auditable permission: the trainer
decides whether a client may train independently, and submitted workouts come
back to the trainer for review.

## Goals

- `pt_clients.allow_self_workout`, default `false`, trainer-only and org-scoped.
- Server-side enforcement on session start and on the legacy one-shot log.
- A server-backed in-progress session: start/resume, autosave, submit, discard.
- A prescription snapshot kept beside the actual performance.
- Immutable submitted records, timestamps, and a pending-review queue.
- Trainer review with approve / changes-requested and feedback.
- Audit rows for permission changes and session lifecycle events.
- No duplicate workout system; trainer-led logging is untouched.

## Non-goals

- Multi-trainer studios: the product has one trainer account per tenant, so
  "assigned trainer" is the studio's trainer account.
- Client editing of a submitted workout.
- Cross-client or cross-tenant reporting beyond the existing workout log.

## Constraints

- Canonical tables: `workout_sessions` → `workout_session_exercises` →
  `workout_sets`. `source = 'member'` already separates member sessions.
- Member identity always comes from `req.user.pt_client_id` and
  `req.user.organization_id`; never from the request.
- Trainer routes stay behind `requireTrainer` and every query is org-scoped.
- Migration 283 is additive and idempotent, with no `BEGIN`/`COMMIT`.
- Existing trainer-led session behaviour and the legacy member POST stay working.

## Approaches

1. **Extend `workout_sessions` (chosen).** Add `prescribed`, `draft`,
   `started_at`, `submitted_at`, and review columns to the existing session row.
   Autosave writes the draft JSONB; submit materialises the canonical exercise
   and set rows. One session system, one history.
2. **Local-only draft.** Keep localStorage as the only autosave and add review
   columns at submit. Less work, but no cross-device recovery and no server-side
   session lifecycle to audit. Rejected.
3. **New member-session table.** Rejected: duplicates the canonical session
   system and splits history.

## Decisions

- Permission OFF hides Start but never blocks an in-progress session from
  autosaving or being submitted. Revocation must not destroy work.
- Starting resumes the latest open member session within 24 hours; older open
  member sessions are marked `abandoned` (never deleted).
- A submitted member session cannot be changed by the member. Trainer
  exercise/set writes on a submitted member session are refused too; the review
  is the only write.
- Review states: `pending` on submit, then `approved` or `changes_requested`,
  with optional feedback. The member sees the outcome in session history.
- Trainer notification on submit; member notification on review.
- The prescription snapshot is built from the same resolved plan payload the
  member sees (`portal.myWorkout`), so the two cannot disagree.
- Legacy `POST /api/me/workouts` remains, permission-gated, and creates a
  completed session with a snapshot and `review_status = 'pending'`.

## What is left to the builder

Exact endpoint names, payload shapes, UI placement, and test layout are fixed in
the implementation plan (`docs/superpowers/plans/2026-11-13-trainer-controlled-self-workout.md`).

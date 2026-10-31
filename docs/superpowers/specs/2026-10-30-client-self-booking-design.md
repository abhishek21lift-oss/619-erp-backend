# Client self-booking, availability and reminders — design

Status: draft for approval, 2026-10-30.
Phase 1 of the PT OS expansion (sequence: delivery loop → churn AI → video review → money → surface).

## Intent

Every session today is booked by the trainer from `/pt-os/schedule-session`. A PT
client has a portal (`/member`, `/api/me`) but cannot see or claim a slot, so every
booking, reschedule and cancellation arrives as a WhatsApp message and the trainer
is the bottleneck. This phase lets the trainer publish weekly availability once,
lets the client book inside it, and reminds both sides before the session.

## Goals

1. Trainer publishes weekly availability and time off from one screen.
2. Client sees real free slots for the next N days and books one; it appears
   immediately in the trainer's Sessions list.
3. Client can reschedule or cancel until a cutoff; after the cutoff the app tells
   them to message the trainer (the trainer can still cancel).
4. Reminders: an in-app notification always; WhatsApp 24 h and 2 h before start,
   through the existing automation engine (opt-out and studio switch respected).
5. Trainer can subscribe to their sessions from Google/Apple/Outlook Calendar
   through a read-only ICS URL.

## Non-goals

- Public (unauthenticated) booking page or discovery — that is Phase 5.
- Two-way Google Calendar OAuth sync.
- Payment or package deduction at booking time — money is Phase 4. The existing
  training-eligibility gate still applies.
- Group sessions, multi-trainer round robin, waitlists.

## Anti-goals

- No gym vocabulary (classes, memberships, branches) reintroduced.
- No second booking store beside `pt_sessions`: one table, one source of truth.
- No materialised slot inventory: slots are derived from availability minus
  sessions, so they cannot drift.

## Constraints

- `pt_sessions` stores wall-clock `session_date` + `start_time` with no timezone.
  The server runs UTC. The product is India-only (₹, UPI), so all times are treated
  as Asia/Kolkata; the reminder computation must do this explicitly and say so in a
  `shortcut:` comment.
- `pt_sessions` still carries legacy gym columns (`member_id`, `starts_at`, …).
  Leave them untouched.
- Existing status machine: `scheduled → completed | cancelled | no_show`, and
  `cancelled | no_show → scheduled`.
- Tenant isolation: every query binds `organization_id`; client routes take identity
  from the token only, never from a request field.

## Approaches

**A. Slot storage — computed vs materialised.** Computed wins: availability windows
minus booked sessions, evaluated per request over a bounded horizon (30 days
default). No generation job, no drift when a session is cancelled outside the app.
Materialised slots would read faster and need a refresh job plus cleanup — not worth
it for one trainer.

**B. Calendar sync — OAuth 2-way vs read-only ICS.** ICS wins. A per-trainer signed
URL works in every calendar app, stores no credentials, and needs no refresh or
revocation flow. The gym era's Google OAuth integration was just deleted and
re-adding it is several times the work. Trade-off: events in the trainer's personal
calendar do not block slots; the trainer blocks time in-app instead (time off).

**C. Confirmation — auto-confirm vs request/approve.** Auto-confirm inside published
availability; that is what publishing availability means. A solo trainer does not
need a second inbox. Request/approve is the right model for the public page (Phase 5),
where the client is unknown.

## Data model (migration 245)

```sql
trainer_availability (
  id text primary key default gen_random_uuid()::text,
  organization_id uuid not null,
  trainer_id text not null,
  weekday smallint not null check (weekday between 0 and 6),  -- 0 = Sunday
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  unique (trainer_id, weekday, start_time),
  check (start_time < end_time)
)

trainer_time_off (
  id text primary key default gen_random_uuid()::text,
  organization_id uuid not null,
  trainer_id text not null,
  starts_on date not null,
  ends_on date not null,
  reason text,
  created_at timestamptz not null default now(),
  check (starts_on <= ends_on)
)

trainer_booking_settings (
  organization_id uuid not null,
  trainer_id text not null,
  slot_minutes int not null default 60,
  buffer_minutes int not null default 0,
  min_notice_hours int not null default 12,
  horizon_days int not null default 30,
  cancel_cutoff_hours int not null default 12,
  ics_token text not null unique,
  primary key (organization_id, trainer_id)
)
```

- Partial unique index on `pt_sessions (trainer_id, session_date, start_time)` where
  `deleted_at is null and status = 'scheduled' and start_time is not null` — the last
  line of defence against a double booking. The migration first checks for existing
  duplicates and raises with the offending rows rather than deleting anything.
  Verified against production on 2026-10-30: 0 duplicate slots, 1 `pt_sessions` row
  total, so the index applies cleanly.
- `automation_rules` trigger CHECK gains `session_reminder`.
- RLS enabled and org-scoped on the three new tables, using the migration 227
  `pt_client_interviews` policy template (`pt_sessions` itself has no RLS).

## Slot computation

For each day in `[today, today + horizon_days)`:

- windows = availability rows for that weekday, minus time-off ranges;
- subtract existing `scheduled` sessions for that trainer (plus `buffer_minutes`);
- keep starts at least `min_notice_hours` in the future;
- cap the day at the last start that fits `slot_minutes` before the window ends.

Returns `{ days: [{ date, slots: [{ start, end }] }] }`. The same function backs the
client list and the server-side validation on book/reschedule, so a slot the client
was shown is a slot the server accepts.

## API

Client — mounted under `/api/me`, `auth + requireClient` (identity from token only):

| Method | Path | Behaviour |
|---|---|---|
| GET | `/booking/availability` | free slots for the horizon |
| GET | `/booking` | upcoming sessions + `can_cancel` per row |
| POST | `/booking` | book `{date, start}`; 409 `SLOT_TAKEN`, 400 `OUTSIDE_AVAILABILITY` / `TOO_SOON` |
| PATCH | `/booking/:id` | reschedule in one transaction; old slot kept on conflict |
| DELETE | `/booking/:id` | cancel; 409 `CANCEL_CUTOFF_PASSED` after the cutoff |

Trainer — mounted under `/api/pt-os`, `auth + requireTrainer`:

| Method | Path | Behaviour |
|---|---|---|
| GET/PUT | `/availability` | read; PUT replaces the week atomically |
| GET/POST | `/time-off` | list; create (refuses ranges that collide with booked sessions) |
| DELETE | `/time-off/:id` | remove |
| GET/PUT | `/booking-settings` | read/update; creates the row + ICS token on first save |

Public — `GET /api/public/calendar/:token.ics`, no auth. 90 days of `scheduled`
sessions for that trainer, `text/calendar`. Unknown token → 404.

Booked sessions use `created_by = req.user.id`, `client_id` and `organization_id`
from the token, `session_type` default `1-on-1`, `title` default `PT Session`. The
existing `checkTrainingEligibility` gate runs before insert, as it does for the
trainer's booking route.

## Reminders

A new 15-minute job on the automation queue (same pattern as `TERM_EXPIRY_JOB_ID`),
not the daily sweep:

- bucket `24h`: sessions starting between 23 h 45 m and 24 h 15 m from now (IST);
- bucket `2h`: sessions starting between 1 h 45 m and 2 h 15 m from now (IST).

For every match: write a `notifications` row for the client's user id (always — no
configuration needed), then `emit('session_reminder', …)` with dedupe key
`session_reminder:<rule>:<session_id>:<bucket>`. WhatsApp therefore fires only if the
studio has an active rule for the event, and respects opt-out; the availability
screen links to Automation settings instead of seeding a rule silently.

The job scans every scheduled session in the window, not the automation-enabled
orgs list: the in-app reminder must reach studios that never switched automation
on, and `emit()` already no-ops for a disabled studio or a missing rule.

Template placeholders: `client_name`, `date`, `time`, `when` ("tomorrow" / "in 2 hours").

## UI

Member portal:

- nav "Book" → `/member/book`: next 30 days, slot chips, confirm sheet;
  "My sessions" list with Reschedule/Cancel (disabled with the cutoff message).
- dashboard card: next session + Book.

Trainer:

- nav Sessions → "Availability" → `/pt-os/availability`: weekly windows, time off,
  settings, ICS URL (copy + "Add to Google Calendar"), reminders hint.
- Sessions list marks client-booked rows with a small "Booked by client" badge.

## Edge cases

- **Race on a slot** — unique index rejects the second insert; map to 409.
- **Trainer shrinks availability with future bookings** — existing bookings stay;
  the editor shows how many fall outside and asks for confirmation. Nothing is
  cancelled silently.
- **Time off over booked sessions** — refused with the conflicting rows listed.
- **Client with no active term** — blocked by the existing eligibility check.
- **Cancellation after cutoff** — 409 with a message to contact the trainer; trainer
  cancellation is unrestricted.
- **Reschedule** — one transaction: validate new slot, update, re-check the index; a
  conflict leaves the original booking untouched.
- **Duplicate sessions already in the table** — migration fails loudly; a human
  decides what to do.
- **ICS** — cancelled/completed sessions are excluded; invalid token returns 404.

## Tests

- Migration: constraint and index exist; duplicate check fails loudly on seeded dupes.
- Slot computation unit tests: windows, buffer, notice, horizon, time off, booked
  slots, cross-tenant isolation.
- Route integration: book → 409 on repeat → cancel → rebook; cutoff rejection;
  reschedule atomicity; client cannot name another client (no parameter exists).
- Reminder job: 24 h and 2 h windows, dedupe per bucket, opt-out, automation off,
  in-app row always written.
- ICS: valid token shape, invalid token 404, cancelled excluded.
- Frontend: slot picker renders only returned slots; cancel confirmation; availability
  editor rejects overlapping windows.
- E2E: trainer saves availability → client books → trainer session list shows it.

## Rollout and rollback

- Migration 245 runs in the normal deploy; no backfill.
- No feature flag: a client with no published availability sees "Your trainer hasn't
  opened booking yet".
- Rollback is code-only; the new tables are inert if the code is reverted.

## Left to the builder

- Migration filename/style and RLS policy shape, matching the neighbouring PT tables.
- Router file placement and the cron env var name.
- Empty-state and badge copy.

# Siri integration — Phases 1–7

Enables:

> **Phase 1** — "Hey Siri, how many clients do I have in MY PT STUDIO?"
> **Phase 2** — "Hey Siri, find Rahul in MY PT STUDIO."
> **Phase 3** — "Hey Siri, show me Rahul's details in MY PT STUDIO."
> **Phase 4** — "Hey Siri, show me today's workouts in MY PT STUDIO."
> **Phase 5** — "Hey Siri, create a workout for Rahul." *(the first write)*
> **Phase 6** — "Hey Siri, mark Rahul's workout as completed."
> **Phase 7** — "Hey Siri, does Rahul have any pending payment?" /
>   "Hey Siri, record a payment from Rahul." *(money)*

## Architecture

```
Siri
  → GetClientCountIntent (App Intent, on device)
      → reads bearer token from Keychain (written by the host app at sign-in)
  → GET /api/voice/dashboard/client-count      (https, bearer token)
      → auth middleware        — resolves the session to a user row
      → requireStaff           — refuses role=member
      → orgWhere(req, …)       — appends organization_id = $N from the SESSION
      → Postgres               — COUNT(*) over pt_clients, fixed SQL
      → activity_log           — audit row, fire-and-forget
  → { count, scope, spoken }
  → Siri speaks `spoken`

Siri
  → FindClientIntent (App Intent, on device)          [Phase 2]
      → name spoken as a parameter; token from Keychain
  → GET /api/voice/clients/search?q=…          (https, bearer token)
      → auth → requireStaff
      → zod validation        — q trimmed, 2-60 chars, else 400
      → orgWhere(req, …)      — organization_id from the SESSION
      → trainer narrowing     — a trainer sees only their own roster
      → Postgres              — fixed SQL, q bound as $1, LIMIT 5
      → activity_log          — audit row
  → { query, count, results[], spoken }
  → Siri speaks `spoken`

Siri
  → GetClientDetailIntent (App Intent, on device)     [Phase 3]
      → the CLIENT is an entity parameter, not a name
      → ClientEntityQuery resolves the spoken name via /clients/search
      → several matches → Siri asks WHICH ONE, before any detail is read
  → GET /api/voice/clients/:clientId           (https, bearer token)
      → auth → requireStaff
      → zod validation        — id shape and length bounded, else 400
      → clientInOrg(req, id)  — OWNERSHIP FIRST, before any client read
      → orgWhere(req, …)      — organization_id from the SESSION
      → trainer narrowing     — a trainer sees only their own roster
      → Postgres              — fixed SQL; two best-effort side reads
      → activity_log          — audit row
  → { id, name, status, active, package_type, expires_on, expired,
      sessions_remaining, today, spoken }
  → Siri speaks `spoken`

Siri
  → GetTodaysWorkoutsIntent (App Intent, on device)   [Phase 4]
      → NO parameter — subject is always "my studio, today"
  → GET /api/voice/workouts/today              (https, bearer token)
      → auth → requireStaff
      → zod validation        — query is .strict(): unknown keys are 400
      → studioToday()         — the STUDIO's calendar day, not UTC's
      → orgWhere(req, …)      — organization_id from the SESSION, all 3 tiers
      → trainer narrowing     — resolveMyTrainerIds(), fails closed
      → Postgres              — 3 fixed queries: booked / programme / enrolment
      → activity_log          — audit row
  → { date, timezone, count, booked_count, sessions[], truncated,
      trainer_linked, spoken }
  → Siri speaks `spoken`

Siri
  → PrepareWorkoutIntent (App Intent, on device)      [Phase 5]
      → NOT available from the lock screen
      → client resolved via ClientEntityQuery (disambiguates first)
  → POST /api/voice/workouts/prepare           (https, bearer token)
      → auth → requireStaff → adminManagerOrTrainer
      → voiceWriteLimiter     — 12/min, not the read surface's 200
      → clientInOrg()         — ownership, 404 not 403
      → trainer narrowing     — a trainer authors only for their own client
      → checkScreeningGate()  — PAR-Q block stops it here
      → contraindication filter REMOVES exercises from the candidate list
      → selection (model, or deterministic when the model is unavailable)
      → INSERT voice_workout_drafts        ← the ONLY write
      → activity_log
  → { draft_id, preview, excluded, saved: false, spoken }
  → Siri SPEAKS the draft and ASKS
      → user declines → nothing happens, the draft expires
      → user confirms ↓
  → POST /api/voice/workouts/confirm    body: { draft_id }  ← nothing else
      → BEGIN
      → UPDATE … SET status='confirmed' WHERE id AND pending
                     AND organization_id AND created_by     ← the claim
      → checkScreeningGate() AGAIN, against live data
      → re-validate every exercise against the live library
      → INSERT workout_plans / workout_exercises / workout_assignments
      → COMMIT
      → activity_log
  → { saved: true, workout_plan_id, workout_plan_name, client_name, spoken }
  → Siri speaks "Done. Rahul's workout has been saved."

Siri
  → CompleteWorkoutIntent (App Intent, on device)     [Phase 6]
      → NOT available from the lock screen; no confirmation step
      → client resolved via ClientEntityQuery (disambiguates first)
  → POST /api/voice/workouts/complete   body: { client_id }
      → auth → requireStaff → adminManagerOrTrainer
      → voiceWriteLimiter     — 12/min
      → clientInOrg()         — ownership, 404 not 403
      → trainer narrowing     — a trainer completes only their own client's
      → SELECT the session for the STUDIO's today, org-filtered
          → none          → 404, nothing written, no session invented
          → already done  → 200, nothing written, DIFFERENT sentence
      → UPDATE … SET status='completed' WHERE id AND status <> 'completed'
      → recomputeAssignmentProgress()  ← the app's own business logic
      → activity_log
  → { completed, already_completed, session_id, client_name, date, spoken }
  → Siri speaks "Done. Rahul's workout is marked completed."

Siri
  → CheckPaymentStatusIntent (App Intent, on device)  [Phase 7]
  → GET /api/voice/payments/client/:clientId/status
      → auth → requireStaff → clientInOrg() → trainer narrowing
      → pt_clients balance + the LATEST payment only (LIMIT 1)
  → { client_name, outstanding, last_payment, package, spoken }

Siri
  → RecordPaymentIntent (App Intent, on device)       [Phase 7]
      → NOT available from the lock screen
  → POST /api/voice/payments/prepare   body: { client_id, amount }
      → auth → requireStaff → adminManagerOrTrainer → voiceWriteLimiter
      → clientInOrg() → trainer narrowing
      → amount validated: > 0, <= 1,000,000, at most 2 decimals
      → duplicate scan: identical amount in the last 10 minutes?
      → INSERT voice_payment_drafts        ← the ONLY write; no money moves
  → { draft_id, amount, outstanding_before, recent_duplicate, spoken }
  → Siri ASKS "Record 3,000 rupees payment for Rahul?"
      → no  → nothing happens, the draft expires in 10 minutes
      → yes ↓
  → POST /api/voice/payments/confirm   body: { draft_id }   ← NO amount
      → BEGIN
      → UPDATE … SET status='confirmed' WHERE id AND pending
                     AND organization_id AND created_by     ← the claim
      → SELECT … FROM pt_clients FOR UPDATE                 ← the lock
      → re-check org and trainer against the LIVE row
      → recordPayment()  ← lib/paymentService.js, shared with the finance UI
          → INSERT pt_payments (receipt no, incentive)
          → UPDATE pt_clients paid_amount / balance_amount
      → COMMIT → activity_log
  → { recorded: true, payment_id, receipt_no, outstanding_after, spoken }
```

The intent sends a **path and a token**. It never sends an organization id, a
query, a filter or a table name, so there is no request it can make — malformed
or malicious — that widens what is counted. The SQL is fixed at author time and
its only variable is the org id the server resolved from the caller's own
session.

## API

### `GET /api/voice/dashboard/client-count`

**Auth:** `Authorization: Bearer <token>` — the same session token the web app
uses. No separate voice credential exists, by design: one fewer secret to
store, revoke and rotate.

**Authorization:** staff only. The allow-list is `middleware/rbac.js`'s
`STAFF_ROLES` — `super_admin`, `admin`, `manager`, `staff`, `trainer`,
`reception`, `receptionist`. `member` — the role client activation gives a gym
client — is refused with 403. (There is no `owner` role in this system.)

**Response `200`**

```json
{ "count": 7, "scope": "active", "spoken": "You have 7 active clients." }
```

| Field    | Meaning                                                              |
| -------- | -------------------------------------------------------------------- |
| `count`  | Active, non-deleted clients in the caller's organization              |
| `scope`  | Always `"active"` in Phase 1 — names the predicate so it can widen later |
| `spoken` | The sentence Siri reads aloud, pluralised server-side                 |

`spoken` is built on the server so the wording can be corrected without an App
Store release.

**Errors**

| Status | Cause                        | What the intent says                              |
| ------ | ---------------------------- | ------------------------------------------------- |
| `401`  | Missing/expired/revoked token | "Please sign in to MY PT STUDIO first."           |
| `403`  | A client account asked        | "Please sign in to MY PT STUDIO first."           |
| `429`  | Rate limited                  | "Too many requests just now…"                     |
| `5xx`  | Server fault                  | "MY PT STUDIO could not answer that right now."   |

An empty roster is **not** an error: it returns `200` with `count: 0` and is
spoken as "You have 0 active clients."

**Rate limiting:** `userApiLimiter` — 200 requests/minute keyed on the **user**,
not the IP. A phone on cellular shares an egress IP with the whole carrier, so
an IP-keyed limit would let one device throttle unrelated studios.

**Audit:** every call writes `voice.dashboard.client_count` to `activity_log`
with the org id, the count and `channel: "voice"`. A voice request leaves no UI
trace, so the audit row is the only record it happened.

### `GET /api/voice/clients/search?q=Rahul` *(Phase 2)*

**Auth / authorization:** as above, plus **a trainer sees only their own
roster** — narrower than the org filter and applied *in addition* to it, the
same rule as `routes/search.js` and `routes/clients.js`. A trainer account with
no trainer record returns zero results rather than falling through to the whole
studio.

**Validation:** `q` is trimmed and must be 2–60 characters. One character
matches most of a roster and turns search into enumeration; 60 is past any real
name. It reaches SQL as a bound parameter (`$1`), never interpolated.

**Response `200`**

```json
{
  "query": "Rahul",
  "count": 1,
  "results": [{
    "id": "ptc-1",
    "client_id": "PT001",
    "name": "Rahul Sharma",
    "status": "active",
    "package_type": "PT 3 Month",
    "expires_on": "2026-01-01",
    "expired": false
  }],
  "spoken": "Rahul Sharma is active until 2026-01-01."
}
```

Capped at **5 results**.

**What it deliberately does not return:** no mobile, no email, no address, no
amounts — those columns are not even selected. Whatever comes back may be
spoken aloud with other people in the room, and a phone number read out near a
stranger cannot be un-said.

**The spoken cases**

| Case | Spoken |
| --- | --- |
| No match | "I could not find anyone matching Rahul." |
| One match, active | "Rahul Sharma is active until 2026-01-01." |
| One match, expired | "Rahul Sharma has an expired package, which ended on …" |
| One match, inactive | "Rahul Sharma is frozen." |
| Several matches | "I found 2 people matching Rahul: Rahul Sharma, Rahul Verma." |

Several matches are **counted and named, never guessed between** — picking a
"best" match would have Siri state one person's expiry with total confidence
when it may be the other's, and the user cannot see that it chose.

`expired` is `null`, not `false`, when a client has no `pt_end_date` on file:
no date means unknown, and announcing "expired" would be a claim about the
client rather than about the record.

**Audit:** writes `voice.clients.search` with the query and the result count —
what was asked, not the roster that came back.

### `GET /api/voice/clients/:clientId` *(Phase 3)*

**Auth / authorization:** as above — staff only, org filter from the session,
trainer narrowing — plus **an explicit ownership check on the id itself**,
before any client data is read.

This endpoint is the first on this surface that takes an id chosen by the
caller rather than a term to match, so the id is checked against the caller's
organization by `clientInOrg()` first. `src/modules/automation/` carries the
header comment explaining why: handlers there once took a `client_id` from the
request without that check and returned every studio's client names and mobile
numbers to any authenticated account of any role.

**404, never 403.** A client id belonging to another studio returns the same
`404` as an id that does not exist anywhere. A `403` would confirm the id is
real, which turns the endpoint into an existence oracle for anyone willing to
guess ids. The `spoken` sentence is identical in both cases for the same
reason.

**Validation:** `clientId` is bounded at 64 characters and must match
`^[A-Za-z0-9_-]+$`. It reaches SQL as a bound parameter (`$1`).

**Response `200`**

```json
{
  "id": "ptc-1",
  "name": "Rahul Sharma",
  "status": "active",
  "active": true,
  "package_type": "PT Gold",
  "expires_on": "2026-09-14",
  "expired": false,
  "sessions_remaining": 8,
  "today": { "status": "in_progress", "program_name": "Push Day" },
  "spoken": "Rahul Sharma is on PT Gold. Their package expires on 14 September, they have 8 sessions left, and today's workout is pending."
}
```

**What it deliberately does not return:** no mobile, no email, no address, no
payment amounts, no trainer id, no organization id and no row ids from the
joined tables. Those columns are not selected. The one identifier in the
response is the `pt_clients` id the search endpoint already returned, and it
is **never spoken** — it is there for the intent to pass back on the next call.

**Unknown is not zero.** Two of the fields come from side reads that may find
nothing:

| Field | `null` means | `0` / `"none"` means |
| --- | --- | --- |
| `sessions_remaining` | no active balance on file | they have run out |
| `today.status` | — | `"none"`: nothing logged today |

`sessions_remaining: null` is left **out of the spoken sentence entirely**
rather than spoken as zero — "they have 0 sessions left" is a claim about the
client, and nothing was measured. Likewise `expired` is `null`, not `false`,
when no `pt_end_date` is on file.

Both side reads are best-effort: if the balance or the workout log cannot be
read, the package facts still answer, and today's state is spoken as "today's
workout could not be checked" rather than as "nothing logged".

**The spoken sentence** is assembled server-side like the others, so wording is
correctable without an App Store release. It is **gender-neutral** — the record
has a `gender` column, but inferring a pronoun from it would be wrong for some
clients and is not worth being wrong about out loud. "Their package" is always
correct.

**Audit:** writes `voice.clients.detail` with the client id and
`channel: "voice"`. A retrieval that names one person is worth a row of its own.

### `GET /api/voice/workouts/today` *(Phase 4)*

**Auth / authorization:** staff only, org filter from the session, and **a
trainer sees only their own diary**.

**Takes no input.** The query schema is `z.object({}).strict()`, so
`?organization_id=…` or `?trainer_id=…` returns `400` rather than being
silently ignored. Silently ignoring a parameter is what makes the next reader
assume it was honoured.

**Response `200`**

```json
{
  "date": "2026-08-22",
  "timezone": "Asia/Kolkata",
  "count": 6,
  "booked_count": 2,
  "truncated": false,
  "trainer_linked": true,
  "sessions": [{
    "client_id": "ptc-rahul",
    "client_name": "Rahul Sharma",
    "program_name": "Push Pull Legs",
    "start_time": "09:00",
    "time_source": "booked",
    "status": "scheduled",
    "trainer_name": "Coach A",
    "source": "booked"
  }],
  "spoken": "You have 6 PT sessions today. Rahul at 9 AM, Amit at 11 AM, and four more."
}
```

Capped at **25**; `truncated` says when it clipped.

#### Why three sources and not just the appointment book

The obvious query is `pt_sessions WHERE session_date = today`. It also ships a
dead feature: `pt-os.service.js` records that `pt_sessions` "holds no rows at
all while five assignments are active", because these studios run off
programmes rather than a diary. A voice command that answers "no sessions
today" every day is worse than no command — the dashboard panel next door was
rebuilt twice for exactly this reason.

So the same three tiers that panel settled on, each more specific than the next:

| `source` | Where it comes from | Has a time? |
| --- | --- | --- |
| `booked` | a real slot in `pt_sessions` | yes — `time_source: "booked"` |
| `programme` | an active plan whose exercises name today's weekday | no |
| `enrolment` | the client's own `preferred_training_days` | only a preference |

A client appears **once**, under the most specific tier that matches — the
`NOT EXISTS` clauses are what stop the same person being announced three times,
and the count is the whole answer on a surface with no screen to check.

Cancelled slots are excluded. "You have 6 sessions today" must not count a
session the studio cancelled.

#### The time is never invented

Only a `booked` row carries a time the studio committed to. A programme names
a **day**, never an hour. An enrolment carries a **preference**, and
`preferred_workout_time` is free text holding two formats (`6:00 AM` from the
dropdown, `06:00` from the `<input type="time">`) — anything matching neither
becomes `null` rather than being spoken as a time.

Spoken accordingly: `"Rahul at 9 AM"` for a booked slot, `"Sana around 6 AM"`
for a preference, and the bare first name when there is no time at all.
Announcing a preference as an appointment sends a trainer to a slot nobody
agreed to.

#### Today is the studio's today

`studioToday()` / `studioShortDay()` from `src/lib/appTime.js` — Asia/Kolkata
by default, overridable via `APP_TIMEZONE`. Not the phone's zone, not UTC.
This is the command people use first thing in the morning, and in IST a UTC
"today" is still yesterday until 05:30. A trainer checking the roster from
another country must see the day the **studio** is operating on.

The same fix was applied to the Phase 3 detail endpoint in this phase: its
`expired` comparison was using `new Date().toISOString()`, which is the bug
`appTime.js` exists to end.

#### What it deliberately does not return

No mobile, email, address or amount — not selected by any of the three tiers.
No organization id and no trainer id in the body. The one identifier is the
`pt_clients` id (the same opaque handle `/clients/search` already returns, so
no new exposure) and it exists for a Shortcut to chain into Phase 3's detail
endpoint. **It is never spoken.**

Only **first names** are spoken, and at most three. Naming three people is what
makes the answer useful; naming them in full is what makes it worth
overhearing.

#### An empty day is not an error

`200` with `count: 0` and "You have no workouts scheduled today."

An account not linked to a trainer profile is its own state, not an empty day:
`trainer_linked: false`, and a sentence that says why. That distinction was a
real reported complaint — `users.trainer_id` is only ever populated by the
studio-approval path, so a studio owner who trains can easily have no link.

**Audit:** writes `voice.workouts.today` with the date and the count.

### `POST /api/voice/workouts/prepare` and `/confirm` *(Phase 5 — the first write)*

**Auth / authorization:** staff, **plus** `adminManagerOrTrainer` — the same
middleware `POST /api/workouts/plans` uses. The permission to author a plan by
voice is exactly the permission to author one in the app, not a second looser
rule that happens to live on a different surface. Reception can ask this
surface questions and cannot create a workout.

A trainer may author only for their own client (404, not 403). The client id is
checked with `clientInOrg()` before anything about them is read.

**Rate limit:** `voiceWriteLimiter` — **12/min**, not the read surface's 200. A
read that runs away wastes a query; a write that runs away rewrites a client's
programme.

#### Why this is two endpoints

The tempting design returns the generated plan to the phone and has `/confirm`
accept it back. That is not a confirmation step — it is an exercise-injection
endpoint with an extra round trip, because whatever comes back is whatever the
caller chose to send. Every safety decision made during preparation (the PAR-Q
gate, the contraindication filter, the library check) would become advisory:
whatever they removed, the second call could put back.

So the draft is written to `voice_workout_drafts` and **`/confirm` accepts one
field**:

```json
{ "draft_id": "…" }
```

The body schema is `.strict()`, so `exercises`, `plan`, `client_id` or anything
else is a `400`. There is no request that can save an exercise this server did
not generate and check.

#### Prepare saves nothing

`POST /api/voice/workouts/prepare` → `201`

```json
{
  "draft_id": "…",
  "expires_at": "…",
  "preview": { "client_name": "Rahul Sharma", "plan_name": "Rahul's 4-day plan",
               "days": 4, "difficulty": "beginner", "source": "derived",
               "based_on_plan_name": "Push Pull Legs", "exercises": [ … ] },
  "screening_warnings": [],
  "excluded": [{ "exercise_id": "…", "name": "Box Jump",
                 "contraindication": "knee injury", "matched": "knee injury" }],
  "saved": false,
  "spoken": "I prepared a 4-day workout for Rahul based on their current programme, Push Pull Legs. I left out one exercise that conflicts with their medical record. Shall I save it?"
}
```

The only row it writes is the draft (plus its audit row). No plan, no exercise
row, no assignment — asserted directly against what reached the pool.

#### The safety chain, in order

1. **`clientInOrg()`** — ownership, before any client data is read.
2. **Trainer narrowing** — a trainer authors only for their own roster.
3. **`checkScreeningGate()`** — the *same function* `POST /api/workouts/assign`
   calls. A client the PAR-Q flags as `blocked` gets a `403` and nothing is
   generated. A surface that can route around a clearance rule is a surface
   that removes it.
4. **The contraindication filter** — `pt_clients.health_conditions` and
   `.injuries` are tokenised and matched against `exercises.contraindications[]`
   in **both** directions ("knee" in "knee injury", and "knee injury" in
   "previous knee injury, cleared"). Conflicting exercises are removed from the
   candidate list **before either selector sees it**, so nothing can choose one.
5. **Selection** — a model chooses from the filtered list *by id*, or the
   deterministic library selection does.
6. **Re-validation at confirm** — see below.

#### The model may choose an exercise; it may never name one

The model is handed a numbered list of ids that already exist in this studio's
library and asked to pick among them. Any id it returns that is not in that
list is discarded: a hallucinated exercise resolves to nothing, because the
only exercises that exist are the ones the library already had. Nothing from
the model reaches the database as a name, a description or a set count.

It also **never sees the client's medical text**. The contraindicated
exercises are already gone from the list, so there is nothing to reason about
— and a client's injuries are not something to hand to a third-party API when
excluding server-side achieves the same result.

If the model is unconfigured, over quota, down, returns unparseable output, or
returns too few days, the deterministic selection runs instead and `source`
says `"derived"`. Same posture as `coach-ai.js`: a feature that disappears when
an API does teaches people not to rely on it.

#### Confirm is the only thing that persists

`POST /api/voice/workouts/confirm` → `201`

```json
{
  "saved": true,
  "workout_plan_id": "…",
  "workout_plan_name": "Rahul's 4-day plan",
  "client_name": "Rahul Sharma",
  "assignment_id": "…",
  "exercise_count": 20,
  "spoken": "Done. Rahul's workout has been saved."
}
```

The plan's **name** is returned alongside its id — an id identifies the plan to
software, the name is what a Shortcut can show and a person can recognise. The
client's name is read **live** inside the transaction rather than taken from the
draft: the sentence names a person out loud, and a name corrected between
preparing and saving should be the corrected one.

Inside one transaction:

```sql
UPDATE voice_workout_drafts SET status='confirmed', confirmed_at=NOW()
 WHERE id = $1 AND status = 'pending' AND expires_at > NOW()
   AND organization_id = $2 AND created_by = $3
```

That single statement is the whole single-use guarantee **and** the
authorization. Two confirmations racing produce one plan and one `409`: the
loser's `UPDATE` matches nothing and never reaches the `INSERT`. A draft id
leaked to a colleague — even in the same studio — matches nothing either.

Then, before writing anything:

- **The screening gate runs again**, against live data. A PAR-Q filed in the
  last half hour stops the save. A draft is a proposal, never a clearance
  already granted.
- **Every exercise is re-validated** against the live library. One archived,
  made private or deleted since preparation is dropped; if all of them are
  gone, the save is refused rather than writing an empty plan.

Expired, already-confirmed, not-yours and nonexistent all return the same
`409` with the same sentence. Distinguishing them would let a caller probe
which draft ids exist, and none of the four is separately actionable by voice.

A confirmed plan is **assigned** to the client, not left floating — "a workout
for Rahul" that Rahul never receives does not answer the command.

#### Audit

| Action | When |
| --- | --- |
| `voice.workouts.prepare` | draft created — records the client, day count, `source`, exercise count, **excluded count**, the plan it was based on, and how many screening warnings |
| `voice.workouts.prepare.blocked` | PAR-Q refused it |
| `voice.workouts.prepare.failed` | nothing safe could be generated |
| `voice.workouts.confirm` | plan saved — records the draft id, client, source, and **how many exercises vanished between preparing and saving** |
| `voice.workouts.confirm.rejected` | a claim matched no draft |
| `voice.workouts.confirm.blocked` | the re-run gate stopped it |
| `voice.workouts.confirm.invalid` | the draft's exercises were all gone |

The draft row itself keeps the generated plan, the withheld exercises and their
reasons. "Who chose this exercise for this injured client" is the first
question anyone will ask, and it is answerable.

#### The one new table

`voice_workout_drafts` (migration `180`) — RLS enabled, `anon` and
`authenticated` revoked, `deny_all_direct_access` policy, per the repo
convention. It matters more here than on most tables: direct **write** access
would let someone author a draft and confirm it through the API, walking past
the PAR-Q gate and the contraindication filter, which both run on the way *in*.

Drafts expire after **30 minutes**. A draft is a proposal about a person's body
built from facts read at one moment; a confirmation arriving a week later would
save a plan built from a week-old reading of all three. Nothing deletes lapsed
drafts — a workout somebody was offered and did not save is worth keeping.

### `POST /api/voice/workouts/complete` *(Phase 6)*

**Auth / authorization:** staff **plus** `adminManagerOrTrainer`, the same as
the Phase 5 writes, on the same `voiceWriteLimiter` (12/min). A trainer may
complete only their own client's session. Ownership is `clientInOrg()`, 404 not
403.

**Body**

```json
{ "client_id": "ptc-rahul" }
```

`.strict()`, so `status`, `session_id` or `organization_id` is a `400`. `date`
is optional and must be `YYYY-MM-DD`; absent means **today in the studio's
zone**, never the phone's.

#### Why there is no prepare/confirm step here

Phase 5 asks before saving because it CREATES a programme, and what is being
agreed to — four days of exercises, minus whatever the safety filter withheld —
does not fit in one spoken sentence. This flips one status on a session that
already exists. The whole effect fits in the sentence Siri says back, so a
confirmation would be a second question about something the first already
described completely.

#### It does not invent a session

A client with nothing logged for the date has not trained. The endpoint answers
`404 NO_SESSION` and writes nothing — no `INSERT`, ever. Writing a completion
for a workout that never happened corrupts exactly the record a trainer later
relies on, and it would do so invisibly.

#### Idempotence is the point

| State | Response | Written? |
| --- | --- | --- |
| in progress | `200` `already_completed: false` — "Done. Rahul's workout is marked completed." | yes |
| already completed | `200` `already_completed: true` — "Rahul's workout was already marked completed." | **no** |
| completed by someone else mid-request | `200` `already_completed: true` | **no** |
| no session that day | `404 NO_SESSION` | no |

Siri repeats itself when it mishears a phrase, so the second request must not
write again — and must not say "done" either. A command that reports success
when nothing changed teaches a trainer it works when it may not have.

The `UPDATE` is guarded on `status <> 'completed'`, so two requests racing
produce one completion: the loser matches no row and falls through to the
already-done answer.

#### It reuses the app's own completion logic

After the status changes, `recomputeAssignmentProgress()` runs — the same
function `PATCH /pt-os/workout-log/sessions/:id` calls when a trainer completes
a session on screen. It was extracted to `src/lib/assignmentProgress.js` so
both paths share one implementation rather than drifting. Without it the
completion is real and invisible: the client's assignment keeps yesterday's
percentage.

A progress failure does not fail the completion — the session is done either
way, and the percentage is derived.

#### Audit

| Action | When |
| --- | --- |
| `voice.workouts.complete` | a session was marked done — records client, date, programme, assignment |
| `voice.workouts.complete.duplicate` | it was already done (including the lost-race case) |
| `voice.workouts.complete.missing` | no session existed on that date |

### `GET /api/voice/payments/client/:clientId/status` *(Phase 7)*

**Auth:** staff — including reception, who take payments at the desk and need
to answer "what do I owe?". `clientInOrg()` first, 404 not 403, and a trainer
sees only their own clients (fail-closed when unlinked).

**Response `200`**

```json
{
  "client_name": "Rahul Sharma",
  "currency": "INR",
  "outstanding": 5000,
  "last_payment": { "amount": 2000, "status": "completed", "date": "2026-08-01" },
  "package": { "type": "PT Gold", "expires_on": "2026-09-14" },
  "spoken": "Rahul has 5,000 rupees outstanding. Their last payment was 2,000 rupees on 1 August. Their package runs to 14 September."
}
```

**Only the latest payment, never a history.** `LIMIT 1`, and the query does not
select `payment_ref`, `payment_method` or `notes` at all. A balance overheard
is bad; a client's payment history narrated to whoever is standing in the room
cannot be un-said.

**`outstanding: null` is not zero.** A client with no balance on file is spoken
as *"I do not have an outstanding balance on file for Rahul"* — never as *"no
pending payment"*, which would be a claim about the client made from an empty
column. (`Number(null)` is `0`, not `NaN`; that trap is a named test.)

**Money is spoken as words, in Indian grouping** — "1,50,000 rupees", not
"₹150000". A currency symbol is read differently by different voices and
languages, and a figure about money must not be ambiguous when heard. Paise are
only said when there are any.

The package renewal date is volunteered **only when something is owed** — it
matters to the person chasing a balance and is noise to everyone else.

### `POST /api/voice/payments/prepare` and `/confirm` *(Phase 7 — money)*

**Auth:** `adminManagerOrTrainer` on both, on the 12/min `voiceWriteLimiter`. A
trainer may only take payment for **their own** client — the same rule
`routes/payments.js` enforces, so recording by voice is no looser than
recording at the desk. **Reception can check a balance and cannot record a
payment.**

#### The amount never travels back from the phone

`/confirm` accepts exactly one field:

```json
{ "draft_id": "…" }
```

`.strict()`, so `amount`, `client_id` or `method` is a `400`. This is the whole
point of the two-step: if `/confirm` carried a figure, the sentence Siri read
out and the number written to the ledger would be two independent values with
nothing tying them together, and the confirmation would be a formality rather
than a control. What the user agreed to is what the server stored; what it
stored is what it records.

**Amount validation** (at prepare): greater than zero, at most 1,000,000, and
at most two decimal places — rejected rather than rounded, because Postgres
would silently round a third decimal and the amount confirmed would differ from
the amount stored by exactly the kind of rounding error nobody can later
account for. Method is an enum.

#### Duplicate and replay protection, in four layers

| Layer | Stops |
| --- | --- |
| The claim — `WHERE id AND status='pending' AND expires_at > NOW() AND organization_id AND created_by` | the same draft being confirmed twice; a leaked or guessed id; a colleague's draft |
| `SELECT … FOR UPDATE` on the client | concurrent payments interleaving and the balance drifting |
| 10-minute TTL (not the workout draft's 30) | a stale question about money being answered after the fact |
| **The recent-duplicate warning** | *the actual human mistake* |

The fourth is the one that matters in practice. The claim stops the same
*draft* being confirmed twice — but a person saying "record three thousand from
Rahul" twice produces two different drafts and two entirely legitimate
payments. So an identical amount already recorded for that client in the last
ten minutes is surfaced **in the question**, before it:

> "I already recorded 3,000 rupees for Rahul 2 minutes ago. Record 3,000 rupees
> payment for Rahul?"

That is the one moment where somebody can still say no.

#### Confirm re-checks against live data

Inside the transaction, after the claim and the lock, before any money moves:
the client must still exist, still belong to the caller's organization, and —
for a trainer — still be theirs. A client deleted, transferred, or reassigned
in the ten minutes since preparing must not receive a payment on the strength
of a stale read.

#### It records money through the app's own code

`recordPayment()` in `src/lib/paymentService.js`, extracted from
`routes/payments.js` (the canonical finance API) so voice and the finance UI
record money by **one** code path: the ledger row with its sequence-drawn
receipt number and the trainer incentive, and the client's `paid_amount` /
`balance_amount`, in one transaction. `GREATEST(0, …)` keeps an overpayment
from driving the outstanding figure negative, which the UI would render as a
credit nobody granted.

The header of `pt-os.routes.js` records what happened when this was two loose
queries: "money in the ledger that the client's outstanding figure does not
know about, silent, and surfacing much later as a reconciliation discrepancy
nobody can account for."

**Audit:** `voice.payments.status`, `voice.payments.prepare` (with the amount,
method and whether a recent duplicate was seen), `voice.payments.confirm` (with
the receipt number), plus `.rejected`, `.invalid` and `.forbidden`. The confirm
row is written **after** `COMMIT` — a row logged before the transaction lands
would describe a payment that, on rollback, never happened.

#### The one new table

`voice_payment_drafts` (migration `181`) — RLS enabled, `anon`/`authenticated`
revoked, `deny_all_direct_access`. Direct write access would be a way to author
a draft and confirm it through the API, recording money against any client with
the organization and permission checks bypassed, because those run on the way
*in*.

## Backend — build and test

```bash
cd 619-erp-backend
npm ci

# The voice endpoint's authorization + isolation boundaries
npm test -- src/__tests__/security/voice

# Full suite
npm test
```

Phases 1–4 need no migration. **Phase 5 adds `180_voice_workout_drafts.sql`**
and **Phase 7 adds `181_voice_payment_drafts.sql`** — both because a two-step
confirmation needs somewhere server-side to hold the proposal between the
question and the answer. No other schema change and no new environment
variable.

## iOS — setup

The Swift sources live in `ios/MyPtStudioSiri/Sources/MyPtStudioSiri/` and are
**source files, not a shipped Xcode project** — they are dropped into the iOS
app target that will host them.

### 1. Add the sources

Add all eight to the app target (and to the App Intents extension target, if
you use a separate one):

- `Keychain.swift`
- `VoiceAPIClient.swift`
- `GetClientCountIntent.swift` — also holds `MyPtStudioShortcuts`, which
  registers the spoken phrases for **both** intents
- `FindClientIntent.swift` *(Phase 2)*
- `GetClientDetailIntent.swift` *(Phase 3)* — also holds `ClientEntity` and
  `ClientEntityQuery`, which are what make Siri ask *which* Rahul
- `GetTodaysWorkoutsIntent.swift` *(Phase 4)*
- `PrepareWorkoutIntent.swift` *(Phase 5)* — writes; asks first
- `CompleteWorkoutIntent.swift` *(Phase 6)* — writes; idempotent
- `PaymentIntents.swift` *(Phase 7)* — `CheckPaymentStatusIntent` (read) and
  `RecordPaymentIntent` (writes money; confirms the amount aloud first)

### 2. Info.plist keys

| Key                          | Value                                          |
| ---------------------------- | ---------------------------------------------- |
| `MPS_API_BASE_URL`           | `https://your-api-host` — **https only**       |
| `MPS_KEYCHAIN_ACCESS_GROUP`  | `$(AppIdentifierPrefix)com.myptstudio.shared`  |

The client refuses any non-`https` base URL rather than silently downgrading.
Point these at staging and production per build configuration — do not commit a
production host into a shared scheme.

### 3. Keychain sharing

Enable **Keychain Sharing** on the app target *and* the intent extension, with
the same group as `MPS_KEYCHAIN_ACCESS_GROUP`. Without it the two get separate
keychains and the intent never sees the token the app stored.

### 4. Host app writes the token at sign-in

Phase 1 does **not** implement sign-in — the app already has one. At the point
it receives a session token, store it:

```swift
try Keychain.set(
    sessionToken,
    account: VoiceAPIClient.tokenAccount,
    accessGroup: "<MPS_KEYCHAIN_ACCESS_GROUP>"
)
```

and on sign-out:

```swift
Keychain.delete(
    account: VoiceAPIClient.tokenAccount,
    accessGroup: "<MPS_KEYCHAIN_ACCESS_GROUP>"
)
```

The Keychain item is stored `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:

- **AfterFirstUnlock** — the intent can read it from the lock screen, which is
  where "Hey Siri" is actually used.
- **ThisDeviceOnly** — excluded from iCloud Keychain and encrypted backups, so
  restoring onto another device does not carry a live studio session.

### 5. Try it

Build to a device (Siri does not work in the Simulator), sign in once, then:

> "Hey Siri, how many clients do I have in MY PT STUDIO?"
> "Hey Siri, find Rahul in MY PT STUDIO."
> "Hey Siri, show me Rahul's details in MY PT STUDIO."
> "Hey Siri, show me today's workouts in MY PT STUDIO."
> "Hey Siri, create a workout for Rahul in MY PT STUDIO." *(asks before saving)*
> "Hey Siri, mark Rahul's workout as completed in MY PT STUDIO."
> "Hey Siri, does Rahul have any pending payment in MY PT STUDIO?"
> "Hey Siri, record a payment from Rahul in MY PT STUDIO." *(asks the amount, then confirms it)*

All eight phrases are registered by `MyPtStudioShortcuts`, so no Shortcut has
to be created first. Alternative phrasings are also registered — "client count
in MY PT STUDIO", "search for Rahul in MY PT STUDIO", "how is Rahul doing in
MY PT STUDIO", "what workouts do I have today in MY PT STUDIO", "who has a
workout today in MY PT STUDIO", "show my PT sessions today in MY PT STUDIO".

`FindClientIntent` takes the name as a spoken parameter. A phrase with no name
("find someone in MY PT STUDIO") prompts for one rather than failing.

### Several people called Rahul

`GetClientDetailIntent` takes a **`ClientEntity`**, not a string. Siri resolves
the spoken name through `ClientEntityQuery.entities(matching:)`, which calls
the Phase 2 search endpoint:

| Matches | What happens |
| --- | --- |
| 0 | Siri re-prompts for a name |
| 1 | resolved silently, detail fetched |
| 2+ | **Siri asks which one**, showing name + package, then fetches |

The choice happens **before** any detail is requested, so no one's expiry date
is read out on the assumption that they were the Rahul meant. Each candidate is
shown as a name and a package type and nothing else — enough to tell two people
apart, and not worth reading over someone's shoulder.

`suggestedEntities()` returns `[]` on purpose. Filling it would push the
studio's roster into the Shortcuts UI — names on screen, cached by the system,
visible to whoever is holding the phone — to save a search nobody asked to
skip.

`entities(for:)` re-fetches each id through the API rather than trusting a
value cached on the device, so a saved Shortcut pointing at a client who has
since been deleted, transferred, or who was never this account's to read
resolves to nothing. **A saved Shortcut is not a standing grant.**

## Security notes — what holds across all seven phases

- **Siri never touches SQL.** It cannot express a query. It calls one of three
  named endpoints whose SQL is fixed in this repository; the only caller-supplied
  values are a search term and a client id, both bound as parameters and both
  length- and shape-checked first.
- **No cross-organization access.** The org id is resolved from the session by
  `tenantScope`. A tenant user sending `x-org-id` is ignored. Phase 3 adds an
  ownership check on the id itself, and answers 404 — not 403 — so the API does
  not confirm that a foreign id exists.
- **Fail closed.** A tenant user with no organization filters on `NULL`, which
  matches nothing. A trainer account with no trainer record returns nothing
  rather than falling through to the whole studio. Both are asserted by tests,
  and both were verified by mutation: removing either guard fails the suite.
- **No secrets on the device.** No API key, client secret or base URL literal
  in any Swift file. The base URL is build configuration; the token is the
  user's own session, written by their own sign-in, stored
  `AfterFirstUnlockThisDeviceOnly` so it is excluded from iCloud Keychain and
  encrypted backups.
- **Nothing private is spoken.** No mobile, email, address or amount is
  selected by any of the three endpoints, so there is nothing to leak by
  accident. Internal ids are never spoken — the one id in a response exists for
  the intent to pass back, not for Siri to read out.
- **Unknown is never spoken as zero.** A missing balance is left out of the
  sentence rather than announced as "0 sessions left"; an unreadable workout log
  is spoken as unchecked rather than as "nothing logged".
- **Writes are the exception, and they are shaped to their blast radius.**
  Phases 1–4 are `GET`s. Phase 5 CREATES a programme, so it is a `POST` pair
  where preparing saves nothing and confirming accepts a single draft id — no
  one voice command changes anything, and the second step cannot describe what
  to change. Phase 6 flips one status on a session that already exists, so it
  is a single idempotent `POST` that refuses to create anything. Neither write
  intent runs from a locked device; both are on a 12/min limit rather than the
  read surface's 200.
- **Nothing writes twice.** Phase 5's draft claim, Phase 6's guarded `UPDATE`
  and Phase 7's payment claim are all conditional statements, so a repeated
  request — which is what Siri produces when it mishears a confirmation —
  changes nothing the second time and says so. Phase 7 adds the layer the
  others do not need: a warning about an identical payment recorded minutes
  ago, because the mistake that actually happens with money is a person
  repeating themselves, not a request replaying.
- **A confirmed value cannot be substituted.** Neither confirm endpoint accepts
  the thing being confirmed — not the exercises, not the amount. What was said
  out loud is what the server stored, and what it stored is what it writes.
- **Safety gates cannot be routed around.** The voice write calls the same
  `checkScreeningGate()` the app's own assign route calls, and calls it twice:
  once before generating and once against live data before saving.
- **Time is server-resolved.** No endpoint accepts a date, a timezone or the
  device's clock. "Today" is the studio's calendar day, computed server-side,
  so a wrong handset clock cannot shift which day is reported.
- **Audit.** Every call writes an `activity_log` row —
  `voice.dashboard.client_count`, `voice.clients.search`,
  `voice.clients.detail`, `voice.workouts.today`. A voice request leaves no UI
  trace, so the audit row is the only record it happened.


## Phase 8 — exact next step

Seven phases have added commands. **Phase 8 should add none**, and the reason
is now concrete rather than tidy-minded: Siri can create a training programme,
complete a session and record money, and none of those changes is visible to
anyone who did not hear them. The `activity_log` rows exist for every one.
No screen reads them.

That is the whole of Phase 8:

1. **A studio-visible voice activity feed**, reading the `voice.*` actions
   already written. Money first: a `voice.payments.confirm` row carries the
   amount, the receipt number and who spoke, and a studio owner currently has
   no way to see that a payment was taken by voice rather than at the desk.
   A surface that records money and whose history needs SQL to read is one
   nobody audits.
2. **Mark voice-originated records in the app.** `created_via` on
   `workout_plans` and `pt_payments`, surfaced in the plans list and the
   payments ledger. Reconciliation is done against the ledger screen, and a
   voice-recorded payment that looks identical to a desk-recorded one is
   indistinguishable exactly when someone is trying to work out what happened.
3. **A `voice.write` scope on the token**, so a studio can allow voice reads
   without voice writes — and, separately, workout writes without *payment*
   writes. Today all three are one role check. Some studios will want a trainer
   who can complete sessions by speaking and cannot touch money.
4. **The concurrency tests all three writes now deserve.** Every single-apply
   guarantee on this surface is argued from the SQL rather than demonstrated,
   because the pool is mocked. Two simultaneous payment confirmations against a
   real database is the test that matters most — it is the one where being
   wrong means a client is credited twice.
5. **Draft retention.** Two draft tables now accumulate. Keep confirmed ones,
   expire pending ones after 90 days.

Also worth knowing before Phase 8 adds anything: `MyPtStudioShortcuts` now
registers **8** AppShortcuts, and Apple's limit is 10. The next feature that
wants a phrase needs a decision about which ones stay top-level.

Deliberately **not** in Phase 8: refunds, reversing a payment, deleting a plan,
or un-completing a session. Every one of them is a *correction*, which needs to
record who corrected what and why — a harder design than the action it undoes,
and one that should not ride in on a phase about visibility.

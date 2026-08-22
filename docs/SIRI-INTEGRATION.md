# Siri integration — Phases 1–4

Enables:

> **Phase 1** — "Hey Siri, how many clients do I have in MY PT STUDIO?"
> **Phase 2** — "Hey Siri, find Rahul in MY PT STUDIO."
> **Phase 3** — "Hey Siri, show me Rahul's details in MY PT STUDIO."
> **Phase 4** — "Hey Siri, show me today's workouts in MY PT STUDIO."

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

## Backend — build and test

```bash
cd 619-erp-backend
npm ci

# The voice endpoint's authorization + isolation boundaries
npm test -- src/__tests__/security/voice

# Full suite
npm test
```

No migration, no schema change, no new environment variable. The endpoint reads
`pt_clients`, which already exists.

## iOS — setup

The Swift sources live in `ios/MyPtStudioSiri/Sources/MyPtStudioSiri/` and are
**source files, not a shipped Xcode project** — they are dropped into the iOS
app target that will host them.

### 1. Add the sources

Add all five to the app target (and to the App Intents extension target, if
you use a separate one):

- `Keychain.swift`
- `VoiceAPIClient.swift`
- `GetClientCountIntent.swift` — also holds `MyPtStudioShortcuts`, which
  registers the spoken phrases for **both** intents
- `FindClientIntent.swift` *(Phase 2)*
- `GetClientDetailIntent.swift` *(Phase 3)* — also holds `ClientEntity` and
  `ClientEntityQuery`, which are what make Siri ask *which* Rahul
- `GetTodaysWorkoutsIntent.swift` *(Phase 4)*

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

All four phrases are registered by `MyPtStudioShortcuts`, so no Shortcut has
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

## Security notes — what holds across all four phases

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
- **Time is server-resolved.** No endpoint accepts a date, a timezone or the
  device's clock. "Today" is the studio's calendar day, computed server-side,
  so a wrong handset clock cannot shift which day is reported.
- **Audit.** Every call writes an `activity_log` row —
  `voice.dashboard.client_count`, `voice.clients.search`,
  `voice.clients.detail`, `voice.workouts.today`. A voice request leaves no UI
  trace, so the audit row is the only record it happened.


## Phase 5 — exact next step

Phases 1–4 are all **read-only**, and Phase 4 completed the set: the studio can
now be asked how many, who, about one person, and what today looks like.
Everything a trainer can usefully be *told* is covered. Phase 5 is therefore
where writing has to start, and a write reachable from a locked phone is a
different security problem from a read, not a bigger one.

The recommendation is **one narrow write, with confirmation**, and it follows
directly from what Phase 4 now reports:

1. `POST /api/voice/clients/:clientId/sessions/today/complete` in
   `src/routes/voice.js`. Phase 4 already says "today's workout is pending";
   marking it done is the one state change whose whole effect fits in a
   sentence Siri can read back. Same `clientInOrg()` ownership check, same
   `orgWhere`, same trainer narrowing, same 404-not-403.
2. **Idempotent by date, not by request.** Completing an already-completed
   session returns `200` with "that was already marked done" rather than
   writing twice. Siri repeats itself when it mishears a confirmation, and a
   voice write that double-applies is one that cannot be trusted.
3. **A separate, much tighter rate limit** than `userApiLimiter`'s 200/min. A
   read that runs away wastes a query; a write that runs away rewrites a day.
4. `requestConfirmation(result:)` in the intent so Siri states what it is about
   to do and waits, and `authenticationPolicy = .requiresAuthentication` — this
   one must **not** run from the lock screen. A read spoken to a locked phone
   leaks; a write accepts an instruction from anyone within earshot, and Face
   ID is the difference.
5. Chain it off Phase 4 rather than adding a second search: the intent takes
   the `ClientEntity` Phase 3 already defines, so "show me today's workouts" →
   "mark Rahul done" works without naming anyone twice.
6. `voice.clientComplete.authz.test.js`, extending the Phase 3/4 pattern, plus
   two tests that cannot exist yet because nothing has written before: **the
   double-apply case**, and **an unauthorized caller must not change state** —
   asserting the pool never saw an `UPDATE`, not merely that the response
   was 403.

Deliberately **not** in Phase 5: booking, cancelling, payments, or anything
returning contact details. Each needs its own decision about confirmation and
replay, and none should ride in on the first write.

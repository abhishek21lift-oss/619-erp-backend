# Siri integration — Phases 1–2

Enables:

> **Phase 1** — "Hey Siri, how many clients do I have in MY PT STUDIO?"
> **Phase 2** — "Hey Siri, find Rahul in MY PT STUDIO."

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

**Authorization:** staff only (`admin` / `manager` / `owner` / `trainer`).
`member` — the role client activation gives a gym client — is refused with 403.

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

Add all three to the app target (and to the App Intents extension target, if
you use a separate one):

- `Keychain.swift`
- `VoiceAPIClient.swift`
- `GetClientCountIntent.swift` — also holds `MyPtStudioShortcuts`, which
  registers the spoken phrases for **both** intents
- `FindClientIntent.swift` *(Phase 2)*

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

Both phrases are registered by `MyPtStudioShortcuts`, so no Shortcut has to be
created first. Alternative phrasings are also registered — "client count in
MY PT STUDIO", "search for Rahul in MY PT STUDIO", "show Rahul PT details in
MY PT STUDIO".

`FindClientIntent` takes the name as a spoken parameter. A phrase with no name
("find someone in MY PT STUDIO") prompts for one rather than failing.

## Security notes

- **No hardcoded secrets.** No API key, client secret or base URL literal in
  any Swift file. The base URL is build configuration; the token is the user's
  own session, written by their own sign-in.
- **No cross-organization access.** The org id is resolved from the session by
  `tenantScope`. A tenant user sending `x-org-id` is ignored — asserted by
  `voice.authz.test.js`.
- **Fail closed.** A tenant user with no organization filters on `NULL`, which
  matches no rows. The dangerous failure would be dropping the filter.
- **Read-only.** Everything under `/api/voice` is a GET returning one scalar. A
  voice surface that can write is one that can be made to write by anyone
  within earshot.
- **No roster detail.** The response is a count and a sentence — no names, no
  ids, no list. A spoken answer cannot be scrolled past or redacted, and a
  bystander hears whatever comes back.
- **Siri never touches SQL.** It cannot express a query; it can only call a
  named endpoint whose SQL is fixed in this repository.

## Phase 3 — exact next step

Phases 1–2 are both **read-only** and both answer with a sentence. Phase 3 is
where that stops being enough, so the next step is deliberately still read-only
— one more retrieval, with a richer result — before anything writes:

1. `GET /api/voice/clients/:id/summary` in `src/routes/voice.js`, taking the
   `id` Phase 2 already returns. Same `orgWhere` filter, same trainer
   narrowing, and an ownership check on the id itself: a client id from
   another studio must 404, never 403, so the API does not confirm that the id
   exists somewhere.
2. Return the next session, sessions remaining and the balance — the three
   things a trainer asks after finding someone. Still no contact details.
3. Extend the Swift client with `clientSummary(id:)` — one more method on
   `VoiceAPIClient`, not a second client.
4. Add `GetClientSummaryIntent` that accepts the `VoiceClient` from
   `FindClientIntent` as its parameter, so "find Rahul" → "how many sessions
   does he have left" chains without a second search.
5. Extend `voice.clientSearch.authz.test.js`'s pattern into a new
   `voice.clientSummary.authz.test.js`, with the cross-organization test
   asserting the 404-not-403 behaviour.

Deliberately **not** in Phase 3: anything that writes (booking, cancelling,
marking attendance), and anything returning contact details. A write reachable
from a locked phone needs a separate decision about confirmation and replay,
and it should not ride in on a retrieval phase.

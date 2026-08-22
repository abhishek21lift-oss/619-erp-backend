# Siri integration — Phase 1

Enables one voice command:

> "Hey Siri, how many clients do I have in MY PT STUDIO?"

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
- `GetClientCountIntent.swift`

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

The phrase is registered by `MyPtStudioShortcuts`, so no Shortcut has to be
created first. Alternative phrasings are also registered — "client count in
MY PT STUDIO", etc.

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

## Phase 2 — exact next step

Add a second read-only metric behind the same router, to prove the surface
generalises before it grows:

1. `GET /api/voice/dashboard/sessions-today` in `src/routes/voice.js`, counting
   today's sessions for the caller's organization with the same `orgWhere`
   filter and the same `{ count, scope, spoken }` shape.
2. Extend `voice.authz.test.js` with the same A/B/C boundaries for the new
   route (staff-only, org-filtered, fails closed).
3. Add `GetSessionsTodayIntent` alongside `GetClientCountIntent`, reusing
   `VoiceAPIClient` — add one method, not a second client.
4. Register its phrases in `MyPtStudioShortcuts`.

Deliberately **not** in Phase 2: anything that writes, anything taking a
free-text parameter, and anything returning a client's name. Those need a
separate decision about what is safe to say out loud near other people, and
Phase 1's boundaries do not cover them.

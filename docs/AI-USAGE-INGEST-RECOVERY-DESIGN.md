# AI Usage-Ingest Recovery — Current State, Explicit Limits, Design Proposal (Phase 5B)

> **Superseded 2026-10-22.** The `/api/ai/usage/service/ingest` bridge and the
> `mps-ai` service are retired. The Client Assistant writes `ai_usage_log`
> in-process, exactly once per answered turn; there is no ingest hop to
> recover. Kept as the Phase 5B design record.

Scope: failed ingestion of `/api/ai/usage/service/ingest` (mps-ai → ERP), what
recovers automatically today, what cannot honestly be called recovery yet, and
the smallest safe design that would make it durable. **Phase 5 implements no
new queue, no new dependency, and no pretend durability.**

## Current behavior (pinned by tests)

- mps-ai reports one ingest per completed turn, keyed by its `requestId`
  (UUID per HTTP turn). The ERP resolves identity **server-side from the
  forwarded user token** — never from the body — and writes with
  `INSERT ... ON CONFLICT (request_id, user_id) DO NOTHING RETURNING id`.
  Answers: `202 {ok:true}` (new row) | `202 {ok:true,duplicate:true}`
  (already there) | `503 USAGE_LOG_UNAVAILABLE` (write failed).
- On ingest failure the service keeps the turn alive and emits **exactly one
  warn** (`usage_ingest_failed`, `code`+`requestId`, no content) per turn
  (`usage-ingest-observability.test.js`). There is **no in-process retry
  loop** — deliberate and honest: no appearance of recovery either.
- The turn evidence is not lost: every completed turn is appended to the local
  JSONL usage ledger (`src/lib/usageLedger.js`) with `request_id` and token
  counts, and deliberately no client names, no prompt/reply content, no JWTs.

## Safe today without new code: same-id re-delivery

A transient DB blip gives the caller a typed `503 USAGE_LOG_UNAVAILABLE`; the
row simply is not in the ledger. Re-delivering the same payload with the same
`requestId` later inserts it once — idempotency is the ERP's job. Attribution
is byte-identical across attempts because both resolve identity the same
auth-resolved way (pinned in `aiServiceUsage.test.js`). **While credentials
are live this is correct recovery today.** An operator can also drive it at
any later time — the typed 503 says exactly what failed and the ledger says
what was lost — but today nothing ever re-supplies the call automatically.

## Why there is NO automated durable recovery today — architecture facts

1. **Identity is the wall.** A recoverable row must record *whose* usage.
   mps-ai's local ledger carries no identity by design; the only place
   identity existed was the forwarded user JWT, which expires. A durable
   replay executed after expiry cannot re-resolve those users, so a replay
   key would be a source of MIS-attribution without a new authorization.
2. **The service credential cannot carry the attribution confidently.**
   Letting mps-ai assert `userId` would violate the resolution contract that
   started Phase 4/5 (callers never claim identity — this is the
   bug-shape being remediated).
3. **The ERP has no durable outbox to reuse.** The existing 'ai' job queue is
   in-process with inline fallback when redis is lost — during the outages
   that cause these drops, nothing is persisted on the ERP side either.
   In-memory service-side retry dies with the service process and covers only
   sub-minute blips — the brief explicitly rejects pretending that is durable.

## Concrete design proposal (for a future approved phase — not implemented now)

**Option B — service-asserted, verifiable user reference (recommended).**

1. At ingest-build time — while the identity IS resolvable — extend the
   ledger row and ingest payload with one field: `userRef`, the ERP-resolved
   user id HMAC'd under a dedicated `USAGE_REPLAY_SECRET` (a new secret,
   separate from auth material).
2. The ingest route accepts `userRef` only under the SERVICE credential,
   verifies the HMAC + freshness (TTL), and inserts attribution derived from
   the verified value. Every replay acceptance logs its own line.
3. Recovery then becomes plain re-delivery: on service boot (or on a missed
   backlog), scan the JSONL ledger's unconfirmed rows and re-POST with the
   same `requestId`/`userRef`; the unique key keeps it single-row, and reruns
   stay idempotent.
4. Requires, explicitly: a new secret + rotation story, a contract change to
   the S-4/identity resolution (`userRef` = service-asserted identity with
   verification), a TTL decision, and review of the new ledger field by the
   security lane. Nothing here is shippable without explicit approval.

**Option A — monitor-only, zero code (deployable with 5E as-is).**

- Alert on the `usage_ingest_failed` warn.
- Reconciliation stays quantitative, not attributive: for any outage window,
  compare ledger `request_id`s vs `ai_usage_log.request_id` — the count of
  missing request ids is the loss; identity stays unknown. No backfill.

**Option C — bounded in-process redelivery (rejected).** Non-durable and
invisible across restarts: the schedule dies with the process, and a live
retry can race an operator's reconciliation script. The warn plus the typed
503 already carry everything this option would add.

## What Phase 5 delivers for 5B

- Tests: honest failure semantics, single warn, no retry loops, and same-id
  re-delivery safety with identical attribution.
- This document: constraints, options, recommendation — no schema change, no
  contract change, no new infrastructure shipped.

## Blockers on anything more

No database in this phase (prod or otherwise); Option B needs the security
lane and an approved secret-management story; and automated replay of an
expired identity CANNOT be safe without it.

# Churn AI — risk ranking, reasons and next action — design

Status: draft for approval, 2026-10-30.
Phase 2 of the PT OS expansion (sequence: delivery loop → **churn AI** → video review → money → surface).

## Intent

The roster sweep (`GET /api/pt-os/signals`, `training-signals.js`) already finds
the clients a trainer should call: quiet clients, clients who paid and never
started, finished terms, plateaued lifts. It shows them on Today and the trainer
reads a list of evidence strings.

What it does not do is answer the two questions that decide whether the list
gets used:

1. **Who first?** The list is ordered by severity, then silence. It does not know
   that a client whose term ends on Friday and owes ₹8,000 matters more than one
   who is merely quiet.
2. **Then what?** Each row carries a generic recommendation. Nothing records that
   the trainer already called someone, so the same five names sit at the top
   every morning and the list stops being read.

This phase adds a deterministic risk score over the signals that already exist,
one canonical ranking, one next action per client, and a "contacted / snooze"
record so a handled client leaves the list. The AI writes the roster-level
briefing; it never invents a number and never runs once per client.

## Goals

1. One endpoint returns the roster ranked by churn risk 0–100, with every point
   traceable to a reason ("last trained 31 days ago", +60).
2. A dedicated page at `/pt-os/clients/at-risk` shows the ranked list, the
   reasons, and the one next action. Today's `RosterSignalsCard` stays as the
   glance and links to it.
3. Trainer marks a client **contacted** (hides 7 days) or **snoozed until a
   date** (max 90 days). If the score rises 15+ points while hidden, the client
   comes back with "risk increased since you contacted them".
4. One LLM call, on demand, produces a 3–5 sentence roster briefing over the
   deterministic list. No per-client LLM calls.
5. Score uses training signals **and** money (`balance_amount`, term ending,
   term ended), because a PT client who is paying and disappearing is the
   product's core churn case.

## Non-goals

- Drafting or sending win-back messages. No WhatsApp send path is added. The
  trainer calls or messages on their own.
- Automated win-back cadence, rules, or scheduled messages.
- Daily score snapshots, trend charts, or "risk changed 45 → 72". The score is
  computed on read. History is a later phase if the list is actually used.
- Per-client AI narrative. The reasons and the action are deterministic text.
- Predicting churn with a model. The score is an explicit, weighted checklist.

## Anti-goals

- **No second definition of "trained".** `TRAINING_HAPPENED` in
  `client-context.js` is the one definition (completed session OR any logged
  set). A churn query that uses `status = 'completed'` would repeat the bug that
  reported a client who trained yesterday as 41 days silent.
- **No parallel scoring engine.** The score consumes the existing sweep's output
  plus the client row through the sweep's own `termState()`. It does not
  re-query sessions and does not re-implement "last trained".
- **No black box.** Every point is shown with its reason. Adding a component
  means adding a line to the table below, not tuning a model.
- **No LLM arithmetic.** The model receives finished numbers and is instructed
  to quote them.

## Constraints

- One trainer per studio in this product; the roster the sweep returns is the
  whole org. Tenant scope is `organization_id`, taken from the token.
- The studio's day is `studioToday()` (Asia/Kolkata wall clock). Every date in
  this feature uses it — score, snooze validation, visibility. The database's
  `CURRENT_DATE` is not used.
- Existing thresholds are product constants, not per-studio settings:
  `QUIET_DAYS=10`, `GONE_DAYS=21`, `NEVER_STARTED_DAYS=14`. Churn adds weights
  and bands, not new thresholds for the same concepts.
- AI models are free-tier OpenRouter routes behind `routedChat`; the feature
  must work without a key (`requireConfigured` → 501) and must not spend on
  page load.
- No new dependency, no background job, no worker change. Migration 246 is
  additive.

## Approaches

**A. Extend the existing sweep (chosen).** Sweep for training evidence, one
uncapped client query for money/term, score in a pure module, merge by
`pt_clients.id`. Reuses `TRAINING_HAPPENED`, `termState()` and the AI route
pattern; the only new storage is the follow-up table.
Trade-off: the sweep also computes plateau/volume that churn does not need
(3 queries, ~400 sets) — cheaper than a second definition of "trained".

**B. Separate churn module with its own SQL.** One query computing last-session,
balance, expiry and renewal. Independent and easy to evolve, but it becomes a
second definition of "last trained" — the exact drift `metric-definitions.js`
forbids and the bug that reported a client who trained yesterday as 41 days
silent. Rejected.

**C. Churn as an Insights block only.** Add a churn insight to
`insights-engine.js` and render it in AI Business Insights. No new page, one AI
call already exists, but it is aggregate-only ("8 clients at risk") with no
per-client rank, no next action, and no follow-through. Does not answer "who do
I call today". Rejected.

## What already exists (reuse map)

| Need | Reuse | File |
|---|---|---|
| Per-client signals, last session, days quiet | `sweepRoster()` 3 queries | `modules/pt-os/client-context.js` |
| Signal ids, thresholds, evidence, recommendations | `detectSignals()`, `QUIET_DAYS=10`, `GONE_DAYS=21`, `NEVER_STARTED_DAYS=14` | `modules/pt-os/training-signals.js` |
| Term state and `days_left` (same function the sweep uses) | `termState()` | `modules/pt-os/training-signals.js` |
| Studio's today (one clock for every date decision) | `studioToday()` | `modules/pt-os/client-context.js` |
| AI call pattern (config gate, JSON extraction, usage log, 501/503) | `POST /api/ai/business/insights` | `routes/ai.js` |
| Today card and its data contract | `RosterSignalsCard`, `RosterSignalSweep` | `components/pt-os/RosterSignalsCard.tsx`, `lib/api/types.ts` |
| Migration + RLS template | migration 245 | `db/migrations/245_client_self_booking.sql` |

`getDuesRows()` and `getRenewalRows()` are **not** reused. Both are report
tables capped at 500 rows and both compute dates from PostgreSQL
`CURRENT_DATE`; a churn list that silently drops the 501st debtor, or disagrees
with the sweep about whether a term ends today, is worse than one extra query.
Churn reads the client row directly (`balance_amount`, `pt_end_date`, `status`)
and does its own date math on `studioToday()` — the same clock the sweep uses.

## Data assembly

One uncapped roster query plus the existing sweep, merged by `pt_clients.id`:

```js
// churn.repository.listRoster(orgId) — no LIMIT, no aggregation
SELECT id, name, mobile, balance_amount, pt_end_date, status
  FROM pt_clients
 WHERE organization_id = $1 AND deleted_at IS NULL

// churn.service.buildChurnList(orgId)
const today = studioToday();
const [roster, sweep, marks] = await Promise.all([
  listRoster(orgId),
  sweepRoster(orgId, { today }),
  latestFollowups(orgId, today),
]);
```

- `roster` is the authority for who is assessed and for money/term fields.
- `sweep.clients_detail` is the authority for `last_session`, `days_quiet` and
  `never_started`. It already contains every client with a training signal; a
  roster client absent from it trained recently and has no training reason.
- `term` is computed from the roster row with the sweep's own exported
  `termState(client, today)` — not read from `clients_detail`. A dues-only
  client therefore still gets a term state, and there is exactly one definition
  of "term ends today". `term_ending_7` / `term_ending_30` apply to every
  roster client; `term_ended` applies only to clients the sweep also flagged
  (see scoring).
- Merge key is `pt_clients.id` on both sides. The legacy `client_id` column
  (member id) is not used anywhere in this feature.
- `assessed` = number of non-deleted clients in the org (`roster.length`),
  whether or not they scored. `flagged` = rows with score > 0.
- Clients with no signal, no balance and no term pressure score 0, are counted
  in `assessed`, and are not listed.
- `days_left` = `pt_end_date - studioToday()`, computed once in the service and
  reused by both the score and the response. No `CURRENT_DATE` anywhere in this
  feature.

`never_started` is the only reason taken from `signals[]`. It cannot be
re-derived safely from the roster row alone (the sweep also checks
`pt_start_date` and `NEVER_STARTED_DAYS`). Every other scoring code below is
churn's own name for a condition over `days_quiet`, `term` and
`balance_amount` — they are **not** `signals[].id` values. In particular
`gone_quiet` covers both silence bands by `severity`, and `term_ending_7` /
`term_ending_30` are not signals at all.

## Scoring model (deterministic contract)

Inputs per client: `days_quiet`, `term.state` / `term.days_left` (from
`termState()`), `balance_amount`, plus the sweep's `never_started` reason when
present.

| Code | Condition | Points |
|---|---|---|
| `never_started` | signal `never_started` present (paid, current term, no training) | 60 |
| `silent_21` | `days_quiet >= 21` | 60 |
| `silent_10` | `10 <= days_quiet < 21` | 25 |
| `term_ending_7` | `0 <= term.days_left <= 7` | 35 |
| `term_ending_30` | `8 <= term.days_left <= 30` | 15 |
| `term_ended` | `term.state === 'ended'` **and** the client has a training signal (appears in `clients_detail`) | 20 |
| `dues` | `balance_amount > 0` | 15 |

`never_started` and the silence codes are mutually exclusive (the sweep already
guarantees this: no last session vs a last session). Sum is clamped to 100.
`term_ended` needs a training signal on purpose: a client whose term ended but
who trained yesterday is a renewal conversation, not a churn risk, and a studio
with years of expired clients must not see all of them on this list.

Bands: **critical ≥ 60**, **high 35–59**, **medium 15–34**, **low 1–14**.
A client with no reasons scores 0 and is not listed; the response reports how
many were assessed so "nobody flagged" and "the sweep did not run" stay distinct
— the same rule the Today card already follows.

Why these weights: the two headline signals the existing card already calls
CRITICAL — `never_started` and `silent_21` — reach critical on their own. Money
and term pressure decide the order *within* a band without letting a ₹500
balance outrank a client who has stopped training. `term_ended` is deliberately
medium: it is a win-back, not someone currently disappearing.

### Next action (one per client, first match wins)

| Order | When | Action |
|---|---|---|
| 1 | `never_started` | Call today and book their first session — the paid term is running. |
| 2 | `silent_21` | Call this week. They are paying for training they are not taking. |
| 3 | `term_ending_7` | Renewal conversation this week, before the term lapses. |
| 4 | `term_ended` | Win-back, not a chase. They completed what they bought. |
| 5 | `silent_10` | Check in before the gap becomes a habit. |
| 6 | `term_ending_30` | Renewal conversation in the next two weeks. |
| 7 | `dues` | Collect the balance before the next session. |
| — | none | Not listed. |

All reasons (not just the winner) are returned, so "dues + silent_10" shows both
and the action points at retention rather than money.

## Follow-through

New table `pt_client_followups` (migration `246_churn_followups.sql`):

```sql
CREATE TABLE IF NOT EXISTS pt_client_followups (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id UUID NOT NULL,
  client_id       TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  outcome         TEXT NOT NULL CHECK (outcome IN ('contacted','snoozed')),
  hide_until      DATE NOT NULL,
  risk_score      INT  NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pt_client_followups_latest
  ON pt_client_followups (organization_id, client_id, created_at DESC);
```

Append-only: history rows are kept; the list reads the latest row per client
(`DISTINCT ON (client_id) ... ORDER BY client_id, created_at DESC`). RLS, grants
and the `deny_all_direct_access` policy follow migration 245 exactly. The table
is added to the `clients` domain in `src/architecture/domains.js` — the
architecture test fails if the schema grows a table the manifest does not place.

Visibility rule (all dates use `studioToday()`, never `CURRENT_DATE`):

- `contacted` → `hide_until = today + 7 days`.
- `snoozed` → caller supplies `hide_until` between tomorrow and today + 90.
- Hidden while `hide_until >= today` **and** `current_score < risk_score + 15`.
- Reappears early when the score rose by 15+ points, flagged
  `risk_increased: true` so the trainer knows it moved after they acted.
  A score that merely re-crosses a band is not enough; the +15 is the explicit
  contract and is unit-tested.
- `data.handled` = clients **currently hidden** (latest mark, `hide_until >=
  today`), capped at 100. When `hide_until` passes, the client drops out of
  `handled` and returns to `rows` if it still scores. The table keeps its
  history; the response does not.

Before inserting, the handler must verify the client belongs to the caller's
organization (`SELECT id FROM pt_clients WHERE id = $1 AND organization_id = $2
AND deleted_at IS NULL`), because the FK on `client_id` does not imply the
tenant. This is the same 404 answer the client-history routes give: never 403,
which would confirm the id exists elsewhere.

## API contracts

### `GET /api/pt-os/churn-risk`

Auth + tenant scope exactly like `GET /signals` (`orgIdOf(req)`), read-only.

```json
{
  "data": {
    "as_of": "2026-10-30",
    "assessed": 34,
    "flagged": 9,
    "bands": { "critical": 2, "high": 3, "medium": 3, "low": 1 },
    "rows": [{
      "client_id": "…", "client_name": "…", "score": 75, "band": "critical",
      "reasons": [{ "code": "silent_21", "label": "Last trained 31 days ago", "points": 60 }],
      "next_action": "Call this week. They are paying for training they are not taking.",
      "last_session": "2026-09-29", "days_quiet": 31,
      "term": { "state": "current", "end": "2026-11-14", "days_left": 15 },
      "balance_amount": 8000,
      "risk_increased": false
    }],
    "handled": [{ "...": "same shape, currently hidden", "hide_until": "2026-11-06", "outcome": "contacted" }]
  }
}
```

`rows` = visible, sorted by score desc, then days quiet desc (never-trained
sorts as +Infinity, same as the sweep), then name. Stable ordering is part of the
contract: the same data must not reshuffle between two calls.

### `POST /api/pt-os/churn-risk/:clientId/followup`

Body `{ "outcome": "contacted" | "snoozed", "snooze_until": "YYYY-MM-DD", "note": "…" }`.
`note` is optional, max 500 chars. Rejects a client outside the caller's org with
404 (not 403 — the same rule the client-history routes already use). The handler
reuses `buildChurnList(orgId)` and picks that client from it, so the score stored
on the mark is the same score the list showed; the client cannot supply it.

### `POST /api/ai/business/churn`

`requireTrainer, requireConfigured`. Builds the same scored list through the same
service, then one `routedChat({ intent: 'business', … })` call.

Response:

```json
{
  "data": {
    "summary": "4 sentences, quoting only the supplied numbers",
    "themes": ["…"],
    "this_week": ["…"]
  },
  "model": "…", "tier": "…", "used_fallback": false
}
```

Rules:

- Zero flagged clients → deterministic summary, no LLM call, `model:
  "deterministic"` (same shortcut `/business/insights` takes for an empty
  studio).
- Unparseable/shape-wrong JSON → 422 `AI_UNPARSEABLE`, never raw completion to
  the browser.
- `logUsage` on every real call, with `intent_type: 'business'`.
- Prompt receives the scored rows (top 10) and counts; it is told to quote them
  and not to compute, and not to name a client who is not in the payload.
- Called only when the trainer presses **Explain this list**. Page load makes no
  AI call, so a refresh loop cannot spend tokens.

## UI

### `/pt-os/clients/at-risk` (new page, static route before `[id]`)

- Summary strip: assessed / flagged / critical / high, and `as_of`.
- Ranked list: score chip + band, name (links to `/pt-os/clients/:id`), reasons
  with points, next action, `last trained X days ago`, term days left, balance.
- Row actions: **Mark contacted**, **Snooze** (date picker, default +7 days).
- Collapsed **Handled recently** section from `data.handled`, with hide-until and
  the "risk increased" chip when applicable.
- **Explain this list** button renders the AI summary in place, with loading and
  error states. Failure never hides the deterministic list.
- Empty state names the sweep and the count, like the Today card.

### Existing surfaces

- `RosterSignalsCard`: a `View all` link in the shell header →
  `/pt-os/clients/at-risk`. No change to its ordering or its data contract.
- Nav: `Clients` group gains `{ href: '/pt-os/clients/at-risk', label: 'At-risk
  Clients', icon: 'AlertTriangle' }`. `AlertTriangle` is added to the Sidebar
  icon map.
- API types in `lib/api/types.ts`, client in `lib/api/endpoints/ptOs.ts`
  (`churnRisk`, `markFollowup`, `churnInsight`), following the existing
  `api.pt.*` shape.

## Backend files

| File | Change |
|---|---|
| `src/modules/pt-os/churn-risk.js` | **new** — pure scoring: `scoreClient(input)`, `rankClients(rows)`, band + action tables. No DB, no Express. |
| `src/modules/pt-os/churn.service.js` | **new** — assembles roster + sweep + latest follow-ups, merges by `pt_clients.id`, applies visibility. All SQL for follow-ups lives in a repository, matching the Phase 1 pattern. |
| `src/modules/pt-os/churn.repository.js` | **new** — `listRoster` (uncapped), `latestFollowups(orgId, today)`, `latestForClient`, `create`; every query binds `organization_id`. |
| `src/modules/pt-os/pt-os.routes.js` | two routes: GET list, POST followup. Handlers only; no SQL. |
| `src/routes/ai.js` | one route: `POST /business/churn`, reusing the insight pattern. |
| `src/architecture/domains.js` | `pt_client_followups` under `clients`. |
| `src/db/migrations/246_churn_followups.sql` | table + index + RLS + grants + comments. |
| `src/__tests__/churn-risk.test.js` | scoring table, bands, actions, clamping, interpolated reasons. |
| `src/__tests__/churn.service.test.js` | merge by `id` not `client_id`, roster ∪ sweep, hide/reappear threshold, cross-org isolation. |

## Frontend files

| File | Change |
|---|---|
| `src/app/(chrome)/pt-os/clients/at-risk/page.tsx` | **new** page. |
| `src/components/pt-os/ChurnRow.tsx` | row + reason chips + actions (keeps the page readable). |
| `src/components/pt-os/RosterSignalsCard.tsx` | `View all` link only. |
| `src/lib/nav-config.ts`, `src/components/sidebar/Sidebar.tsx` | nav item + icon. |
| `src/lib/api/types.ts`, `src/lib/api/endpoints/ptOs.ts` | contracts. |

## Edge cases the implementation must hold

- Client with no term dates (`term.state = 'unknown'`) and a balance → dues
  reason only; no invented silence.
- Client in `clients_detail` and also in the roster → one row, merged by id,
  points summed once.
- Dues-only client (no training signal) → one row with the dues reason, from the
  roster query, not from `clients_detail`.
- A 600-client roster is fully assessed: the roster query has no LIMIT and no
  client drops out of `assessed` or the scoring.
- Client with 0 score → not listed; counted in `assessed`, not in `flagged`.
- `days_left = 0` (term ends today) → `term_ending_7`, not `term_ended`.
- Negative `days_left` → `term_ended` only, never `term_ending_7`.
- A client whose `pt_end_date` and `studioToday()` straddle midnight → the
  studio clock decides, the same one the sweep used.
- Deleted client (`deleted_at`) → never appears; follow-ups cascade on delete.
- A follow-up row from another org → invisible, and POST returns 404.
- Sweep failure → the endpoint fails honestly (500/503), never an empty list.
  "Nobody at risk" and "we could not look" are different answers.

## Tests

- Scoring: each component in isolation, the two criticals alone, an all-signals
  client clamped at 100, band boundaries at 14/15, 34/35, 59/60.
- Action priority: `dues + silent_10` → silence action; `term_ended + silent_21`
  → silence action; `term_ending_7 + dues` → renewal action.
- Visibility: hidden on `contacted`; hidden on `snoozed`; reappears at +15;
  stays hidden at +14; reappears after `hide_until`; a passed mark drops out of
  `handled` and returns to `rows` when it still scores.
- Assembly: dues-only client appears; `assessed` counts the whole roster; a
  501st debtor is not dropped; the clock is the injected studio date.
- Route: tenant isolation, 404 outside org, invalid snooze date rejected,
  note length capped.
- AI: empty roster makes no model call; unparseable JSON → 422 and list intact.
- Architecture: domain manifest test passes with the new table; migration 246
  passes the RLS shape test; route adapter has no SQL.

## Rollout

- Migration 246 is additive and reversible by dropping one table; no existing
  column or row changes.
- Backend deploy runs `npm run migrate`; no worker change (no cron, no queue).
- Verification: `/api/health` 200, `_migrations` contains 246, the page renders
  the live roster, a `contacted` mark hides the row and appears in Handled, the
  row returns when the date passes, `Explain this list` logs one AI usage row.

## Known limits (recorded, not hidden)

- `shortcut:` no score history. The page says "as of today"; it cannot show a
  trend. Upgrade when the list has been in daily use and the trainer asks
  "is this better than last week?" — that needs a daily snapshot table.
- `shortcut:` ended terms only appear when the sweep also flagged them (quiet or
  training signal). A client whose term ended but who trained yesterday is not
  listed; win-back for everyone expired lives on `/pt-os/clients?term=ended`
  until this phase earns its own section.
- `shortcut:` the +15 reappear threshold is a constant, not per-studio
  configuration. Upgrade if studios with large rosters report the list
  resurfacing too aggressively.

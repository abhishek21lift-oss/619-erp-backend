# Training OS — state, runbook, and what happens next

The workout system rewrite: new schema, new API, new UI, and the migration off
the old `workout_*` tables. This file exists so a fresh session can pick the
work up without re-deriving any of it.

Read this first. Then read the linked PR descriptions for the reasoning behind
each piece — the decisions are written down there, not summarised here.

---

## 1. Connecting Supabase (do this on your own machine)

Claude Code sessions running in the cloud **cannot** authorise an MCP server:
the OAuth flow needs an interactive terminal. So Supabase access has to be set
up locally, once.

```bash
claude mcp add --scope project --transport http supabase \
  "https://mcp.supabase.com/mcp?features=docs%2Caccount%2Cdatabase%2Cdebugging%2Cdevelopment%2Cfunctions%2Cbranching"

claude          # starts an interactive session, prompts to approve the server
/mcp            # inside the session: check status, authenticate
```

`--scope project` writes `.mcp.json` into the current directory. Run it from
whichever repo you want the config shared with, and commit that file if you
want everyone to get it.

Without this, a session can still do everything except query the database
directly — it will ask you to run SQL and paste the result, which works but is
slow.

Project ref: `adffjnztzrolibtuvhgc`.

---

## 2. What is built and merged

Backend (`619-erp-backend`):

| | |
|---|---|
| #74 | Slice A — domain: migrations 164–166, units/prescription/records/progression/volume |
| #75 | Slice B — authz helpers, every child row joined back to `pt_clients` |
| #76 | Slice C — the API at `/api/training`, behind `gate('programs')` |
| #77 | Slice G.1 — migration 167 copies the old log; records backfill script |

Frontend (`619-erp-frontend`):

| | |
|---|---|
| #149 | Slice D — API client, `PrescriptionEditor`, `useTrainingMeta` |
| #150 | The workout day builder and the page that mounts it |
| #151 | Slice E — the session logger: durable queue, cardio, rest timer |
| #152 | The workouts index — the builder's front door *(open at time of writing)* |

Routes now live: `/pt-os/training/templates`, `/pt-os/training/templates/[id]`,
`/pt-os/training/sessions/[id]`.

---

## 3. What production actually contains

Measured, not assumed. Re-check before relying on it — people are still using
the old screens, so these numbers move.

| | |
|---|---|
| Old sessions | 49 (was 47 when this work started) |
| Old sets | 100 |
| Migrated | 1:1, verified by count |
| `personal_records` | 43, all live, none superseded |

**The `completed` flag on old sets is real, and must be respected.**

| session status | sets logged | ticked | |
|---|---|---|---|
| `completed` | 44 | 29 | 66% |
| `in_progress` | 56 | 3 | 5% |

Ticking tracks session completion almost perfectly. If it had been optional UI
clutter the two rates would match. **Do not backfill it** — analytics showing
~29 completed sets out of 100 logged is the truth about what was performed.
"Fixing" it would inflate every client's training volume threefold with work
nobody did.

---

## 4. What happens next, in order

1. **Start-a-session flow.** `/pt-os/training/sessions/[id]` is still
   URL-only — the same problem #152 just fixed for the builder. Needs an entry
   point from the client page that creates a session and lands on the logger.
2. **Client session history** reading the new tables.
3. **Slice F — analytics.** Filters on `completed`; see §3.
4. **Freeze writes to the old tables.** See the runbook below; the re-migration
   step is not optional.
5. **Drop the old tables.** A separate migration, only after 4 has been live.

---

## 5. Runbook

### Re-running the migration (safe, idempotent)

Deploy applies it automatically. To force it, or to pick up rows logged since:

```bash
cd /opt/myptstudio
docker compose run --rm --no-deps backend npm run migrate
```

**Before the freeze (step 4 above), run this again.** The old screens are still
in use — session counts moved 47 → 48 → 49 during a single working session — so
anything logged between the last run and the freeze would otherwise never reach
the new tables. Migration 167 is idempotent precisely so this is cheap.

### Rebuilding personal records

Not run by the deploy. Run after any re-migration:

```bash
docker compose run --rm --no-deps backend npm run backfill:training-records -- --dry-run
docker compose run --rm --no-deps backend npm run backfill:training-records
```

It converges: a second run must report `0 records written`. **If it does not,
that is a bug** — the quantisation fix in `records.js` has regressed and repeat
sets are re-registering as PRs.

### Verifying a migration run

```sql
SELECT (SELECT count(*) FROM workout_sessions)                          AS old_sessions,
       (SELECT count(*) FROM training_sessions
         WHERE metadata->>'migrated_from' IS NOT NULL)                  AS migrated_sessions,
       (SELECT count(*) FROM workout_sets)                              AS old_sets,
       (SELECT count(*) FROM set_performances
         WHERE client_token LIKE 'legacy:%')                            AS migrated_sets;
```

Both pairs must match.

---

## 6. Open decisions

**32 migrated sessions sit in `IN_PROGRESS` and are actually abandoned.**
They are historical, with 56 sets written down and 3 done. Migration 167
mapped `in_progress` → `IN_PROGRESS` faithfully, but they will show as
"currently training" forever and pollute any in-flight query. The schema has
`ABANDONED` for this. Needs a small follow-up migration, with the reason
recorded in `metadata` rather than silently flipped. **Not yet decided.**

**The mobile keyboard fix (#147) has never run on a real device.** It cannot be
verified in jsdom — the whole bug is a WebKit user-gesture requirement. Worth
sixty seconds on a real phone against the Relationship dropdown, the exercise
picker, ⌘K, and the mobile search sheet.

**Two `.env.example` inconsistencies**, offered and never resolved: a duplicate
`EMAIL_FROM` with conflicting values, and `SMTP_PORT` documented as 465 while
the code defaults to 587.

---

## 7. Things that will bite you

- **A page module may only export the page.** Next fails the build on any extra
  export — helpers go in `lib/` or `components/`. Cost two builds to learn.
- **Convention tests are ratchets and they are load-bearing.** `palette.test.ts`
  (no off-palette hex), `scale.test.ts` (no new font sizes, 14.5px deliberately
  removed), `pull-refresh-optout.test.ts` (every fixed-inset overlay needs
  `data-no-pull-refresh`), `tenantScope.convention.test.js`. All three caught
  real regressions in this work.
- **`use(params)` suspends.** Page tests need a `Suspense` boundary *inside an
  awaited `act`*, or nothing renders and the failure looks like a broken mock.
- **DB-backed backend tests** run against `RLS_TEST_DATABASE_URL`, inside a
  transaction that is always rolled back. They fail loudly in CI if the URL is
  missing rather than skipping silently. Locally: `./scripts/rls-proof-setup.sh`.
- **Three suites fail locally in a bare container** (`rls.isolation`,
  `exercises.visibility`, `auth.forgotPassword`) — unseeded database, no redis.
  They fail identically on unmodified `main`. Not regressions.

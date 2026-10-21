# Migrations 218 & 234 — Operator Runbook (READ FIRST; Phases 4D/5D)

Everything here is review/rehearsal material. **Nothing in this phase executes
SQL against any database.** The engineering artifacts these documents refer to
were written in Phase 4 for what they already implement; this runbook makes the
two migrations' effects, lock profile, rollback and compatibility explicit.

## What each migration does

### `218_ai_usage_accounting_and_quota.sql`
1. `ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cost_inr / usage_source / request_id`
   — production already has these columns (the code has been writing them);
   this declares them for CI/fresh-restore databases. Catalog-only, seconds.
2. `ai_usage_source_check` CHECK constraint (idempotent via `pg_constraint`
   probe). Constraint validation scans the table once.
3. **The enforcement flip** — verbatim from the file:

   ```sql
   UPDATE ai_platform_settings
      SET enforcement_enabled    = TRUE,
          default_monthly_tokens = 3000000,
          updated_at             = NOW()
    WHERE default_monthly_tokens IS NULL
      AND enforcement_enabled     = FALSE;
   ```

   Affected rows: exactly the settings rows listed by preflight sections 2/2b.
   Expected on production: 0–1 rows (there is one settings row). **This is a
   behavior change at deploy time, not a schema change**: from the moment this
   commits, every studio without an explicit decision is capped at 3,000,000
   tokens/calendar-month with `enforcement_enabled = TRUE`, and
   `requireAiQuota()` may start answering 429 `AI_QUOTA_EXCEEDED`. Options the
   operator retains: per-studio rows in `organization_ai_limits` (NULL row =
   exempt), or the Command Center switches to change/delete the default.
   Only rows where *somebody chose nothing* flip; an existing default or an
   existing enabled flag is left untouched.

### `234_ai_usage_organization_and_upstream.sql`
1. `organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL` +
   `routed_via TEXT` — nullable, additive; historical rows stay **NULL by
   design** and quota/report queries read through
   `COALESCE(l.organization_id, u.organization_id)`. **No backfill** —
   stamping a transferred trainer's past rows with their CURRENT studio would
   rewrite history; unknown stays unknown, new rows are exact.
2. `ai_usage_org_idx (organization_id, created_at DESC)` — plain index.
3. `ai_usage_request_key (request_id, user_id) WHERE request_id IS NOT NULL`
   — the ingest idempotency key. Partial on purpose: the ERP's own rows carry
   `request_id IS NULL`, and multiple NULLs never conflict.

## Execution model and ordering

- Runner: `node src/db/migrate.js` applies `src/db/migrations/*.sql` in
  filename order under advisory lock `619619619`, one transaction per file
  (verify with the runner source before staging). 218 < 234, so 218 runs
  first; both are fully idempotent (`IF NOT EXISTS` everywhere), so a re-run
  after a mid-flight failure is safe. The runner dependency means preflight
  SQL must live in `docs/`, NEVER in the migrations directory.
- Lock profile: both `CREATE INDEX` statements are plain. A plain index build
  takes a brief **ACCESS EXCLUSIVE** lock, holds it for the build duration and
  blocks concurrent INSERTs into `ai_usage_log` while it runs. The table is
  usage-log-sized; on the production instance this is expected to be seconds.
  If preflight section 7 shows long-running transactions, they outlive the
  lock and queue everything behind them — clear those first, or migrate in a
  low-traffic window.
  - If the build ever turns out slow, the operator alternative is
    `CREATE INDEX CONCURRENTLY ...` run manually outside the migration
    transaction, then `npm run migrate` sees the index exists and no-ops. Do
    NOT put a CONCURRENTLY variant into the migrations directory; the runner's
    transactional context cannot host it.
- The unique build can fail on duplicate keys — preflight sections 3/3b must
  report **0 duplicate groups** before staging. On a healthy production ledger
  this is 0: the service keys one row per turn and never retried; the duplicates
  the index exists to block are re-ingestion, which only began being blocked
  with this index.

## Post-migration verification (read-only)

```sql
\d ai_usage_log                                -- columns + constraint present
SELECT indexdef FROM pg_indexes WHERE indexname LIKE 'ai_usage%';
SELECT count(*) FROM ai_platform_settings WHERE enforcement_enabled = TRUE;
-- usage now arriving WITH attribution:
SELECT count(*) FILTER (WHERE request_id IS NOT NULL) AS service_rows,
       count(*) FILTER (WHERE organization_id IS NULL) AS unknown_org_rows
  FROM ai_usage_log;
```

Then: one chat turn through mps-ai, confirm a single ledger row with
`request_id` + `organization_id` set, and re-run the duplicate summary
(preflight 3b) expecting zero.

## Rollback / recovery

All of 234's effects are additive (two columns + two indexes). Rollback =
`DROP INDEX`/`DROP COLUMN IF EXISTS` — no data loss, no ordering trap:
- Old app versions INSERT without the new columns; nullable columns welcome
  them. Production code already writes/reads them (the columns exist there);
  rolled-back code-idle pins only fresh databases, which lose nothing they
  never had.
- The 218 flip cannot be "rolled back" by the migration — it is data. Should
  an operator want the old posture back: Command Center or
  `UPDATE ai_platform_settings SET enforcement_enabled = FALSE` (existing
  caps can be deleted per row). The 3M default itself may stay; disabling
  enforcement restores pre-218 behavior exactly.
- Failure mid-run: the advisory-lock transaction per file means a failed file
  rolls back wholly; re-run after fixing the cause.

## Live-DB items (cannot be verified in this phase — no database access)

1. Preflight sections 0–7 captured on production (sizes, flip-row identity,
   duplicate counts, lock environment).
2. The exact row count that the flip actually changed, read from
   `updated_at` right after apply.
3. Build timings for both index builds (informational).
4. First post-migration turn reporting into `ai_usage_log` with explicit
   `organization_id` and no duplicate row on replay.

-- MIGRATION-PREFLIGHT-218-234.sql — READ-ONLY PREFLIGHT (Phases 4D/5D)
--
-- Purpose: the checks an operator runs BEFORE `npm run migrate` applies
-- 218_ai_usage_accounting_and_quota.sql and 234_ai_usage_organization_and_
-- upstream.sql. Every statement is a SELECT — this file must never be placed
-- under src/db/migrations/ (the runner executes every .sql there) and must
-- never be massaged into a mutating script. Nothing here changes state.
--
-- Run: psql "$DATABASE_URL" -f docs/MIGRATION-PREFLIGHT-218-234.sql
-- Capture the full output into the migration ticket.

\echo '══ 0. Current table size / index footprint (forecast lock durations) ══'
SELECT relname                                     AS table,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       n_live_tup                                  AS approx_rows
  FROM pg_stat_user_tables
 WHERE relname = 'ai_usage_log';

\echo '══ 1. Are the 218 usage columns already present? (IF NOT EXISTS makes it a no-op if so) ══'
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'ai_usage_log'
   AND column_name IN ('cost_inr', 'usage_source', 'request_id',
                       'organization_id', 'routed_via')
 ORDER BY column_name;

\echo '══ 2. Before the 218 flip: WHO would this flip touch? ══'
SELECT id            AS settings_row,
       default_monthly_tokens,
       enforcement_enabled,
       warn_at_pct,
       updated_at
  FROM ai_platform_settings;

\echo '══ 2b. Rows the 218 UPDATE will flip (must match section 2) ══'
SELECT count(*) AS rows_that_will_flip
  FROM ai_platform_settings
 WHERE default_monthly_tokens IS NULL
   AND enforcement_enabled     = FALSE;

\echo '── The 218 flip, for the record: ──'
\echo 'UPDATE ai_platform_settings SET enforcement_enabled = TRUE, default_monthly_tokens = 3000000, updated_at = NOW() WHERE default_monthly_tokens IS NULL AND enforcement_enabled = FALSE;'

\echo '══ 3. Before the 234 unique index: duplicate (request_id, user_id) keys ══'
SELECT request_id,
       user_id,
       count(*)      AS dup_rows,
       sum(tokens)   AS tokens_at_risk_of_one_less_count
  FROM ai_usage_log
 WHERE request_id IS NOT NULL
 GROUP BY 1, 2
 HAVING count(*) > 1
 LIMIT 50;

\echo '══ 3b. Duplicate summary (0 expected on healthy data) ══'
SELECT count(*) AS duplicate_groups,
       coalesce(sum(n_rows - 1), 0) AS rows_the_unique_index_would_have_blocked
  FROM (SELECT request_id, user_id, count(*) AS n_rows
          FROM ai_usage_log
         WHERE request_id IS NOT NULL
         GROUP BY 1, 2
        HAVING count(*) > 1) d;

\echo '══ 4. Historical attribution (234): NULL organization_id rows ══'
SELECT count(*)                                                     AS total_rows,
       count(*) FILTER (WHERE organization_id IS NULL)              AS unknown_org_rows,
       count(*) FILTER (WHERE organization_id IS NULL
                         AND user_id IS NULL)                       AS unjoinable_rows
  FROM ai_usage_log;

\echo '══ 5. Rows whose user_id has no users row (join-based reads drop these) ══'
SELECT count(*) AS orphan_user_rows
  FROM ai_usage_log l
 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id);

\echo '══ 6. Has 234 already been applied? ══'
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE indexname IN ('ai_usage_org_idx', 'ai_usage_request_key');

\echo '══ 7. What would block a plain CREATE INDEX during the build? ══'
SELECT pid,
       state,
       xact_start,
       now() - xact_start AS age
  FROM pg_stat_activity
 WHERE datname = current_database()
   AND state <> 'idle'
 ORDER BY age DESC NULLS LAST;
\echo 'Long-running transactions here hold locks past CREATE INDEX; clear before migrating.'

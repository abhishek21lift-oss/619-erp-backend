-- 218_ai_usage_accounting_and_quota.sql
--
-- AI audit 2026-09-28 (docs/AI-AUDIT-2026-09-28.md), AI-3.
--
-- ── Usage columns the code writes ───────────────────────────────────────────
--
-- Production's ai_usage_log already has cost_inr, usage_source and request_id,
-- but no migration in this repository creates them: a database built from the
-- migrations (CI, a local copy, a restore onto a fresh server) lacks them. The
-- usage logger now writes cost_inr and usage_source, so they are declared here
-- in exactly production's shape. IF NOT EXISTS, so production is untouched.
--
-- ── A default AI allowance, enforced ────────────────────────────────────────
--
-- Enforcement was off with no default cap: a studio's AI use had no ceiling at
-- all. Turned on here with a default of 3,000,000 tokens per studio per
-- calendar month — about three times the busiest studio's current use,
-- counted with real prompt tokens (which the log only now records). A studio
-- can be given its own figure in organization_ai_limits, and the operator can
-- change the default or switch enforcement off from the Command Center.
--
-- Only applied where nobody has chosen otherwise: a default already set, or
-- enforcement already turned on, is left exactly as it is.

ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cost_inr     NUMERIC(12,6);
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS usage_source TEXT;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS request_id   TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_source_check') THEN
    ALTER TABLE ai_usage_log
      ADD CONSTRAINT ai_usage_source_check
      CHECK (usage_source IS NULL OR usage_source IN ('provider', 'estimated'));
  END IF;
END $$;

UPDATE ai_platform_settings
   SET enforcement_enabled    = TRUE,
       default_monthly_tokens = 3000000,
       updated_at             = NOW()
 WHERE default_monthly_tokens IS NULL
   AND enforcement_enabled = FALSE;

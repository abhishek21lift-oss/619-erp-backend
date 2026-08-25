-- ============================================================
-- 184_ai_proposal_execution_history.sql
--
-- Phase 2J — Execution Reversal & Production Safety
--
-- Stores the deterministic before/after state of every execution
-- so that reversals restore the exact previous values without
-- AI reconstruction or percentage calculations.
-- ============================================================

-- Add execution_history to store before/after for reversal
ALTER TABLE ai_programmer_proposals
  ADD COLUMN IF NOT EXISTS execution_history JSONB DEFAULT NULL;

-- Add reversed_at for reversal tracking
ALTER TABLE ai_programmer_proposals
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ DEFAULT NULL;

-- Add reversed_by for audit
ALTER TABLE ai_programmer_proposals
  ADD COLUMN IF NOT EXISTS reversed_by TEXT DEFAULT NULL;

-- Update status check to include 'reversed' and 'reversing'
ALTER TABLE ai_programmer_proposals DROP CONSTRAINT IF EXISTS ai_programmer_proposals_status_check;
ALTER TABLE ai_programmer_proposals ADD CONSTRAINT ai_programmer_proposals_status_check
  CHECK (status IN (
    'draft', 'approved', 'rejected', 'expired', 'executed',
    'deleted', 'executing', 'reversing', 'reversed', 'reversal_failed'
  ));

-- Fast lookup: executed proposals that can be reversed
CREATE INDEX IF NOT EXISTS idx_ai_programmer_proposals_reversible
  ON ai_programmer_proposals (client_id, organization_id, status)
  WHERE status = 'executed';

COMMENT ON COLUMN public.ai_programmer_proposals.execution_history IS
  'Phase 2J — JSONB recording the deterministic before/after state of each executed change. Used for safe reversal without AI reconstruction.';
COMMENT ON COLUMN public.ai_programmer_proposals.reversed_at IS
  'Phase 2J — Timestamp when the execution was reversed by a trainer.';
COMMENT ON COLUMN public.ai_programmer_proposals.reversed_by IS
  'Phase 2J — User ID of the trainer who reversed the execution.';

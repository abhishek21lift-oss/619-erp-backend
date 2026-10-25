-- ============================================================
-- 237_client_welcome_tour.sql
-- K11 onboarding step 1: the trainer recorded a welcome and gym tour.
-- Additive and nullable; existing clients are grandfathered in the journey
-- service when they already have a PT term, so no backfill is needed.
-- ============================================================

ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS welcome_tour_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN pt_clients.welcome_tour_completed_at IS
  'When the trainer completed the K11 welcome and gym tour (step 1). NULL for not recorded.';

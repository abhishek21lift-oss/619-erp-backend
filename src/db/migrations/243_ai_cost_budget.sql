-- A monthly rupee ceiling for AI spend.
--
-- The token allowance answers "how much may this studio use"; this answers
-- "what may the platform spend". They move independently: a provider rate
-- change moves the bill without moving a single token.
--
-- NULL means no budget. The Command Center card then reports month-to-date
-- spend and never grades it — the same "off until switched on" posture the
-- token allowance takes, and different from a budget of zero.
ALTER TABLE ai_platform_settings
  ADD COLUMN IF NOT EXISTS monthly_cost_inr NUMERIC(12,2)
  CHECK (monthly_cost_inr IS NULL OR monthly_cost_inr >= 0);

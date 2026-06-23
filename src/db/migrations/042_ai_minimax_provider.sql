-- Migration 042: replace multi-provider AI settings with Token Router / MiniMax-M3
-- The old ai_provider_settings table stored OpenAI/Gemini mode selection.
-- We reset it to a single-provider record reflecting the new architecture.

-- Add provider column to ai_messages and ai_usage_log if not already present
-- (migration 029 added them, but old rows will have 'openai' — leave them as-is).

ALTER TABLE ai_messages
  ALTER COLUMN provider SET DEFAULT 'minimax';

ALTER TABLE ai_usage_log
  ALTER COLUMN provider SET DEFAULT 'minimax';

-- Reset the singleton provider settings row to reflect Token Router / MiniMax-M3.
-- If the row doesn't exist yet, insert it.
INSERT INTO ai_provider_settings (id, mode, gemini_model, updated_at)
VALUES ('singleton', 'minimax', NULL, NOW())
ON CONFLICT (id) DO UPDATE
  SET mode        = 'minimax',
      gemini_model = NULL,
      updated_at   = NOW();

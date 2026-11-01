-- 253_ai_conversation_retention.sql
--
-- Two gaps in the AI conversation store, both privacy-shaped.
--
-- 1. ai_conversations.client_id was plain TEXT with no foreign key, so it
--    could name a client that no longer exists and nothing ever cleaned it up.
--    This adds the reference with ON DELETE CASCADE: a client removed from the
--    studio takes its conversations with it.
--
--    NOT VALID on purpose. The constraint is enforced for every insert, update
--    and delete from this point on — including the cascade — but adding it
--    does not scan a table that may already hold rows for since-deleted
--    clients. Those are aged out by lib/ai/retention.js instead of failing a
--    deploy on data the app can no longer reach.
--
-- 2. Nothing ever deleted an old conversation. lib/ai/retention.js adds the
--    sweep; this index is what keeps its WHERE cheap.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_conversations_client_fk'
  ) THEN
    ALTER TABLE ai_conversations
      ADD CONSTRAINT ai_conversations_client_fk
      FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_conversations_updated_idx
  ON ai_conversations (updated_at);

COMMENT ON COLUMN ai_conversations.client_id IS
  'Optional pt_clients reference (migration 253). Cascade-deletes the conversation when the client row is removed; conversation rows themselves are swept by lib/ai/retention.js after AI_CONVERSATION_RETENTION_DAYS (default 180).';
